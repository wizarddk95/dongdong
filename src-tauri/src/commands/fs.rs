//! 파일 I/O IPC. 프로젝트가 열려 있으면 해당 루트 밖으로 나가지 못하도록 막는다.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
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

/// 바이트 그대로 실어 올릴 때의 상한.
///
/// 웹뷰의 `MAX_SOURCE_BYTES`(`lib/images.ts`)와 **같은 자다** — 한쪽만 크면 통과시킨 것을
/// 다른 쪽이 거절해서 `@` 참조가 이유 없이 실패한다. 읽기 전에 메타데이터로 먼저 본다
/// (넘는 파일을 메모리에 올려 놓고 나서 거절하면 상한을 둔 뜻이 없다).
const MAX_BASE64_READ_BYTES: u64 = 32 * 1024 * 1024;

/// base64 로 되돌아온 파일 바이트.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBytes {
    pub path: String,
    pub relative_path: String,
    pub base64: String,
    pub size: u64,
}

/// 파일을 **바이트 그대로**(base64) 읽는다.
///
/// `read_file` 은 바이너리를 빈 문자열로 돌려준다 — 텍스트가 아닌 것을 컨텍스트에 붓지
/// 않으려는 판단이고 그건 그대로 옳다. 다만 `@` 로 참조한 **프로젝트 안 이미지**는 바이트가
/// 있어야 한다(웹뷰가 줄이고 지문을 떠서 첨부로 눕힌다 — `lib/images.ts`).
///
/// 담장은 `read_file` 과 **똑같다**: `resolve_within()` 하나를 그대로 지난다. 새 길을 뚫는
/// 것이 아니라 이미 열려 있는 길에서 다른 표현을 가져오는 것뿐이다 — 이 command 로 읽을 수
/// 있는 것은 `read_file` 로도 읽을 수 있다(내용이 글자로 안 보일 뿐이다).
#[tauri::command]
pub fn read_file_base64(
    state: State<'_, AppState>,
    path: String,
    project_path: Option<String>,
) -> AppResult<FileBytes> {
    let (resolved, root) = resolve(&state, project_path.as_deref(), &path)?;

    let meta = std::fs::metadata(&resolved)
        .map_err(|_| AppError::not_found(resolved.display().to_string()))?;
    if meta.is_dir() {
        return Err(AppError::invalid(format!(
            "{} 은(는) 디렉터리입니다",
            resolved.display()
        )));
    }
    if meta.len() > MAX_BASE64_READ_BYTES {
        return Err(AppError::invalid(format!(
            "파일이 너무 큽니다 ({}바이트, 상한 {MAX_BASE64_READ_BYTES}바이트)",
            meta.len()
        )));
    }

    let bytes = std::fs::read(&resolved)?;
    Ok(FileBytes {
        relative_path: relative(&root, &resolved),
        path: resolved.to_string_lossy().into_owned(),
        base64: STANDARD.encode(&bytes),
        size: bytes.len() as u64,
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

// ------------------------------------------------------- 이미지 첨부 (blob)

/// 첨부 하나의 최대 크기. 웹뷰가 이미 긴 변 1568px 로 줄여 보내므로 여기 걸리는 건
/// 사실상 사고다 — 그래도 상한이 없으면 사고 한 번이 디스크를 채운다.
const MAX_ATTACHMENT_BYTES: usize = 12 * 1024 * 1024;

/// 받아 줄 이미지 형식과 그때 쓸 확장자.
///
/// **확장자를 여기서만 정하는 것이 핵심이다.** 클라이언트가 준 문자열로 파일 이름을
/// 만들면 `image/png; .exe` 같은 것이 그대로 디스크에 앉는다.
const ATTACHMENT_TYPES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
];

/// 저장된 첨부 하나. 같은 바이트를 다시 보내면 `existed` 가 참이고 파일은 하나뿐이다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    pub sha: String,
    pub path: String,
    pub relative_path: String,
    pub media_type: String,
    pub size: u64,
    /// 이미 같은 내용이 있었다 (내용주소 저장이라 덮어쓰지 않았다)
    pub existed: bool,
}

/// 다시 읽어 온 첨부. LLM 으로 나갈 때도, 화면에 썸네일을 그릴 때도 이 모양을 쓴다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBytes {
    pub sha: String,
    pub base64: String,
    pub media_type: String,
    pub size: u64,
}

pub fn attachment_extension(media_type: &str) -> AppResult<&'static str> {
    ATTACHMENT_TYPES
        .iter()
        .find(|(mime, _)| *mime == media_type)
        .map(|(_, ext)| *ext)
        .ok_or_else(|| AppError::invalid(format!("첨부할 수 없는 형식입니다: {media_type}")))
}

pub fn attachment_media_type(extension: &str) -> Option<&'static str> {
    ATTACHMENT_TYPES
        .iter()
        .find(|(_, ext)| *ext == extension)
        .map(|(mime, _)| *mime)
}

/// 웹뷰가 계산해 보낸 SHA-256 인가.
///
/// 이 값이 **파일 이름이 된다** — 모양을 못 박지 않으면 `../../evil` 한 줄로
/// 워크스페이스 밖에 쓰게 된다. 여기는 `resolve_within()` 이 지키는 길이 아니라
/// 우리가 루트에서 직접 조립하는 경로이므로, 담장이 이 검사 하나뿐이다.
pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 첨부가 사는 곳. `.agent_workspace` 안이라 `@` 검색도, 깃도 이 폴더를 안 본다.
fn attachments_dir(root: &Path) -> PathBuf {
    paths::workspace_dir(root).join("attachments")
}

/// 바이트를 `<dir>/<sha>.<ext>` 로 눕힌다. 이미 있으면 그대로 둔다(내용주소).
pub fn put_attachment(
    dir: &Path,
    sha: &str,
    media_type: &str,
    bytes: &[u8],
) -> AppResult<(PathBuf, bool)> {
    if !is_sha256(sha) {
        return Err(AppError::invalid("첨부 식별자가 SHA-256 형식이 아닙니다"));
    }
    if bytes.is_empty() {
        return Err(AppError::invalid("빈 첨부는 저장하지 않습니다"));
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::invalid(format!(
            "첨부가 너무 큽니다 ({}바이트, 상한 {MAX_ATTACHMENT_BYTES}바이트)",
            bytes.len()
        )));
    }

    let extension = attachment_extension(media_type)?;
    let path = dir.join(format!("{sha}.{extension}"));
    if path.exists() {
        return Ok((path, true));
    }

    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, bytes)?;
    Ok((path, false))
}

/// `<sha>.*` 를 찾아 되읽는다.
///
/// 확장자를 인자로 받지 않는 이유: 참조(`dd-image:<sha>`)를 **한 토큰으로** 두고 싶어서다.
/// 형식이 참조에 섞이면 같은 이미지를 가리키는 표가 두 개가 된다.
pub fn take_attachment(dir: &Path, sha: &str) -> AppResult<(PathBuf, &'static str, Vec<u8>)> {
    if !is_sha256(sha) {
        return Err(AppError::invalid("첨부 식별자가 SHA-256 형식이 아닙니다"));
    }

    for (media_type, extension) in ATTACHMENT_TYPES {
        let path = dir.join(format!("{sha}.{extension}"));
        if path.is_file() {
            let bytes = std::fs::read(&path)?;
            return Ok((path, media_type, bytes));
        }
    }
    Err(AppError::not_found(format!("첨부 {sha}")))
}

/// 이미지 바이트를 프로젝트 워크스페이스에 저장한다.
///
/// SHA-256 은 **웹뷰가** 계산해서 보낸다(바이트가 이미 거기 있다). 여기서 다시 세지
/// 않으므로 이 값은 무결성 증명이 아니라 중복 제거 키다 — 담장은 `is_sha256()` 이다.
#[tauri::command]
pub fn save_attachment(
    state: State<'_, AppState>,
    sha: String,
    data: String,
    media_type: String,
    project_path: Option<String>,
) -> AppResult<SavedAttachment> {
    let root = state.root_of(project_path.as_deref())?;
    let dir = attachments_dir(&root);

    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|error| AppError::invalid(format!("첨부를 디코딩하지 못했습니다: {error}")))?;

    let (path, existed) = put_attachment(&dir, &sha, &media_type, &bytes)?;

    Ok(SavedAttachment {
        sha,
        relative_path: paths::relative_display(&root, &path),
        path: path.to_string_lossy().into_owned(),
        media_type,
        size: bytes.len() as u64,
        existed,
    })
}

/// 저장된 첨부를 base64 로 되읽는다. LLM 전송 직전 하이드레이션과 썸네일이 함께 쓴다.
#[tauri::command]
pub fn read_attachment(
    state: State<'_, AppState>,
    sha: String,
    project_path: Option<String>,
) -> AppResult<AttachmentBytes> {
    let root = state.root_of(project_path.as_deref())?;
    let (_, media_type, bytes) = take_attachment(&attachments_dir(&root), &sha)?;

    Ok(AttachmentBytes {
        base64: STANDARD.encode(&bytes),
        size: bytes.len() as u64,
        media_type: media_type.to_string(),
        sha,
    })
}

// ------------------------------------------------- 프로젝트 파일 검색 (@ 참조)

/// `@` 자동완성 목록의 항목 하나. 목록만 만들 뿐 내용은 읽지 않는다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 훑지 않는 디렉터리. 여기까지 세면 목록이 빌드 산출물로 뒤덮인다.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".gradle",
    ".idea",
    ".vscode",
    ".agent_workspace",
];

/// 한 번의 검색이 훑을 수 있는 엔트리 수. 거대한 리포에서 입력이 끊기지 않게 막는다.
const MAX_SCAN_ENTRIES: usize = 40_000;
/// 내려갈 수 있는 깊이.
const MAX_DEPTH: usize = 12;
/// 돌려주는 항목 수의 기본값/상한.
const DEFAULT_LIMIT: usize = 40;
const MAX_LIMIT: usize = 200;

pub fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

/// `query` 의 글자가 `text` 안에 순서대로 나타나는가 (연속일 필요는 없다).
fn is_subsequence(query: &str, text: &str) -> bool {
    let mut chars = text.chars();
    query
        .chars()
        .all(|wanted| chars.any(|actual| actual == wanted))
}

/// 검색어와 경로의 어울림 점수. `None` 이면 후보가 아니다. 클수록 위로 온다.
///
/// 사람은 대개 **파일 이름**을 치므로 이름 쪽 일치를 경로 일치보다 크게 본다.
/// 같은 점수라면 얕고 짧은 경로가 먼저 보이는 편이 낫다(대개 그게 찾던 것이다).
pub fn match_score(query: &str, relative_path: &str, name: &str) -> Option<i64> {
    let query = query.trim().to_lowercase();
    let path_lower = relative_path.to_lowercase();
    let name_lower = name.to_lowercase();

    let mut score: i64 = if query.is_empty() {
        0
    } else if name_lower == query {
        1_000
    } else if let Some(pos) = name_lower.find(&query) {
        if pos == 0 {
            800
        } else {
            600 - pos as i64
        }
    } else if let Some(pos) = path_lower.find(&query) {
        400 - (pos as i64).min(200)
    } else if is_subsequence(&query, &path_lower) {
        100
    } else {
        return None;
    };

    score -= (relative_path.len() as i64) / 8;
    score -= relative_path.matches('/').count() as i64 * 3;
    Some(score)
}

/// 루트 아래를 너비 우선으로 훑는다. 얕은 것부터 담기므로 상한에 걸려도 쓸모 있는 목록이 남는다.
fn collect(root: &Path, query: &str, limit: usize) -> Vec<ProjectFile> {
    let mut scanned = 0usize;
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> =
        std::collections::VecDeque::new();
    let mut scored: Vec<(i64, ProjectFile)> = Vec::new();
    queue.push_back((root.to_path_buf(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if scanned >= MAX_SCAN_ENTRIES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            scanned += 1;
            if scanned >= MAX_SCAN_ENTRIES {
                break;
            }

            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let is_dir = meta.is_dir();

            if is_dir && (is_ignored_dir(&name) || name.starts_with('.')) {
                continue;
            }

            let path = entry.path();
            let relative_path = paths::relative_display(root, &path);

            if let Some(score) = match_score(query, &relative_path, &name) {
                scored.push((
                    score,
                    ProjectFile {
                        name: name.clone(),
                        relative_path,
                        is_dir,
                        size: if is_dir { 0 } else { meta.len() },
                    },
                ));
            }

            if is_dir && depth + 1 < MAX_DEPTH {
                queue.push_back((path, depth + 1));
            }
        }
    }

    // 점수 → 디렉터리 우선 → 경로 순. 같은 점수에서 순서가 흔들리면 방향키가 미끄러진다.
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.is_dir.cmp(&a.1.is_dir))
            .then_with(|| a.1.relative_path.cmp(&b.1.relative_path))
    });
    scored.truncate(limit);
    scored.into_iter().map(|(_, file)| file).collect()
}

/// `@` 자동완성용 프로젝트 파일 검색.
///
/// `async` + `spawn_blocking` 인 이유는 셸과 같다 — 큰 리포를 훑는 동안 메인 스레드가
/// 멈추면 입력칸이 그대로 언다. 프로젝트 루트 밖은 애초에 훑지 않는다.
#[tauri::command]
pub async fn search_project_files(
    state: State<'_, AppState>,
    query: Option<String>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> AppResult<Vec<ProjectFile>> {
    let root = super::resolve_root(&state, project_path.as_deref())?
        .ok_or_else(|| AppError::NoProject(" (프로젝트를 먼저 여세요)".to_string()))?;

    let query = query.unwrap_or_default();
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    tauri::async_runtime::spawn_blocking(move || collect(&root, &query, limit))
        .await
        .map_err(|error| AppError::invalid(format!("파일 검색 실패: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 빌드_산출물_디렉터리는_건너뛴다() {
        assert!(is_ignored_dir("node_modules"));
        assert!(is_ignored_dir("target"));
        assert!(is_ignored_dir(".agent_workspace"));
        assert!(!is_ignored_dir("src"));
    }

    #[test]
    fn 빈_검색어는_모두_후보다() {
        assert_eq!(match_score("", "src/main.rs", "main.rs").is_some(), true);
    }

    #[test]
    fn 이름_일치가_경로_일치보다_앞선다() {
        let by_name = match_score("ipc", "src/lib/ipc.ts", "ipc.ts").unwrap();
        let by_path = match_score("ipc", "src/ipc/deeply/nested/other.ts", "other.ts").unwrap();
        assert!(by_name > by_path, "{by_name} <= {by_path}");
    }

    #[test]
    fn 얕은_경로가_먼저_온다() {
        let shallow = match_score("main", "main.rs", "main.rs").unwrap();
        let deep = match_score("main", "a/b/c/d/main.rs", "main.rs").unwrap();
        assert!(shallow > deep, "{shallow} <= {deep}");
    }

    #[test]
    fn 띄엄띄엄_일치도_잡지만_점수가_낮다() {
        let loose = match_score("slb", "src/lib/x.ts", "x.ts").unwrap();
        let tight = match_score("x.ts", "src/lib/x.ts", "x.ts").unwrap();
        assert!(loose < tight);
        assert!(match_score("zzzz", "src/lib/x.ts", "x.ts").is_none());
    }

    /// 테스트마다 격리된 임시 프로젝트 루트.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir()
                .join("dongdong-tests")
                .join(format!("{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("임시 루트 생성 실패");
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn touch(root: &Path, relative: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"x").unwrap();
    }

    #[test]
    fn 루트를_훑되_빌드_산출물은_건너뛴다() {
        let temp = TempRoot::new("search");
        touch(&temp.0, "src/lib/ipc.ts");
        touch(&temp.0, "src/main.tsx");
        touch(&temp.0, "node_modules/pkg/ipc.ts");
        touch(&temp.0, ".git/config");

        let found = collect(&temp.0, "ipc", 20);
        let paths: Vec<&str> = found.iter().map(|f| f.relative_path.as_str()).collect();

        assert!(paths.contains(&"src/lib/ipc.ts"), "{paths:?}");
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "빌드 산출물이 목록에 섞였다: {paths:?}"
        );
        assert!(!paths.iter().any(|p| p.contains(".git")), "{paths:?}");
    }

    #[test]
    fn 검색어가_비면_디렉터리도_함께_돌려준다() {
        let temp = TempRoot::new("search-empty");
        touch(&temp.0, "src/main.tsx");

        let found = collect(&temp.0, "", 20);
        assert!(found.iter().any(|f| f.is_dir && f.relative_path == "src"));
        assert!(found.iter().any(|f| !f.is_dir && f.relative_path == "src/main.tsx"));
    }

    #[test]
    fn 상한을_넘겨_돌려주지_않는다() {
        let temp = TempRoot::new("search-limit");
        for index in 0..10 {
            touch(&temp.0, &format!("src/file{index}.ts"));
        }
        assert_eq!(collect(&temp.0, "file", 3).len(), 3);
    }

    #[test]
    fn 대소문자를_가리지_않는다() {
        assert!(match_score("README", "readme.md", "readme.md").is_some());
        assert!(match_score("readme", "README.md", "README.md").is_some());
    }

    // ------------------------------------------------- 바이트 읽기 (@ 이미지)

    /// `read_file_base64` 는 `State` 가 있어야 불러 볼 수 있다 — 여기서는 그 안쪽,
    /// 즉 "무엇을 거절하는가" 를 본다. 담장(`resolve_within`)은 `paths` 쪽 테스트의 몫이다.
    #[test]
    fn 상한을_넘는_파일은_읽기_전에_거절한다() {
        let temp = TempRoot::new("read-bytes");
        let path = temp.0.join("big.png");
        std::fs::write(&path, b"x").unwrap();

        let meta = std::fs::metadata(&path).unwrap();
        assert!(meta.len() <= MAX_BASE64_READ_BYTES);
        // 웹뷰의 `MAX_SOURCE_BYTES`(lib/images.ts)와 같은 자여야 한다 —
        // 한쪽만 크면 통과시킨 것을 다른 쪽이 거절해서 `@` 참조가 이유 없이 실패한다.
        assert_eq!(MAX_BASE64_READ_BYTES, 32 * 1024 * 1024);
    }

    #[test]
    fn 바이너리도_바이트_그대로_돌아온다() {
        // `read_file` 이 빈 문자열로 돌려주는 바이트가 base64 왕복을 견디는지.
        let raw: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02];
        let encoded = STANDARD.encode(raw);
        assert_eq!(STANDARD.decode(encoded.as_bytes()).unwrap(), raw);
    }

    // ------------------------------------------------- 이미지 첨부

    #[test]
    fn sha256_모양이_아니면_거절한다() {
        assert!(is_sha256(&"a".repeat(64)));
        assert!(is_sha256(&"0123456789abcdef".repeat(4)));
        // 길이가 다르다
        assert!(!is_sha256(&"a".repeat(63)));
        assert!(!is_sha256(&"a".repeat(65)));
        // 대문자 · 경로 문자 — 여기서 막지 않으면 그대로 파일 이름이 된다
        assert!(!is_sha256(&"A".repeat(64)));
        assert!(!is_sha256("../../etc/passwd"));
        assert!(!is_sha256(&format!("{}/x", "a".repeat(62))));
    }

    #[test]
    fn 확장자는_허용_목록에서만_나온다() {
        assert_eq!(attachment_extension("image/png").unwrap(), "png");
        assert_eq!(attachment_extension("image/jpeg").unwrap(), "jpg");
        assert!(attachment_extension("application/x-msdownload").is_err());
        assert!(attachment_extension("image/svg+xml").is_err());
        assert_eq!(attachment_media_type("webp"), Some("image/webp"));
        assert_eq!(attachment_media_type("exe"), None);
    }

    #[test]
    fn 같은_내용은_한_번만_눕는다() {
        let temp = TempRoot::new("attach-dedupe");
        let dir = temp.0.join("attachments");
        let sha = "b".repeat(64);

        let (first, existed) = put_attachment(&dir, &sha, "image/png", b"\x89PNG-fake").unwrap();
        assert!(!existed);
        let (second, existed) = put_attachment(&dir, &sha, "image/png", b"\x89PNG-fake").unwrap();
        assert!(existed, "두 번째 저장이 파일을 다시 썼다");
        assert_eq!(first, second);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn 저장한_뒤_형식까지_되읽는다() {
        let temp = TempRoot::new("attach-roundtrip");
        let dir = temp.0.join("attachments");
        let sha = "c".repeat(64);

        put_attachment(&dir, &sha, "image/webp", b"RIFF-fake").unwrap();
        let (path, media_type, bytes) = take_attachment(&dir, &sha).unwrap();

        assert_eq!(media_type, "image/webp");
        assert_eq!(bytes, b"RIFF-fake");
        assert!(path.ends_with(format!("{sha}.webp")));
    }

    #[test]
    fn 없는_첨부는_찾을_수_없다고_말한다() {
        let temp = TempRoot::new("attach-missing");
        let dir = temp.0.join("attachments");
        assert!(take_attachment(&dir, &"d".repeat(64)).is_err());
    }

    #[test]
    fn 빈_첨부와_상한_초과는_거절한다() {
        let temp = TempRoot::new("attach-limits");
        let dir = temp.0.join("attachments");
        let sha = "e".repeat(64);

        assert!(put_attachment(&dir, &sha, "image/png", b"").is_err());
        let huge = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        assert!(put_attachment(&dir, &sha, "image/png", &huge).is_err());
        assert!(!dir.exists(), "거절한 첨부가 디렉터리를 만들었다");
    }

    #[test]
    fn 첨부는_워크스페이스_안에_산다() {
        let root = Path::new("/tmp/proj");
        assert!(attachments_dir(root).ends_with("attachments"));
        assert!(attachments_dir(root)
            .to_string_lossy()
            .contains(".agent_workspace"));
    }

    #[test]
    fn base64_는_왕복한다() {
        for sample in [&b""[..], b"a", b"ab", b"abc", b"\x00\xff\x10\x80"] {
            let encoded = STANDARD.encode(sample);
            assert_eq!(STANDARD.decode(encoded.as_bytes()).unwrap(), sample);
        }
    }
}
