/**
 * Tauri IPC 얇은 래퍼.
 *
 * 앱 코드는 `invoke()` 를 직접 부르지 않고 항상 이 모듈을 통한다.
 * 여기 함수들을 Vercel AI SDK 의 도구로 감싼 것이 `lib/ai/tools.ts` 다.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  AgentRun,
  AgentRunPatch,
  DeleteOutcome,
  DirEntry,
  FileContent,
  McpServerConfig,
  McpServerInfo,
  McpToolResult,
  Memory,
  Message,
  MessagePatch,
  NewAgentRun,
  NewMemory,
  NewMessage,
  OpenProjectResult,
  PathInfo,
  Project,
  Session,
  SessionOverview,
  ShellOptions,
  ShellResult,
  SkillDirs,
  SkillFile,
  SystemInfo,
  WriteResult,
} from "@/types/ipc";

/** Rust 쪽 에러는 문자열로 내려온다. 호출부에서 쓰기 좋게 Error 로 바꾼다. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : String(error));
  }
}

// ------------------------------------------------------------- workspace

export const openProject = (path: string) =>
  call<OpenProjectResult>("open_project", { path });

export const closeProject = (path: string) => call<boolean>("close_project", { path });

export const setActiveProject = (path: string) => call<void>("set_active_project", { path });

export const listOpenProjects = () => call<Project[]>("list_open_projects");

export const getActiveProject = () => call<Project | null>("get_active_project");

export const updateProjectSettings = (settings: Record<string, unknown>, projectPath?: string) =>
  call<Project>("update_project_settings", { settings, projectPath });

export const systemInfo = () => call<SystemInfo>("system_info");

// --------------------------------------------------------- app settings

/** API 키 등 사용자 단위 설정. OS 앱 설정 디렉터리의 settings.json 에 저장된다. */
export const readAppSettings = () => call<Record<string, unknown>>("read_app_settings");

export const writeAppSettings = (settings: Record<string, unknown>) =>
  call<Record<string, unknown>>("write_app_settings", { settings });

export const appSettingsPath = () => call<string>("app_settings_path");

// ------------------------------------------------------------- 스킬 문서

/** 스킬 문서를 두는 두 디렉터리. 전역 쪽은 없으면 만들어 준다. */
export const skillDirs = (projectPath?: string) => call<SkillDirs>("skill_dirs", { projectPath });

/** 전역 + 프로젝트의 스킬 문서 원문. 프로젝트가 뒤에 오므로 같은 이름이면 프로젝트가 이긴다. */
export const listSkillFiles = (projectPath?: string) =>
  call<SkillFile[]>("list_skill_files", { projectPath });

export const createSkillFile = (
  name: string,
  scope: "user" | "project",
  content: string,
  projectPath?: string,
) => call<string>("create_skill_file", { name, scope, content, projectPath });

/** 스킬 디렉터리 안의 경로만 받는다 (Rust 가 확인한다). */
export const deleteSkillFile = (path: string, projectPath?: string) =>
  call<boolean>("delete_skill_file", { path, projectPath });

// ----------------------------------------------------------------- shell

export const executeShellCommand = (command: string, options?: ShellOptions) =>
  call<ShellResult>("execute_shell_command", { command, options });

/** 실행 중인 셸 명령을 중단한다 (`ShellOptions.cancelToken` 과 같은 값). */
export const cancelShellCommand = (token: string) =>
  call<boolean>("cancel_shell_command", { token });

// -------------------------------------------------------------------- fs

export const readFile = (path: string, projectPath?: string) =>
  call<FileContent>("read_file", { path, projectPath });

export const writeFile = (
  path: string,
  content: string,
  options?: { projectPath?: string; createDirs?: boolean; append?: boolean },
) =>
  call<WriteResult>("write_file", {
    path,
    content,
    projectPath: options?.projectPath,
    createDirs: options?.createDirs,
    append: options?.append,
  });

export const listDirectory = (
  path?: string,
  options?: { projectPath?: string; includeHidden?: boolean },
) =>
  call<DirEntry[]>("list_directory", {
    path,
    projectPath: options?.projectPath,
    includeHidden: options?.includeHidden,
  });

export const createDirectory = (path: string, projectPath?: string) =>
  call<string>("create_directory", { path, projectPath });

export const deletePath = (path: string, options?: { projectPath?: string; recursive?: boolean }) =>
  call<boolean>("delete_path", {
    path,
    projectPath: options?.projectPath,
    recursive: options?.recursive,
  });

export const pathInfo = (path: string, projectPath?: string) =>
  call<PathInfo>("path_info", { path, projectPath });

// ------------------------------------------------------ sessions & nodes

export const createSession = (options?: {
  title?: string;
  model?: string;
  projectPath?: string;
}) => call<Session>("create_session", options ?? {});

/** 세션 목록. 노드 수·마지막 활동·미리보기 같은 집계가 함께 온다. */
export const listSessions = (projectPath?: string) =>
  call<SessionOverview[]>("list_sessions", { projectPath });

export const getSession = (sessionId: string, projectPath?: string) =>
  call<Session | null>("get_session", { sessionId, projectPath });

export const renameSession = (sessionId: string, title: string, projectPath?: string) =>
  call<void>("rename_session", { sessionId, title, projectPath });

export const deleteSession = (sessionId: string, projectPath?: string) =>
  call<void>("delete_session", { sessionId, projectPath });

export const appendMessage = (message: NewMessage, projectPath?: string) =>
  call<Message>("append_message", { message, projectPath });

export const listMessages = (sessionId: string, projectPath?: string) =>
  call<Message[]>("list_messages", { sessionId, projectPath });

/** 루트 → 지정 노드까지의 조상 체인. LLM 컨텍스트 구성의 기준이 된다. */
export const getMessagePath = (messageId: string, projectPath?: string) =>
  call<Message[]>("get_message_path", { messageId, projectPath });

export const updateMessage = (messageId: string, patch: MessagePatch, projectPath?: string) =>
  call<Message>("update_message", { messageId, patch, projectPath });

export const deleteMessage = (messageId: string, projectPath?: string) =>
  call<void>("delete_message", { messageId, projectPath });

/**
 * 노드 묶음(보통 턴 하나)을 지운다.
 * `cascade` 가 false 면 넘어온 노드만 지우고 그 아래 대화는 살아남은 조상에 이어 붙는다.
 * 돌려받은 값을 그대로 들고 있다가 `restoreMessages()` 에 넘기면 되돌아간다.
 */
export const deleteMessages = (
  messageIds: string[],
  cascade: boolean,
  projectPath?: string,
) => call<DeleteOutcome>("delete_messages", { messageIds, cascade, projectPath });

export const restoreMessages = (outcome: DeleteOutcome, projectPath?: string) =>
  call<number>("restore_messages", { outcome, projectPath });

/** 노드 묶음을 복제해 다른 노드 뒤에 이어 붙인다. 세션을 넘나들 수 있다. */
export const copyMessages = (
  sourceIds: string[],
  targetParentId: string | null,
  sessionId: string,
  projectPath?: string,
) => call<Message[]>("copy_messages", { sourceIds, targetParentId, sessionId, projectPath });

/** 타임머신: 해당 노드 시점까지를 복제한 새 브랜치 세션을 만든다. */
export const branchSession = (messageId: string, title?: string, projectPath?: string) =>
  call<Session>("branch_session", { messageId, title, projectPath });

// ------------------------------------------------------------- memories

/** 같은 (scope, session, key) 면 값을 덮어쓴다. */
export const upsertMemory = (memory: NewMemory, projectPath?: string) =>
  call<Memory>("upsert_memory", { memory, projectPath });

/** 프로젝트 전역 메모리 + (세션을 넘기면) 그 세션 전용 메모리. */
export const listMemories = (sessionId?: string | null, projectPath?: string) =>
  call<Memory[]>("list_memories", { sessionId, projectPath });

export const getMemory = (
  key: string,
  options?: { scope?: string; sessionId?: string | null; projectPath?: string },
) =>
  call<Memory | null>("get_memory", {
    key,
    scope: options?.scope,
    sessionId: options?.sessionId,
    projectPath: options?.projectPath,
  });

export const deleteMemory = (memoryId: string, projectPath?: string) =>
  call<boolean>("delete_memory", { memoryId, projectPath });

// ----------------------------------------------------------- agent runs

/** 서브에이전트 실행을 pending 상태로 등록한다. */
export const createAgentRun = (run: NewAgentRun, projectPath?: string) =>
  call<AgentRun>("create_agent_run", { run, projectPath });

export const listAgentRuns = (sessionId: string, projectPath?: string) =>
  call<AgentRun[]>("list_agent_runs", { sessionId, projectPath });

export const updateAgentRun = (runId: string, patch: AgentRunPatch, projectPath?: string) =>
  call<AgentRun>("update_agent_run", { runId, patch, projectPath });

export const deleteAgentRun = (runId: string, projectPath?: string) =>
  call<boolean>("delete_agent_run", { runId, projectPath });

/** 앱이 죽어서 running 인 채 남은 실행을 실패로 정리한다. 세션을 열 때 호출. */
export const reapAgentRuns = (sessionId: string, projectPath?: string) =>
  call<number>("reap_agent_runs", { sessionId, projectPath });

// ------------------------------------------------------------------- MCP

/** 서버를 띄우고 핸드셰이크 + 도구 목록까지 받아 온다. */
export const mcpConnect = (config: McpServerConfig, projectPath?: string) =>
  call<McpServerInfo>("mcp_connect", { config, projectPath });

/** `cancelToken` 을 함께 넘기면 같은 값으로 `mcpCancelTool` 을 불러 중단할 수 있다. */
export const mcpCallTool = (
  serverId: string,
  name: string,
  args?: unknown,
  cancelToken?: string,
) => call<McpToolResult>("mcp_call_tool", { serverId, name, arguments: args ?? {}, cancelToken });

/**
 * 진행 중인 도구 호출을 중단한다. 파이프 읽기가 블로킹이라 서버 프로세스를 죽여야
 * 읽기가 풀린다 → 그 서버 연결도 함께 끊긴다(부른 쪽이 다시 붙인다).
 */
export const mcpCancelTool = (cancelToken: string) =>
  call<boolean>("mcp_cancel_tool", { cancelToken });

export const mcpDisconnect = (serverId: string) =>
  call<boolean>("mcp_disconnect", { serverId });

export const mcpListServers = () => call<McpServerInfo[]>("mcp_list_servers");

/** 연결이 안 될 때 원인을 보기 위한 서버 stderr 최근 로그. */
export const mcpServerLogs = (serverId: string) =>
  call<string[]>("mcp_server_logs", { serverId });
