//! 로컬 쉘 명령 실행. 도커/샌드박스 없이 사용자 권한으로 직접 실행한다.
//! OS 별 쉘 분기와 타임아웃, 출력 캡처를 담당한다.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::state::AppState;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows 에서 콘솔 창이 깜빡이지 않도록 하는 플래그.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOptions {
    /// 실행 디렉터리. 상대 경로면 프로젝트 루트 기준.
    #[serde(default)]
    pub cwd: Option<String>,
    /// auto | cmd | powershell | pwsh | bash | sh | zsh
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 지정하지 않으면 활성 프로젝트를 사용한다.
    #[serde(default)]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub command: String,
    pub shell: String,
    pub cwd: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

/// 요청한 쉘 이름을 (실행 프로그램, 명령 문자열 앞에 붙는 인자들)로 변환한다.
fn resolve_shell(requested: Option<&str>) -> AppResult<(String, Vec<String>)> {
    let requested = requested.unwrap_or("auto").trim().to_lowercase();

    let name = if requested == "auto" || requested.is_empty() {
        if cfg!(windows) {
            "cmd"
        } else if cfg!(target_os = "macos") {
            "zsh"
        } else {
            "sh"
        }
    } else {
        requested.as_str()
    };

    let resolved = match name {
        "cmd" => ("cmd".to_string(), vec!["/C".to_string()]),
        "powershell" | "pwsh" => (
            name.to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
            ],
        ),
        // macOS 는 로그인 쉘로 실행해야 사용자의 PATH(nvm, homebrew 등)를 물려받는다.
        "zsh" => ("zsh".to_string(), vec!["-lc".to_string()]),
        "bash" => ("bash".to_string(), vec!["-lc".to_string()]),
        "sh" => ("sh".to_string(), vec!["-c".to_string()]),
        other => return Err(AppError::invalid(format!("지원하지 않는 쉘입니다: {other}"))),
    };

    Ok(resolved)
}

fn decode(bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    let slice = if truncated {
        &bytes[..MAX_OUTPUT_BYTES]
    } else {
        &bytes[..]
    };
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

/// 실제 실행. 타임아웃 시 자식 프로세스를 kill 한다. (블로킹 — 워커 스레드에서 호출할 것)
fn run(
    program: &str,
    pre_args: &[String],
    command_line: &str,
    cwd: &std::path::Path,
    env: Option<&HashMap<String, String>>,
    timeout: Duration,
) -> AppResult<(Vec<u8>, Vec<u8>, Option<i32>, bool)> {
    let mut cmd = Command::new(program);
    cmd.args(pre_args)
        .arg(command_line)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(env) = env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::invalid(format!("쉘 실행 실패 ({program}): {e}")))?;

    // 파이프 버퍼가 가득 차서 자식이 블로킹되지 않도록 별도 스레드에서 읽는다.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });
    let err_handle = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None => {
                if started.elapsed() >= timeout {
                    // kill 하면 파이프가 닫히고 위의 리더 스레드도 함께 끝난다.
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    };

    let stdout_bytes = out_handle.join().unwrap_or_default();
    let stderr_bytes = err_handle.join().unwrap_or_default();

    Ok((
        stdout_bytes,
        stderr_bytes,
        status.and_then(|s| s.code()),
        timed_out,
    ))
}

/// 로컬 쉘 명령을 실행한다. (Phase 1 핵심 IPC)
///
/// `async` 로 둔 이유: 동기 command 는 메인 스레드에서 돌기 때문에 오래 걸리는
/// 명령이 UI 를 멈춘다. 실제 프로세스 대기는 `spawn_blocking` 워커로 넘긴다.
#[tauri::command]
pub async fn execute_shell_command(
    state: State<'_, AppState>,
    command: String,
    options: Option<ShellOptions>,
) -> AppResult<ShellResult> {
    if command.trim().is_empty() {
        return Err(AppError::invalid("실행할 명령이 비어 있습니다"));
    }

    let options = options.unwrap_or_default();

    // 프로젝트가 열려 있으면 그 루트를, 아니면 앱의 현재 작업 디렉터리를 기준으로 삼는다.
    let root = super::resolve_root(&state, options.project_path.as_deref())?;

    let cwd = match (&options.cwd, &root) {
        (Some(requested), Some(root)) => {
            let root_str = root.to_string_lossy().into_owned();
            paths::resolve_within(Some(root_str.as_str()), requested)?
        }
        (Some(requested), None) => paths::absolutize(requested)?,
        (None, Some(root)) => root.clone(),
        (None, None) => std::env::current_dir()?,
    };

    if !cwd.is_dir() {
        return Err(AppError::not_found(format!(
            "작업 디렉터리 {}",
            cwd.display()
        )));
    }

    let (program, pre_args) = resolve_shell(options.shell.as_deref())?;

    // cmd 의 기본 코드 페이지는 한글 Windows 에서 CP949 라 출력이 깨진다. UTF-8 로 전환.
    let command_line = if program == "cmd" {
        format!("chcp 65001>nul & {command}")
    } else {
        command.clone()
    };

    let timeout = Duration::from_millis(options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let started = Instant::now();

    let worker_program = program.clone();
    let worker_cwd = cwd.clone();
    let worker_env = options.env.clone();

    let (stdout_bytes, stderr_bytes, exit_code, timed_out) =
        tauri::async_runtime::spawn_blocking(move || {
            run(
                &worker_program,
                &pre_args,
                &command_line,
                &worker_cwd,
                worker_env.as_ref(),
                timeout,
            )
        })
        .await
        .map_err(|e| AppError::invalid(format!("쉘 워커 스레드 오류: {e}")))??;

    let (stdout, out_truncated) = decode(stdout_bytes);
    let (stderr, err_truncated) = decode(stderr_bytes);

    Ok(ShellResult {
        command,
        shell: program,
        cwd: cwd.to_string_lossy().into_owned(),
        stdout,
        stderr,
        success: !timed_out && exit_code == Some(0),
        exit_code,
        timed_out,
        truncated: out_truncated || err_truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
