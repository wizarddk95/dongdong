//! MCP 서버 연결 IPC.
//!
//! stdio 파이프 읽기는 블로킹이라 모두 `spawn_blocking` 워커에서 돌린다.
//! (동기 command 로 두면 서버가 느릴 때 UI 가 그대로 멈춘다 — 쉘 command 와 같은 이유)

use serde_json::Value;
use tauri::State;

use super::resolve_root;
use crate::error::{AppError, AppResult};
use crate::mcp::{McpRegistry, McpServerConfig, McpServerInfo, McpToolResult};
use crate::state::AppState;

/// 워커 스레드에서 실행하고, 패닉/취소는 에러로 바꾼다.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::invalid(format!("MCP 작업 실행 실패: {error}")))?
}

/// 서버를 띄우고 핸드셰이크 + 도구 목록까지 받아 온다.
#[tauri::command]
pub async fn mcp_connect(
    state: State<'_, AppState>,
    registry: State<'_, McpRegistry>,
    config: McpServerConfig,
    project_path: Option<String>,
) -> AppResult<McpServerInfo> {
    // cwd 를 지정하지 않았으면 열려 있는 프로젝트 루트에서 실행한다.
    let root = resolve_root(&state, project_path.as_deref())?;
    let registry = (*registry).clone();

    blocking(move || registry.connect(&config, root)).await
}

/// 도구 하나를 부른다.
///
/// `cancel_token` 은 중단용이다 — 프론트가 만들어 넘기고, 같은 값으로 `mcp_cancel_tool` 을
/// 부르면 멈춘다 (셸의 `execute_shell_command` 와 같은 모양).
#[tauri::command]
pub async fn mcp_call_tool(
    registry: State<'_, McpRegistry>,
    server_id: String,
    name: String,
    arguments: Option<Value>,
    cancel_token: Option<String>,
) -> AppResult<McpToolResult> {
    let registry = (*registry).clone();
    let arguments = arguments.unwrap_or_else(|| Value::Object(Default::default()));

    blocking(move || registry.call_tool(&server_id, &name, arguments, cancel_token.as_deref())).await
}

/// 진행 중인 도구 호출을 중단한다.
///
/// 파이프 읽기가 블로킹이라 자식 프로세스를 죽여야 읽기가 풀린다 → 그 서버 연결도 함께
/// 끊긴다. 프론트가 곧바로 다시 붙이므로 다음 턴에는 도구가 그대로 있다.
#[tauri::command]
pub fn mcp_cancel_tool(registry: State<'_, McpRegistry>, cancel_token: String) -> AppResult<bool> {
    Ok(registry.cancel(&cancel_token))
}

#[tauri::command]
pub fn mcp_disconnect(registry: State<'_, McpRegistry>, server_id: String) -> AppResult<bool> {
    registry.disconnect(&server_id)
}

#[tauri::command]
pub fn mcp_list_servers(registry: State<'_, McpRegistry>) -> AppResult<Vec<McpServerInfo>> {
    registry.list()
}

/// 서버가 stderr 로 남긴 최근 로그. 연결이 안 될 때 원인을 본다.
#[tauri::command]
pub fn mcp_server_logs(
    registry: State<'_, McpRegistry>,
    server_id: String,
) -> AppResult<Vec<String>> {
    registry.logs(&server_id)
}
