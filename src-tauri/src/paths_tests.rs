//! 경로 정규화 / 루트 격리 테스트.

use super::paths::*;
use std::path::Path;

#[test]
fn normalizes_separators_for_the_host_os() {
    let mixed = to_native_separators("a/b\\c");
    let text = mixed.to_string_lossy();
    if cfg!(windows) {
        assert_eq!(text, "a\\b\\c");
    } else {
        assert_eq!(text, "a/b/c");
    }
}

#[test]
fn resolves_dot_segments_without_touching_the_filesystem() {
    let base = if cfg!(windows) {
        Path::new(r"C:\work\project")
    } else {
        Path::new("/work/project")
    };

    let resolved = lexical_absolute(base, Path::new("src/../lib/./mod.rs"));
    assert_eq!(compare_key(&resolved), compare_key(&base.join("lib/mod.rs")));
}

#[test]
fn compare_key_is_case_insensitive_on_windows() {
    let lower = compare_key(Path::new("/Work/Project/"));
    let upper = compare_key(Path::new("/WORK/PROJECT"));
    if cfg!(windows) {
        assert_eq!(lower, upper);
    } else {
        assert_ne!(lower, upper);
    }
    assert!(!lower.ends_with('/'), "끝의 구분자는 제거되어야 한다");
}

#[test]
fn containment_check_rejects_sibling_prefixes() {
    let root = Path::new("/work/project");
    assert!(is_within(root, Path::new("/work/project")));
    assert!(is_within(root, Path::new("/work/project/src/main.rs")));
    // "project-other" 가 "project" 로 시작한다고 통과시키면 안 된다.
    assert!(!is_within(root, Path::new("/work/project-other/x")));
    assert!(!is_within(root, Path::new("/work/other")));
}

#[test]
fn resolve_within_blocks_escaping_the_project_root() {
    let root = std::env::temp_dir().join("dongdong-tests-paths");
    std::fs::create_dir_all(&root).unwrap();
    let root_str = root.to_string_lossy().into_owned();

    let inside = resolve_within(Some(&root_str), "src/main.rs").expect("루트 안은 허용");
    assert!(is_within(&root, &inside));

    let escaped = resolve_within(Some(&root_str), "../../etc/passwd");
    assert!(escaped.is_err(), "상위 디렉터리 탈출은 막아야 한다");

    let absolute_escape = resolve_within(
        Some(&root_str),
        if cfg!(windows) {
            r"C:\Windows\System32\drivers\etc\hosts"
        } else {
            "/etc/hosts"
        },
    );
    assert!(absolute_escape.is_err(), "루트 밖 절대 경로도 막아야 한다");

    // 루트를 지정하지 않으면 제한 없이 절대화만 한다.
    assert!(resolve_within(None, "../..").is_ok());

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn workspace_paths_live_under_the_project_root() {
    let root = Path::new(if cfg!(windows) { r"C:\work\p" } else { "/work/p" });
    assert!(workspace_dir(root).ends_with(".agent_workspace"));
    assert!(db_path(root).ends_with("local.db"));
    assert!(is_within(root, &db_path(root)));
}
