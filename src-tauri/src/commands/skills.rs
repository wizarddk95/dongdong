//! 스킬 문서(`SKILL.md`) 스캔·생성·삭제.
//!
//! 스킬은 **도구가 아니라 절차서**다. 도구처럼 매 턴 스키마째 컨텍스트에 실리지 않고
//! 이름·설명만 실렸다가, 모델이 필요하다고 판단할 때 `load_skill` 로 본문을 끌어간다.
//! 문서는 두 곳에 산다:
//!   - 전역(`user`): OS 앱 설정 디렉터리의 `skills/` — 모든 프로젝트가 공유한다(settings.json 옆).
//!   - 프로젝트(`project`): 프로젝트 루트의 `.dongdong/skills/` — 리포와 함께 커밋된다.
//!     `.agent_workspace` 가 아닌 이유는 그쪽 `.gitignore` 가 `*` 라 절대 커밋되지 않기 때문이다.
//!
//! 전역 디렉터리는 프로젝트 루트 밖이라 `paths::resolve_within` 을 지날 수 없다 →
//! 파일 IPC 를 재활용하지 않고 이 command 들이 그 두 곳만 직접 연다.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::resolve_root;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 문서 하나의 상한(64KB). 본문은 판단 후에야 실리지만 그래도 자른다.
const MAX_SKILL_BYTES: usize = 64 * 1024;

/// 스킬 문서 파일 이름. 폴더 형식(`<이름>/SKILL.md`)일 때 찾는 대상.
const SKILL_FILE: &str = "SKILL.md";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    /// `user`(전역) | `project`
    pub source: String,
    /// 폴더(또는 파일) 이름. frontmatter 에 name 이 없을 때 이 이름을 쓴다.
    pub folder: String,
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDirs {
    pub user: String,
    /// 프로젝트가 열려 있지 않으면 `None`.
    pub project: Option<String>,
}

/// 파일 이름으로 쓸 수 있는 글자만 남긴다. 경로 구분자·`..` 를 넣어 밖으로 나가지 못하게 한다.
pub fn sanitize_skill_name(name: &str) -> AppResult<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        return Err(AppError::invalid(
            "스킬 이름에는 영문·숫자·하이픈을 하나 이상 넣으세요",
        ));
    }
    Ok(cleaned.to_ascii_lowercase())
}

/// 디렉터리 하나를 훑어 스킬 문서를 모은다. 없는 디렉터리는 빈 목록이다(정상).
///
/// 두 가지 배치를 모두 받는다:
///   - `<dir>/<이름>/SKILL.md` — 딸린 자료(스크립트·템플릿)를 같이 두는 표준 형태
///   - `<dir>/<이름>.md` — 한 파일로 끝나는 짧은 스킬
pub fn scan_skill_dir(dir: &Path, source: &str) -> Vec<SkillFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        let (folder, file) = if is_dir {
            let name = entry.file_name().to_string_lossy().to_string();
            // 대소문자를 가리지 않는다 — 손으로 만든 폴더는 skill.md 이기도 하다.
            let candidate = std::fs::read_dir(&path).ok().and_then(|items| {
                items.flatten().map(|item| item.path()).find(|item| {
                    item.file_name()
                        .map(|n| n.to_string_lossy().eq_ignore_ascii_case(SKILL_FILE))
                        .unwrap_or(false)
                })
            });
            match candidate {
                Some(file) => (name, file),
                None => continue,
            }
        } else {
            let is_markdown = path
                .extension()
                .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            let stem = path.file_stem().map(|n| n.to_string_lossy().to_string());
            match (is_markdown, stem) {
                (true, Some(name)) => (name, path.clone()),
                _ => continue,
            }
        };

        let Ok(raw) = std::fs::read_to_string(&file) else {
            continue;
        };
        let truncated = raw.len() > MAX_SKILL_BYTES;
        let content = if truncated {
            // 문자 경계에서 자른다 — 바이트로 자르면 한글이 깨진다.
            raw.chars().take(MAX_SKILL_BYTES / 3).collect()
        } else {
            raw
        };

        found.push(SkillFile {
            source: source.to_string(),
            folder,
            path: file.to_string_lossy().replace('\\', "/"),
            content,
            truncated,
        });
    }

    // 목록 순서가 매번 달라지면 프롬프트도 매번 달라진다 → 이름순으로 못 박는다.
    found.sort_by(|a, b| a.folder.to_lowercase().cmp(&b.folder.to_lowercase()));
    found
}

/// 전역 스킬 디렉터리(`<앱 설정>/skills`). 없으면 만든다.
fn user_skill_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::invalid(format!("앱 설정 디렉터리를 찾을 수 없습니다: {e}")))?
        .join("skills");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 프로젝트 스킬 디렉터리(`<루트>/.dongdong/skills`). 열린 프로젝트가 없으면 `None`.
/// 읽기 경로에서는 만들지 않는다 — 폴더를 열기만 해도 리포에 빈 디렉터리가 생기면 곤란하다.
fn project_skill_dir(
    state: &State<'_, AppState>,
    project_path: Option<&str>,
) -> AppResult<Option<PathBuf>> {
    Ok(resolve_root(state, project_path)?.map(|root| root.join(".dongdong").join("skills")))
}

#[tauri::command]
pub fn skill_dirs(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: Option<String>,
) -> AppResult<SkillDirs> {
    Ok(SkillDirs {
        user: user_skill_dir(&app)?.to_string_lossy().replace('\\', "/"),
        project: project_skill_dir(&state, project_path.as_deref())?
            .map(|dir| dir.to_string_lossy().replace('\\', "/")),
    })
}

/// 두 디렉터리의 스킬 문서를 모두 읽어 온다. 전역이 먼저, 프로젝트가 뒤에 온다
/// (같은 이름이면 프론트가 뒤엣것을 남긴다 — 프로젝트가 전역을 덮어쓴다).
#[tauri::command]
pub fn list_skill_files(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: Option<String>,
) -> AppResult<Vec<SkillFile>> {
    let mut all = scan_skill_dir(&user_skill_dir(&app)?, "user");
    if let Some(dir) = project_skill_dir(&state, project_path.as_deref())? {
        all.extend(scan_skill_dir(&dir, "project"));
    }
    Ok(all)
}

/// 새 스킬 문서를 만든다. 이미 있으면 거절한다(손으로 쓴 내용을 덮어쓰지 않는다).
#[tauri::command]
pub fn create_skill_file(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    scope: String,
    content: String,
    project_path: Option<String>,
) -> AppResult<String> {
    let folder = sanitize_skill_name(&name)?;
    let base = match scope.as_str() {
        "user" => user_skill_dir(&app)?,
        "project" => project_skill_dir(&state, project_path.as_deref())?
            .ok_or_else(|| AppError::NoProject(String::new()))?,
        other => return Err(AppError::invalid(format!("알 수 없는 스킬 범위: {other}"))),
    };

    let dir = base.join(&folder);
    let file = dir.join(SKILL_FILE);
    if file.exists() {
        return Err(AppError::invalid(format!("이미 있는 스킬입니다: {folder}")));
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(&file, content)?;
    Ok(file.to_string_lossy().replace('\\', "/"))
}

/// 스킬 문서를 지운다. 폴더 형식이면 폴더째 지운다.
/// **두 스킬 디렉터리 안에 있는 경로만** 받는다 — 임의 경로 삭제 통로가 되지 않게.
#[tauri::command]
pub fn delete_skill_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    project_path: Option<String>,
) -> AppResult<bool> {
    let target = crate::paths::absolutize(&path)?;
    let mut roots = vec![user_skill_dir(&app)?];
    if let Some(dir) = project_skill_dir(&state, project_path.as_deref())? {
        roots.push(dir);
    }
    if !roots.iter().any(|root| is_inside(root, &target)) {
        return Err(AppError::PathDenied(format!(
            "{} (스킬 디렉터리 밖입니다)",
            target.display()
        )));
    }
    if !target.exists() {
        return Ok(false);
    }

    // `<dir>/<이름>/SKILL.md` 면 딸린 자료까지 함께 지운다. 최상위 `.md` 는 파일만 지운다.
    let parent = target.parent().map(Path::to_path_buf);
    let is_folder_skill = target
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case(SKILL_FILE))
        .unwrap_or(false);
    match (is_folder_skill, parent) {
        (true, Some(dir)) if roots.iter().any(|root| is_inside(root, &dir)) => {
            std::fs::remove_dir_all(&dir)?
        }
        _ => std::fs::remove_file(&target)?,
    }
    Ok(true)
}

/// `root` **아래**에 있는 경로인가. 루트 자신은 아니다 — 스킬 디렉터리 통째로 지우는 길을 막는다.
fn is_inside(root: &Path, target: &Path) -> bool {
    crate::paths::is_within(root, target)
        && crate::paths::compare_key(root) != crate::paths::compare_key(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join("dongdong-tests-skills")
                .join(format!("{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn scans_both_layouts_in_name_order() {
        let temp = TempDir::new("scan");
        std::fs::create_dir_all(temp.0.join("xlsx")).unwrap();
        std::fs::write(
            temp.0.join("xlsx").join("SKILL.md"),
            "---\nname: xlsx\n---\n본문",
        )
        .unwrap();
        std::fs::write(temp.0.join("alpha.md"), "짧은 스킬").unwrap();
        // 스킬 문서가 없는 폴더와 마크다운이 아닌 파일은 건너뛴다.
        std::fs::create_dir_all(temp.0.join("empty")).unwrap();
        std::fs::write(temp.0.join("notes.txt"), "무시").unwrap();

        let found = scan_skill_dir(&temp.0, "user");
        let names: Vec<_> = found.iter().map(|s| s.folder.as_str()).collect();
        assert_eq!(names, vec!["alpha", "xlsx"]);
        assert!(found[1].content.contains("본문"));
        assert_eq!(found[0].source, "user");
    }

    #[test]
    fn missing_directory_is_not_an_error() {
        assert!(scan_skill_dir(Path::new("C:/없는-폴더/skills"), "user").is_empty());
    }

    #[test]
    fn sanitizes_names_and_rejects_empty() {
        assert_eq!(sanitize_skill_name("  Excel Report ").unwrap(), "excel-report");
        assert_eq!(sanitize_skill_name("../../etc").unwrap(), "etc");
        assert!(sanitize_skill_name("///").is_err());
    }

    #[test]
    fn is_inside_rejects_siblings() {
        let root = Path::new("C:/base/skills");
        assert!(is_inside(root, Path::new("C:/base/skills/xlsx/SKILL.md")));
        assert!(!is_inside(root, Path::new("C:/base/skills-other/x.md")));
        assert!(!is_inside(root, Path::new("C:/base/other.md")));
    }
}
