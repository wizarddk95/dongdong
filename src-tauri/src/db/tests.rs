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
            current_skill: Some("execute_shell_command".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(running.started_at.is_some());
    assert!(running.finished_at.is_none());
    assert_eq!(running.current_skill.as_deref(), Some("execute_shell_command"));

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
