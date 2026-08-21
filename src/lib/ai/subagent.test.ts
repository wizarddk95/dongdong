import { describe, expect, it, vi } from "vitest";

import type { RunTurnOptions, RunTurnResult } from "@/lib/ai/runner";

vi.mock("@/lib/ai/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/runner")>()),
  runTurn: vi.fn(),
}));

import { runTurn } from "@/lib/ai/runner";
import {
  buildSubagentContext,
  runSubagent,
  SUBAGENT_SYSTEM_PROMPT,
  type SubagentProgress,
} from "@/lib/ai/subagent";

const base = {
  task: "테스트를 돌리고 실패 원인을 찾아라",
  modelId: "anthropic:claude-haiku-4-5",
  credentials: { anthropicApiKey: "k" },
  tools: {},
  effort: "high" as const,
  maxSteps: 4,
};

const done: RunTurnResult = {
  text: "3건 실패, 타임존 문제",
  reasoning: "",
  usage: null,
  lastStepUsage: null,
  finishReason: "stop",
  aborted: false,
  steps: 2,
};

describe("buildSubagentContext", () => {
  it("작업 지시 하나만 담은 격리된 컨텍스트를 만든다", () => {
    const context = buildSubagentContext(base);

    expect(context.system).toBe(SUBAGENT_SYSTEM_PROMPT);
    expect(context.messages).toEqual([{ role: "user", content: base.task }]);
    expect(context.modelId).toBe("anthropic:claude-haiku-4-5");
    expect(context.maxSteps).toBe(4);
  });

  it("프로젝트별 안내는 기본 프롬프트 뒤에 붙는다", () => {
    const context = buildSubagentContext({ ...base, extraInstructions: "커밋하지 말 것" });
    expect(context.system.startsWith(SUBAGENT_SYSTEM_PROMPT)).toBe(true);
    expect(context.system).toContain("커밋하지 말 것");
  });
});

describe("runSubagent", () => {
  it("스텝이 끝날 때마다 진행률과 실행 중인 Skill 을 알린다", async () => {
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      options.onToolCall?.({ toolCallId: "c1", toolName: "execute_shell_command", input: {} });
      await options.onStepFinish?.({
        index: 0,
        text: "",
        reasoning: "",
        toolCalls: [{ toolCallId: "c1", toolName: "execute_shell_command", input: {} }],
        toolResults: [{ toolCallId: "c1", toolName: "execute_shell_command", output: {} }],
        usage: null,
      });
      await options.onStepFinish?.({
        index: 1,
        text: done.text,
        reasoning: "",
        toolCalls: [],
        toolResults: [],
        usage: null,
      });
      return done;
    });

    const updates: SubagentProgress[] = [];
    const result = await runSubagent({ ...base, onProgress: (update) => updates.push(update) });

    expect(result.text).toBe("3건 실패, 타임존 문제");
    expect(result.toolCalls).toBe(1);
    expect(updates.at(0)?.currentSkill).toBe("execute_shell_command");
    // 스텝 예산(4) 대비 2스텝 → 0.5. 끝나기 전에는 1.0 이 되지 않는다.
    expect(updates.at(-1)?.progress).toBeCloseTo(0.5);
    expect(updates.every((update) => update.progress < 1)).toBe(true);
  });

  it("진행률은 스텝 예산을 넘어도 0.95 를 넘지 않는다", async () => {
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      for (let index = 0; index < 10; index += 1) {
        await options.onStepFinish?.({
          index,
          text: "",
          reasoning: "",
          toolCalls: [],
          toolResults: [],
          usage: null,
        });
      }
      return done;
    });

    const updates: SubagentProgress[] = [];
    await runSubagent({ ...base, maxSteps: 2, onProgress: (update) => updates.push(update) });

    expect(Math.max(...updates.map((update) => update.progress))).toBe(0.95);
  });

  it("서브에이전트의 토큰 스트림은 UI 로 흘리지 않는다", async () => {
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      // 넘겨준 onTextDelta 가 무해한 no-op 인지 (던지지 않는지) 확인한다.
      options.onTextDelta("부분 응답");
      return done;
    });

    await expect(runSubagent(base)).resolves.toMatchObject({ text: done.text });
  });
});
