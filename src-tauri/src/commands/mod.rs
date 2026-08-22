pub mod agent;
pub mod fs;
pub mod mcp;
pub mod memory;
pub mod session;
pub mod settings;
pub mod shell;
pub mod skills;
pub mod workspace;

use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 경로 제한에 쓸 프로젝트 루트를 찾는다.
///
/// - `project_path` 를 명시했는데 열려 있지 않으면 에러.
/// - 생략했고 활성 프로젝트도 없으면 `None` (= 루트 제한 없음).
pub fn resolve_root(
    state: &State<'_, AppState>,
    project_path: Option<&str>,
) -> AppResult<Option<PathBuf>> {
    match state.root_of(project_path) {
        Ok(root) => Ok(Some(root)),
        Err(AppError::NoProject(_)) if project_path.is_none() => Ok(None),
        Err(other) => Err(other),
    }
}
