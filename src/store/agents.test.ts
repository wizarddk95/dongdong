import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentResult } from "@/lib/ai/subagent";
import type { AgentRun, AgentRunPatch, NewAgentRun } from "@/types/ipc";

vi.mock("@/lib/ai/subagent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/subagent")>()),
  runSubagent: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  createAgentRun: vi.fn(),
  listAgentRuns: vi.fn(),
  updateAgentRun: vi.fn(),
  deleteAgentRun: vi.fn(),
  reapAgentRuns: vi.fn(),
}));

import { DEFAULT_MODEL_ID } from "@/lib/ai/providers";
import { runSubagent } from "@/lib/ai/subagent";
import * as ipc from "@/lib/ipc";
import { useAgents } from "@/store/agents";
import { useWorkspace } from "@/store/workspace";

const rows = new Map<string, AgentRun>();
let counter = 0;

const mocked = vi.mocked(ipc);

const finished: SubagentResult = {
  text: "요약: 3건 실패",
  steps: 2,
  toolCalls: 1,
  usage: null,
  finishReason: "stop",
  aborted: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  counter = 0;

  mocked.createAgentRun.mockImplementation(async (input: NewAgentRun) => {
    counter += 1;
    const run: AgentRun = {
      id: `r${counter}`,
      sessionId: input.sessionId,
      parentMessageId: input.parentMessageId ?? null,
      name: input.name,
      task: input.task,
      status: "pending",
      progress: 0,
      currentTool: null,
      tokenUsage: null,
      result: null,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: null,
      finishedAt: null,
    };
    rows.set(run.id, run);
    return run;
  });
  mocked.updateAgentRun.mockImplementation(async (id: string, patch: AgentRunPatch) => {
    const run = { ...rows.get(id)!, ...patch } as AgentRun;
    rows.set(id, run);
    return run;
  });
  mocked.listAgentRuns.mockImplementation(async () => [...rows.values()]);
  mocked.deleteAgentRun.mockImplementation(async (id: string) => rows.delete(id));
  mocked.reapAgentRuns.mockResolvedValue(0);

  useWorkspace.setState({ activeSessionId: "s1", instructions: null });
  useAgents.setState({ runs: [], loading: false, error: null });
});

describe("useAgents.spawn", () => {
  it("성공하면 결과 요약을 남기고 succeeded 로 끝난다", async () => {
    vi.mocked(runSubagent).mockResolvedValue(finished);

    const outcome = await useAgents.getState().spawn({ name: "테스트 러너", task: "테스트 돌려" });

    expect(outcome).toEqual({
      runId: "r1",
      name: "테스트 러너",
      status: "succeeded",
      result: "요약: 3건 실패",
    });

    const run = useAgents.getState().runs[0];
    expect(run.status).toBe("succeeded");
    expect(run.progress).toBe(1);
    expect(run.result).toBe("요약: 3건 실패");
    // pending → running → succeeded 로 DB 에 두 번만 쓴다 (스텝마다 쓰지 않는다).
    expect(mocked.updateAgentRun).toHaveBeenCalledTimes(2);
    expect(mocked.updateAgentRun.mock.calls[0][1]).toEqual({ status: "running" });
  });

  it("진행 상황은 DB 를 거치지 않고 로컬 상태만 갱신한다", async () => {
    vi.mocked(runSubagent).mockImplementation(async (options) => {
      options.onProgress?.({ progress: 0.4, currentTool: "read_file", steps: 1 });
      expect(useAgents.getState().runs[0].currentTool).toBe("read_file");
      expect(useAgents.getState().runs[0].progress).toBeCloseTo(0.4);
      return finished;
    });

    await useAgents.getState().spawn({ name: "탐색", task: "구조 파악" });

    // running 전이 + 종료, 두 번. 진행률 갱신은 DB 를 건드리지 않았다.
    expect(mocked.updateAgentRun).toHaveBeenCalledTimes(2);
  });

  it("서브에이전트가 요약 없이 예산을 다 쓰면 실패로 기록한다", async () => {
    vi.mocked(runSubagent).mockResolvedValue({ ...finished, text: "   " });

    const outcome = await useAgents.getState().spawn({ name: "무한 루프", task: "뭔가" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("스텝 예산");
    expect(useAgents.getState().runs[0].status).toBe("failed");
  });

  it("실행 중 에러는 failed 로 남기고 메인 에이전트에게 사유를 돌려준다", async () => {
    vi.mocked(runSubagent).mockRejectedValue(new Error("Anthropic API 키가 없습니다."));

    const outcome = await useAgents.getState().spawn({ name: "러너", task: "일" });

    expect(outcome).toMatchObject({ status: "failed", error: "Anthropic API 키가 없습니다." });
    expect(useAgents.getState().runs[0].error).toBe("Anthropic API 키가 없습니다.");
  });

  it("중단하면 cancelled 로 끝난다", async () => {
    vi.mocked(runSubagent).mockImplementation(async (options) => {
      // 실행 중 취소 버튼을 누른 상황
      useAgents.getState().cancel(useAgents.getState().runs[0].id);
      expect(options.abortSignal?.aborted).toBe(true);
      return { ...finished, aborted: true, text: "" };
    });

    const outcome = await useAgents.getState().spawn({ name: "러너", task: "일" });

    expect(outcome.status).toBe("cancelled");
    expect(useAgents.getState().runs[0].status).toBe("cancelled");
  });

  it("중단을 누르면 실행이 끝나기 전에도 카드가 곧바로 중단으로 바뀐다", async () => {
    let release: (() => void) | null = null;
    vi.mocked(runSubagent).mockImplementation(async (options) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...finished, aborted: options.abortSignal?.aborted ?? false, text: "" };
    });

    const pending = useAgents.getState().spawn({ name: "러너", task: "일" });
    await vi.waitFor(() => expect(release).not.toBeNull());

    useAgents.getState().cancel("r1");
    // 서브에이전트가 아직 풀리지 않았는데도 화면 상태는 이미 중단이다.
    expect(useAgents.getState().runs[0].status).toBe("cancelled");

    release!();
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
  });

  it("중단 도중 터진 예외는 실패가 아니라 취소로 남는다", async () => {
    vi.mocked(runSubagent).mockImplementation(async () => {
      useAgents.getState().cancel("r1");
      // 중단되면 도구가 거절되면서 예외로 빠져나온다 (abortableTools).
      throw new Error("중단되었습니다 (execute_shell_command)");
    });

    const outcome = await useAgents.getState().spawn({ name: "러너", task: "일" });

    expect(outcome.status).toBe("cancelled");
    expect(useAgents.getState().runs[0].status).toBe("cancelled");
  });

  it("실행 중에 삭제하면 즉시 목록에서 빠지고 없는 행에 UPDATE 하지 않는다", async () => {
    let release: (() => void) | null = null;
    vi.mocked(runSubagent).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...finished, aborted: true, text: "" };
    });

    const pending = useAgents.getState().spawn({ name: "러너", task: "일" });
    await vi.waitFor(() => expect(release).not.toBeNull());

    await useAgents.getState().remove("r1");
    expect(useAgents.getState().runs).toHaveLength(0);
    expect(mocked.deleteAgentRun).toHaveBeenCalledWith("r1");

    const writesBefore = mocked.updateAgentRun.mock.calls.length;
    release!();
    await pending;

    expect(mocked.updateAgentRun.mock.calls.length).toBe(writesBefore);
    expect(useAgents.getState().runs).toHaveLength(0);
  });

  it("메인 턴이 중지되면 하위 에이전트도 끊긴다", async () => {
    const turn = new AbortController();
    vi.mocked(runSubagent).mockImplementation(async (options) => {
      turn.abort(); // 사용자가 채팅의 [중지] 를 누른 상황
      expect(options.abortSignal?.aborted).toBe(true);
      return { ...finished, aborted: true, text: "" };
    });

    const outcome = await useAgents
      .getState()
      .spawn({ name: "러너", task: "일", signal: turn.signal });

    expect(outcome.status).toBe("cancelled");
  });

  it("여러 명을 동시에 띄워도 각자 기록된다", async () => {
    vi.mocked(runSubagent).mockImplementation(async (options) => ({
      ...finished,
      text: `${options.task} 완료`,
    }));

    const outcomes = await Promise.all([
      useAgents.getState().spawn({ name: "A", task: "일1" }),
      useAgents.getState().spawn({ name: "B", task: "일2" }),
    ]);

    expect(outcomes.map((outcome) => outcome.result)).toEqual(["일1 완료", "일2 완료"]);
    expect(useAgents.getState().runs).toHaveLength(2);
    expect(useAgents.getState().runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("프로젝트 지침을 서브에이전트에게도 전달한다", async () => {
    useWorkspace.setState({
      instructions: {
        path: "AGENTS.md",
        content: "커밋하지 말 것.",
        truncated: false,
        loadedAt: "2026-01-01T00:00:00Z",
      },
    });

    let extra: string | undefined;
    vi.mocked(runSubagent).mockImplementation(async (options) => {
      extra = options.extraInstructions;
      return finished;
    });

    await useAgents.getState().spawn({ name: "러너", task: "일" });

    expect(extra).toContain("커밋하지 말 것.");
    expect(extra).toContain("# 프로젝트 지침 (AGENTS.md)");
  });

  it("쓴 토큰을 실행 기록에 남긴다 — 위임은 대화 트리에 노드가 없다", async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      ...finished,
      usage: {
        inputTokens: 1_200,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        outputTokens: 300,
        reasoningTokens: 0,
        totalTokens: 1_500,
      },
    });

    await useAgents.getState().spawn({ name: "탐색", task: "구조 파악" });

    const patch = mocked.updateAgentRun.mock.calls.at(-1)?.[1];
    expect(patch?.tokenUsage).toMatchObject({
      inputTokens: 1_200,
      cacheReadTokens: 400,
      outputTokens: 300,
      // 서브에이전트 모델이 따로 설정돼 있지 않으면 메인 모델을 쓴다.
      modelId: DEFAULT_MODEL_ID,
    });
  });

  it("중단된 실행도 이미 나간 토큰은 기록한다", async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      ...finished,
      aborted: true,
      text: "",
      usage: {
        inputTokens: 800,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        totalTokens: 820,
      },
    });

    await useAgents.getState().spawn({ name: "러너", task: "일" });

    const patch = mocked.updateAgentRun.mock.calls.at(-1)?.[1];
    expect(patch).toMatchObject({ status: "cancelled" });
    expect(patch?.tokenUsage).toMatchObject({ inputTokens: 800 });
  });

  it("세션이 없으면 띄우지 않는다", async () => {
    useWorkspace.setState({ activeSessionId: null });
    await expect(useAgents.getState().spawn({ name: "러너", task: "일" })).rejects.toThrow(
      "세션이 없어",
    );
    expect(mocked.createAgentRun).not.toHaveBeenCalled();
  });
});

describe("useAgents.refresh / 정리", () => {
  it("세션을 열 때 죽은 채 남은 실행을 정리하고 목록을 읽는다", async () => {
    rows.set("r9", {
      id: "r9",
      sessionId: "s1",
      parentMessageId: null,
      name: "예전 실행",
      task: "일",
      status: "failed",
      progress: 0.2,
      currentTool: null,
      tokenUsage: null,
      result: null,
      error: "앱이 종료되어 중단되었습니다",
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: null,
      finishedAt: null,
    });

    await useAgents.getState().refresh();

    expect(mocked.reapAgentRuns).toHaveBeenCalledWith("s1");
    expect(useAgents.getState().runs).toHaveLength(1);
  });

  it("끝난 실행만 정리한다", async () => {
    vi.mocked(runSubagent).mockResolvedValue(finished);
    await useAgents.getState().spawn({ name: "끝난 것", task: "일" });
    useAgents.setState({
      runs: [
        ...useAgents.getState().runs,
        { ...useAgents.getState().runs[0], id: "r-running", status: "running" },
      ],
    });

    await useAgents.getState().clearFinished();

    expect(useAgents.getState().runs.map((run) => run.id)).toEqual(["r-running"]);
  });
});

describe("useAgents.cancelForMessages", () => {
  it("지워진 노드에 매달려 돌던 실행만 멈추고 기록은 남긴다", async () => {
    vi.mocked(runSubagent).mockResolvedValue(finished);

    await useAgents.getState().spawn({ name: "끝난 것", task: "일", parentMessageId: "m1" });
    // 아직 돌고 있는 실행 하나를 같은 노드에 매단다.
    useAgents.setState({
      runs: [
        { ...useAgents.getState().runs[0], id: "r-running", status: "running" },
        ...useAgents.getState().runs,
      ],
    });

    useAgents.getState().cancelForMessages(["m1"]);

    // 기록은 실제로 쓴 토큰이라 지우지 않는다 — 상태만 중단으로 바뀐다.
    expect(mocked.deleteAgentRun).not.toHaveBeenCalled();
    expect(useAgents.getState().runs).toHaveLength(2);
    expect(useAgents.getState().runs.find((run) => run.id === "r-running")?.status).toBe(
      "cancelled",
    );
  });

  it("다른 노드의 실행은 건드리지 않는다", async () => {
    vi.mocked(runSubagent).mockResolvedValue(finished);
    await useAgents.getState().spawn({ name: "무관", task: "일", parentMessageId: "m2" });
    useAgents.setState({
      runs: useAgents.getState().runs.map((run) => ({ ...run, status: "running" })),
    });

    useAgents.getState().cancelForMessages(["m1"]);

    expect(useAgents.getState().runs[0].status).toBe("running");
  });
});
