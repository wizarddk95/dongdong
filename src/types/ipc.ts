/**
 * Rust 백엔드(serde, camelCase)와 1:1 대응하는 타입들.
 * src-tauri/src/db/models.rs, commands/*.rs 를 수정하면 여기도 함께 고쳐야 한다.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Project {
  id: string;
  rootPath: string;
  name: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  /** 타임머신 분기 시 원본 세션 */
  parentSessionId: string | null;
  branchedFromMessageId: string | null;
  model: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/**
 * 세션이 모델 하나에 쓴 토큰 합계. 요금은 모델마다 단가가 달라서
 * Rust 는 토큰만 모델별로 나눠 올려 보내고, 계산은 `lib/ai/usage.ts` 가 한다.
 */
export interface SessionModelUsage {
  /** `provider:modelId`. 모델을 알 수 없는 옛 기록이면 null */
  modelId: string | null;
  /** 이 모델로 부른 LLM 호출 수 (메인 턴 + 위임 실행) */
  calls: number;
  /** 캐시 읽기·쓰기를 포함한 전체 입력 토큰 */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** 세션 목록/맵 카드용 — Session 에 집계를 얹은 형태 (Rust 는 serde flatten 으로 내려준다). */
export interface SessionOverview extends Session {
  messageCount: number;
  lastMessageAt: string | null;
  /** 첫 사용자 메시지 앞 120자 */
  preview: string | null;
  agentRunCount: number;
  /** 누적 토큰 (서브에이전트 포함). 비용은 프론트가 요율표로 계산한다 */
  usageByModel: SessionModelUsage[];
  /** 가장 최근 LLM 호출의 usage 원문 — 컨텍스트 잔량 추정용 */
  lastUsage: unknown | null;
  /** `lastUsage` 를 만든 모델. 컨텍스트 창 크기를 이걸로 찾는다 */
  lastUsageModel: string | null;
}

/** 대화 트리의 노드. React Flow 노드와 1:1 로 매핑된다. */
export interface Message {
  id: string;
  sessionId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  toolCalls: unknown | null;
  toolResults: unknown | null;
  /** 이 시점에 LLM 으로 보낸 컨텍스트 원문 (Context Inspector 용) */
  contextSnapshot: unknown | null;
  tokenUsage: unknown | null;
  status: string;
  agentId: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewMessage {
  sessionId: string;
  parentId?: string | null;
  role: MessageRole;
  content?: string;
  toolCalls?: unknown | null;
  toolResults?: unknown | null;
  contextSnapshot?: unknown | null;
  tokenUsage?: unknown | null;
  status?: string | null;
  agentId?: string | null;
}

export interface MessagePatch {
  content?: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  contextSnapshot?: unknown;
  tokenUsage?: unknown;
  status?: string;
}

/** 에이전트 메모리. `scope` 가 session 이면 해당 세션에서만 보인다. */
export type MemoryScope = "project" | "session";

export interface Memory {
  id: string;
  projectId: string;
  sessionId: string | null;
  scope: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory {
  scope?: MemoryScope;
  sessionId?: string | null;
  key: string;
  value: string;
}

/** 서브에이전트 실행 1건. `delegate_task` 호출마다 하나씩 생긴다. */
export type AgentStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  sessionId: string;
  parentMessageId: string | null;
  name: string;
  task: string;
  status: string;
  /** 0.0 ~ 1.0 */
  progress: number;
  currentSkill: string | null;
  result: string | null;
  error: string | null;
  /** 이 실행이 쓴 토큰 (`StoredUsage` JSON). 서브에이전트는 노드를 남기지 않는다 */
  tokenUsage: unknown | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface NewAgentRun {
  sessionId: string;
  parentMessageId?: string | null;
  name: string;
  task: string;
}

export interface AgentRunPatch {
  status?: AgentStatus;
  progress?: number;
  currentSkill?: string;
  result?: string;
  error?: string;
  tokenUsage?: unknown;
}

/** MCP 서버 실행 설정. 앱 설정(settings.json)에 저장된다. */
export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 생략하면 프로젝트 루트에서 실행 */
  cwd?: string;
  timeoutMs?: number;
  /** 앱 시작 시 자동 연결할지 (Rust 는 이 필드를 무시한다) */
  enabled?: boolean;
}

export interface McpTool {
  name: string;
  description: string | null;
  /** JSON Schema 원문 */
  inputSchema: unknown;
}

export interface McpServerInfo {
  id: string;
  name: string;
  protocolVersion: string;
  serverName: string | null;
  serverVersion: string | null;
  tools: McpTool[];
  connectedAt: string;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

export interface OpenProjectResult {
  project: Project;
  workspaceDir: string;
  dbPath: string;
  schemaVersion: number;
  sessions: SessionOverview[];
}

export interface SystemInfo {
  os: string;
  arch: string;
  defaultShell: string;
  pathSeparator: string;
  homeDir: string | null;
  cwd: string;
}

export type ShellKind = "auto" | "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "zsh";

export interface ShellOptions {
  cwd?: string;
  shell?: ShellKind;
  env?: Record<string, string>;
  timeoutMs?: number;
  projectPath?: string;
  /** 중단용 토큰. 같은 값으로 cancelShellCommand 를 부르면 프로세스 트리를 죽인다. */
  cancelToken?: string;
}

export interface ShellResult {
  command: string;
  shell: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  timedOut: boolean;
  /** 사용자가 중단해서 끝난 경우 */
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface FileContent {
  path: string;
  relativePath: string;
  content: string;
  size: number;
  truncated: boolean;
  isBinary: boolean;
}

export interface WriteResult {
  path: string;
  relativePath: string;
  bytesWritten: number;
  created: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  relativePath: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: string | null;
}

export interface PathInfo {
  path: string;
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  size: number;
}
