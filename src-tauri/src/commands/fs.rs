//! 파일 I/O IPC. 프로젝트가 열려 있으면 해당 루트 밖으로 나가지 못하도록 막는다.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use super::resolve_root;
use crate::error::{AppError, AppResult};
use crate::paths;
use crate::state::AppState;

/// 한 번에 읽어 들일 최대 크기 (약 2MB). 넘으면 잘라서 돌려준다.
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub relative_path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub relative_path: String,
    pub bytes_written: usize,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
}

fn resolve(
    state: &State<'_, AppState>,
    project_path: Option<&str>,
    path: &str,
) -> AppResult<(PathBuf, Option<PathBuf>)> {
    let root = resolve_root(state, project_path)?;
    let root_str = root.as_ref().map(|r| r.to_string_lossy().into_owned());
    let resolved = paths::resolve_within(root_str.as_deref(), path)?;
    Ok((resolved, root))
}

fn relative(root: &Option<PathBuf>, path: &PathBuf) -> String {
    match root {
        Some(root) => paths::relative_display(root, path),
        None => path.to_string_lossy().replace('\\', "/"),
    }
}

fn modified_at(meta: &std::fs::Metadata) -> Option<String> {
    let modified = meta.modified().ok()?;
    let datetime: time::OffsetDateTime = modified.into();
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// 텍스트 파일을 읽는다. 바이너리는 내용 없이 메타데이터만 돌려준다.
#[tauri::command]
pub fn read_file(
    state: State<'_, AppState>,
    path: String,
    project_path: Option<String>,
) -> AppResult<FileContent> {
    let (resolved, root) = resolve(&state, project_path.as_deref(), &path)?;

    let meta = std::fs::metadata(&resolved)
        .map_err(|_| AppError::not_found(resolved.display().to_string()))?;
    if meta.is_dir() {
        return Err(AppError::invalid(format!(
            "{} 은(는) 디렉터리입니다",
            resolved.display()
        )));
    }

    let bytes = std::fs::read(&resolved)?;
    let is_binary = bytes.iter().take(8_000).any(|b| *b == 0);
    let truncated = bytes.len() > MAX_READ_BYTES;

    let content = if is_binary {
        String::new()
    } else {
        let slice = if truncated {
            &bytes[..MAX_READ_BYTES]
        } else {
            &bytes[..]
        };
        String::from_utf8_lossy(slice).into_owned()
    };

    Ok(FileContent {
        relative_path: relative(&root, &resolved),
        path: resolved.to_string_lossy().into_owned(),
        content,
        size: meta.len(),
        truncated,
        is_binary,
    })
}

/// 파일을 쓴다. 기본적으로 상위 디렉터리를 자동 생성한다.
#[tauri::command]
pub fn write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    project_path: Option<String>,
    create_dirs: Option<bool>,
    append: Option<bool>,
) -> AppResult<WriteResult> {
    let (resolved, root) = resolve(&state, project_path.as_deref(), &path)?;
    let existed = resolved.exists();

    if create_dirs.unwrap_or(true) {
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }

    if append.unwrap_or(false) {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&resolved)?;
        file.write_all(content.as_bytes())?;
    } else {
        std::fs::write(&resolved, content.as_bytes())?;
    }

    Ok(WriteResult {
        relative_path: relative(&root, &resolved),
        path: resolved.to_string_lossy().into_owned(),
        bytes_written: content.as_bytes().len(),
        created: !existed,
    })
}

/// 디렉터리 목록. `path` 를 생략하면 프로젝트 루트를 본다.
#[tauri::command]
pub fn list_directory(
    state: State<'_, AppState>,
    path: Option<String>,
    project_path: Option<String>,
    include_hidden: Option<bool>,
) -> AppResult<Vec<DirEntry>> {
    let target = path.unwrap_or_else(|| ".".to_string());
    let (resolved, root) = resolve(&state, project_path.as_deref(), &target)?;

    if !resolved.is_dir() {
        return Err(AppError::not_found(format!(
            "디렉터리 {}",
            resolved.display()
        )));
    }

    let include_hidden = include_hidden.unwrap_or(false);
    let mut entries = Vec::new();

    for entry in std::fs::read_dir(&resolved)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }

        let meta = entry.metadata()?;
        let entry_path = entry.path();
        entries.push(DirEntry {
            relative_path: relative(&root, &entry_path),
            path: entry_path.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.len(),
            modified: modified_at(&meta),
            name,
        });
    }

    // 디렉터리 우선, 그다음 이름순.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub fn create_directory(
    state: State<'_, AppState>,
    path: String,
    project_path: Option<String>,
) -> AppResult<String> {
    let (resolved, _) = resolve(&state, project_path.as_deref(), &path)?;
    std::fs::create_dir_all(&resolved)?;
    Ok(resolved.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_path(
    state: State<'_, AppState>,
    path: String,
    project_path: Option<String>,
    recursive: Option<bool>,
) -> AppResult<bool> {
    let (resolved, root) = resolve(&state, project_path.as_deref(), &path)?;

    // 프로젝트 루트 자체를 지우는 사고를 막는다.
    if let Some(root) = &root {
        if paths::compare_key(root) == paths::compare_key(&resolved) {
            return Err(AppError::PathDenied(
                "프로젝트 루트는 삭제할 수 없습니다".to_string(),
            ));
        }
    }

    if !resolved.exists() {
        return Ok(false);
    }

    if resolved.is_dir() {
        if recursive.unwrap_or(false) {
            std::fs::remove_dir_all(&resolved)?;
        } else {
            std::fs::remove_dir(&resolved)?;
        }
    } else {
        std::fs::remove_file(&resolved)?;
    }
    Ok(true)
}

#[tauri::command]
pub fn path_info(
    state: State<'_, AppState>,
    path: String,
    project_path: Option<String>,
) -> AppResult<PathInfo> {
    let (resolved, _) = resolve(&state, project_path.as_deref(), &path)?;
    let meta = std::fs::metadata(&resolved).ok();

    Ok(PathInfo {
        path: resolved.to_string_lossy().into_owned(),
        exists: meta.is_some(),
        is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        is_file: meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
    })
}
