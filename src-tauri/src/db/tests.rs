//! 워크스페이스 DB 스모크 테스트. `cargo test` 로 실행.

use std::path::PathBuf;

use super::models::{AgentRunPatch, NewAgentRun, NewMemory, NewMessage};
use super::{open_workspace_db, queries};
use crate::paths;

/// 테스트마다 격리된 임시 프로젝트 루트를 만든다.
struct TempProject(PathBuf);

impl TempProject {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir()
            .join("dongdong-tests")
            .join(format!("{tag}-{}", queries::new_id()));
        std::fs::create_dir_all(&root).expect("임시 프로젝트 생성 실패");
        Self(root)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn message(session_id: &str, parent_id: Option<&str>, role: &str, content: &str) -> NewMessage {
    NewMessage {
        session_id: session_id.to_string(),
        parent_id: parent_id.map(str::to_string),
        role: role.to_string(),
        content: content.to_string(),
        tool_calls: None,
        tool_results: None,
        context_snapshot: None,
        token_usage: None,
        status: None,
        agent_id: None,
    }
}

#[test]
fn creates_workspace_and_applies_migrations() {
    let project = TempProject::new("workspace");
    let conn = open_workspace_db(&project.0).expect("DB 열기 실패");

    assert!(paths::db_path(&project.0).is_file(), "local.db 가 생성되어야 한다");
    assert!(
        paths::workspace_dir(&project.0).join(".gitignore").is_file(),
        ".agent_workspace/.gitignore 가 생성되어야 한다"
    );

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, super::schema::MIGRATIONS.len() as i64);

    // 같은 폴더를 다시 열어도 마이그레이션이 중복 적용되지 않아야 한다.
    drop(conn);
    let conn = open_workspace_db(&project.0).expect("재오픈 실패");
    let version_again: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, version_again);
}

#[test]
fn stores_conversation_tree_and_walks_ancestors() {
    let project = TempProject::new("tree");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "tree").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();

    let first = queries::insert_message(&conn, &message(&session.id, None, "user", "안녕")).unwrap();
    let second =
        queries::insert_message(&conn, &message(&session.id, Some(&first.id), "assistant", "반가워"))
            .unwrap();
    let third =
        queries::insert_message(&conn, &message(&session.id, Some(&second.id), "user", "고마워"))
            .unwrap();

    // 같은 부모에서 갈라진 형제 노드 — 트리 구조가 유지되는지 확인.
    let sibling =
        queries::insert_message(&conn, &message(&session.id, Some(&first.id), "assistant", "다른 답"))
            .unwrap();

    assert_eq!(queries::list_messages(&conn, &session.id).unwrap().len(), 4);

    let ancestors = queries::message_path(&conn, &third.id).unwrap();
    let ids: Vec<&str> = ancestors.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec![first.id.as_str(), second.id.as_str(), third.id.as_str()]);

    let sibling_path = queries::message_path(&conn, &sibling.id).unwrap();
    assert_eq!(sibling_path.len(), 2, "형제 분기는 자기 조상만 따라와야 한다");
}

#[test]
fn branches_session_at_a_node() {
    let project = TempProject::new("branch");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "branch").unwrap();
    let session = queries::create_session(&conn, &record.id, "원본", None, None, None).unwrap();

    let first = queries::insert_message(&conn, &message(&session.id, None, "user", "1")).unwrap();
    let second =
        queries::insert_message(&conn, &message(&session.id, Some(&first.id), "assistant", "2"))
            .unwrap();
    let _third =
        queries::insert_message(&conn, &message(&session.id, Some(&second.id), "user", "3")).unwrap();

    // 2번 노드 시점으로 타임머신 — 3번은 복제되면 안 된다.
    let branch = queries::branch_session_at(&mut conn, &second.id, None).unwrap();

    assert_eq!(branch.parent_session_id.as_deref(), Some(session.id.as_str()));
    assert_eq!(branch.branched_from_message_id.as_deref(), Some(second.id.as_str()));

    let copied = queries::list_messages(&conn, &branch.id).unwrap();
    assert_eq!(copied.len(), 2);
    assert_eq!(copied[0].content, "1");
    assert_eq!(copied[1].content, "2");
    assert!(copied[0].parent_id.is_none(), "복제본의 루트는 부모가 없어야 한다");
    assert_eq!(
        copied[1].parent_id.as_deref(),
        Some(copied[0].id.as_str()),
        "복제본끼리 부모 관계가 재구성되어야 한다"
    );

    // 원본은 그대로.
    assert_eq!(queries::list_messages(&conn, &session.id).unwrap().len(), 3);
}

#[test]
fn deleting_a_node_removes_its_subtree() {
    let project = TempProject::new("cascade");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "cascade").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();

    let first = queries::insert_message(&conn, &message(&session.id, None, "user", "1")).unwrap();
    let second =
        queries::insert_message(&conn, &message(&session.id, Some(&first.id), "assistant", "2"))
            .unwrap();
    queries::insert_message(&conn, &message(&session.id, Some(&second.id), "user", "3")).unwrap();

    queries::delete_message(&conn, &second.id).unwrap();

    let remaining = queries::list_messages(&conn, &session.id).unwrap();
    assert_eq!(remaining.len(), 1, "하위 트리까지 함께 지워져야 한다");
    assert_eq!(remaining[0].id, first.id);
}

#[test]
fn rejects_unknown_role() {
    let project = TempProject::new("role");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "role").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();

    let result = queries::insert_message(&conn, &message(&session.id, None, "robot", "x"));
    assert!(result.is_err());
}

fn memory(scope: &str, session_id: Option<&str>, key: &str, value: &str) -> NewMemory {
    NewMemory {
        scope: Some(scope.to_string()),
        session_id: session_id.map(str::to_string),
        key: key.to_string(),
        value: value.to_string(),
    }
}

#[test]
fn upserts_memory_by_scope_and_key() {
    let project = TempProject::new("memory-upsert");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "memory").unwrap();

    let created =
        queries::upsert_memory(&conn, &record.id, &memory("project", None, "빌드", "pnpm build"))
            .unwrap();
    assert_eq!(created.scope, "project");
    assert!(created.session_id.is_none(), "project 스코프는 세션에 묶이지 않는다");

    // 같은 key 로 다시 저장하면 새 행이 아니라 값 갱신.
    let updated = queries::upsert_memory(
        &conn,
        &record.id,
        &memory("project", None, "빌드", "pnpm typecheck && pnpm build"),
    )
    .unwrap();
    assert_eq!(updated.id, created.id);
    assert_eq!(updated.value, "pnpm typecheck && pnpm build");
    assert_eq!(queries::list_memories(&conn, &record.id, None).unwrap().len(), 1);
}

#[test]
fn keeps_session_memories_separate_per_session() {
    let project = TempProject::new("memory-scope");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "memory").unwrap();
    let first = queries::create_session(&conn, &record.id, "A", None, None, None).unwrap();
    let second = queries::create_session(&conn, &record.id, "B", None, None, None).unwrap();

    queries::upsert_memory(&conn, &record.id, &memory("project", None, "규칙", "한국어")).unwrap();
    queries::upsert_memory(&conn, &record.id, &memory("session", Some(&first.id), "할일", "A 작업"))
        .unwrap();
    queries::upsert_memory(&conn, &record.id, &memory("session", Some(&second.id), "할일", "B 작업"))
        .unwrap();

    // 같은 key 라도 세션이 다르면 서로 덮어쓰지 않아야 한다 (마이그레이션 v2).
    let a = queries::list_memories(&conn, &record.id, Some(&first.id)).unwrap();
    assert_eq!(a.len(), 2, "프로젝트 메모리 + 그 세션 메모리만 보인다");
    let a_session: Vec<&str> = a
        .iter()
        .filter(|m| m.scope == "session")
        .map(|m| m.value.as_str())
        .collect();
    assert_eq!(a_session, vec!["A 작업"]);

    let global_only = queries::list_memories(&conn, &record.id, None).unwrap();
    assert_eq!(global_only.len(), 1);
    assert_eq!(global_only[0].scope, "project");
}

#[test]
fn rejects_bad_memory_input_and_deletes() {
    let project = TempProject::new("memory-invalid");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "memory").unwrap();

    assert!(
        queries::upsert_memory(&conn, &record.id, &memory("session", None, "키", "값")).is_err(),
        "session 스코프인데 sessionId 가 없으면 거부해야 한다"
    );
    assert!(
        queries::upsert_memory(&conn, &record.id, &memory("global", None, "키", "값")).is_err(),
        "알 수 없는 scope 는 거부해야 한다"
    );
    assert!(
        queries::upsert_memory(&conn, &record.id, &memory("project", None, "   ", "값")).is_err(),
        "빈 key 는 거부해야 한다"
    );

    let saved =
        queries::upsert_memory(&conn, &record.id, &memory("project", None, "키", "값")).unwrap();
    assert!(queries::delete_memory(&conn, &saved.id).unwrap());
    assert!(!queries::delete_memory(&conn, &saved.id).unwrap(), "두 번째 삭제는 false");
    assert!(queries::list_memories(&conn, &record.id, None).unwrap().is_empty());
}

#[test]
fn migrates_v1_memories_table_without_losing_rows() {
    // Phase 2 까지 쓰던 DB(v1)를 그대로 재현한 뒤 v2 로 올린다.
    let project = TempProject::new("migrate-v2");
    let db_path = paths::db_path(&project.0);
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let mut conn = rusqlite::Connection::open(&db_path).unwrap();
    super::schema::apply_pragmas(&conn).unwrap();

    conn.execute_batch(super::schema::MIGRATIONS[0]).unwrap();
    conn.pragma_update(None, "user_version", 1i64).unwrap();

    let ts = queries::now();
    conn.execute(
        "INSERT INTO projects (id, root_path, name, settings, created_at, updated_at)
         VALUES ('p1', 'C:/old', 'old', '{}', ?1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memories (id, project_id, session_id, scope, key, value, created_at, updated_at)
         VALUES ('m1', 'p1', NULL, 'project', '빌드', 'pnpm build', ?1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();

    let version = super::schema::migrate(&mut conn).unwrap();
    assert_eq!(version, super::schema::MIGRATIONS.len() as i64);

    let kept = queries::list_memories(&conn, "p1", None).unwrap();
    assert_eq!(kept.len(), 1, "기존 메모리가 그대로 남아야 한다");
    assert_eq!(kept[0].value, "pnpm build");

    // v2 의 유일 인덱스가 실제로 붙었는지 — 같은 키를 두 번 넣으면 막혀야 한다.
    let duplicated = conn.execute(
        "INSERT INTO memories (id, project_id, session_id, scope, key, value, created_at, updated_at)
         VALUES ('m2', 'p1', NULL, 'project', '빌드', '다른 값', ?1, ?1)",
        rusqlite::params![ts],
    );
    assert!(duplicated.is_err(), "같은 (project, scope, key) 는 유일해야 한다");
}

#[test]
fn migrates_v2_agent_runs_by_adding_the_token_column() {
    // 토큰 집계 이전(v2)까지 쓰던 DB 를 재현한 뒤 v3 로 올린다.
    let project = TempProject::new("migrate-v3");
    let db_path = paths::db_path(&project.0);
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let mut conn = rusqlite::Connection::open(&db_path).unwrap();
    super::schema::apply_pragmas(&conn).unwrap();

    conn.execute_batch(super::schema::MIGRATIONS[0]).unwrap();
    conn.execute_batch(super::schema::MIGRATIONS[1]).unwrap();
    conn.pragma_update(None, "user_version", 2i64).unwrap();

    let ts = queries::now();
    conn.execute(
        "INSERT INTO projects (id, root_path, name, settings, created_at, updated_at)
         VALUES ('p1', 'C:/old', 'old', '{}', ?1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, project_id, title, metadata, created_at, updated_at)
         VALUES ('s1', 'p1', '옛 세션', '{}', ?1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_runs (id, session_id, name, task, status, progress, created_at)
         VALUES ('r1', 's1', '옛 실행', '일', 'succeeded', 1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();

    let version = super::schema::migrate(&mut conn).unwrap();
    assert_eq!(version, super::schema::MIGRATIONS.len() as i64);

    // 기존 행은 그대로 남고, 새 컬럼은 비어 있다.
    let run = queries::get_agent_run(&conn, "r1").unwrap().unwrap();
    assert_eq!(run.name, "옛 실행");
    assert!(run.token_usage.is_none());

    // 토큰이 없는 옛 실행은 집계에도 잡히지 않아야 한다 (0 이 아니라 아예 없음).
    let overviews = queries::list_session_overviews(&conn, "p1").unwrap();
    assert!(overviews[0].usage_by_model.is_empty());
}

#[test]
fn migrates_v3_by_renaming_current_skill_to_current_tool() {
    // 이름을 고치기 전(v3)까지 쓰던 DB 를 재현한 뒤 v4 로 올린다.
    // 담겨 있던 값(도구 이름)은 그대로 남아야 한다 — 컬럼 이름만 바뀌는 마이그레이션이다.
    let project = TempProject::new("migrate-v4");
    let db_path = paths::db_path(&project.0);
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let mut conn = rusqlite::Connection::open(&db_path).unwrap();
    super::schema::apply_pragmas(&conn).unwrap();

    for index in 0..3 {
        conn.execute_batch(super::schema::MIGRATIONS[index]).unwrap();
    }
    conn.pragma_update(None, "user_version", 3i64).unwrap();

    let ts = queries::now();
    conn.execute(
        "INSERT INTO projects (id, root_path, name, settings, created_at, updated_at)
         VALUES ('p1', 'C:/old', 'old', '{}', ?1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, project_id, title, metadata, created_at, updated_at)
         VALUES ('s1', 'p1', '옛 세션', '{}', ?1, ?1)",
        rusqlite::params![ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_runs (id, session_id, name, task, status, progress, current_skill, created_at)
         VALUES ('r1', 's1', '옛 실행', '일', 'running', 0.5, 'read_file', ?1)",
        rusqlite::params![ts],
    )
    .unwrap();

    let version = super::schema::migrate(&mut conn).unwrap();
    assert_eq!(version, super::schema::MIGRATIONS.len() as i64);

    let run = queries::get_agent_run(&conn, "r1").unwrap().unwrap();
    assert_eq!(run.current_tool.as_deref(), Some("read_file"));
}

#[test]
fn tracks_agent_run_lifecycle() {
    let project = TempProject::new("agent-run");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "agent").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();
    let anchor = queries::insert_message(&conn, &message(&session.id, None, "assistant", "위임")).unwrap();

    let run = queries::create_agent_run(
        &conn,
        &NewAgentRun {
            session_id: session.id.clone(),
            parent_message_id: Some(anchor.id.clone()),
            name: "테스트 러너".into(),
            task: "테스트를 돌리고 실패 원인을 찾아라".into(),
        },
    )
    .unwrap();

    assert_eq!(run.status, "pending");
    assert_eq!(run.progress, 0.0);
    assert!(run.started_at.is_none() && run.finished_at.is_none());

    // 실행 시작 — started_at 이 자동으로 찍혀야 한다.
    let running = queries::update_agent_run(
        &conn,
        &run.id,
        &AgentRunPatch {
            status: Some("running".into()),
            progress: Some(0.5),
            current_tool: Some("execute_shell_command".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(running.started_at.is_some());
    assert!(running.finished_at.is_none());
    assert_eq!(running.current_tool.as_deref(), Some("execute_shell_command"));

    // 종료 — finished_at 이 찍히고 결과가 남는다.
    let done = queries::update_agent_run(
        &conn,
        &run.id,
        &AgentRunPatch {
            status: Some("succeeded".into()),
            progress: Some(1.0),
            result: Some("3건 실패, 원인은 타임존".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(done.finished_at.is_some());
    assert_eq!(done.result.as_deref(), Some("3건 실패, 원인은 타임존"));

    assert_eq!(queries::list_agent_runs(&conn, &session.id).unwrap().len(), 1);
    assert!(queries::delete_agent_run(&conn, &run.id).unwrap());
    assert!(queries::list_agent_runs(&conn, &session.id).unwrap().is_empty());
}

#[test]
fn rejects_unknown_status_and_clamps_progress() {
    let project = TempProject::new("agent-status");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "agent").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();

    let run = queries::create_agent_run(
        &conn,
        &NewAgentRun {
            session_id: session.id.clone(),
            parent_message_id: None,
            name: "러너".into(),
            task: "일".into(),
        },
    )
    .unwrap();

    assert!(queries::update_agent_run(
        &conn,
        &run.id,
        &AgentRunPatch { status: Some("zombie".into()), ..Default::default() },
    )
    .is_err());

    let clamped = queries::update_agent_run(
        &conn,
        &run.id,
        &AgentRunPatch { progress: Some(7.5), ..Default::default() },
    )
    .unwrap();
    assert_eq!(clamped.progress, 1.0);

    assert!(
        queries::create_agent_run(
            &conn,
            &NewAgentRun {
                session_id: session.id.clone(),
                parent_message_id: None,
                name: "  ".into(),
                task: "일".into(),
            }
        )
        .is_err(),
        "이름이 비면 거부해야 한다"
    );
}

#[test]
fn reaps_runs_left_behind_by_a_crash() {
    let project = TempProject::new("agent-reap");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "agent").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();

    let new_run = |name: &str| NewAgentRun {
        session_id: session.id.clone(),
        parent_message_id: None,
        name: name.to_string(),
        task: "일".into(),
    };

    let pending = queries::create_agent_run(&conn, &new_run("대기")).unwrap();
    let running = queries::create_agent_run(&conn, &new_run("진행")).unwrap();
    queries::update_agent_run(
        &conn,
        &running.id,
        &AgentRunPatch { status: Some("running".into()), ..Default::default() },
    )
    .unwrap();
    let done = queries::create_agent_run(&conn, &new_run("완료")).unwrap();
    queries::update_agent_run(
        &conn,
        &done.id,
        &AgentRunPatch { status: Some("succeeded".into()), ..Default::default() },
    )
    .unwrap();

    // 앱이 죽었다 켜진 상황 — 끝나지 않은 것만 실패로 정리된다.
    assert_eq!(queries::fail_stale_agent_runs(&conn, &session.id).unwrap(), 2);

    assert_eq!(queries::get_agent_run(&conn, &pending.id).unwrap().unwrap().status, "failed");
    assert_eq!(queries::get_agent_run(&conn, &running.id).unwrap().unwrap().status, "failed");
    assert_eq!(queries::get_agent_run(&conn, &done.id).unwrap().unwrap().status, "succeeded");
}

#[test]
fn summarizes_sessions_with_counts_and_preview() {
    let project = TempProject::new("overview");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "overview").unwrap();
    let empty = queries::create_session(&conn, &record.id, "빈 세션", None, None, None).unwrap();
    let talking = queries::create_session(&conn, &record.id, "대화", None, None, None).unwrap();

    let first =
        queries::insert_message(&conn, &message(&talking.id, None, "user", "첫 질문")).unwrap();
    let second = queries::insert_message(
        &conn,
        &message(&talking.id, Some(&first.id), "assistant", "답변"),
    )
    .unwrap();
    queries::insert_message(&conn, &message(&talking.id, Some(&second.id), "user", "두 번째"))
        .unwrap();

    queries::create_agent_run(
        &conn,
        &NewAgentRun {
            session_id: talking.id.clone(),
            parent_message_id: Some(second.id.clone()),
            name: "탐색".into(),
            task: "폴더를 훑어봐".into(),
        },
    )
    .unwrap();

    // 분기 세션도 목록에 함께 나와야 한다.
    let branch = queries::branch_session_at(&mut conn, &second.id, Some("분기")).unwrap();

    let overviews = queries::list_session_overviews(&conn, &record.id).unwrap();
    assert_eq!(overviews.len(), 3);

    let by_id = |id: &str| {
        overviews
            .iter()
            .find(|item| item.session.id == id)
            .expect("세션이 목록에 있어야 한다")
    };

    let empty_row = by_id(&empty.id);
    assert_eq!(empty_row.message_count, 0);
    assert!(empty_row.last_message_at.is_none());
    assert!(empty_row.preview.is_none());
    assert_eq!(empty_row.agent_run_count, 0);

    let talking_row = by_id(&talking.id);
    assert_eq!(talking_row.message_count, 3);
    assert_eq!(talking_row.preview.as_deref(), Some("첫 질문"), "첫 user 메시지가 미리보기");
    assert!(talking_row.last_message_at.is_some());
    assert_eq!(talking_row.agent_run_count, 1);

    let branch_row = by_id(&branch.id);
    assert_eq!(branch_row.message_count, 2, "분기 세션은 복제된 노드를 갖는다");
    assert_eq!(
        branch_row.session.parent_session_id.as_deref(),
        Some(talking.id.as_str())
    );
    assert_eq!(
        branch_row.session.branched_from_message_id.as_deref(),
        Some(second.id.as_str())
    );
}

/// 노드에 붙일 usage JSON. 프론트의 `StoredUsage` 와 같은 모양이다.
fn usage(model_id: &str, input: i64, cache_read: i64, output: i64) -> serde_json::Value {
    serde_json::json!({
        "modelId": model_id,
        "inputTokens": input,
        "cacheReadTokens": cache_read,
        "cacheWriteTokens": 0,
        "outputTokens": output,
        "reasoningTokens": 0,
        "totalTokens": input + output,
    })
}

#[test]
fn aggregates_session_tokens_per_model() {
    let project = TempProject::new("tokens");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "tokens").unwrap();
    let session = queries::create_session(&conn, &record.id, "비용", None, None, None).unwrap();

    let ask = queries::insert_message(&conn, &message(&session.id, None, "user", "질문")).unwrap();

    let mut answer = message(&session.id, Some(&ask.id), "assistant", "답");
    answer.token_usage = Some(usage("anthropic:claude-opus-5", 1_000, 400, 200));
    let answer = queries::insert_message(&conn, &answer).unwrap();

    // 같은 모델의 두 번째 호출은 한 줄로 합쳐져야 한다.
    let mut again = message(&session.id, Some(&answer.id), "assistant", "또 답");
    again.token_usage = Some(usage("anthropic:claude-opus-5", 500, 0, 100));
    let again = queries::insert_message(&conn, &again).unwrap();

    // 모델이 다르면 줄이 갈린다 (단가가 다르니 합치면 안 된다).
    let mut cheap = message(&session.id, Some(&again.id), "assistant", "싼 모델");
    cheap.token_usage = Some(usage("anthropic:claude-sonnet-5", 30, 0, 10));
    queries::insert_message(&conn, &cheap).unwrap();

    // 서브에이전트도 자기 몫을 낸다 — 대화 트리에는 노드가 없다.
    let run = queries::create_agent_run(
        &conn,
        &NewAgentRun {
            session_id: session.id.clone(),
            parent_message_id: Some(answer.id.clone()),
            name: "탐색".into(),
            task: "훑어봐".into(),
        },
    )
    .unwrap();
    queries::update_agent_run(
        &conn,
        &run.id,
        &AgentRunPatch {
            status: Some("succeeded".into()),
            token_usage: Some(usage("anthropic:claude-opus-5", 200, 0, 50)),
            ..Default::default()
        },
    )
    .unwrap();

    let overviews = queries::list_session_overviews(&conn, &record.id).unwrap();
    let row = &overviews[0];

    assert_eq!(row.usage_by_model.len(), 2, "모델별로 나뉜다");

    let opus = &row.usage_by_model[0];
    assert_eq!(opus.model_id.as_deref(), Some("anthropic:claude-opus-5"));
    assert_eq!(opus.calls, 3, "메인 턴 2 + 위임 1");
    assert_eq!(opus.input_tokens, 1_700);
    assert_eq!(opus.cache_read_tokens, 400);
    assert_eq!(opus.output_tokens, 350);

    let sonnet = &row.usage_by_model[1];
    assert_eq!(sonnet.model_id.as_deref(), Some("anthropic:claude-sonnet-5"));
    assert_eq!(sonnet.calls, 1);
    assert_eq!(sonnet.input_tokens, 30);

    // 컨텍스트 잔량은 가장 최근 호출을 기준으로 잡는다.
    assert_eq!(
        row.last_usage_model.as_deref(),
        Some("anthropic:claude-sonnet-5")
    );
    let last = row.last_usage.as_ref().expect("마지막 usage 가 있어야 한다");
    assert_eq!(last["inputTokens"], 30);
}

#[test]
fn falls_back_to_the_snapshot_model_for_older_nodes() {
    let project = TempProject::new("tokens-legacy");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "tokens-legacy").unwrap();
    let session = queries::create_session(&conn, &record.id, "옛 기록", None, None, None).unwrap();

    // usage 에 modelId 를 안 박던 시절의 노드: 모델은 컨텍스트 스냅샷에만 남아 있고
    // 캐시 읽기는 `cachedInputTokens` 라는 옛 이름을 쓴다.
    let mut old = message(&session.id, None, "assistant", "옛 답");
    old.context_snapshot = Some(serde_json::json!({ "modelId": "anthropic:claude-sonnet-5" }));
    old.token_usage = Some(serde_json::json!({
        "inputTokens": 900,
        "cachedInputTokens": 300,
        "outputTokens": 40,
    }));
    queries::insert_message(&conn, &old).unwrap();

    let overviews = queries::list_session_overviews(&conn, &record.id).unwrap();
    let usage = &overviews[0].usage_by_model[0];
    assert_eq!(usage.model_id.as_deref(), Some("anthropic:claude-sonnet-5"));
    assert_eq!(usage.input_tokens, 900);
    assert_eq!(usage.cache_read_tokens, 300, "옛 이름도 읽어야 한다");
    assert_eq!(usage.cache_write_tokens, 0);
}

#[test]
fn truncates_long_session_preview() {
    let project = TempProject::new("preview");
    let conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "preview").unwrap();
    let session = queries::create_session(&conn, &record.id, "긴 질문", None, None, None).unwrap();

    // 한글이 섞여도 문자 경계에서 잘려야 한다 (바이트 슬라이스면 패닉).
    let long = "가".repeat(300);
    queries::insert_message(&conn, &message(&session.id, None, "user", &long)).unwrap();

    let overviews = queries::list_session_overviews(&conn, &record.id).unwrap();
    let preview = overviews[0].preview.as_deref().unwrap();
    assert_eq!(preview.chars().count(), 120);
}

/// 삭제/복사 테스트가 공유하는 밑그림 — 한 줄기로 이어진 세 턴.
/// (u1 → a1 → u2 → a2 → u3 → a3)
fn linear_session(conn: &rusqlite::Connection, tag: &str) -> (String, Vec<super::models::Message>) {
    let record = queries::upsert_project(conn, tag, tag).unwrap();
    let session = queries::create_session(conn, &record.id, "세션", None, None, None).unwrap();

    let mut nodes: Vec<super::models::Message> = Vec::new();
    for (role, content) in [
        ("user", "질문1"),
        ("assistant", "답1"),
        ("user", "질문2"),
        ("assistant", "답2"),
        ("user", "질문3"),
        ("assistant", "답3"),
    ] {
        let parent = nodes.last().map(|m| m.id.clone());
        nodes.push(
            queries::insert_message(
                conn,
                &message(&session.id, parent.as_deref(), role, content),
            )
            .unwrap(),
        );
    }
    (session.id, nodes)
}

#[test]
fn deletes_one_turn_and_stitches_the_rest_back_together() {
    let project = TempProject::new("delete-solo");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();
    let (session_id, nodes) = linear_session(&conn, &root_path);

    // 가운데 턴(u2 + a2)만 도려낸다.
    let doomed = vec![nodes[2].id.clone(), nodes[3].id.clone()];
    let outcome = queries::delete_messages(&mut conn, &doomed, false).unwrap();

    assert_eq!(outcome.removed.len(), 2);
    assert_eq!(outcome.reattached.len(), 1);
    assert_eq!(outcome.reattached[0].message_id, nodes[4].id);
    assert_eq!(
        outcome.reattached[0].to_parent_id.as_deref(),
        Some(nodes[1].id.as_str()),
        "다음 턴은 지워진 턴의 부모에 이어 붙어야 한다"
    );

    let left = queries::list_messages(&conn, &session_id).unwrap();
    assert_eq!(left.len(), 4, "뒤에 이어지던 턴은 살아남아야 한다");
    let u3 = left.iter().find(|m| m.id == nodes[4].id).unwrap();
    assert_eq!(u3.parent_id.as_deref(), Some(nodes[1].id.as_str()));

    // 되돌리면 원래 id·부모가 그대로 돌아온다.
    let restored = queries::restore_messages(&mut conn, &outcome).unwrap();
    assert_eq!(restored, 2);

    let back = queries::list_messages(&conn, &session_id).unwrap();
    assert_eq!(back.len(), 6);
    let u3 = back.iter().find(|m| m.id == nodes[4].id).unwrap();
    assert_eq!(u3.parent_id.as_deref(), Some(nodes[3].id.as_str()));
    let a2 = back.iter().find(|m| m.id == nodes[3].id).unwrap();
    assert_eq!(a2.content, "답2");
    assert_eq!(a2.seq, nodes[3].seq);

    // 같은 되돌리기를 두 번 적용하면 노드가 두 벌 생긴다 → 막아야 한다.
    assert!(queries::restore_messages(&mut conn, &outcome).is_err());
}

#[test]
fn cascade_delete_takes_the_whole_subtree() {
    let project = TempProject::new("delete-cascade");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();
    let (session_id, nodes) = linear_session(&conn, &root_path);

    let outcome =
        queries::delete_messages(&mut conn, &[nodes[2].id.clone(), nodes[3].id.clone()], true)
            .unwrap();

    assert_eq!(outcome.removed.len(), 4, "아래 턴까지 함께 지워야 한다");
    assert!(outcome.reattached.is_empty());
    assert_eq!(queries::list_messages(&conn, &session_id).unwrap().len(), 2);

    queries::restore_messages(&mut conn, &outcome).unwrap();
    assert_eq!(queries::list_messages(&conn, &session_id).unwrap().len(), 6);
}

#[test]
fn refuses_a_delete_that_would_leave_two_roots() {
    let project = TempProject::new("delete-root");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "root").unwrap();
    let session = queries::create_session(&conn, &record.id, "세션", None, None, None).unwrap();

    // 루트 하나에서 두 갈래가 갈라진 모양.
    let root = queries::insert_message(&conn, &message(&session.id, None, "user", "뿌리")).unwrap();
    let left =
        queries::insert_message(&conn, &message(&session.id, Some(&root.id), "user", "왼쪽"))
            .unwrap();
    let right = queries::insert_message(
        &conn,
        &message(&session.id, Some(&root.id), "user", "오른쪽"),
    )
    .unwrap();

    let blocked = queries::delete_messages(&mut conn, &[root.id.clone()], false);
    assert!(
        blocked.is_err(),
        "루트를 지우면 뿌리가 둘이 되는 삭제는 거절해야 한다"
    );
    assert_eq!(queries::list_messages(&conn, &session.id).unwrap().len(), 3);

    // 갈래가 하나면 그 자식이 새 뿌리가 되므로 허용된다.
    queries::delete_messages(&mut conn, &[right.id], true).unwrap();
    queries::delete_messages(&mut conn, &[root.id], false).unwrap();
    let left_now = queries::get_message(&conn, &left.id).unwrap().unwrap();
    assert_eq!(left_now.parent_id, None);
}

#[test]
fn keeps_agent_runs_but_relinks_them_on_undo() {
    let project = TempProject::new("delete-runs");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();
    let (session_id, nodes) = linear_session(&conn, &root_path);

    let run = queries::create_agent_run(
        &conn,
        &NewAgentRun {
            session_id: session_id.clone(),
            parent_message_id: Some(nodes[3].id.clone()),
            name: "조사".into(),
            task: "일".into(),
        },
    )
    .unwrap();

    let outcome = queries::delete_messages(
        &mut conn,
        &[nodes[2].id.clone(), nodes[3].id.clone()],
        false,
    )
    .unwrap();
    assert_eq!(outcome.detached_runs.len(), 1);

    // 실제로 쓴 토큰이므로 기록 자체는 남기고 링크만 끊는다.
    let detached = queries::get_agent_run(&conn, &run.id).unwrap().unwrap();
    assert_eq!(detached.parent_message_id, None);

    queries::restore_messages(&mut conn, &outcome).unwrap();
    let relinked = queries::get_agent_run(&conn, &run.id).unwrap().unwrap();
    assert_eq!(
        relinked.parent_message_id.as_deref(),
        Some(nodes[3].id.as_str())
    );
}

#[test]
fn copies_a_turn_without_carrying_its_usage() {
    let project = TempProject::new("copy");
    let mut conn = open_workspace_db(&project.0).unwrap();
    let root_path = project.0.to_string_lossy().into_owned();

    let record = queries::upsert_project(&conn, &root_path, "copy").unwrap();
    let source = queries::create_session(&conn, &record.id, "원본", None, None, None).unwrap();
    let target = queries::create_session(&conn, &record.id, "대상", None, None, None).unwrap();

    let ask = queries::insert_message(&conn, &message(&source.id, None, "user", "질문")).unwrap();
    let answer = queries::insert_message(
        &conn,
        &NewMessage {
            context_snapshot: Some(serde_json::json!({ "modelId": "anthropic:x" })),
            token_usage: Some(serde_json::json!({ "inputTokens": 100, "outputTokens": 20 })),
            status: Some("streaming".into()),
            ..message(&source.id, Some(&ask.id), "assistant", "답")
        },
    )
    .unwrap();

    // 다른 세션의 뿌리로 붙여넣는다 (세션이 비어 있으므로 붙일 자리가 없어도 된다).
    let copies = queries::copy_messages(
        &mut conn,
        &[ask.id.clone(), answer.id.clone()],
        None,
        &target.id,
    )
    .unwrap();

    assert_eq!(copies.len(), 2);
    assert_ne!(copies[0].id, ask.id, "복사본은 새 id 를 받는다");
    assert_eq!(copies[0].parent_id, None);
    assert_eq!(copies[1].parent_id.as_deref(), Some(copies[0].id.as_str()));
    assert_eq!(copies[1].content, "답");
    assert!(copies[1].token_usage.is_none(), "토큰은 복제하지 않는다");
    assert!(copies[1].context_snapshot.is_none());
    assert_eq!(
        copies[1].status, "aborted",
        "흐르다 만 노드는 중단으로 굳힌다"
    );

    // 원본은 그대로.
    assert_eq!(queries::list_messages(&conn, &source.id).unwrap().len(), 2);

    // 이미 대화가 있는 세션에 뿌리를 하나 더 만들 수는 없다.
    let blocked = queries::copy_messages(&mut conn, &[ask.id.clone()], None, &target.id);
    assert!(blocked.is_err());

    // 자리를 고르면 그 뒤에 이어 붙는다.
    let appended =
        queries::copy_messages(&mut conn, &[ask.id], Some(&copies[1].id), &target.id).unwrap();
    assert_eq!(
        appended[0].parent_id.as_deref(),
        Some(copies[1].id.as_str())
    );
    assert_eq!(queries::list_messages(&conn, &target.id).unwrap().len(), 3);
}
