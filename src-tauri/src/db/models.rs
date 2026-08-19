use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub root_path: String,
    pub name: String,
    /// JSON 문자열이 아닌 파싱된 값으로 전달한다.
    pub settings: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub parent_session_id: Option<String>,
    pub branched_from_message_id: Option<String>,
    pub model: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub parent_id: Option<String>,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<serde_json::Value>,
    pub tool_results: Option<serde_json::Value>,
    pub context_snapshot: Option<serde_json::Value>,
    pub token_usage: Option<serde_json::Value>,
    pub status: String,
    pub agent_id: Option<String>,
    pub seq: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 메시지 생성 입력. 프론트엔드에서 그대로 보낸다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    pub session_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_results: Option<serde_json::Value>,
    #[serde(default)]
    pub context_snapshot: Option<serde_json::Value>,
    #[serde(default)]
    pub token_usage: Option<serde_json::Value>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePatch {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_results: Option<serde_json::Value>,
    #[serde(default)]
    pub context_snapshot: Option<serde_json::Value>,
    #[serde(default)]
    pub token_usage: Option<serde_json::Value>,
    #[serde(default)]
    pub status: Option<String>,
}

/// 에이전트 메모리. 프로젝트 전역(`project`) 또는 세션 한정(`session`) 으로 축적된다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub project_id: String,
    /// scope 가 `session` 일 때만 채워진다.
    pub session_id: Option<String>,
    pub scope: String,
    pub key: String,
    pub value: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 메모리 저장 입력. 같은 (scope, session_id, key) 면 값을 덮어쓴다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemory {
    /// project | session (기본값 project)
    #[serde(default)]
    pub scope: Option<String>,
    /// scope 가 `session` 이면 필수.
    #[serde(default)]
    pub session_id: Option<String>,
    pub key: String,
    pub value: String,
}

/// 서브에이전트 실행 1건. 메인 에이전트의 `delegate_task` 호출마다 하나씩 생긴다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub session_id: String,
    /// 이 실행을 촉발한 assistant 메시지
    pub parent_message_id: Option<String>,
    pub name: String,
    pub task: String,
    /// pending | running | succeeded | failed | cancelled
    pub status: String,
    /// 0.0 ~ 1.0
    pub progress: f64,
    /// 지금 실행 중인 Skill 이름
    pub current_skill: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentRun {
    pub session_id: String,
    #[serde(default)]
    pub parent_message_id: Option<String>,
    pub name: String,
    pub task: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunPatch {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub current_skill: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}
