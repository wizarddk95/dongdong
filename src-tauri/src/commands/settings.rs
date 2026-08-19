//! 앱 전역 설정 (API 키, 기본 모델 등).
//!
//! 세션/메시지 같은 작업 데이터는 프로젝트별 `.agent_workspace/local.db` 에 남지만,
//! API 키는 프로젝트가 아니라 사용자에게 속하므로 OS 앱 설정 디렉터리의
//! `settings.json` 한 곳에만 둔다. (프로젝트 DB 에 넣으면 프로젝트마다 다시 입력해야 하고,
//! 실수로 커밋될 위험도 커진다)

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::invalid(format!("앱 설정 디렉터리를 찾을 수 없습니다: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// 소유자만 읽을 수 있게 제한한다. (Windows 는 기본 ACL 로 사용자 프로필이 이미 보호된다)
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
pub fn read_app_settings(app: AppHandle) -> AppResult<Value> {
    let path = settings_path(&app)?;
    if !path.is_file() {
        return Ok(Value::Object(Default::default()));
    }
    let text = std::fs::read_to_string(&path)?;
    // 파일이 깨졌다고 앱이 못 뜨면 안 되므로 빈 설정으로 되돌린다.
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Default::default())))
}

#[tauri::command]
pub fn write_app_settings(app: AppHandle, settings: Value) -> AppResult<Value> {
    if !settings.is_object() {
        return Err(AppError::invalid("설정은 JSON 객체여야 합니다"));
    }
    let path = settings_path(&app)?;
    std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
    restrict_permissions(&path)?;
    Ok(settings)
}

/// 설정 파일 위치를 UI 에 보여주기 위한 헬퍼.
#[tauri::command]
pub fn app_settings_path(app: AppHandle) -> AppResult<String> {
    Ok(settings_path(&app)?.to_string_lossy().into_owned())
}
