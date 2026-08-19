//! 서브에이전트 실행 기록. 대시보드가 읽고, 프론트의 실행 루프가 갱신한다.
//!
//! 실제 LLM 루프는 프론트(`store/agents.ts`)가 돌린다. 여기서는 상태를 영속화해
//! 앱을 껐다 켜도 무엇이 언제 무슨 일을 했는지 남게 하는 역할만 한다.

use tauri::State;

use crate::db::models::{AgentRun, AgentRunPatch, NewAgentRun};
use crate::db::queries;
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn create_agent_run(
    state: State<'_, AppState>,
    run: NewAgentRun,
    project_path: Option<String>,
) -> AppResult<AgentRun> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::create_agent_run(conn, &run)
    })
}

#[tauri::command]
pub fn list_agent_runs(
    state: State<'_, AppState>,
    session_id: String,
    project_path: Option<String>,
) -> AppResult<Vec<AgentRun>> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::list_agent_runs(conn, &session_id)
    })
}

#[tauri::command]
pub fn update_agent_run(
    state: State<'_, AppState>,
    run_id: String,
    patch: AgentRunPatch,
    project_path: Option<String>,
) -> AppResult<AgentRun> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::update_agent_run(conn, &run_id, &patch)
    })
}

#[tauri::command]
pub fn delete_agent_run(
    state: State<'_, AppState>,
    run_id: String,
    project_path: Option<String>,
) -> AppResult<bool> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::delete_agent_run(conn, &run_id)
    })
}

/// 앱이 죽어서 running 인 채로 남은 실행들을 실패로 정리한다. 세션을 열 때 호출한다.
#[tauri::command]
pub fn reap_agent_runs(
    state: State<'_, AppState>,
    session_id: String,
    project_path: Option<String>,
) -> AppResult<usize> {
    state.with_conn(project_path.as_deref(), |conn, _| {
        queries::fail_stale_agent_runs(conn, &session_id)
    })
}
