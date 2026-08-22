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

/// 세션이 모델 하나에 쓴 토큰 합계.
///
/// 요금 계산은 여기서 하지 않는다 — 요율표(`lib/ai/providers.ts`)가 프론트에 있고,
/// 같은 토큰이라도 모델마다 단가가 다르므로 **모델별로 나눠서** 올려 보낸다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelUsage {
    /// `provider:modelId`. 옛 기록이라 모델을 알 수 없으면 None.
    pub model_id: Option<String>,
    /// 이 모델로 부른 LLM 호출 수 (메인 턴 + 위임 실행)
    pub calls: i64,
    /// 캐시 읽기·쓰기를 **포함한** 전체 입력 토큰
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
}

/// 세션 목록 카드에 필요한 집계까지 얹은 형태.
/// `session` 을 flatten 하므로 프론트에서는 `Session` 을 확장한 하나의 객체로 보인다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOverview {
    #[serde(flatten)]
    pub session: Session,
    pub message_count: i64,
    pub last_message_at: Option<String>,
    /// 첫 사용자 메시지 앞부분 (세션 맵 카드 미리보기)
    pub preview: Option<String>,
    pub agent_run_count: i64,
    /// 누적 토큰 — 모델별로 나눠 담는다 (비용은 프론트가 요율표로 계산).
    pub usage_by_model: Vec<SessionModelUsage>,
    /// 이 세션의 **가장 최근** LLM 호출 usage 원문. 컨텍스트 잔량 추정에 쓴다.
    /// (활성 경로가 아니라 seq 최댓값 기준 — 정확한 값은 채팅 화면이 경로에서 다시 센다)
    pub last_usage: Option<serde_json::Value>,
    /// `last_usage` 를 만든 모델. 컨텍스트 창 크기를 이걸로 찾는다.
    pub last_usage_model: Option<String>,
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

/// 지워진 노드를 건너뛰고 부모가 바뀐 자식 하나.
///
/// 턴 하나만 지울 때 그 아래 대화가 잘려 나가지 않도록 살아남은 조상에 이어 붙인다.
/// 되돌리기가 원래 부모를 알아야 하므로 바뀌기 **전** 값도 함께 담는다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reattachment {
    pub message_id: String,
    pub from_parent_id: Option<String>,
    pub to_parent_id: Option<String>,
}

/// 노드가 사라져 연결이 끊긴 서브에이전트 실행.
///
/// 실행 기록 자체는 지우지 않는다 — 실제로 쓴 토큰이라 지우면 세션 비용이 조용히 줄어든다.
/// (`agent_runs.parent_message_id` 는 ON DELETE SET NULL 이라 링크만 끊긴다.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedRun {
    pub run_id: String,
    pub parent_message_id: String,
}

/// 노드 삭제 결과. **되돌리기에 필요한 것을 전부** 담는다.
///
/// 프론트가 이 값을 그대로 들고 있다가 `restore_messages` 로 돌려보내면
/// 지워진 노드가 원래 id·seq 로 되살아나고 자식들의 부모도 제자리로 돌아간다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    /// 지워진 노드 원문 (seq 오름차순 — 되돌릴 때 부모가 먼저 들어가야 한다)
    pub removed: Vec<Message>,
    pub reattached: Vec<Reattachment>,
    pub detached_runs: Vec<DetachedRun>,
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
    /// 지금 실행 중인 도구 이름 (스킬이 아니다 — v4 에서 이름을 고쳤다)
    pub current_tool: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    /// 이 실행이 쓴 토큰 (`StoredUsage` JSON). 서브에이전트는 대화 트리에
    /// 노드를 남기지 않으므로 여기 적지 않으면 비용 집계에서 통째로 빠진다.
    pub token_usage: Option<serde_json::Value>,
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
    pub current_tool: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub token_usage: Option<serde_json::Value>,
}
