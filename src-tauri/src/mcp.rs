//! MCP(Model Context Protocol) stdio 클라이언트.
//!
//! 외부 MCP 서버를 자식 프로세스로 띄우고, 줄바꿈으로 구분된 JSON-RPC 2.0 메시지를
//! stdin/stdout 으로 주고받는다. 도커 없이 사용자 권한으로 그대로 실행하는 것은
//! 쉘 command 와 같은 원칙이다.
//!
//! 파이프 읽기는 블로킹이므로 모든 호출은 `spawn_blocking` 워커에서 이루어져야 한다.
//! 응답이 영영 오지 않는 서버에 매달리지 않도록, 요청마다 감시 스레드를 두고
//! 시간이 지나면 자식 프로세스를 kill 해서 읽기를 EOF 로 풀어 준다.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::queries::now;
use crate::error::{AppError, AppResult};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 우리가 요청하는 프로토콜 버전. 서버가 다른 버전을 답하면 그대로 받아들인다.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
const CLIENT_NAME: &str = "dongdong";

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// tools/list 페이지네이션이 끝나지 않는 서버를 대비한 상한.
const MAX_TOOL_PAGES: usize = 20;
/// 서버가 stderr 로 흘리는 로그는 최근 것만 들고 있는다 (진단용).
const MAX_LOG_LINES: usize = 200;

// ------------------------------------------------------------------ 타입

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 생략하면 프로젝트 루트에서 실행한다.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    /// JSON Schema. 프론트가 AI SDK 도구의 inputSchema 로 그대로 쓴다.
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
    /// 실제로 합의된 버전 (서버가 답한 값)
    pub protocol_version: String,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Vec<McpTool>,
    pub connected_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    /// content 파트를 텍스트로 이어 붙인 것 — LLM 에게 그대로 보낸다.
    pub text: String,
    pub is_error: bool,
    /// 서버가 돌려준 원본 (인스펙터용)
    pub raw: Value,
}

// -------------------------------------------------------- JSON-RPC 피어

/// 줄바꿈 구분 JSON-RPC 한 쌍. 전송 계층과 분리해 두어 테스트할 수 있다.
pub struct McpPeer<R: BufRead, W: Write> {
    reader: R,
    pub(crate) writer: W,
    next_id: i64,
}

impl<R: BufRead, W: Write> McpPeer<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer,
            next_id: 0,
        }
    }

    fn send(&mut self, message: &Value) -> AppResult<()> {
        // stdio 전송에서는 JSON 한 줄이 메시지 하나다 (Content-Length 헤더 없음).
        let line = serde_json::to_string(message)?;
        self.writer.write_all(line.as_bytes())?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn notify(&mut self, method: &str, params: Value) -> AppResult<()> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    pub fn request(&mut self, method: &str, params: Value) -> AppResult<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        self.await_response(id, method)
    }

    /// 내 id 의 응답이 올 때까지 읽는다. 알림·다른 id·JSON 이 아닌 줄은 흘려보낸다.
    fn await_response(&mut self, id: i64, method: &str) -> AppResult<Value> {
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line)? == 0 {
                return Err(AppError::invalid(format!(
                    "MCP 서버가 응답 없이 종료했습니다 ({method})"
                )));
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // stdout 에 로그를 섞어 쓰는 서버가 있다. JSON 이 아니면 무시한다.
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if message.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }

            if let Some(error) = message.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("알 수 없는 오류");
                return Err(AppError::invalid(format!(
                    "MCP {method} 실패 ({code}): {detail}"
                )));
            }

            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// initialize 요청 + initialized 알림까지의 핸드셰이크.
    pub fn initialize(&mut self) -> AppResult<Value> {
        let result = self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        self.notify("notifications/initialized", json!({}))?;
        Ok(result)
    }

    pub fn list_tools(&mut self) -> AppResult<Vec<McpTool>> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;

        for _ in 0..MAX_TOOL_PAGES {
            let params = match &cursor {
                Some(value) => json!({ "cursor": value }),
                None => json!({}),
            };
            let result = self.request("tools/list", params)?;

            for item in result
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                if let Some(tool) = parse_tool(&item) {
                    tools.push(tool);
                }
            }

            let next = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            // 커서가 그대로면 무한 루프다. 진전이 없으면 멈춘다.
            if next.is_none() || next == cursor {
                break;
            }
            cursor = next;
        }

        Ok(tools)
    }

    pub fn call_tool(&mut self, name: &str, arguments: Value) -> AppResult<McpToolResult> {
        let result = self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )?;
        Ok(parse_tool_result(result))
    }
}

/// tools/list 항목 하나. name 이 없으면 쓸 수 없으므로 버린다.
fn parse_tool(item: &Value) -> Option<McpTool> {
    let name = item.get("name").and_then(Value::as_str)?.to_string();
    Some(McpTool {
        name,
        description: item
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        input_schema: item
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object" })),
    })
}

/// tools/call 결과의 content 파트를 텍스트로 평탄화한다.
fn parse_tool_result(result: Value) -> McpToolResult {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for part in content {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                // 텍스트가 아닌 파트(이미지·리소스)는 원본을 남기고 요약만 적는다.
                Some(kind) => parts.push(format!("[{kind} 파트]")),
                None => {}
            }
        }
    }

    // 구조화된 출력만 주는 서버도 있다.
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(structured.to_string());
        }
    }

    McpToolResult {
        text: parts.join("\n"),
        is_error,
        raw: result,
    }
}

// ------------------------------------------------------------ 연결/레지스트리

struct McpConnection {
    child: Arc<Mutex<Child>>,
    peer: McpPeer<BufReader<ChildStdout>, ChildStdin>,
    info: McpServerInfo,
    timeout: Duration,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        // 앱이 닫히거나 연결을 끊으면 자식 프로세스도 함께 정리한다.
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 실행 중인 MCP 서버들. `Arc` 내부 상태라 clone 해서 워커 스레드로 넘길 수 있다.
#[derive(Default, Clone)]
pub struct McpRegistry {
    servers: Arc<Mutex<HashMap<String, Arc<Mutex<McpConnection>>>>>,
}

/// 블로킹 요청이 영원히 멈추지 않도록 감시한다.
/// 시간이 지나면 자식을 kill 해서 읽기를 EOF 로 풀고, 그 사실을 에러 메시지에 남긴다.
fn with_timeout<T>(
    child: &Arc<Mutex<Child>>,
    timeout: Duration,
    label: &str,
    work: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let done = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(AtomicBool::new(false));

    {
        let done = done.clone();
        let killed = killed.clone();
        let child = child.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + timeout;
            while Instant::now() < deadline {
                if done.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !done.load(Ordering::Relaxed) {
                killed.store(true, Ordering::Relaxed);
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
            }
        });
    }

    let result = work();
    done.store(true, Ordering::Relaxed);

    match result {
        Err(error) if killed.load(Ordering::Relaxed) => Err(AppError::invalid(format!(
            "MCP 서버가 {}초 안에 응답하지 않아 종료했습니다 ({label})",
            timeout.as_secs()
        ))),
        other => other,
    }
}

/// stderr 를 흘려보내면 파이프가 차서 서버가 멈춘다. 별도 스레드에서 계속 비워 준다.
fn drain_stderr(stream: impl Read + Send + 'static, logs: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Ok(mut logs) = logs.lock() {
                if logs.len() >= MAX_LOG_LINES {
                    logs.pop_front();
                }
                logs.push_back(line);
            }
        }
    });
}

fn build_command(config: &McpServerConfig, cwd: Option<&PathBuf>) -> Command {
    // Windows 의 npx / uvx 는 .cmd 셸 스크립트라 직접 spawn 되지 않는다. cmd 를 거친다.
    #[cfg(windows)]
    let mut cmd = if config.command.to_lowercase().ends_with(".exe") {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args);
        cmd
    } else {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(&config.command).args(&config.args);
        cmd
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args);
        cmd
    };

    if let Some(dir) = config.cwd.as_ref().map(PathBuf::from).or_else(|| cwd.cloned()) {
        cmd.current_dir(dir);
    }
    for (key, value) in &config.env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd
}

impl McpRegistry {
    /// 서버를 띄우고 핸드셰이크 + 도구 목록까지 마친다. (블로킹)
    pub fn connect(
        &self,
        config: &McpServerConfig,
        default_cwd: Option<PathBuf>,
    ) -> AppResult<McpServerInfo> {
        if config.command.trim().is_empty() {
            return Err(AppError::invalid("MCP 서버 실행 명령이 비어 있습니다"));
        }
        // 같은 id 로 다시 연결하면 기존 프로세스는 정리한다.
        self.disconnect(&config.id)?;

        let mut child = build_command(config, default_cwd.as_ref())
            .spawn()
            .map_err(|error| {
                AppError::invalid(format!(
                    "MCP 서버를 실행하지 못했습니다 ({}): {error}",
                    config.command
                ))
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::invalid("MCP 서버 stdin 을 열지 못했습니다"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::invalid("MCP 서버 stdout 을 열지 못했습니다"))?;
        let logs: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            drain_stderr(stderr, logs.clone());
        }

        let child = Arc::new(Mutex::new(child));
        let timeout = Duration::from_millis(config.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
        let mut peer = McpPeer::new(BufReader::new(stdout), stdin);

        let handshake = with_timeout(&child, timeout, "initialize", || peer.initialize());
        let handshake = match handshake {
            Ok(value) => value,
            Err(error) => return Err(self.with_logs(error, &logs)),
        };

        let tools = match with_timeout(&child, timeout, "tools/list", || peer.list_tools()) {
            Ok(tools) => tools,
            Err(error) => return Err(self.with_logs(error, &logs)),
        };

        let info = McpServerInfo {
            id: config.id.clone(),
            name: config.name.clone(),
            protocol_version: handshake
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION)
                .to_string(),
            server_name: handshake
                .pointer("/serverInfo/name")
                .and_then(Value::as_str)
                .map(str::to_string),
            server_version: handshake
                .pointer("/serverInfo/version")
                .and_then(Value::as_str)
                .map(str::to_string),
            tools,
            connected_at: now(),
        };

        let connection = McpConnection {
            child,
            peer,
            info: info.clone(),
            timeout,
            logs,
        };
        self.lock()?
            .insert(config.id.clone(), Arc::new(Mutex::new(connection)));

        Ok(info)
    }

    pub fn call_tool(&self, server_id: &str, name: &str, arguments: Value) -> AppResult<McpToolResult> {
        let connection = self
            .lock()?
            .get(server_id)
            .cloned()
            .ok_or_else(|| AppError::not_found(format!("MCP 서버 {server_id}")))?;

        let mut connection = connection
            .lock()
            .map_err(|_| AppError::invalid("MCP 연결 잠금 실패 (poisoned)"))?;

        let child = connection.child.clone();
        let timeout = connection.timeout;
        let logs = connection.logs.clone();

        let result = with_timeout(&child, timeout, name, || {
            connection.peer.call_tool(name, arguments)
        });

        match result {
            Ok(value) => Ok(value),
            // 연결이 끊긴 서버는 목록에서 빼서 상태가 거짓말하지 않게 한다.
            Err(error) => {
                drop(connection);
                self.lock()?.remove(server_id);
                Err(self.with_logs(error, &logs))
            }
        }
    }

    pub fn disconnect(&self, server_id: &str) -> AppResult<bool> {
        // 제거 시 Drop 이 자식 프로세스를 kill 한다.
        Ok(self.lock()?.remove(server_id).is_some())
    }

    pub fn list(&self) -> AppResult<Vec<McpServerInfo>> {
        let servers = self.lock()?;
        let mut out = Vec::new();
        for connection in servers.values() {
            if let Ok(connection) = connection.lock() {
                out.push(connection.info.clone());
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 서버가 stderr 로 남긴 최근 로그. 연결 실패 원인을 볼 때 쓴다.
    pub fn logs(&self, server_id: &str) -> AppResult<Vec<String>> {
        let connection = self.lock()?.get(server_id).cloned();
        let Some(connection) = connection else {
            return Ok(Vec::new());
        };
        let connection = connection
            .lock()
            .map_err(|_| AppError::invalid("MCP 연결 잠금 실패 (poisoned)"))?;
        let logs = connection
            .logs
            .lock()
            .map_err(|_| AppError::invalid("MCP 로그 잠금 실패 (poisoned)"))?;
        Ok(logs.iter().cloned().collect())
    }

    /// 실패 메시지에 서버의 마지막 stderr 를 붙여 준다 (원인 추적용).
    fn with_logs(&self, error: AppError, logs: &Arc<Mutex<VecDeque<String>>>) -> AppError {
        let tail: Vec<String> = logs
            .lock()
            .map(|logs| logs.iter().rev().take(5).rev().cloned().collect())
            .unwrap_or_default();
        if tail.is_empty() {
            return error;
        }
        AppError::invalid(format!("{error}\n서버 로그:\n{}", tail.join("\n")))
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<McpConnection>>>>> {
        self.servers
            .lock()
            .map_err(|_| AppError::invalid("MCP 레지스트리 잠금 실패 (poisoned)"))
    }
}
