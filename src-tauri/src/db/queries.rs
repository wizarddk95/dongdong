//! 모든 SQL 접근은 이 모듈을 통해서만 이루어진다.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use std::collections::{HashMap, HashSet};

use super::models::{
    AgentRun, AgentRunPatch, DeleteOutcome, DetachedRun, Memory, Message, MessagePatch,
    NewAgentRun, NewMemory, NewMessage, Project, Reattachment, Session, SessionModelUsage,
    SessionOverview,
};
use crate::error::{AppError, AppResult};

pub fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::from("1970-01-01T00:00:00Z"))
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn to_text(value: &Option<Value>) -> Option<String> {
    value
        .as_ref()
        .filter(|v| !v.is_null())
        .map(|v| v.to_string())
}

fn from_text(text: Option<String>) -> Option<Value> {
    text.and_then(|t| serde_json::from_str(&t).ok())
}

fn object_or_empty(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Default::default()))
}

// ---------------------------------------------------------------- projects

const PROJECT_COLUMNS: &str = "id, root_path, name, settings, created_at, updated_at";

fn map_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        root_path: row.get(1)?,
        name: row.get(2)?,
        settings: object_or_empty(row.get(3)?),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// 루트 경로 기준으로 프로젝트 행을 만들거나 갱신한다.
pub fn upsert_project(conn: &Connection, root_path: &str, name: &str) -> AppResult<Project> {
    let ts = now();
    conn.execute(
        "INSERT INTO projects (id, root_path, name, settings, created_at, updated_at)
         VALUES (?1, ?2, ?3, '{}', ?4, ?4)
         ON CONFLICT(root_path) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
        params![new_id(), root_path, name, ts],
    )?;

    get_project_by_root(conn, root_path)?
        .ok_or_else(|| AppError::not_found(format!("프로젝트 {root_path}")))
}

pub fn get_project_by_root(conn: &Connection, root_path: &str) -> AppResult<Option<Project>> {
    let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE root_path = ?1");
    Ok(conn
        .query_row(&sql, params![root_path], map_project)
        .optional()?)
}

pub fn update_project_settings(conn: &Connection, id: &str, settings: &Value) -> AppResult<()> {
    conn.execute(
        "UPDATE projects SET settings = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, settings.to_string(), now()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------- sessions

const SESSION_COLUMNS: &str = "id, project_id, title, parent_session_id, branched_from_message_id, model, metadata, created_at, updated_at, archived_at";

fn map_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        parent_session_id: row.get(3)?,
        branched_from_message_id: row.get(4)?,
        model: row.get(5)?,
        metadata: object_or_empty(row.get(6)?),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        archived_at: row.get(9)?,
    })
}

pub fn create_session(
    conn: &Connection,
    project_id: &str,
    title: &str,
    model: Option<&str>,
    parent_session_id: Option<&str>,
    branched_from_message_id: Option<&str>,
) -> AppResult<Session> {
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO sessions
           (id, project_id, title, parent_session_id, branched_from_message_id, model, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, ?7)",
        params![
            id,
            project_id,
            title,
            parent_session_id,
            branched_from_message_id,
            model,
            ts
        ],
    )?;
    get_session(conn, &id)?.ok_or_else(|| AppError::not_found(format!("세션 {id}")))
}

pub fn get_session(conn: &Connection, id: &str) -> AppResult<Option<Session>> {
    let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], map_session).optional()?)
}

/// 미리보기 문구 길이. 너무 길면 세션 카드가 넘친다.
const PREVIEW_CHARS: usize = 120;

fn map_session_overview(row: &Row<'_>) -> rusqlite::Result<SessionOverview> {
    let preview: Option<String> = row.get(10)?;
    Ok(SessionOverview {
        session: map_session(row)?,
        message_count: row.get(11)?,
        last_message_at: row.get(12)?,
        preview: preview.map(|text| {
            let trimmed = text.trim();
            trimmed.chars().take(PREVIEW_CHARS).collect::<String>()
        }),
        agent_run_count: row.get(13)?,
        last_usage: from_text(row.get(14)?),
        last_usage_model: row.get(15)?,
        // 아래 집계 쿼리에서 채운다.
        usage_by_model: Vec::new(),
    })
}

/// 한 호출이 쓴 모델을 되찾는 SQL 식.
///
/// 새 기록은 usage JSON 안에 `modelId` 를 박아 둔다(모델을 바꿔도 옛 비용이 흔들리지 않게).
/// 그게 없는 옛 노드는 컨텍스트 스냅샷에 남은 모델을, 그것도 없으면 세션 기본 모델을 쓴다.
const MESSAGE_MODEL_EXPR: &str = "COALESCE(json_extract(m.token_usage, '$.modelId'),
                 json_extract(m.context_snapshot, '$.modelId'), s.model)";

/// usage JSON 의 한 필드를 정수로 꺼내 합한다. 값이 없으면 0.
/// `fallback` 은 필드 이름이 바뀌기 전의 옛 이름.
fn usage_sum(alias: &str, field: &str, fallback: Option<&str>) -> String {
    match fallback {
        Some(old) => format!(
            "SUM(COALESCE(json_extract({alias}.token_usage, '$.{field}'),              json_extract({alias}.token_usage, '$.{old}'), 0))"
        ),
        None => format!("SUM(COALESCE(json_extract({alias}.token_usage, '$.{field}'), 0))"),
    }
}

/// 토큰 합계 열 묶음. 메인 턴(messages)과 위임 실행(agent_runs)이 같은 모양을 쓴다.
fn usage_columns(alias: &str) -> String {
    format!(
        "COUNT(*), {}, {}, {}, {}, {}",
        usage_sum(alias, "inputTokens", None),
        // 옛 기록은 캐시 읽기를 `cachedInputTokens` 라는 이름으로 남겼다.
        usage_sum(alias, "cacheReadTokens", Some("cachedInputTokens")),
        usage_sum(alias, "cacheWriteTokens", None),
        usage_sum(alias, "outputTokens", None),
        usage_sum(alias, "reasoningTokens", None),
    )
}

/// 프로젝트의 모든 세션에 대해 `세션 → 모델별 토큰 합계` 를 한 번에 읽는다.
///
/// 서브에이전트는 대화 트리에 노드를 남기지 않으므로 `agent_runs` 를 UNION 으로 함께 센다.
fn session_usage_map(
    conn: &Connection,
    project_id: &str,
) -> AppResult<HashMap<String, Vec<SessionModelUsage>>> {
    let sql = format!(
        "SELECT s.id, {MESSAGE_MODEL_EXPR} AS model_id, {message_usage}
           FROM sessions s JOIN messages m ON m.session_id = s.id
          WHERE s.project_id = ?1 AND m.token_usage IS NOT NULL
          GROUP BY s.id, model_id
         UNION ALL
         SELECT s.id,
                COALESCE(json_extract(a.token_usage, '$.modelId'), s.model) AS model_id,
                {agent_usage}
           FROM sessions s JOIN agent_runs a ON a.session_id = s.id
          WHERE s.project_id = ?1 AND a.token_usage IS NOT NULL
          GROUP BY s.id, model_id",
        message_usage = usage_columns("m"),
        agent_usage = usage_columns("a"),
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            SessionModelUsage {
                model_id: row.get(1)?,
                calls: row.get(2)?,
                input_tokens: row.get(3)?,
                cache_read_tokens: row.get(4)?,
                cache_write_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                reasoning_tokens: row.get(7)?,
            },
        ))
    })?;

    let mut map: HashMap<String, Vec<SessionModelUsage>> = HashMap::new();
    for row in rows {
        let (session_id, usage) = row?;
        let bucket = map.entry(session_id).or_default();
        // 같은 모델이 메시지 쪽과 위임 쪽 양쪽에서 오면 한 줄로 합친다.
        match bucket.iter_mut().find(|item| item.model_id == usage.model_id) {
            Some(existing) => {
                existing.calls += usage.calls;
                existing.input_tokens += usage.input_tokens;
                existing.cache_read_tokens += usage.cache_read_tokens;
                existing.cache_write_tokens += usage.cache_write_tokens;
                existing.output_tokens += usage.output_tokens;
                existing.reasoning_tokens += usage.reasoning_tokens;
            }
            None => bucket.push(usage),
        }
    }
    // 많이 쓴 모델이 앞에 오게 — 카드에는 대표 모델 하나만 적는다.
    for bucket in map.values_mut() {
        bucket.sort_by(|a, b| {
            (b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens))
        });
    }
    Ok(map)
}

/// 세션 목록 + 카드에 필요한 집계(노드 수 · 마지막 활동 · 미리보기 · 위임 수 · 토큰)를
/// 한 번에 읽는다. 세션마다 메시지를 따로 조회하면 세션 수만큼 왕복이 생긴다.
pub fn list_session_overviews(
    conn: &Connection,
    project_id: &str,
) -> AppResult<Vec<SessionOverview>> {
    let sql = format!(
        "SELECT {SESSION_COLUMNS},
                (SELECT m.content FROM messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.seq LIMIT 1),
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id),
                (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id),
                (SELECT COUNT(*) FROM agent_runs a WHERE a.session_id = s.id),
                (SELECT m.token_usage FROM messages m
                  WHERE m.session_id = s.id AND m.token_usage IS NOT NULL
                  ORDER BY m.seq DESC LIMIT 1),
                (SELECT {MESSAGE_MODEL_EXPR} FROM messages m
                  WHERE m.session_id = s.id AND m.token_usage IS NOT NULL
                  ORDER BY m.seq DESC LIMIT 1)
           FROM sessions s
          WHERE s.project_id = ?1 AND s.archived_at IS NULL
          ORDER BY s.updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![project_id], map_session_overview)?;
    let mut overviews = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut usage = session_usage_map(conn, project_id)?;
    for overview in &mut overviews {
        overview.usage_by_model = usage.remove(&overview.session.id).unwrap_or_default();
    }
    Ok(overviews)
}

pub fn rename_session(conn: &Connection, id: &str, title: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now()],
    )?;
    Ok(())
}

pub fn delete_session(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(())
}

fn touch_session(conn: &Connection, session_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![session_id, now()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------- messages

const MESSAGE_COLUMNS: &str = "id, session_id, parent_id, role, content, tool_calls, tool_results, context_snapshot, token_usage, status, agent_id, seq, created_at, updated_at";

fn map_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        parent_id: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        tool_calls: from_text(row.get(5)?),
        tool_results: from_text(row.get(6)?),
        context_snapshot: from_text(row.get(7)?),
        token_usage: from_text(row.get(8)?),
        status: row.get(9)?,
        agent_id: row.get(10)?,
        seq: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn next_seq(conn: &Connection, session_id: &str) -> AppResult<i64> {
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    Ok(seq)
}

pub fn insert_message(conn: &Connection, input: &NewMessage) -> AppResult<Message> {
    const ROLES: [&str; 4] = ["system", "user", "assistant", "tool"];
    if !ROLES.contains(&input.role.as_str()) {
        return Err(AppError::invalid(format!("알 수 없는 role: {}", input.role)));
    }

    let id = new_id();
    let ts = now();
    let seq = next_seq(conn, &input.session_id)?;

    conn.execute(
        "INSERT INTO messages
           (id, session_id, parent_id, role, content, tool_calls, tool_results,
            context_snapshot, token_usage, status, agent_id, seq, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            id,
            input.session_id,
            input.parent_id,
            input.role,
            input.content,
            to_text(&input.tool_calls),
            to_text(&input.tool_results),
            to_text(&input.context_snapshot),
            to_text(&input.token_usage),
            input.status.as_deref().unwrap_or("complete"),
            input.agent_id,
            seq,
            ts,
        ],
    )?;

    touch_session(conn, &input.session_id)?;
    get_message(conn, &id)?.ok_or_else(|| AppError::not_found(format!("메시지 {id}")))
}

pub fn get_message(conn: &Connection, id: &str) -> AppResult<Option<Message>> {
    let sql = format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], map_message).optional()?)
}

pub fn list_messages(conn: &Connection, session_id: &str) -> AppResult<Vec<Message>> {
    let sql = format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE session_id = ?1 ORDER BY seq");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![session_id], map_message)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 루트에서 해당 메시지까지의 조상 체인(자기 자신 포함). LLM 컨텍스트 구성에 사용한다.
pub fn message_path(conn: &Connection, message_id: &str) -> AppResult<Vec<Message>> {
    let sql = format!(
        "WITH RECURSIVE chain(id) AS (
             SELECT ?1
             UNION ALL
             SELECT m.parent_id FROM messages m JOIN chain c ON m.id = c.id
             WHERE m.parent_id IS NOT NULL
         )
         SELECT {MESSAGE_COLUMNS} FROM messages WHERE id IN (SELECT id FROM chain) ORDER BY seq"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![message_id], map_message)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn update_message(conn: &Connection, id: &str, patch: &MessagePatch) -> AppResult<Message> {
    let existing =
        get_message(conn, id)?.ok_or_else(|| AppError::not_found(format!("메시지 {id}")))?;

    let content = patch.content.clone().unwrap_or(existing.content);
    let tool_calls = to_text(&patch.tool_calls.clone().or(existing.tool_calls));
    let tool_results = to_text(&patch.tool_results.clone().or(existing.tool_results));
    let context_snapshot = to_text(&patch.context_snapshot.clone().or(existing.context_snapshot));
    let token_usage = to_text(&patch.token_usage.clone().or(existing.token_usage));
    let status = patch.status.clone().unwrap_or(existing.status);

    conn.execute(
        "UPDATE messages SET content = ?2, tool_calls = ?3, tool_results = ?4,
             context_snapshot = ?5, token_usage = ?6, status = ?7, updated_at = ?8
         WHERE id = ?1",
        params![
            id,
            content,
            tool_calls,
            tool_results,
            context_snapshot,
            token_usage,
            status,
            now()
        ],
    )?;

    touch_session(conn, &existing.session_id)?;
    get_message(conn, id)?.ok_or_else(|| AppError::not_found(format!("메시지 {id}")))
}

/// 하위 트리까지 삭제 (messages.parent_id 에 ON DELETE CASCADE 가 걸려 있다).
pub fn delete_message(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
    Ok(())
}

/// 세션 안에서 "부모가 없거나 부모 행이 사라진" 노드 = 루트.
/// (`lib/tree.ts` 의 `buildIndex` 와 같은 판정 — 두 곳이 어긋나면 화면과 DB 가 다른 말을 한다.)
fn is_root(message: &Message, by_id: &HashMap<&str, &Message>) -> bool {
    match message.parent_id.as_deref() {
        None => true,
        Some(parent) => !by_id.contains_key(parent),
    }
}

/// 노드를 지운다.
///
/// `cascade` 가 false 면 **넘어온 노드만** 지우고, 그 아래 대화는 살아남은 조상에
/// 이어 붙인다(중간에 낀 실패한 턴 하나만 도려내는 용도).
/// true 면 예전처럼 후손까지 통째로 지운다.
///
/// 어느 쪽이든 되돌리기에 필요한 원문을 [`DeleteOutcome`] 으로 돌려준다.
/// 한 세션에 루트가 둘 이상 생기는 삭제는 거절한다 — 대화 트리는 세션당 뿌리 하나가 규칙이다.
pub fn delete_messages(
    conn: &mut Connection,
    ids: &[String],
    cascade: bool,
) -> AppResult<DeleteOutcome> {
    let mut anchors = Vec::new();
    for id in ids {
        if let Some(message) = get_message(conn, id)? {
            anchors.push(message);
        }
    }
    let first = anchors
        .first()
        .ok_or_else(|| AppError::not_found("지울 노드"))?;
    let session_id = first.session_id.clone();
    if anchors.iter().any(|m| m.session_id != session_id) {
        return Err(AppError::invalid(
            "한 번에 한 세션의 노드만 지울 수 있습니다.",
        ));
    }

    let all = list_messages(conn, &session_id)?;
    let by_id: HashMap<&str, &Message> = all.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut children: HashMap<&str, Vec<&Message>> = HashMap::new();
    for message in &all {
        if let Some(parent) = message.parent_id.as_deref() {
            children.entry(parent).or_default().push(message);
        }
    }

    // 지울 집합을 확정한다. cascade 면 후손까지 훑어 내려간다.
    let mut doomed: HashSet<String> = anchors.iter().map(|m| m.id.clone()).collect();
    if cascade {
        let mut stack: Vec<&str> = anchors.iter().map(|m| m.id.as_str()).collect();
        while let Some(current) = stack.pop() {
            for child in children.get(current).into_iter().flatten() {
                if doomed.insert(child.id.clone()) {
                    stack.push(child.id.as_str());
                }
            }
        }
    }

    // 지워질 조상을 건너뛰고 처음 만나는 살아남는 노드. 없으면 루트가 된다.
    let survivor_of = |parent: Option<&str>| -> Option<String> {
        let mut cursor = parent;
        while let Some(id) = cursor {
            match by_id.get(id) {
                None => return None,
                Some(message) if doomed.contains(id) => cursor = message.parent_id.as_deref(),
                Some(_) => return Some(id.to_string()),
            }
        }
        None
    };

    let survivors: Vec<&Message> = all.iter().filter(|m| !doomed.contains(&m.id)).collect();

    // 루트가 늘어나는 삭제는 막는다. 이미 여러 개인 옛 세션은 그대로 두되 더 늘리지는 않는다.
    let roots_before = all.iter().filter(|m| is_root(m, &by_id)).count().max(1);
    let roots_after = survivors
        .iter()
        .filter(|m| survivor_of(m.parent_id.as_deref()).is_none())
        .count();
    if roots_after > roots_before {
        return Err(AppError::invalid(
            "이 턴만 지우면 세션의 루트 노드가 둘 이상 됩니다. 아래 턴까지 함께 지우세요.",
        ));
    }

    let reattached: Vec<Reattachment> = survivors
        .iter()
        .filter(|m| {
            m.parent_id
                .as_deref()
                .is_some_and(|parent| doomed.contains(parent))
        })
        .map(|m| Reattachment {
            message_id: m.id.clone(),
            from_parent_id: m.parent_id.clone(),
            to_parent_id: survivor_of(m.parent_id.as_deref()),
        })
        .collect();

    // 서브에이전트 기록은 지우지 않는다 — 링크가 끊길 뿐이라 되돌리면 다시 붙는다.
    let mut detached_runs = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, parent_message_id FROM agent_runs
              WHERE session_id = ?1 AND parent_message_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (run_id, parent_message_id) = row?;
            if doomed.contains(&parent_message_id) {
                detached_runs.push(DetachedRun {
                    run_id,
                    parent_message_id,
                });
            }
        }
    }

    // seq 오름차순 — 되돌릴 때 부모가 자식보다 먼저 들어가야 한다.
    let removed: Vec<Message> = all
        .iter()
        .filter(|m| doomed.contains(&m.id))
        .cloned()
        .collect();

    let ts = now();
    let tx = conn.transaction()?;
    // 자식을 먼저 옮긴다. 순서가 뒤집히면 CASCADE 가 자식까지 데려가 버린다.
    for item in &reattached {
        tx.execute(
            "UPDATE messages SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![item.message_id, item.to_parent_id, ts],
        )?;
    }
    for message in &removed {
        tx.execute("DELETE FROM messages WHERE id = ?1", params![message.id])?;
    }
    tx.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![session_id, ts],
    )?;
    tx.commit()?;

    Ok(DeleteOutcome {
        removed,
        reattached,
        detached_runs,
    })
}

/// [`delete_messages`] 를 되돌린다. 원래 id·seq·시각 그대로 되살린다 —
/// id 가 바뀌면 서브에이전트 링크도, 되돌린 자식의 부모도 다시 이어 붙일 수 없다.
pub fn restore_messages(conn: &mut Connection, outcome: &DeleteOutcome) -> AppResult<usize> {
    if outcome.removed.is_empty() {
        return Ok(0);
    }

    let mut removed: Vec<&Message> = outcome.removed.iter().collect();
    removed.sort_by_key(|m| m.seq);
    let restoring: HashSet<&str> = removed.iter().map(|m| m.id.as_str()).collect();

    let tx = conn.transaction()?;
    for message in &removed {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM messages WHERE id = ?1",
            params![message.id],
            |row| row.get(0),
        )?;
        if exists > 0 {
            return Err(AppError::invalid("이미 되돌린 삭제입니다."));
        }
        // 부모가 그 사이에 다른 삭제로 사라졌으면 되돌릴 자리가 없다.
        if let Some(parent) = message.parent_id.as_deref() {
            if !restoring.contains(parent) {
                let alive: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM messages WHERE id = ?1",
                    params![parent],
                    |row| row.get(0),
                )?;
                if alive == 0 {
                    return Err(AppError::invalid(
                        "부모 노드가 이미 사라져 되돌릴 수 없습니다.",
                    ));
                }
            }
        }

        tx.execute(
            "INSERT INTO messages
               (id, session_id, parent_id, role, content, tool_calls, tool_results,
                context_snapshot, token_usage, status, agent_id, seq, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                message.id,
                message.session_id,
                message.parent_id,
                message.role,
                message.content,
                to_text(&message.tool_calls),
                to_text(&message.tool_results),
                to_text(&message.context_snapshot),
                to_text(&message.token_usage),
                message.status,
                message.agent_id,
                message.seq,
                message.created_at,
                message.updated_at,
            ],
        )?;
    }

    let ts = now();
    for item in &outcome.reattached {
        tx.execute(
            "UPDATE messages SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![item.message_id, item.from_parent_id, ts],
        )?;
    }
    for run in &outcome.detached_runs {
        tx.execute(
            "UPDATE agent_runs SET parent_message_id = ?2 WHERE id = ?1",
            params![run.run_id, run.parent_message_id],
        )?;
    }
    tx.commit()?;

    Ok(removed.len())
}

/// 노드 묶음(보통 턴 하나)을 복제해 다른 노드 뒤에 이어 붙인다. 세션을 넘나들 수 있다.
///
/// **토큰 사용량과 컨텍스트 스냅샷은 복제하지 않는다** — 복사본은 LLM 을 부른 적이
/// 없으므로 그대로 옮기면 세션 비용이 이중으로 잡히고, 스냅샷은 붙여넣은 자리와
/// 어긋난 거짓 원문이 된다. `agent_id` 도 같은 이유로 비운다.
pub fn copy_messages(
    conn: &mut Connection,
    source_ids: &[String],
    target_parent_id: Option<&str>,
    session_id: &str,
) -> AppResult<Vec<Message>> {
    let mut sources = Vec::new();
    for id in source_ids {
        let message =
            get_message(conn, id)?.ok_or_else(|| AppError::not_found(format!("메시지 {id}")))?;
        sources.push(message);
    }
    if sources.is_empty() {
        return Err(AppError::invalid("복사할 노드가 없습니다."));
    }
    sources.sort_by_key(|m| m.seq);

    match target_parent_id {
        Some(parent_id) => {
            let parent = get_message(conn, parent_id)?
                .ok_or_else(|| AppError::not_found(format!("메시지 {parent_id}")))?;
            if parent.session_id != session_id {
                return Err(AppError::invalid("붙여넣을 노드가 다른 세션에 있습니다."));
            }
        }
        // 붙일 자리를 안 주면 새 루트가 된다 — 이미 대화가 있는 세션에는 만들 수 없다.
        None => {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            if count > 0 {
                return Err(AppError::invalid(
                    "붙여넣을 노드를 먼저 고르세요. 세션의 루트 노드는 하나뿐입니다.",
                ));
            }
        }
    }

    let members: HashSet<&str> = sources.iter().map(|m| m.id.as_str()).collect();
    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut seq = next_seq(conn, session_id)?;
    let ts = now();

    let tx = conn.transaction()?;
    for message in &sources {
        let copy_id = new_id();
        // 묶음 안에 부모가 있으면 그 복사본에, 없으면(=묶음의 머리) 붙여넣을 자리에 매단다.
        let parent = match message.parent_id.as_deref() {
            Some(parent) if members.contains(parent) => id_map.get(parent).cloned(),
            _ => target_parent_id.map(str::to_string),
        };
        // 흐르다 만 노드를 복사하면 영원히 "생성 중" 으로 남는다 → 중단으로 굳혀 둔다.
        let status = if message.status == "streaming" {
            "aborted"
        } else {
            message.status.as_str()
        };

        tx.execute(
            "INSERT INTO messages
               (id, session_id, parent_id, role, content, tool_calls, tool_results,
                context_snapshot, token_usage, status, agent_id, seq, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, NULL, ?9, ?10, ?10)",
            params![
                copy_id,
                session_id,
                parent,
                message.role,
                message.content,
                to_text(&message.tool_calls),
                to_text(&message.tool_results),
                status,
                seq,
                ts,
            ],
        )?;
        id_map.insert(message.id.clone(), copy_id);
        seq += 1;
    }
    tx.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![session_id, ts],
    )?;
    tx.commit()?;

    let mut copies = Vec::new();
    for message in &sources {
        if let Some(copy_id) = id_map.get(&message.id) {
            if let Some(copy) = get_message(conn, copy_id)? {
                copies.push(copy);
            }
        }
    }
    Ok(copies)
}

/// 타임머신: 특정 메시지 시점까지의 대화를 복제한 새 세션(브랜치)을 만든다.
pub fn branch_session_at(
    conn: &mut Connection,
    message_id: &str,
    title: Option<&str>,
) -> AppResult<Session> {
    let anchor = get_message(conn, message_id)?
        .ok_or_else(|| AppError::not_found(format!("메시지 {message_id}")))?;
    let source = get_session(conn, &anchor.session_id)?
        .ok_or_else(|| AppError::not_found(format!("세션 {}", anchor.session_id)))?;
    let chain = message_path(conn, message_id)?;

    let branch_title = title
        .map(str::to_string)
        .unwrap_or_else(|| format!("{} (branch)", source.title));

    let tx = conn.transaction()?;
    let session_id = new_id();
    let ts = now();
    tx.execute(
        "INSERT INTO sessions
           (id, project_id, title, parent_session_id, branched_from_message_id, model, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            session_id,
            source.project_id,
            branch_title,
            source.id,
            message_id,
            source.model,
            source.metadata.to_string(),
            ts,
        ],
    )?;

    // 원본 메시지 id -> 복제본 id 매핑을 유지하며 부모 관계를 재구성한다.
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (index, message) in chain.iter().enumerate() {
        let new_message_id = new_id();
        let parent = message
            .parent_id
            .as_ref()
            .and_then(|p| id_map.get(p))
            .cloned();

        tx.execute(
            "INSERT INTO messages
               (id, session_id, parent_id, role, content, tool_calls, tool_results,
                context_snapshot, token_usage, status, agent_id, seq, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![
                new_message_id,
                session_id,
                parent,
                message.role,
                message.content,
                to_text(&message.tool_calls),
                to_text(&message.tool_results),
                to_text(&message.context_snapshot),
                to_text(&message.token_usage),
                message.status,
                message.agent_id,
                (index + 1) as i64,
                ts,
            ],
        )?;
        id_map.insert(message.id.clone(), new_message_id);
    }
    tx.commit()?;

    get_session(conn, &session_id)?.ok_or_else(|| AppError::not_found(format!("세션 {session_id}")))
}

// ---------------------------------------------------------------- memories

const MEMORY_COLUMNS: &str = "id, project_id, session_id, scope, key, value, created_at, updated_at";
const MEMORY_SCOPES: [&str; 2] = ["project", "session"];

fn map_memory(row: &Row<'_>) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: row.get(0)?,
        project_id: row.get(1)?,
        session_id: row.get(2)?,
        scope: row.get(3)?,
        key: row.get(4)?,
        value: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// scope 를 검증하고, session 스코프면 세션 id 를 함께 확정한다.
fn normalize_scope(
    scope: Option<&str>,
    session_id: Option<&str>,
) -> AppResult<(String, Option<String>)> {
    let scope = scope.unwrap_or("project").trim().to_lowercase();
    if !MEMORY_SCOPES.contains(&scope.as_str()) {
        return Err(AppError::invalid(format!("알 수 없는 메모리 scope: {scope}")));
    }
    if scope == "session" {
        let session_id = session_id
            .map(str::to_string)
            .ok_or_else(|| AppError::invalid("session 스코프 메모리에는 sessionId 가 필요합니다"))?;
        Ok((scope, Some(session_id)))
    } else {
        // project 스코프는 세션에 묶이지 않는다.
        Ok((scope, None))
    }
}

pub fn get_memory(
    conn: &Connection,
    project_id: &str,
    scope: &str,
    session_id: Option<&str>,
    key: &str,
) -> AppResult<Option<Memory>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memories
         WHERE project_id = ?1 AND scope = ?2 AND COALESCE(session_id, '') = COALESCE(?3, '')
           AND key = ?4"
    );
    Ok(conn
        .query_row(&sql, params![project_id, scope, session_id, key], map_memory)
        .optional()?)
}

/// 같은 (project, scope, session, key) 가 있으면 값을 덮어쓰고, 없으면 새로 만든다.
pub fn upsert_memory(
    conn: &Connection,
    project_id: &str,
    input: &NewMemory,
) -> AppResult<Memory> {
    let key = input.key.trim();
    if key.is_empty() {
        return Err(AppError::invalid("메모리 key 가 비어 있습니다"));
    }
    let (scope, session_id) = normalize_scope(input.scope.as_deref(), input.session_id.as_deref())?;
    let ts = now();

    match get_memory(conn, project_id, &scope, session_id.as_deref(), key)? {
        Some(existing) => {
            conn.execute(
                "UPDATE memories SET value = ?2, updated_at = ?3 WHERE id = ?1",
                params![existing.id, input.value, ts],
            )?;
            get_memory_by_id(conn, &existing.id)?
                .ok_or_else(|| AppError::not_found(format!("메모리 {}", existing.id)))
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO memories
                   (id, project_id, session_id, scope, key, value, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, project_id, session_id, scope, key, input.value, ts],
            )?;
            get_memory_by_id(conn, &id)?.ok_or_else(|| AppError::not_found(format!("메모리 {id}")))
        }
    }
}

pub fn get_memory_by_id(conn: &Connection, id: &str) -> AppResult<Option<Memory>> {
    let sql = format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], map_memory).optional()?)
}

/// 프로젝트 전역 메모리 + (세션을 지정했다면) 그 세션의 메모리.
pub fn list_memories(
    conn: &Connection,
    project_id: &str,
    session_id: Option<&str>,
) -> AppResult<Vec<Memory>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memories
         WHERE project_id = ?1
           AND (scope = 'project' OR (?2 IS NOT NULL AND session_id = ?2))
         ORDER BY scope, key"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![project_id, session_id], map_memory)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delete_memory(conn: &Connection, id: &str) -> AppResult<bool> {
    let affected = conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

// -------------------------------------------------------------- agent runs

const AGENT_RUN_COLUMNS: &str = "id, session_id, parent_message_id, name, task, status, progress, current_skill, result, error, token_usage, created_at, started_at, finished_at";
const AGENT_STATUSES: [&str; 5] = ["pending", "running", "succeeded", "failed", "cancelled"];
/// 실행이 끝난 상태들 — 여기 들어오면 finished_at 을 찍는다.
const AGENT_TERMINAL: [&str; 3] = ["succeeded", "failed", "cancelled"];

fn map_agent_run(row: &Row<'_>) -> rusqlite::Result<AgentRun> {
    Ok(AgentRun {
        id: row.get(0)?,
        session_id: row.get(1)?,
        parent_message_id: row.get(2)?,
        name: row.get(3)?,
        task: row.get(4)?,
        status: row.get(5)?,
        progress: row.get(6)?,
        current_skill: row.get(7)?,
        result: row.get(8)?,
        error: row.get(9)?,
        token_usage: from_text(row.get(10)?),
        created_at: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
    })
}

pub fn create_agent_run(conn: &Connection, input: &NewAgentRun) -> AppResult<AgentRun> {
    if input.name.trim().is_empty() {
        return Err(AppError::invalid("서브에이전트 이름이 비어 있습니다"));
    }

    let id = new_id();
    conn.execute(
        "INSERT INTO agent_runs
           (id, session_id, parent_message_id, name, task, status, progress, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6)",
        params![
            id,
            input.session_id,
            input.parent_message_id,
            input.name.trim(),
            input.task,
            now()
        ],
    )?;
    get_agent_run(conn, &id)?.ok_or_else(|| AppError::not_found(format!("서브에이전트 {id}")))
}

pub fn get_agent_run(conn: &Connection, id: &str) -> AppResult<Option<AgentRun>> {
    let sql = format!("SELECT {AGENT_RUN_COLUMNS} FROM agent_runs WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], map_agent_run).optional()?)
}

pub fn list_agent_runs(conn: &Connection, session_id: &str) -> AppResult<Vec<AgentRun>> {
    let sql = format!(
        "SELECT {AGENT_RUN_COLUMNS} FROM agent_runs WHERE session_id = ?1 ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![session_id], map_agent_run)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 상태 전이에 맞춰 started_at / finished_at 을 알아서 찍어 준다.
pub fn update_agent_run(conn: &Connection, id: &str, patch: &AgentRunPatch) -> AppResult<AgentRun> {
    let existing =
        get_agent_run(conn, id)?.ok_or_else(|| AppError::not_found(format!("서브에이전트 {id}")))?;

    let status = match &patch.status {
        Some(status) if !AGENT_STATUSES.contains(&status.as_str()) => {
            return Err(AppError::invalid(format!("알 수 없는 실행 상태: {status}")));
        }
        Some(status) => status.clone(),
        None => existing.status.clone(),
    };

    let progress = patch
        .progress
        .unwrap_or(existing.progress)
        .clamp(0.0, 1.0);
    let current_skill = patch.current_skill.clone().or(existing.current_skill);
    let result = patch.result.clone().or(existing.result);
    let error = patch.error.clone().or(existing.error);
    let token_usage = to_text(&patch.token_usage.clone().or(existing.token_usage));

    let started_at = match existing.started_at {
        Some(value) => Some(value),
        None if status == "running" => Some(now()),
        None => None,
    };
    let finished_at = match existing.finished_at {
        Some(value) => Some(value),
        None if AGENT_TERMINAL.contains(&status.as_str()) => Some(now()),
        None => None,
    };

    conn.execute(
        "UPDATE agent_runs SET status = ?2, progress = ?3, current_skill = ?4, result = ?5,
             error = ?6, token_usage = ?7, started_at = ?8, finished_at = ?9
         WHERE id = ?1",
        params![
            id,
            status,
            progress,
            current_skill,
            result,
            error,
            token_usage,
            started_at,
            finished_at
        ],
    )?;

    get_agent_run(conn, id)?.ok_or_else(|| AppError::not_found(format!("서브에이전트 {id}")))
}

pub fn delete_agent_run(conn: &Connection, id: &str) -> AppResult<bool> {
    let affected = conn.execute("DELETE FROM agent_runs WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

/// 앱이 비정상 종료되면 running 상태가 DB 에 그대로 남는다. 세션을 열 때 정리한다.
pub fn fail_stale_agent_runs(conn: &Connection, session_id: &str) -> AppResult<usize> {
    let affected = conn.execute(
        "UPDATE agent_runs
            SET status = 'failed', error = COALESCE(error, '앱이 종료되어 중단되었습니다'),
                finished_at = ?2
          WHERE session_id = ?1 AND status IN ('pending', 'running')",
        params![session_id, now()],
    )?;
    Ok(affected)
}
