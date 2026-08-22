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

import { isRunActive } from "@/lib/agentRuns";
import { instructionBlock } from "@/lib/ai/instructions";
import { errorMessage } from "@/lib/ai/errors";
import { buildSkillTools, skillCatalogBlock } from "@/lib/ai/skills";
import { buildTools } from "@/lib/ai/tools";
import { runSubagent } from "@/lib/ai/subagent";
import { toStoredUsage } from "@/lib/ai/usage";
import * as ipc from "@/lib/ipc";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useSkills } from "@/store/skills";
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
  /** 지워진 노드에 매달려 돌고 있던 실행을 멈춘다 (턴 삭제용). 기록은 남긴다. */
  cancelForMessages: (messageIds: string[]) => void;
  clearFinished: () => Promise<void>;
}

const FINISHED: string[] = ["succeeded", "failed", "cancelled"];

/** 지침 블록 사이의 가름선. 메인 턴의 시스템 프롬프트와 같은 모양이다. */
const BLOCK_SEPARATOR = `

---

`;

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
        set({ error: errorMessage(error) });
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

        // 스킬은 메인이 방금 읽어 둔 목록을 그대로 쓴다 (서브에이전트도 절차를 따라야 한다).
        const skills = useSkills.getState().enabled();

        // 서브에이전트에게는 `delegate_task` 를 주지 않는다 (재위임 금지).
        const tools = {
          ...buildTools({ enabled: settings.tools, sessionId }),
          ...(settings.tools.mcp ? useMcp.getState().tools() : {}),
          ...buildSkillTools(skills),
        };

        // 서브에이전트도 프로젝트 지침을 따라야 한다 (메인이 방금 읽어 둔 것을 쓴다).
        const instructions = useWorkspace.getState().instructions;

        // 위임 실행은 대화 트리에 노드를 남기지 않는다 → 쓴 토큰을 실행 행에 직접 적어야
        // 세션 비용에 잡힌다. 어느 모델이었는지도 함께 남긴다(메인과 다를 수 있다).
        const modelId = settings.subagentModelId || settings.modelId;

        // 프로젝트 지침과 스킬 목록을 한 덩이로 묶어 넘긴다 (둘 다 없으면 undefined).
        // 둘 사이의 가름선은 메인 턴의 시스템 프롬프트와 같은 모양으로 둔다.
        const extraInstructions =
          [
            settings.useProjectInstructions && instructions ? instructionBlock(instructions) : "",
            skillCatalogBlock(skills),
          ]
            .filter(Boolean)
            .join(BLOCK_SEPARATOR) || undefined;

        const result = await runSubagent({
          task,
          extraInstructions,
          modelId,
          credentials: settings.credentials(),
          tools,
          effort: settings.effort,
          maxSteps: settings.subagentMaxSteps,
          abortSignal: controller.signal,
          onProgress: (progress) =>
            patchLocal(run.id, {
              progress: progress.progress,
              currentTool: progress.currentTool,
            }),
        });

        // 중단·실패한 실행도 토큰은 이미 나갔다. 빼놓으면 비용이 축소된다.
        const tokenUsage = toStoredUsage(modelId, result.usage) ?? undefined;

        if (result.aborted || controller.signal.aborted) {
          await persist(run.id, { status: "cancelled", error: CANCELLED_MESSAGE, tokenUsage });
          return { runId: run.id, name, status: "cancelled", error: CANCELLED_MESSAGE };
        }

        const text = result.text.trim();
        if (!text) {
          // 스텝 예산을 다 쓰고 요약을 못 남긴 경우 — 성공으로 포장하지 않는다.
          const error = `요약 없이 스텝 예산(${settings.subagentMaxSteps})을 모두 사용했습니다.`;
          await persist(run.id, { status: "failed", progress: 1, error, tokenUsage });
          return { runId: run.id, name, status: "failed", error };
        }

        await persist(run.id, {
          status: "succeeded",
          progress: 1,
          result: text,
          currentTool: "",
          tokenUsage,
        });
        return { runId: run.id, name, status: "succeeded", result: text };
      } catch (error) {
        // 중단 중에 터진 예외(도구가 중단으로 거절되는 등)는 실패가 아니라 취소다.
        const cancelled = controller.signal.aborted || cancelledRuns.has(run.id);
        const message = cancelled ? CANCELLED_MESSAGE : errorMessage(error);
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
        set({ error: errorMessage(error) });
      } finally {
        forget(runId);
      }
    },

    cancelForMessages: (messageIds) => {
      // 기록 자체는 지우지 않는다 — 실제로 쓴 토큰이라 지우면 세션 비용이 조용히 줄어든다.
      // 노드가 사라지면 DB 가 링크만 끊고(ON DELETE SET NULL), 삭제를 되돌리면 다시 붙는다.
      const doomed = new Set(messageIds);
      for (const run of get().runs) {
        if (run.parentMessageId && doomed.has(run.parentMessageId) && isRunActive(run)) {
          get().cancel(run.id);
        }
      }
    },

    clearFinished: async () => {
      const finished = get().runs.filter((run) => FINISHED.includes(run.status));
      await Promise.all(finished.map((run) => ipc.deleteAgentRun(run.id)));
      set({ runs: get().runs.filter((run) => !FINISHED.includes(run.status)) });
    },
  };
});
