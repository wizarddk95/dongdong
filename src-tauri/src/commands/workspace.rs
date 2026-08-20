//! 프로젝트(워크스페이스) 열기/닫기. `.agent_workspace/local.db` 수명 주기를 관리한다.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::{self, models::Project, models::SessionOverview, queries};
use crate::error::{AppError, AppResult};
use crate::paths;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResult {
    pub project: Project,
    pub workspace_dir: String,
    pub db_path: String,
    pub schema_version: i64,
    pub sessions: Vec<SessionOverview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub default_shell: String,
    pub path_separator: String,
    pub home_dir: Option<String>,
    pub cwd: String,
}

/// 폴더를 프로젝트로 연다. 없으면 `.agent_workspace/local.db` 를 새로 만든다.
#[tauri::command]
pub fn open_project(state: State<'_, AppState>, path: String) -> AppResult<OpenProjectResult> {
    let root = paths::absolutize(&path)?;
    if !root.is_dir() {
        return Err(AppError::not_found(format!(
            "프로젝트 폴더 {}",
            root.display()
        )));
    }

    let conn = db::open_workspace_db(&root)?;
    let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    let root_path = root.to_string_lossy().into_owned();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_path.clone());

    let project = queries::upsert_project(&conn, &root_path, &name)?;
    let sessions = queries::list_session_overviews(&conn, &project.id)?;

    let workspace_dir = paths::workspace_dir(&root).to_string_lossy().into_owned();
    let db_path = paths::db_path(&root).to_string_lossy().into_owned();

    // 커넥션 소유권을 상태로 넘긴다.
    conn.execute_batch("PRAGMA optimize;")?;
    state.insert(root, project.clone(), conn)?;

    Ok(OpenProjectResult {
        project,
        workspace_dir,
        db_path,
        schema_version,
        sessions,
    })
}

#[tauri::command]
pub fn close_project(state: State<'_, AppState>, path: String) -> AppResult<bool> {
    state.close(&path)
}

#[tauri::command]
pub fn set_active_project(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.set_active(&path)
}

#[tauri::command]
pub fn list_open_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    state.list_projects()
}

#[tauri::command]
pub fn get_active_project(state: State<'_, AppState>) -> AppResult<Option<Project>> {
    state.active_project()
}

#[tauri::command]
pub fn update_project_settings(
    state: State<'_, AppState>,
    settings: Value,
    project_path: Option<String>,
) -> AppResult<Project> {
    state.with(project_path.as_deref(), |ws| {
        queries::update_project_settings(&ws.conn, &ws.project.id, &settings)?;
        ws.project.settings = settings;
        Ok(ws.project.clone())
    })
}

/// UI 가 OS 별 안내(쉘 종류, 경로 구분자 등)를 표시할 때 사용한다.
#[tauri::command]
pub fn system_info() -> AppResult<SystemInfo> {
    let default_shell = if cfg!(windows) {
        "cmd"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "sh"
    };

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        default_shell: default_shell.to_string(),
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
        home_dir: home,
        cwd: std::env::current_dir()?.to_string_lossy().into_owned(),
    })
}
