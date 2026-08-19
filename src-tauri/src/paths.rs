//! 크로스 플랫폼 경로 정규화 유틸.
//! Windows 의 역슬래시와 POSIX 의 `/` 를 모두 받아들이고, 항상 OS 네이티브 형태로 되돌린다.

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Windows `canonicalize()` 가 붙이는 확장 프리픽스(`\\?\`)를 제거한다.
/// 그대로 두면 UI 표시나 다른 프로세스로 전달할 때 문제가 된다.
pub fn strip_extended_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// 입력 문자열의 구분자를 현재 OS 형태로 통일한다.
pub fn to_native_separators(input: &str) -> PathBuf {
    let trimmed = input.trim().trim_matches('"');
    if cfg!(windows) {
        PathBuf::from(trimmed.replace('/', "\\"))
    } else {
        PathBuf::from(trimmed.replace('\\', "/"))
    }
}

/// 파일 시스템 접근 없이 `.` / `..` 를 해소한다. (아직 존재하지 않는 경로도 처리 가능)
pub fn lexical_absolute(base: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };

    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 존재하는 경로면 canonicalize, 아니면 렉시컬 정규화로 절대 경로를 만든다.
pub fn absolutize(input: &str) -> AppResult<PathBuf> {
    if input.trim().is_empty() {
        return Err(AppError::invalid("경로가 비어 있습니다"));
    }
    let native = to_native_separators(input);
    let cwd = std::env::current_dir()?;
    let lexical = lexical_absolute(&cwd, &native);

    match lexical.canonicalize() {
        Ok(canonical) => Ok(strip_extended_prefix(&canonical)),
        Err(_) => Ok(lexical),
    }
}

/// 경로 비교용 키. Windows 는 대소문자를 구분하지 않는다.
pub fn compare_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// `child` 가 `root` 하위(혹은 root 자신)인지 검사한다.
pub fn is_within(root: &Path, child: &Path) -> bool {
    let root_key = compare_key(root);
    let child_key = compare_key(child);
    child_key == root_key || child_key.starts_with(&format!("{root_key}/"))
}

/// root 가 주어지면 그 안으로 접근을 제한하며 절대 경로를 반환한다.
/// root 가 없으면(= 열린 프로젝트가 없어 사용자가 전체 권한으로 쓰는 경우) 절대화만 수행한다.
pub fn resolve_within(root: Option<&str>, path: &str) -> AppResult<PathBuf> {
    let Some(root) = root else {
        return absolutize(path);
    };

    let root_abs = absolutize(root)?;
    let native = to_native_separators(path);
    let resolved = lexical_absolute(&root_abs, &native);
    let resolved = match resolved.canonicalize() {
        Ok(canonical) => strip_extended_prefix(&canonical),
        Err(_) => resolved,
    };

    if !is_within(&root_abs, &resolved) {
        return Err(AppError::PathDenied(format!(
            "{} (프로젝트 루트: {})",
            resolved.display(),
            root_abs.display()
        )));
    }
    Ok(resolved)
}

/// 프로젝트 루트 기준 상대 경로 문자열(항상 `/` 구분자)로 변환한다.
pub fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

/// 프로젝트 루트 안의 `.agent_workspace` 디렉터리 경로.
pub fn workspace_dir(root: &Path) -> PathBuf {
    root.join(".agent_workspace")
}

/// 프로젝트 루트 안의 SQLite 파일 경로.
pub fn db_path(root: &Path) -> PathBuf {
    workspace_dir(root).join("local.db")
}
