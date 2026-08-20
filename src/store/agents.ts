/**
 * 서브에이전트 인스턴스 상태.
 *
 * 실행 자체는 프론트에서 돌리고(`lib/ai/subagent.ts`), 상태는 `agent_runs` 테이블에
 * 영속화한다. 대시보드는 이 스토어만 본다.
 *
 * DB 쓰기는 상태가 바뀌는 지점(시작 / 스텝 종료 / 종료)에서만 한다 —
 * 채팅 스트리밍과 같은 원칙이다.
 */
import { create } from "zustand";

import { instructionBlock } from "@/lib/ai/instructions";
import { MissingApiKeyError } from "@/lib/ai/providers";
import { buildSkills } from "@/lib/ai/skills";
import { runSubagent } from "@/lib/ai/subagent";
import * as ipc from "@/lib/ipc";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import type { AgentRun, AgentRunPatch, AgentStatus } from "@/types/ipc";

/** `delegate_task` 가 메인 에이전트에게 돌려주는 값. */
export interface DelegateOutcome {
  runId: string;
  name: string;
  status: AgentStatus;
  result?: string;
  error?: string;
}

interface AgentsState {
  runs: AgentRun[];
  loading: boolean;
  error: string | null;

  /** 현재 세션의 실행 목록을 다시 읽는다 (죽은 채 남은 실행은 정리). */
  refresh: () => Promise<void>;
  /** 서브에이전트 하나를 띄우고 끝날 때까지 기다린다. */
  spawn: (input: {
    name: string;
    task: string;
    parentMessageId?: string | null;
    /** 메인 턴의 중단 시그널. 끊기면 이 서브에이전트도 멈춘다. */
    signal?: AbortSignal;
  }) => Promise<DelegateOutcome>;
  cancel: (runId: string) => void;
  remove: (runId: string) => Promise<void>;
  /** 지워진 노드에 매달려 있던 실행 기록을 함께 정리한다 (턴 삭제용). */
  removeForMessages: (messageIds: string[]) => Promise<void>;
  clearFinished: () => Promise<void>;
}

const FINISHED: string[] = ["succeeded", "failed", "cancelled"];

const CANCELLED_MESSAGE = "사용자가 중단했습니다";

/** 실행 중인 서브에이전트의 중단 스위치. 스토어 상태가 아니라 모듈 스코프에 둔다. */
const controllers = new Map<string, AbortController>();

/** 사용자가 중단을 누른 실행. 뒤늦게 도착하는 결과가 상태를 되돌리지 못하게 한다. */
const cancelledRuns = new Set<string>();

/** 실행 중에 삭제된 실행. 없는 행에 UPDATE 를 날리지 않도록 표시해 둔다. */
const removedRuns = new Set<string>();

/** 아직 돌고 있는 실행이 아니라면 표시를 지운다 (실행 루프가 끝날 때도 같은 정리를 한다). */
function forget(runId: string) {
  if (controllers.has(runId)) return;
  cancelledRuns.delete(runId);
  removedRuns.delete(runId);
}

export const useAgents = create<AgentsState>((set, get) => {
  /** 로컬 캐시만 갱신 (스텝마다 DB 를 두드리지 않기 위해). */
  function patchLocal(runId: string, partial: Partial<AgentRun>) {
    set({
      runs: get().runs.map((run) => (run.id === runId ? { ...run, ...partial } : run)),
    });
  }

  /** DB 에 쓰고 그 결과로 로컬을 맞춘다. 이미 지워진 실행에는 쓰지 않는다. */
  async function persist(runId: string, patch: AgentRunPatch) {
    if (removedRuns.has(runId)) return null;
    const saved = await ipc.updateAgentRun(runId, patch);
    patchLocal(runId, saved);
    return saved;
  }

  return {
    runs: [],
    loading: false,
    error: null,

    refresh: async () => {
      const sessionId = useWorkspace.getState().activeSessionId;
      if (!sessionId) {
        set({ runs: [] });
        return;
      }
      set({ loading: true, error: null });
      try {
        // 앱이 죽어 running 인 채 남은 실행은 여기서 실패로 확정된다.
        if (controllers.size === 0) await ipc.reapAgentRuns(sessionId);
        set({ runs: await ipc.listAgentRuns(sessionId) });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ loading: false });
      }
    },

    spawn: async ({ name, task, parentMessageId, signal }) => {
      const sessionId = useWorkspace.getState().activeSessionId;
      if (!sessionId) throw new Error("세션이 없어 서브에이전트를 띄울 수 없습니다.");

      const settings = useSettings.getState();
      const run = await ipc.createAgentRun({ sessionId, parentMessageId, name, task });
      set({ runs: [run, ...get().runs] });

      const controller = new AbortController();
      controllers.set(run.id, controller);

      // 메인 턴이 중지되면 하위 에이전트도 같이 끊는다.
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      try {
        await persist(run.id, { status: "running" });

        // 서브에이전트에게는 `delegate_task` 를 주지 않는다 (재위임 금지).
        const tools = {
          ...buildSkills({ enabled: settings.skills, sessionId }),
          ...(settings.skills.mcp ? useMcp.getState().tools() : {}),
        };

        // 서브에이전트도 프로젝트 지침을 따라야 한다 (메인이 방금 읽어 둔 것을 쓴다).
        const instructions = useWorkspace.getState().instructions;

        const result = await runSubagent({
          task,
          extraInstructions:
            settings.useProjectInstructions && instructions
              ? instructionBlock(instructions)
              : undefined,
          modelId: settings.subagentModelId || settings.modelId,
          credentials: settings.credentials(),
          tools,
          effort: settings.effort,
          maxSteps: settings.subagentMaxSteps,
          abortSignal: controller.signal,
          onProgress: (progress) =>
            patchLocal(run.id, {
              progress: progress.progress,
              currentSkill: progress.currentSkill,
            }),
        });

        if (result.aborted || controller.signal.aborted) {
          await persist(run.id, { status: "cancelled", error: CANCELLED_MESSAGE });
          return { runId: run.id, name, status: "cancelled", error: CANCELLED_MESSAGE };
        }

        const text = result.text.trim();
        if (!text) {
          // 스텝 예산을 다 쓰고 요약을 못 남긴 경우 — 성공으로 포장하지 않는다.
          const error = `요약 없이 스텝 예산(${settings.subagentMaxSteps})을 모두 사용했습니다.`;
          await persist(run.id, { status: "failed", progress: 1, error });
          return { runId: run.id, name, status: "failed", error };
        }

        await persist(run.id, {
          status: "succeeded",
          progress: 1,
          result: text,
          currentSkill: "",
        });
        return { runId: run.id, name, status: "succeeded", result: text };
      } catch (error) {
        // 중단 중에 터진 예외(도구가 중단으로 거절되는 등)는 실패가 아니라 취소다.
        const cancelled = controller.signal.aborted || cancelledRuns.has(run.id);
        const message = cancelled
          ? CANCELLED_MESSAGE
          : error instanceof MissingApiKeyError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        const status: AgentStatus = cancelled ? "cancelled" : "failed";
        try {
          await persist(run.id, { status, error: message });
        } catch {
          // DB 갱신까지 실패하면 로컬 상태만이라도 맞춰 둔다.
          patchLocal(run.id, { status, error: message });
        }
        return { runId: run.id, name, status, error: message };
      } finally {
        controllers.delete(run.id);
        cancelledRuns.delete(run.id);
        removedRuns.delete(run.id);
      }
    },

    cancel: (runId) => {
      cancelledRuns.add(runId);
      controllers.get(runId)?.abort();
      // 실행 루프가 풀리는 데는 한 박자가 걸린다. 카드는 곧바로 중단으로 바꿔 준다.
      patchLocal(runId, { status: "cancelled", error: CANCELLED_MESSAGE });
    },

    remove: async (runId) => {
      removedRuns.add(runId);
      cancelledRuns.add(runId);
      controllers.get(runId)?.abort();
      // 목록에서 먼저 지운다 — DB 왕복을 기다리는 동안 카드가 남아 있으면 안 지워진 것처럼 보인다.
      set({ runs: get().runs.filter((run) => run.id !== runId) });
      try {
        await ipc.deleteAgentRun(runId);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        forget(runId);
      }
    },

    removeForMessages: async (messageIds) => {
      const doomed = new Set(messageIds);
      const targets = get().runs.filter(
        (run) => run.parentMessageId && doomed.has(run.parentMessageId),
      );
      if (targets.length === 0) return;

      for (const run of targets) {
        removedRuns.add(run.id);
        cancelledRuns.add(run.id);
        controllers.get(run.id)?.abort();
      }

      const removed = new Set(targets.map((run) => run.id));
      set({ runs: get().runs.filter((run) => !removed.has(run.id)) });
      try {
        await Promise.all(targets.map((run) => ipc.deleteAgentRun(run.id)));
      } finally {
        for (const run of targets) forget(run.id);
      }
    },

    clearFinished: async () => {
      const finished = get().runs.filter((run) => FINISHED.includes(run.status));
      await Promise.all(finished.map((run) => ipc.deleteAgentRun(run.id)));
      set({ runs: get().runs.filter((run) => !FINISHED.includes(run.status)) });
    },
  };
});
