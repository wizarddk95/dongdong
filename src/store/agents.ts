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
  clearFinished: () => Promise<void>;
}

const FINISHED: string[] = ["succeeded", "failed", "cancelled"];

/** 실행 중인 서브에이전트의 중단 스위치. 스토어 상태가 아니라 모듈 스코프에 둔다. */
const controllers = new Map<string, AbortController>();

export const useAgents = create<AgentsState>((set, get) => {
  /** 로컬 캐시만 갱신 (스텝마다 DB 를 두드리지 않기 위해). */
  function patchLocal(runId: string, partial: Partial<AgentRun>) {
    set({
      runs: get().runs.map((run) => (run.id === runId ? { ...run, ...partial } : run)),
    });
  }

  /** DB 에 쓰고 그 결과로 로컬을 맞춘다. */
  async function persist(runId: string, patch: AgentRunPatch) {
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

        if (result.aborted) {
          await persist(run.id, { status: "cancelled", error: "사용자가 중단했습니다" });
          return { runId: run.id, name, status: "cancelled", error: "사용자가 중단했습니다" };
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
        const message =
          error instanceof MissingApiKeyError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        try {
          await persist(run.id, { status: "failed", error: message });
        } catch {
          // DB 갱신까지 실패하면 로컬 상태만이라도 맞춰 둔다.
          patchLocal(run.id, { status: "failed", error: message });
        }
        return { runId: run.id, name, status: "failed", error: message };
      } finally {
        controllers.delete(run.id);
      }
    },

    cancel: (runId) => {
      controllers.get(runId)?.abort();
    },

    remove: async (runId) => {
      controllers.get(runId)?.abort();
      await ipc.deleteAgentRun(runId);
      set({ runs: get().runs.filter((run) => run.id !== runId) });
    },

    clearFinished: async () => {
      const finished = get().runs.filter((run) => FINISHED.includes(run.status));
      await Promise.all(finished.map((run) => ipc.deleteAgentRun(run.id)));
      set({ runs: get().runs.filter((run) => !FINISHED.includes(run.status)) });
    },
  };
});
