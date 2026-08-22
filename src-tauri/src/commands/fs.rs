//! 파일 I/O IPC. 프로젝트가 열려 있으면 해당 루트 밖으로 나가지 못하도록 막는다.

use std::path::{Path, PathBuf};

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
}
