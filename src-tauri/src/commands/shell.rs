//! 로컬 쉘 명령 실행. 도커/샌드박스 없이 사용자 권한으로 직접 실행한다.
//! OS 별 쉘 분기와 타임아웃, 출력 캡처, 중단(취소)을 담당한다.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
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

/// 자식이 정상 종료했을 때 남은 파이프를 마저 비우며 기다리는 시간.
const NORMAL_GRACE: Duration = Duration::from_millis(2_000);
/// kill 한 뒤에는 오래 기다리지 않는다. 손자가 파이프를 물고 있으면 EOF 가 영영 안 온다.
const KILLED_GRACE: Duration = Duration::from_millis(300);

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
    /// 중단용 토큰. 프론트가 만들어 넘기고, 같은 값으로 `cancel_shell_command` 를 부르면 멈춘다.
    #[serde(default)]
    pub cancel_token: Option<String>,
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
    /// 사용자가 중단해서 끝난 경우
    pub cancelled: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

// ------------------------------------------------------- 실행 중인 프로세스 레지스트리

/// 돌고 있는 셸 프로세스 하나.
struct Running {
    pid: u32,
    cancelled: Arc<AtomicBool>,
}

/// `cancelToken` → 프로세스. 중단 버튼이 눌리면 여기서 찾아 트리째 죽인다.
static RUNNING: OnceLock<Mutex<HashMap<String, Running>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Running>> {
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 등록을 RAII 로 잡아 둔다 — 어떤 경로로 빠져나가도 레지스트리에 찌꺼기가 남지 않는다.
struct Registration(Option<String>);

impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(token) = self.0.take() {
            if let Ok(mut map) = registry().lock() {
                map.remove(&token);
            }
        }
    }
}

/// 자식만 죽이면 손자(예: `cmd /C pnpm dev` 안의 node)가 살아남아 파이프를 계속 물고 있는다.
/// Windows 는 taskkill 로 트리째 정리한다.
#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// 그 외 OS 는 자식만 정리한다. (프로세스 그룹까지 다루려면 libc 의존성이 필요하다)
#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// 실행 중인 셸 명령을 취소한다. 없는 토큰이면 false.
pub fn cancel_token(token: &str) -> bool {
    let entry = match registry().lock() {
        Ok(mut map) => map.remove(token),
        Err(_) => None,
    };

    match entry {
        Some(running) => {
            running.cancelled.store(true, Ordering::Relaxed);
            kill_tree(running.pid);
            true
        }
        None => false,
    }
}

// ------------------------------------------------------------------------- 실행

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

/// Windows 콘솔 프로그램의 출력은 UTF-8 이 아닐 수 있다.
/// 리다이렉트된 파이프에 쓸 때 `cmd` 내장 명령(`dir` 등)과 PowerShell 5 는 `chcp` 와
/// 무관하게 OEM 코드 페이지(한국어 Windows 면 CP949)로 쓰기 때문이다.
/// 여기서 그 바이트열을 유니코드로 되돌린다.
#[cfg(windows)]
fn decode_oem(bytes: &[u8]) -> Option<String> {
    extern "system" {
        fn GetOEMCP() -> u32;
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const u8,
            multi_byte_len: i32,
            wide_char_str: *mut u16,
            wide_char_len: i32,
        ) -> i32;
    }

    if bytes.is_empty() {
        return Some(String::new());
    }
    if bytes.len() > i32::MAX as usize {
        return None;
    }

    // SAFETY: 길이를 함께 넘기고, 커널이 채울 만큼만 버퍼를 잡아 두 번 호출한다.
    unsafe {
        let code_page = GetOEMCP();
        let needed = MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if needed <= 0 {
            return None;
        }

        let mut wide = vec![0_u16; needed as usize];
        let written = MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            needed,
        );
        if written <= 0 {
            return None;
        }
        wide.truncate(written as usize);
        String::from_utf16(&wide).ok()
    }
}

#[cfg(not(windows))]
fn decode_oem(_bytes: &[u8]) -> Option<String> {
    None
}

/// 한 스트림 안에 인코딩이 섞여 나온다 — `dir` 은 CP949, node 계열 도구는 UTF-8.
/// 그래서 줄 단위로 UTF-8 을 먼저 시도하고, 깨지는 줄만 OEM 코드 페이지로 되돌린다.
/// (CP949 트레일 바이트도 UTF-8 연속 바이트도 `\n`(0x0A)을 포함하지 않아 줄 분리는 안전하다)
fn decode_text(bytes: &[u8]) -> String {
    if std::str::from_utf8(bytes).is_ok() {
        // 흔한 경우 — 통째로 UTF-8 이면 줄을 쪼갤 것 없이 그대로 쓴다.
        return String::from_utf8_lossy(bytes).into_owned();
    }

    let mut out = String::with_capacity(bytes.len());
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        match std::str::from_utf8(line) {
            Ok(text) => out.push_str(text),
            Err(_) => match decode_oem(line) {
                Some(text) => out.push_str(&text),
                None => out.push_str(&String::from_utf8_lossy(line)),
            },
        }
    }
    out
}

fn decode(bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    let slice = if truncated {
        &bytes[..MAX_OUTPUT_BYTES]
    } else {
        &bytes[..]
    };
    (decode_text(slice), truncated)
}

/// 파이프를 청크 단위로 공유 버퍼에 붓는다.
/// `read_to_end` 로 통째로 받으면 리더가 EOF 를 못 봤을 때 여태 읽은 것까지 버려진다.
fn pump(mut stream: impl Read + Send + 'static, sink: Arc<Mutex<Vec<u8>>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 8192];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if let Ok(mut buffer) = sink.lock() {
                        if buffer.len() < MAX_OUTPUT_BYTES {
                            buffer.extend_from_slice(&chunk[..read]);
                        }
                    }
                }
            }
        }
    })
}

/// 리더 스레드를 기다리되 영원히 붙잡히지는 않는다.
/// 손자 프로세스가 파이프를 물려받아 살아 있으면 EOF 가 오지 않는다 —
/// 예전에는 여기(`join()`)에서 워커가 영구히 멈춰 도구 호출이 끝나지 않았다.
fn join_with_grace(handle: JoinHandle<()>, grace: Duration) {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if handle.is_finished() {
            let _ = handle.join();
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn snapshot(buffer: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
    buffer.lock().map(|guard| guard.clone()).unwrap_or_default()
}

struct Outcome {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
}

/// 실제 실행. 타임아웃/취소 시 프로세스 트리를 kill 한다. (블로킹 — 워커 스레드에서 호출할 것)
fn run(
    program: &str,
    pre_args: &[String],
    command_line: &str,
    cwd: &std::path::Path,
    env: Option<&HashMap<String, String>>,
    timeout: Duration,
    token: Option<String>,
) -> AppResult<Outcome> {
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

    let pid = child.id();
    let cancelled = Arc::new(AtomicBool::new(false));

    // 취소 토큰이 있으면 레지스트리에 올린다. 스코프를 벗어나면 Drop 이 지운다.
    let _registration = match token {
        Some(token) => {
            if let Ok(mut map) = registry().lock() {
                map.insert(
                    token.clone(),
                    Running {
                        pid,
                        cancelled: cancelled.clone(),
                    },
                );
            }
            Registration(Some(token))
        }
        None => Registration(None),
    };

    // 파이프 버퍼가 가득 차서 자식이 블로킹되지 않도록 별도 스레드에서 읽는다.
    let stdout_buffer = Arc::new(Mutex::new(Vec::new()));
    let stderr_buffer = Arc::new(Mutex::new(Vec::new()));
    let out_handle = child
        .stdout
        .take()
        .map(|pipe| pump(pipe, stdout_buffer.clone()));
    let err_handle = child
        .stderr
        .take()
        .map(|pipe| pump(pipe, stderr_buffer.clone()));

    let started = Instant::now();
    let mut timed_out = false;
    let mut was_cancelled = false;

    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None => {
                if cancelled.load(Ordering::Relaxed) {
                    // 취소 쪽에서 이미 kill 했지만, 놓친 자식이 없도록 한 번 더 확인사살한다.
                    kill_tree(pid);
                    let _ = child.wait();
                    was_cancelled = true;
                    break None;
                }
                if started.elapsed() >= timeout {
                    kill_tree(pid);
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    };

    // kill 이 빨라서 위 루프가 status 를 받고 빠져나왔을 수도 있다.
    was_cancelled = was_cancelled || cancelled.load(Ordering::Relaxed);

    let grace = if timed_out || was_cancelled {
        KILLED_GRACE
    } else {
        NORMAL_GRACE
    };
    if let Some(handle) = out_handle {
        join_with_grace(handle, grace);
    }
    if let Some(handle) = err_handle {
        join_with_grace(handle, grace);
    }

    Ok(Outcome {
        stdout: snapshot(&stdout_buffer),
        stderr: snapshot(&stderr_buffer),
        exit_code: status.and_then(|s| s.code()),
        timed_out,
        cancelled: was_cancelled,
    })
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
    let worker_token = options.cancel_token.clone();

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run(
            &worker_program,
            &pre_args,
            &command_line,
            &worker_cwd,
            worker_env.as_ref(),
            timeout,
            worker_token,
        )
    })
    .await
    .map_err(|e| AppError::invalid(format!("쉘 워커 스레드 오류: {e}")))??;

    let (stdout, out_truncated) = decode(outcome.stdout);
    let (stderr, err_truncated) = decode(outcome.stderr);

    Ok(ShellResult {
        command,
        shell: program,
        cwd: cwd.to_string_lossy().into_owned(),
        stdout,
        stderr,
        success: !outcome.timed_out && !outcome.cancelled && outcome.exit_code == Some(0),
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
        cancelled: outcome.cancelled,
        truncated: out_truncated || err_truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 실행 중인 셸 명령을 중단한다. 프론트의 [중단] 이 여기까지 내려온다.
/// taskkill 자체가 프로세스를 띄우므로 워커 스레드에서 돌린다.
#[tauri::command]
pub async fn cancel_shell_command(token: String) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || cancel_token(&token))
        .await
        .map_err(|e| AppError::invalid(format!("쉘 취소 워커 오류: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_for_test() -> (String, Vec<String>) {
        resolve_shell(None).expect("기본 쉘 해석 실패")
    }

    /// 오래 걸리는 명령을 취소하면 타임아웃을 기다리지 않고 즉시 끝나야 한다.
    #[test]
    fn cancel_stops_a_long_command() {
        let (program, pre_args) = shell_for_test();
        let command = if cfg!(windows) {
            "ping -n 60 127.0.0.1 >nul"
        } else {
            "sleep 60"
        };

        let token = String::from("test-cancel-token");
        let worker_token = token.clone();
        let worker_program = program.clone();
        let worker_args = pre_args.clone();
        let cwd = std::env::current_dir().expect("cwd");

        let handle = std::thread::spawn(move || {
            run(
                &worker_program,
                &worker_args,
                command,
                &cwd,
                None,
                Duration::from_secs(60),
                Some(worker_token),
            )
        });

        // 프로세스가 레지스트리에 올라올 때까지 잠깐 기다린다.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if registry().lock().map(|m| m.contains_key(&token)).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(cancel_token(&token), "취소 대상이 레지스트리에 있어야 한다");

        let started = Instant::now();
        let outcome = handle.join().expect("워커 조인 실패").expect("실행 실패");

        assert!(outcome.cancelled, "취소로 끝났다고 표시되어야 한다");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "취소 후 곧바로 반환되어야 한다"
        );
        assert!(
            !registry().lock().map(|m| m.contains_key(&token)).unwrap_or(true),
            "끝난 뒤 레지스트리에서 빠져야 한다"
        );
    }

    /// UTF-8 로 온 출력은 한 글자도 건드리지 않는다.
    #[test]
    fn decodes_utf8_as_is() {
        let text = "한글 · ascii · 絵文字\n두 번째 줄\n";
        assert_eq!(decode_text(text.as_bytes()), text);
    }

    /// UTF-8 이 아닌 줄이 섞여 있어도 UTF-8 줄은 그대로 살아남는다.
    #[test]
    fn keeps_utf8_lines_when_mixed_with_legacy_bytes() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice("정상 줄\n".as_bytes());
        // CP949 "지정" — UTF-8 로는 해석되지 않는 바이트열.
        bytes.extend_from_slice(&[0xC1, 0xF6, 0xC1, 0xA4]);
        bytes.push(b'\n');

        let decoded = decode_text(&bytes);
        let lines: Vec<&str> = decoded.split('\n').collect();

        assert_eq!(lines[0], "정상 줄");
        assert_eq!(lines[2], "");
        // Windows 에서는 OEM 코드 페이지로 되돌아가므로 대체 문자(U+FFFD)가 남지 않는다.
        #[cfg(windows)]
        assert!(
            !lines[1].contains('\u{FFFD}'),
            "CP949 줄이 깨진 채로 남았다: {:?}",
            lines[1]
        );
    }

    /// `dir` 처럼 cmd 내장 명령의 한글 출력이 깨지지 않아야 한다.
    #[cfg(windows)]
    #[test]
    fn windows_builtin_output_is_not_mojibake() {
        let (program, pre_args) = shell_for_test();
        let cwd = std::env::current_dir().expect("cwd");
        let outcome = run(
            &program,
            &pre_args,
            "chcp 65001>nul & dir",
            &cwd,
            None,
            Duration::from_secs(30),
            None,
        )
        .expect("실행 실패");

        let (stdout, _) = decode(outcome.stdout);
        assert!(
            !stdout.contains('\u{FFFD}'),
            "출력에 깨진 문자가 있다: {stdout}"
        );
    }

    #[test]
    fn cancel_unknown_token_is_false() {
        assert!(!cancel_token("존재하지-않는-토큰"));
    }

    /// 정상 종료한 명령의 출력은 그대로 잡혀야 한다 (청크 리더 회귀 방지).
    #[test]
    fn captures_output_of_a_normal_command() {
        let (program, pre_args) = shell_for_test();
        let cwd = std::env::current_dir().expect("cwd");
        let outcome = run(
            &program,
            &pre_args,
            "echo dongdong",
            &cwd,
            None,
            Duration::from_secs(30),
            None,
        )
        .expect("실행 실패");

        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.cancelled);
        assert!(!outcome.timed_out);
        assert!(String::from_utf8_lossy(&outcome.stdout).contains("dongdong"));
    }
}
