//! MCP JSON-RPC 계층 테스트.
//! 실제 서버를 띄우지 않고, 줄바꿈 구분 프로토콜만 메모리 파이프로 검증한다.

use std::io::Cursor;

use serde_json::{json, Value};

use super::mcp::{McpPeer, PROTOCOL_VERSION};

/// 서버가 보낼 줄들을 미리 적어 둔 가짜 연결.
fn peer(lines: &[&str]) -> McpPeer<Cursor<Vec<u8>>, Vec<u8>> {
    let payload = lines.join("\n") + "\n";
    McpPeer::new(Cursor::new(payload.into_bytes()), Vec::new())
}

/// 우리가 보낸 줄들을 JSON 으로 되읽는다.
fn sent(peer: &McpPeer<Cursor<Vec<u8>>, Vec<u8>>) -> Vec<Value> {
    String::from_utf8(peer.writer.clone())
        .expect("보낸 내용이 UTF-8 이어야 한다")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("보낸 줄은 JSON 이어야 한다"))
        .collect()
}

#[test]
fn handshake_sends_initialize_then_initialized() {
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"files","version":"0.2.0"}}}"#,
    ]);

    let result = peer.initialize().expect("핸드셰이크 실패");
    assert_eq!(
        result.pointer("/serverInfo/name").and_then(Value::as_str),
        Some("files")
    );

    let messages = sent(&peer);
    assert_eq!(messages.len(), 2, "initialize 요청과 initialized 알림");
    assert_eq!(messages[0]["method"], "initialize");
    assert_eq!(messages[0]["id"], 1);
    assert_eq!(messages[0]["params"]["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(messages[1]["method"], "notifications/initialized");
    assert!(messages[1].get("id").is_none(), "알림에는 id 가 없어야 한다");
}

#[test]
fn skips_logs_and_unrelated_messages_while_waiting() {
    let mut peer = peer(&[
        "서버가 stdout 에 흘린 로그 한 줄",
        r#"{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}"#,
        r#"{"jsonrpc":"2.0","id":99,"result":{"other":true}}"#,
        "",
        r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#,
    ]);

    let tools = peer.list_tools().expect("도구 목록 실패");
    assert!(tools.is_empty(), "내 id 의 응답만 받아야 한다");
}

#[test]
fn maps_error_responses_to_app_error() {
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#,
    ]);

    let error = peer.list_tools().expect_err("에러 응답은 실패로 이어져야 한다");
    let message = error.to_string();
    assert!(message.contains("tools/list"), "{message}");
    assert!(message.contains("Method not found"), "{message}");
    assert!(message.contains("-32601"), "{message}");
}

#[test]
fn reports_eof_when_the_server_dies() {
    let mut peer = peer(&[]);
    let error = peer.initialize().expect_err("EOF 는 실패여야 한다");
    assert!(error.to_string().contains("응답 없이 종료"), "{error}");
}

#[test]
fn collects_tools_across_pages() {
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read","description":"읽기","inputSchema":{"type":"object","properties":{"path":{"type":"string"}}}}],"nextCursor":"p2"}}"#,
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"write"}]}}"#,
    ]);

    let tools = peer.list_tools().expect("도구 목록 실패");
    assert_eq!(
        tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>(),
        vec!["read", "write"]
    );
    assert_eq!(tools[0].description.as_deref(), Some("읽기"));
    // inputSchema 가 없는 서버도 있다 — 빈 객체 스키마로 채운다.
    assert_eq!(tools[1].input_schema, json!({ "type": "object" }));

    let messages = sent(&peer);
    assert_eq!(messages[1]["params"]["cursor"], "p2", "다음 페이지 커서 전달");
}

#[test]
fn stops_when_the_cursor_stops_advancing() {
    // 같은 커서를 계속 돌려주는 서버에 매달리지 않아야 한다.
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"loop"}],"nextCursor":"same"}}"#,
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"loop"}],"nextCursor":"same"}}"#,
        r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"loop"}],"nextCursor":"same"}}"#,
    ]);

    let tools = peer.list_tools().expect("도구 목록 실패");
    // 진전 없는 커서를 확인한 시점(2페이지)에서 멈춰야 한다.
    assert_eq!(tools.len(), 2, "커서가 그대로면 더 요청하지 않는다");
}

#[test]
fn flattens_tool_call_content() {
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"첫 줄"},{"type":"image","data":"..."},{"type":"text","text":"둘째 줄"}]}}"#,
    ]);

    let result = peer
        .call_tool("read", json!({ "path": "a.ts" }))
        .expect("도구 호출 실패");

    assert_eq!(result.text, "첫 줄\n[image 파트]\n둘째 줄");
    assert!(!result.is_error);
    assert!(result.raw.get("content").is_some(), "원본도 함께 남긴다");

    let messages = sent(&peer);
    assert_eq!(messages[0]["method"], "tools/call");
    assert_eq!(messages[0]["params"]["name"], "read");
    assert_eq!(messages[0]["params"]["arguments"]["path"], "a.ts");
}

#[test]
fn marks_tool_errors_without_failing_the_call() {
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"파일 없음"}]}}"#,
    ]);

    // 도구 실행 실패는 프로토콜 실패가 아니다 — 모델이 읽고 대응해야 한다.
    let result = peer.call_tool("read", json!({})).expect("호출 자체는 성공");
    assert!(result.is_error);
    assert_eq!(result.text, "파일 없음");
}

#[test]
fn falls_back_to_structured_content() {
    let mut peer = peer(&[
        r#"{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"count":3}}}"#,
    ]);

    let result = peer.call_tool("count", json!({})).expect("도구 호출 실패");
    assert!(result.text.contains("\"count\":3"), "{}", result.text);
}

// ------------------------------------------------- 실제 프로세스 통합 테스트

/// 최소한의 MCP 서버. 핸드셰이크 → 도구 목록 → 도구 호출만 응답한다.
const FAKE_SERVER_JS: &str = r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

// stderr 로 로그를 흘리는 서버가 흔하다. 브리지가 이걸 계속 비워 주는지도 함께 본다.
process.stderr.write("fake mcp server booted\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "fake", version: "1.0.0" },
      capabilities: { tools: {} },
    }});
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "echo", description: "받은 문자열을 되돌려준다",
        inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ]}});
  } else if (message.method === "tools/call") {
    const text = (message.params && message.params.arguments && message.params.arguments.text) || "";
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo: " + text }] } });
  }
});
"#;

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[test]
fn talks_to_a_real_stdio_server() {
    // node 가 없는 환경에서는 건너뛴다. 프로토콜 자체는 위 단위 테스트가 덮는다.
    if !node_available() {
        eprintln!("node 가 없어 MCP 통합 테스트를 건너뜁니다");
        return;
    }

    let dir = std::env::temp_dir()
        .join("dongdong-tests")
        .join(format!("mcp-{}", crate::db::queries::new_id()));
    std::fs::create_dir_all(&dir).expect("임시 디렉터리 생성 실패");
    let script = dir.join("fake-mcp-server.cjs");
    std::fs::write(&script, FAKE_SERVER_JS).expect("가짜 서버 작성 실패");

    let config: super::mcp::McpServerConfig = serde_json::from_value(json!({
        "id": "fake",
        "name": "fake",
        "command": "node",
        "args": [script.to_string_lossy()],
        "timeoutMs": 20000,
    }))
    .expect("설정 역직렬화 실패");

    let registry = super::mcp::McpRegistry::default();
    let info = registry.connect(&config, None).expect("MCP 연결 실패");

    assert_eq!(info.server_name.as_deref(), Some("fake"));
    assert_eq!(info.protocol_version, "2025-06-18");
    assert_eq!(info.tools.len(), 1);
    assert_eq!(info.tools[0].name, "echo");

    let result = registry
        .call_tool("fake", "echo", json!({ "text": "안녕" }))
        .expect("도구 호출 실패");
    assert_eq!(result.text, "echo: 안녕");
    assert!(!result.is_error);

    // 같은 연결로 두 번 이상 부를 수 있어야 한다 (id 가 증가해도 응답을 제대로 짝짓는지).
    let again = registry
        .call_tool("fake", "echo", json!({ "text": "두 번째" }))
        .expect("두 번째 호출 실패");
    assert_eq!(again.text, "echo: 두 번째");

    assert_eq!(registry.list().unwrap().len(), 1);
    assert!(registry.disconnect("fake").unwrap());
    assert!(registry.list().unwrap().is_empty());
    assert!(
        !registry.disconnect("fake").unwrap(),
        "이미 끊긴 서버는 false"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reports_a_command_that_cannot_start() {
    let config: super::mcp::McpServerConfig = serde_json::from_value(json!({
        "id": "missing",
        "name": "없는 서버",
        "command": "dongdong-no-such-binary-xyz",
        "timeoutMs": 5000,
    }))
    .expect("설정 역직렬화 실패");

    let registry = super::mcp::McpRegistry::default();
    let error = registry
        .connect(&config, None)
        .expect_err("없는 명령은 실패해야 한다");

    // Windows 는 cmd 를 거치므로 spawn 자체는 성공하고 핸드셰이크에서 걸린다.
    let message = error.to_string();
    assert!(
        message.contains("실행하지 못했습니다") || message.contains("응답 없이 종료"),
        "{message}"
    );
    assert!(registry.list().unwrap().is_empty(), "실패한 서버는 남지 않는다");
}
