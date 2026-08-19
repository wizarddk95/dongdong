//! 에이전트 메모리 CRUD. `remember` / `recall` 스킬과 메모리 인스펙터의 백엔드.

use tauri::State;

use crate::db::models::{Memory, NewMemory};
use crate::db::queries;
use crate::error::AppResult;
use crate::state::AppState;

/// 같은 (scope, session, key) 가 있으면 값을 덮어쓴다.
#[tauri::command]
pub fn upsert_memory(
    state: State<'_, AppState>,
    memory: NewMemory,
    project_path: Option<String>,
) -> AppResult<Memory> {
    state.with_conn(project_path.as_deref(), |conn, project| {
        queries::upsert_memory(conn, &project.id, &memory)
    })
}

/// 프로젝트 전역 메모리 + (세션을 넘겼다면) 그 세션 전용 메모리.
#[tauri::command]
pub fn list_memories(
    state: State<'_, AppState>,
    session_id: Option<String>,
    project_path: Option<String>,
) -> AppResult<Vec<Memory>> {
    state.with_conn(project_path.as_deref(), |conn, project| {
        queries::list_memories(conn, &project.id, session_id.as_deref())
    })
}

#[tauri::command]
pub fn get_memory(
    state: State<'_, AppState>,
    key: String,
    scope: Option<String>,
    session_id: Option<String>,
    project_path: Option<String>,
) -> AppResult<Option<Memory>> {
    state.with_conn(project_path.as_deref(), |conn, project| {
        let scope = scope.unwrap_or_else(|| String::from("project"));
        queries::get_memory(conn, &project.id, &scope, session_id.as_deref(), &key)
    })
}

#[tauri::command]
pub fn delete_memory(
    state: State<'_, AppState>,
    memory_id: String,
    project_path: Option<String>,
) -> AppResult<bool> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::delete_memory(conn, &memory_id)
    })
}
