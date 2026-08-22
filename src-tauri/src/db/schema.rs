//! SQLite 스키마 & 마이그레이션.
//! `PRAGMA user_version` 값을 마이그레이션 버전으로 사용한다.

use rusqlite::Connection;

use crate::error::AppResult;

/// 인덱스는 1 부터 시작하는 버전 번호. 새 마이그레이션은 배열 끝에만 추가한다.
pub const MIGRATIONS: &[&str] = &[
    // v1 — Phase 1 기본 스키마
    r#"
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    root_path   TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id                       TEXT PRIMARY KEY,
    project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title                    TEXT NOT NULL DEFAULT 'New Session',
    -- 타임머신(분기) 용: 어떤 세션의 어떤 메시지에서 갈라져 나왔는지
    parent_session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    branched_from_message_id TEXT,
    model                    TEXT,
    metadata                 TEXT NOT NULL DEFAULT '{}',
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    archived_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- 대화 트리 구조. NULL 이면 세션의 루트 노드.
    parent_id        TEXT REFERENCES messages(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content          TEXT NOT NULL DEFAULT '',
    tool_calls       TEXT,   -- JSON array
    tool_results     TEXT,   -- JSON array
    context_snapshot TEXT,   -- JSON: 이 시점에 LLM 으로 보낸 컨텍스트 원문
    token_usage      TEXT,   -- JSON
    status           TEXT NOT NULL DEFAULT 'complete',
    agent_id         TEXT,   -- 서브에이전트가 생성한 메시지면 해당 run id
    seq              INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

-- Phase 4 서브에이전트 대시보드 기반
CREATE TABLE IF NOT EXISTS agent_runs (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    name              TEXT NOT NULL,
    task              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
    progress          REAL NOT NULL DEFAULT 0,
    current_skill     TEXT,
    result            TEXT,
    error             TEXT,
    created_at        TEXT NOT NULL,
    started_at        TEXT,
    finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, created_at DESC);

-- Phase 3 메모리 인스펙터 기반
CREATE TABLE IF NOT EXISTS memories (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    scope      TEXT NOT NULL DEFAULT 'project',
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, scope, key)
);
"#,
    // v2 — Phase 3: 메모리 유일성 기준을 세션까지 포함하도록 재정의.
    //   v1 의 UNIQUE(project_id, scope, key) 는 서로 다른 세션의 session 스코프
    //   메모리가 같은 key 를 쓰면 덮어써 버린다. 테이블 제약은 못 고치므로 재작성한다.
    r#"
ALTER TABLE memories RENAME TO memories_v1;

CREATE TABLE memories (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    scope      TEXT NOT NULL DEFAULT 'project',
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO memories (id, project_id, session_id, scope, key, value, created_at, updated_at)
SELECT id, project_id, session_id, scope, key, value, created_at, updated_at FROM memories_v1;

DROP TABLE memories_v1;

-- session 스코프는 세션마다 별도 키 공간을 갖는다 (project 스코프는 session_id 가 NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_key
    ON memories(project_id, scope, COALESCE(session_id, ''), key);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, updated_at DESC);
"#,
    // v3 — 토큰/비용 집계: 서브에이전트도 자기가 쓴 토큰을 남긴다.
    //   메인 턴은 messages.token_usage 에 남지만 위임 실행은 별도 컨텍스트라
    //   대화 트리에 노드가 생기지 않는다 → 여기 안 적으면 세션 비용이 조용히 축소된다.
    r#"
ALTER TABLE agent_runs ADD COLUMN token_usage TEXT;
"#,
    // v4 — 이름 정정: 이 칸에 담기는 것은 스킬이 아니라 **도구 이름**이다.
    //   도구(실행 경로)와 스킬(절차서)을 가르면서 옛 이름이 거짓말이 됐다.
    //   v1 의 정의는 손대지 않는다(이미 만들어진 DB 와 어긋난다) → 여기서 이름만 바꾼다.
    r#"
ALTER TABLE agent_runs RENAME COLUMN current_skill TO current_tool;
"#,
];

/// 커넥션에 공통 PRAGMA 를 적용한다.
pub fn apply_pragmas(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5_000)?;
    Ok(())
}

/// 미적용 마이그레이션을 순서대로 실행한다.
pub fn migrate(conn: &mut Connection) -> AppResult<i64> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as i64;
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }

    let applied: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(applied)
}
