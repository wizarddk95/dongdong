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
  Message,
  NewMessage,
  Project,
  Session,
  SessionOverview,
  SystemInfo,
} from "@/types/ipc";

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
  /** 턴 단위 삭제 — 앵커(user) 노드부터 하위 트리와 딸린 서브에이전트 기록까지 함께 지운다. */
  removeTurn: (anchorId: string) => Promise<void>;

  setActiveParent: (messageId: string | null) => void;
  selectMessage: (messageId: string | null) => void;
  /** 타임머신: 해당 노드 시점을 복제한 새 세션으로 이동 */
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
  return { ...session, messageCount: 0, lastMessageAt: null, preview: null, agentRunCount: 0 };
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
      const parentId = message.parentId ?? get().activeParentId ?? null;
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

  removeTurn: async (anchorId) => {
    // 턴의 앵커(user 노드)를 지우면 그 아래 응답/도구 노드가 CASCADE 로 함께 사라진다.
    // 딸린 서브에이전트 기록 정리는 호출부가 `agents.removeForMessages()` 로 맡는다
    // (스토어끼리 서로를 import 하지 않기 위해).
    await get().removeMessage(anchorId);
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
