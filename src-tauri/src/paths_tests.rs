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
    // `resolve_within` 은 링크를 풀어서 돌려주므로 비교 기준도 풀어 둔 것이어야 한다.
    // `temp_dir()` 이 실제 위치가 아닌 OS 가 있다 — macOS 는 `/var` → `/private/var`,
    // Windows 는 `C:\Users\RUNNER~1\...` 같은 8.3 단축 경로다(리눅스의 `/tmp` 만 그대로다).
    // 날것으로 비교하면 그 두 곳에서만 조용히 어긋난다.
    let root_real = resolve_through_links(&root);

    let inside = resolve_within(Some(&root_str), "src/main.rs").expect("루트 안은 허용");
    assert!(is_within(&root_real, &inside));

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

/// 루트 안에 밖을 가리키는 링크를 두고, **아직 없는** 파일을 그 링크 너머에 쓰려 해 본다.
/// 문자열로만 보면 루트 안이라 예전에는 통과했다.
#[test]
fn resolve_within_blocks_escaping_through_a_symlink() {
    let base = std::env::temp_dir().join("dongdong-tests-symlink");
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("project");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&outside, root.join("link")).is_ok();
    // Windows 의 심볼릭 링크는 개발자 모드나 관리자 권한을 요구한다. 실패하면 **정션**으로
    // 물러난다 — 권한 없이 만들 수 있고, 링크를 지나 밖으로 나간다는 점은 똑같다.
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&outside, root.join("link")).is_ok()
        || std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);

    if !linked {
        eprintln!("심볼릭 링크를 만들 수 없어 탈출 테스트를 건너뜁니다");
        let _ = std::fs::remove_dir_all(&base);
        return;
    }

    let root_str = root.to_string_lossy().into_owned();

    // 아직 없는 파일(= canonicalize 가 실패하는 경로)이 핵심이다.
    // 문자열만 보는 예전 검사로는 통과한다 — 그게 이 테스트가 지키는 구멍이다.
    assert!(is_within(&root, &lexical_absolute(&root, Path::new("link/not-yet.txt"))));
    let escaped = resolve_within(Some(&root_str), "link/not-yet.txt");
    assert!(escaped.is_err(), "링크를 타고 루트 밖으로 나가는 쓰기는 막아야 한다");

    // 이미 있는 경로도 마찬가지.
    std::fs::write(outside.join("already.txt"), "x").unwrap();
    assert!(resolve_within(Some(&root_str), "link/already.txt").is_err());

    // 링크와 무관한 평범한 경로는 그대로 통과해야 한다.
    let inside = resolve_within(Some(&root_str), "src/main.rs").expect("루트 안은 허용");
    assert!(is_within(&resolve_through_links(&root), &inside));

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn resolve_through_links_keeps_missing_tails_attached() {
    let root = std::env::temp_dir().join("dongdong-tests-tail");
    std::fs::create_dir_all(&root).unwrap();

    // 없는 조상이 여러 겹이어도 꼬리는 순서대로 되붙어야 한다.
    let resolved = resolve_through_links(&root.join("a/b/c.txt"));
    assert!(resolved.ends_with("a/b/c.txt") || resolved.ends_with(r"a\b\c.txt"));
    assert!(is_within(&resolve_through_links(&root), &resolved));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn workspace_paths_live_under_the_project_root() {
    let root = Path::new(if cfg!(windows) { r"C:\work\p" } else { "/work/p" });
    assert!(workspace_dir(root).ends_with(".agent_workspace"));
    assert!(db_path(root).ends_with("local.db"));
    assert!(is_within(root, &db_path(root)));
}

