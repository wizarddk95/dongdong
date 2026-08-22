//! 프로세스 트리 정리.
//!
//! **자식만 죽이면 손자가 살아남아 파이프를 계속 물고 있는다** — 리더 스레드의 `read` 가
//! EOF 를 못 보고 영영 기다린다. Windows 에서는 이 상황이 예외가 아니라 기본값이다:
//! `npx`·`pnpm` 같은 `.cmd` 는 직접 spawn 되지 않아 `cmd /C` 를 거치므로 실제 프로그램이
//! 언제나 손자 자리에 앉는다(셸 도구도, MCP 서버 기동도 같은 경로).
//!
//! 그래서 "죽인다" 는 곳은 셸이든 MCP 든 전부 여기를 지난다.

use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 프로세스와 그 후손을 함께 죽인다.
#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// 그 외 OS 는 자식만 정리한다. (프로세스 그룹까지 다루려면 libc 의존성이 필요하다)
#[cfg(not(windows))]
pub fn kill_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
