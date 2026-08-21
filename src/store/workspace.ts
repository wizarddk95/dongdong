/**
 * 워크스페이스 전역 상태 — 열린 프로젝트, 세션, 대화 트리(노드).
 *
 * 스트리밍 같은 일시적 상태는 여기 두지 않는다 (`store/chat.ts` 담당).
 * 이 스토어는 항상 "DB 에 저장된 것"을 반영한다.
 */
import { create } from "zustand";

import { loadProjectInstructions, type ProjectInstructions } from "@/lib/ai/instructions";
import * as ipc from "@/lib/ipc";
import type {
  DeleteOutcome,
  Message,
  NewMessage,
  Project,
  Session,
  SessionOverview,
  SystemInfo,
} from "@/types/ipc";

/**
 * 방금 지운 것 한 건 — 되돌리기 표.
 * Rust 가 준 `outcome` 을 손대지 않고 그대로 돌려보내면 삭제 이전으로 돌아간다.
 * **메모리에만 산다** — 앱을 끄거나 프로젝트를 닫으면 사라진다.
 */
export interface Deletion {
  sessionId: string;
  outcome: DeleteOutcome;
  /** 되돌리기 버튼에 띄울 한 줄 */
  label: string;
}

/** 복사해 둔 노드 묶음(보통 턴 하나). 세션을 옮겨 다녀도 유지된다. */
export interface Clipboard {
  /** 복사한 원본이 있는 세션 — 붙여넣기는 다른 세션에도 할 수 있다 */
  sessionId: string;
  messageIds: string[];
  label: string;
}

interface WorkspaceState {
  project: Project | null;
  workspaceDir: string | null;
  dbPath: string | null;
  schemaVersion: number | null;
  system: SystemInfo | null;

  /** 프로젝트 루트의 AGENTS.md (없으면 null). 매 턴 컨텍스트 맨 앞에 실린다. */
  instructions: ProjectInstructions | null;

  sessions: SessionOverview[];
  activeSessionId: string | null;
  messages: Message[];
  /** 다음 메시지가 붙을 부모 노드. 여기서 갈라지면 세션 내 분기가 생긴다. */
  activeParentId: string | null;
  /** 노드 트리에서 선택(하이라이트)된 노드 */
  selectedMessageId: string | null;

  /** 되돌릴 수 있는 삭제들 (오래된 것부터). 세션별로 골라 쓴다. */
  deletions: Deletion[];
  clipboard: Clipboard | null;

  loading: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  closeProject: () => Promise<void>;

  /** AGENTS.md 를 다시 읽는다. 대화 중에 파일이 바뀔 수 있어 턴마다 호출된다. */
  loadInstructions: () => Promise<ProjectInstructions | null>;

  refreshSessions: () => Promise<void>;
  newSession: (title?: string) => Promise<Session | null>;
  selectSession: (sessionId: string) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;

  refreshMessages: () => Promise<void>;
  addMessage: (message: Omit<NewMessage, "sessionId">) => Promise<Message | null>;
  /** DB 를 거치지 않고 로컬 캐시만 교체 (스트리밍 종료 후 동기화용) */
  replaceMessage: (message: Message) => void;
  removeMessage: (messageId: string) => Promise<void>;
  /**
   * 노드 묶음(보통 턴 하나) 삭제.
   * `cascade` 가 false 면 그 노드들만 지우고 아래 대화는 살아남은 조상에 이어 붙는다.
   * 지운 내용은 되돌리기 스택에 쌓인다.
   */
  removeNodes: (
    messageIds: string[],
    options: { cascade: boolean; label: string },
  ) => Promise<boolean>;
  /** 현재 세션에서 마지막으로 지운 것을 되살린다. */
  undoDelete: () => Promise<boolean>;

  /** 턴 하나를 클립보드에 담는다 (DB 는 건드리지 않는다). */
  copyNodes: (messageIds: string[], label: string) => void;
  clearClipboard: () => void;
  /** 클립보드의 묶음을 복제해 지정한 노드 뒤에 잇는다. 세션이 달라도 된다. */
  pasteNodes: (targetParentId: string | null) => Promise<Message[] | null>;

  setActiveParent: (messageId: string | null) => void;
  selectMessage: (messageId: string | null) => void;
  /**
   * 타임머신: 해당 노드 시점을 복제한 새 세션으로 이동.
   * 지금은 화면에 진입점이 없다 — 분기는 그래프에서 턴을 고르는 길 하나로 모았다.
   * 예전에 만들어 둔 분기 세션은 세션 맵이 그대로 그린다.
   */
  branchFrom: (messageId: string, title?: string) => Promise<Session | null>;

  setError: (error: string | null) => void;
}

/** 스토어 액션 공통 래퍼: 로딩/에러 처리를 한곳에서 한다. */
async function guard<T>(
  set: (partial: Partial<WorkspaceState>) => void,
  action: () => Promise<T>,
): Promise<T | null> {
  set({ loading: true, error: null });
  try {
    return await action();
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    set({ loading: false });
  }
}

/** 방금 만든 세션은 집계가 없다. 목록을 다시 읽기 전까지 쓸 빈 값. */
function emptyOverview(session: Session): SessionOverview {
  return {
    ...session,
    messageCount: 0,
    lastMessageAt: null,
    preview: null,
    agentRunCount: 0,
    usageByModel: [],
    lastUsage: null,
    lastUsageModel: null,
  };
}

/**
 * 트리의 "현재 끝" 노드를 고른다.
 * 분기가 있으면 가장 최근에 만들어진 잎(seq 가 가장 큰 노드)을 이어간다.
 */
function latestLeaf(messages: Message[]): string | null {
  if (messages.length === 0) return null;
  const parents = new Set(messages.map((m) => m.parentId).filter(Boolean) as string[]);
  const leaves = messages.filter((m) => !parents.has(m.id));
  const pool = leaves.length > 0 ? leaves : messages;
  return pool.reduce((best, current) => (current.seq > best.seq ? current : best)).id;
}

/**
 * 트리를 건드린 뒤 로컬 캐시를 DB 와 맞춘다.
 * 사라진 노드를 가리키던 손가락(활성 부모·선택)은 살아 있는 잎으로 옮긴다 —
 * 없는 노드를 부모로 들고 있으면 다음 턴이 조용히 새 뿌리를 만든다.
 */
async function syncTree(
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
  sessionId: string,
) {
  const messages = await ipc.listMessages(sessionId);
  const alive = new Set(messages.map((m) => m.id));
  const parentId = get().activeParentId;
  const selectedId = get().selectedMessageId;
  set({
    messages,
    activeParentId: parentId && alive.has(parentId) ? parentId : latestLeaf(messages),
    selectedMessageId: selectedId && alive.has(selectedId) ? selectedId : null,
  });
}

/** 이 세션에서 마지막으로 지운 것의 위치. 없으면 -1. */
function lastDeletionIndex(deletions: Deletion[], sessionId: string): number {
  for (let index = deletions.length - 1; index >= 0; index -= 1) {
    if (deletions[index].sessionId === sessionId) return index;
  }
  return -1;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  project: null,
  workspaceDir: null,
  dbPath: null,
  schemaVersion: null,
  system: null,

  instructions: null,

  sessions: [],
  activeSessionId: null,
  messages: [],
  activeParentId: null,
  selectedMessageId: null,

  deletions: [],
  clipboard: null,

  loading: false,
  error: null,

  bootstrap: async () => {
    await guard(set, async () => {
      set({ system: await ipc.systemInfo() });
    });
  },

  openProject: async (path) => {
    await guard(set, async () => {
      const result = await ipc.openProject(path);
      set({
        project: result.project,
        workspaceDir: result.workspaceDir,
        dbPath: result.dbPath,
        schemaVersion: result.schemaVersion,
        sessions: result.sessions,
        activeSessionId: null,
        messages: [],
        activeParentId: null,
        selectedMessageId: null,
        deletions: [],
        clipboard: null,
        instructions: null,
      });

      // 지침을 못 읽어도 프로젝트는 열려야 한다.
      void get().loadInstructions();

      if (result.sessions.length === 0) {
        const session = await ipc.createSession({ title: "새 대화" });
        set({ sessions: [emptyOverview(session)] });
        await get().selectSession(session.id);
      } else {
        await get().selectSession(result.sessions[0].id);
      }
    });
  },

  closeProject: async () => {
    const project = get().project;
    if (!project) return;
    await guard(set, async () => {
      await ipc.closeProject(project.rootPath);
      set({
        project: null,
        workspaceDir: null,
        dbPath: null,
        schemaVersion: null,
        sessions: [],
        activeSessionId: null,
        messages: [],
        activeParentId: null,
        selectedMessageId: null,
        deletions: [],
        clipboard: null,
        instructions: null,
      });
    });
  },

  loadInstructions: async () => {
    if (!get().project) {
      set({ instructions: null });
      return null;
    }
    const instructions = await loadProjectInstructions();
    set({ instructions });
    return instructions;
  },

  refreshSessions: async () => {
    if (!get().project) return;
    await guard(set, async () => {
      set({ sessions: await ipc.listSessions() });
    });
  },

  newSession: async (title) => {
    if (!get().project) return null;
    return guard(set, async () => {
      const session = await ipc.createSession({ title: title ?? "새 대화" });
      set({ sessions: [emptyOverview(session), ...get().sessions] });
      await get().selectSession(session.id);
      return session;
    });
  },

  selectSession: async (sessionId) => {
    await guard(set, async () => {
      const messages = await ipc.listMessages(sessionId);
      set({
        activeSessionId: sessionId,
        messages,
        activeParentId: latestLeaf(messages),
        selectedMessageId: null,
      });
    });
  },

  removeSession: async (sessionId) => {
    await guard(set, async () => {
      await ipc.deleteSession(sessionId);
      const sessions = get().sessions.filter((s) => s.id !== sessionId);
      set({ sessions });
      if (get().activeSessionId === sessionId) {
        set({ activeSessionId: null, messages: [], activeParentId: null });
        if (sessions[0]) await get().selectSession(sessions[0].id);
      }
    });
  },

  renameSession: async (sessionId, title) => {
    await guard(set, async () => {
      await ipc.renameSession(sessionId, title);
      set({
        sessions: get().sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      });
    });
  },

  refreshMessages: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await guard(set, async () => {
      set({ messages: await ipc.listMessages(sessionId) });
    });
  },

  addMessage: async (message) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return null;

    return guard(set, async () => {
      // 세션의 뿌리는 하나뿐이다 — 붙일 곳을 잃었으면 새 뿌리 대신 마지막 잎에 잇는다.
      const parentId =
        message.parentId ?? get().activeParentId ?? latestLeaf(get().messages);
      const created = await ipc.appendMessage({ ...message, sessionId, parentId });
      set({ messages: [...get().messages, created], activeParentId: created.id });
      return created;
    });
  },

  replaceMessage: (message) => {
    set({
      messages: get().messages.map((m) => (m.id === message.id ? message : m)),
    });
  },

  removeMessage: async (messageId) => {
    await guard(set, async () => {
      await ipc.deleteMessage(messageId);
      // 하위 트리도 DB 에서 함께 지워지므로 통째로 다시 읽는다.
      const sessionId = get().activeSessionId;
      const messages = sessionId ? await ipc.listMessages(sessionId) : [];
      set({
        messages,
        activeParentId: latestLeaf(messages),
        selectedMessageId: null,
      });
    });
  },

  removeNodes: async (messageIds, { cascade, label }) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || messageIds.length === 0) return false;

    const outcome = await guard(set, async () => {
      const outcome = await ipc.deleteMessages(messageIds, cascade);
      set({ deletions: [...get().deletions, { sessionId, outcome, label }] });
      await syncTree(set, get, sessionId);
      return outcome;
    });
    return outcome != null;
  },

  undoDelete: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return false;

    const stack = get().deletions;
    const at = lastDeletionIndex(stack, sessionId);
    if (at < 0) return false;

    // 성공하든 실패하든 스택에서 뺀다 — 되돌릴 수 없게 된 항목이 버튼에 남아 있으면
    // 누를 때마다 같은 오류만 반복된다.
    const entry = stack[at];
    set({ deletions: stack.filter((_, index) => index !== at) });

    const done = await guard(set, async () => {
      await ipc.restoreMessages(entry.outcome);
      await syncTree(set, get, sessionId);
      return true;
    });
    return done === true;
  },

  copyNodes: (messageIds, label) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || messageIds.length === 0) return;
    set({ clipboard: { sessionId, messageIds, label } });
  },

  clearClipboard: () => set({ clipboard: null }),

  pasteNodes: async (targetParentId) => {
    const sessionId = get().activeSessionId;
    const clipboard = get().clipboard;
    if (!sessionId || !clipboard) return null;

    return guard(set, async () => {
      const copies = await ipc.copyMessages(clipboard.messageIds, targetParentId, sessionId);
      await syncTree(set, get, sessionId);
      // 붙여넣은 줄기의 끝에서 대화가 이어지도록 손가락을 옮긴다.
      const last = copies.at(-1);
      if (last) set({ activeParentId: last.id, selectedMessageId: last.id });
      return copies;
    });
  },

  setActiveParent: (messageId) => set({ activeParentId: messageId }),

  selectMessage: (messageId) => set({ selectedMessageId: messageId }),

  branchFrom: async (messageId, title) => {
    return guard(set, async () => {
      const session = await ipc.branchSession(messageId, title);
      set({ sessions: [emptyOverview(session), ...get().sessions] });
      await get().selectSession(session.id);
      // 분기 세션은 만들어질 때 이미 노드가 복제돼 있다 — 집계를 실제 값으로 맞춘다.
      void get().refreshSessions();
      return session;
    });
  },

  setError: (error) => set({ error }),
}));
