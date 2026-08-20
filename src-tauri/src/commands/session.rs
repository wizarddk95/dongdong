//! 세션 / 메시지(노드) CRUD. 대화 트리와 분기(타임머신)의 백엔드.

use tauri::State;

use crate::db::models::{Message, MessagePatch, NewMessage, Session, SessionOverview};
use crate::db::queries;
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn create_session(
    state: State<'_, AppState>,
    title: Option<String>,
    model: Option<String>,
    project_path: Option<String>,
) -> AppResult<Session> {
    state.with_conn(project_path.as_deref(), |conn, project| {
        queries::create_session(
            conn,
            &project.id,
            title.as_deref().unwrap_or("New Session"),
            model.as_deref(),
            None,
            None,
        )
    })
}

/// 세션 목록. 카드 표시에 필요한 집계(노드 수 · 마지막 활동 · 미리보기)까지 함께 내려준다.
#[tauri::command]
pub fn list_sessions(
    state: State<'_, AppState>,
    project_path: Option<String>,
) -> AppResult<Vec<SessionOverview>> {
    state.with_conn(project_path.as_deref(), |conn, project| {
        queries::list_session_overviews(conn, &project.id)
    })
}

#[tauri::command]
pub fn get_session(
    state: State<'_, AppState>,
    session_id: String,
    project_path: Option<String>,
) -> AppResult<Option<Session>> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::get_session(conn, &session_id)
    })
}

#[tauri::command]
pub fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    project_path: Option<String>,
) -> AppResult<()> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::rename_session(conn, &session_id, &title)
    })
}

#[tauri::command]
pub fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
    project_path: Option<String>,
) -> AppResult<()> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::delete_session(conn, &session_id)
    })
}

/// 대화 트리에 노드를 추가한다. `parentId` 가 곧 트리 구조.
#[tauri::command]
pub fn append_message(
    state: State<'_, AppState>,
    message: NewMessage,
    project_path: Option<String>,
) -> AppResult<Message> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::insert_message(conn, &message)
    })
}

#[tauri::command]
pub fn list_messages(
    state: State<'_, AppState>,
    session_id: String,
    project_path: Option<String>,
) -> AppResult<Vec<Message>> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::list_messages(conn, &session_id)
    })
}

/// 루트 → 해당 노드까지의 경로. LLM 에 보낼 컨텍스트를 만들 때 쓴다.
#[tauri::command]
pub fn get_message_path(
    state: State<'_, AppState>,
    message_id: String,
    project_path: Option<String>,
) -> AppResult<Vec<Message>> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::message_path(conn, &message_id)
    })
}

#[tauri::command]
pub fn update_message(
    state: State<'_, AppState>,
    message_id: String,
    patch: MessagePatch,
    project_path: Option<String>,
) -> AppResult<Message> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::update_message(conn, &message_id, &patch)
    })
}

#[tauri::command]
pub fn delete_message(
    state: State<'_, AppState>,
    message_id: String,
    project_path: Option<String>,
) -> AppResult<()> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::delete_message(conn, &message_id)
    })
}

/// 타임머신: 특정 노드 시점의 대화를 복제한 새 브랜치 세션을 만든다.
#[tauri::command]
pub fn branch_session(
    state: State<'_, AppState>,
    message_id: String,
    title: Option<String>,
    project_path: Option<String>,
) -> AppResult<Session> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::branch_session_at(conn, &message_id, title.as_deref())
    })
}
