import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunTurnOptions, RunTurnResult } from "@/lib/ai/runner";
import type { Message, NewMessage } from "@/types/ipc";

// 실제 LLM 호출과 Tauri IPC 는 갈아 끼우고, 트리에 노드가 어떻게 쌓이는지만 검증한다.
vi.mock("@/lib/ai/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/runner")>()),
  runTurn: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  readFile: vi.fn(),
  appendMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  listMessages: vi.fn(),
  getMessagePath: vi.fn(),
  renameSession: vi.fn(),
}));

import { DEFAULT_MODEL_ID } from "@/lib/ai/providers";
import { runTurn } from "@/lib/ai/runner";
import { lastCallUsage, readChainUsage } from "@/lib/ai/usage";
import * as ipc from "@/lib/ipc";
import { useChat } from "@/store/chat";
import { useWorkspace } from "@/store/workspace";

/** 메모리에 얹은 가짜 messages 테이블. */
const rows = new Map<string, Message>();
let counter = 0;

function fakeRow(input: NewMessage): Message {
  counter += 1;
  return {
    id: `m${counter}`,
    sessionId: input.sessionId,
    parentId: input.parentId ?? null,
    role: input.role,
    content: input.content ?? "",
    toolCalls: input.toolCalls ?? null,
    toolResults: input.toolResults ?? null,
    contextSnapshot: input.contextSnapshot ?? null,
    tokenUsage: input.tokenUsage ?? null,
    status: input.status ?? "complete",
    agentId: input.agentId ?? null,
    seq: counter,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const mocked = vi.mocked(ipc);

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  counter = 0;

  mocked.appendMessage.mockImplementation(async (input) => {
    const row = fakeRow(input);
    rows.set(row.id, row);
    return row;
  });
  mocked.updateMessage.mockImplementation(async (id, patch) => {
    const row = { ...rows.get(id)!, ...patch } as Message;
    rows.set(id, row);
    return row;
  });
  mocked.deleteMessage.mockImplementation(async (id) => {
    rows.delete(id);
  });
  mocked.listMessages.mockImplementation(async () => [...rows.values()]);
  // 기본은 AGENTS.md 가 없는 프로젝트.
  mocked.readFile.mockRejectedValue(new Error("찾을 수 없습니다: AGENTS.md"));
  mocked.getMessagePath.mockImplementation(async (id) => {
    const chain: Message[] = [];
    let cursor: string | null = id;
    while (cursor) {
      const row: Message | undefined = rows.get(cursor);
      if (!row) break;
      chain.unshift(row);
      cursor = row.parentId;
    }
    return chain;
  });

  useWorkspace.setState({
    project: {
      id: "p1",
      rootPath: "C:/p",
      name: "p",
      settings: {},
      createdAt: "",
      updatedAt: "",
    },
    sessions: [],
    activeSessionId: "s1",
    messages: [],
    activeParentId: null,
    selectedMessageId: null,
    instructions: null,
  });
  useChat.setState({ running: false, error: null, pendingToolCalls: [] });
});

/** 스텝 하나가 쓴 토큰. 노드 하나 = LLM 호출 하나이므로 노드에도 이 모양이 남는다. */
function stepUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

// 도구 스텝은 프롬프트가 짧고, 도구 결과가 붙은 다음 스텝은 그만큼 길어진다.
const TOOL_STEP_USAGE = stepUsage(8, 3);
const LAST_STEP_USAGE = stepUsage(10, 5);

const finalResult: RunTurnResult = {
  text: "다 읽었습니다",
  reasoning: "",
  // 턴 누적(= 두 스텝의 합). 노드에는 이 값이 아니라 스텝별 값이 남는다.
  usage: stepUsage(18, 8),
  lastStepUsage: LAST_STEP_USAGE,
  finishReason: "stop",
  aborted: false,
  steps: 2,
};

describe("useChat.send — 도구 스텝", () => {
  it("도구를 쓴 스텝마다 assistant → tool → assistant 로 노드가 이어진다", async () => {
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      await options.onStepFinish?.({
        index: 0,
        text: "파일을 읽어볼게요",
        reasoning: "",
        toolCalls: [{ toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }],
        toolResults: [{ toolCallId: "c1", toolName: "read_file", output: { content: "x" } }],
        usage: TOOL_STEP_USAGE,
      });
      await options.onStepFinish?.({
        index: 1,
        text: "다 읽었습니다",
        reasoning: "",
        toolCalls: [],
        toolResults: [],
        usage: LAST_STEP_USAGE,
      });
      return finalResult;
    });

    await useChat.getState().send("a.ts 봐줘");

    const messages = useWorkspace.getState().messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const [user, first, toolNode, last] = messages;
    expect(first.parentId).toBe(user.id);
    expect(first.content).toBe("파일을 읽어볼게요");
    expect(first.status).toBe("complete");
    expect(first.toolCalls).toEqual([
      { toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
    ]);

    expect(toolNode.parentId).toBe(first.id);
    expect(toolNode.content).toBe("read_file(a.ts) → 완료");
    expect(toolNode.toolResults).toEqual([
      { toolCallId: "c1", toolName: "read_file", output: { content: "x" } },
    ]);

    expect(last.parentId).toBe(toolNode.id);
    expect(last.content).toBe("다 읽었습니다");
    expect(last.status).toBe("complete");
    // 다음 턴은 마지막 응답에 이어 붙는다.
    expect(useWorkspace.getState().activeParentId).toBe(last.id);
  });

  it("스텝마다 자기 호출의 토큰만 자기 노드에 남는다", async () => {
    // 컨텍스트 잔량은 "마지막 호출"이 기준이다. 턴 누적을 마지막 노드에 몰아 적으면
    // 도구를 많이 쓴 턴일수록 잔량이 실제보다 몇 배로 부풀어 보인다(스텝마다 대화
    // 전체가 다시 올라가므로 앞부분이 겹쳐 세어진다). 그래서 스텝 = 노드로 쪼갠다.
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      await options.onStepFinish?.({
        index: 0,
        text: "파일을 읽어볼게요",
        reasoning: "",
        toolCalls: [{ toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }],
        toolResults: [{ toolCallId: "c1", toolName: "read_file", output: { content: "x" } }],
        usage: TOOL_STEP_USAGE,
      });
      await options.onStepFinish?.({
        index: 1,
        text: "다 읽었습니다",
        reasoning: "",
        toolCalls: [],
        toolResults: [],
        usage: LAST_STEP_USAGE,
      });
      return finalResult;
    });

    await useChat.getState().send("a.ts 봐줘");

    const [, first, toolNode, last] = useWorkspace.getState().messages;
    expect(first.tokenUsage).toEqual({ ...TOOL_STEP_USAGE, modelId: DEFAULT_MODEL_ID });
    // 도구 결과 노드는 LLM 호출이 아니다 — 토큰을 갖지 않는다.
    expect(toolNode.tokenUsage).toBeNull();
    expect(last.tokenUsage).toEqual({ ...LAST_STEP_USAGE, modelId: DEFAULT_MODEL_ID });

    // 노드를 더하면 턴 누적(= runTurn 이 돌려준 합계)과 맞아떨어진다.
    const chain = readChainUsage(useWorkspace.getState().messages);
    expect(chain.usage.inputTokens).toBe(finalResult.usage?.inputTokens);
    expect(chain.usage.outputTokens).toBe(finalResult.usage?.outputTokens);

    // 컨텍스트 잔량은 누적(18)이 아니라 마지막 호출(10 + 5)이 기준이다.
    expect(lastCallUsage(useWorkspace.getState().messages)?.usage).toEqual(LAST_STEP_USAGE);
  });

  it("도구 스텝 직후 턴이 끝나면 빈 응답 노드를 남기지 않는다", async () => {
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      await options.onStepFinish?.({
        index: 0,
        text: "실행할게요",
        reasoning: "",
        toolCalls: [{ toolCallId: "c1", toolName: "execute_shell_command", input: { command: "ls" } }],
        toolResults: [{ toolCallId: "c1", toolName: "execute_shell_command", output: { exitCode: 0 } }],
        usage: TOOL_STEP_USAGE,
      });
      // 최대 스텝에 걸려 텍스트 없이 끝난 상황
      return { ...finalResult, text: "", finishReason: "tool-calls", steps: 1 };
    });

    await useChat.getState().send("ls 실행해줘");

    const messages = useWorkspace.getState().messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(useChat.getState().error).toContain("최대 스텝");
  });

  it("프로젝트에 AGENTS.md 가 있으면 시스템 프롬프트 맨 앞에 싣는다", async () => {
    mocked.readFile.mockResolvedValue({
      path: "C:/p/AGENTS.md",
      relativePath: "AGENTS.md",
      content: "커밋하지 말 것.",
      size: 14,
      truncated: false,
      isBinary: false,
    });

    let sentSystem = "";
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      sentSystem = options.context.system;
      return { ...finalResult, text: "네", steps: 1 };
    });

    await useChat.getState().send("안녕");

    expect(sentSystem.startsWith("# 프로젝트 지침 (AGENTS.md)")).toBe(true);
    expect(sentSystem).toContain("커밋하지 말 것.");
    // 인스펙터가 볼 수 있게 스냅샷에도 같은 내용이 남는다.
    const assistant = useWorkspace.getState().messages[1];
    expect((assistant.contextSnapshot as { system: string }).system).toBe(sentSystem);
    // 배지 표시용으로 스토어에도 반영된다.
    expect(useWorkspace.getState().instructions?.path).toBe("AGENTS.md");
  });

  it("AGENTS.md 가 없으면 기본 시스템 프롬프트만 나간다", async () => {
    let sentSystem = "";
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      sentSystem = options.context.system;
      return { ...finalResult, text: "네", steps: 1 };
    });

    await useChat.getState().send("안녕");

    expect(sentSystem).not.toContain("프로젝트 지침");
    expect(useWorkspace.getState().instructions).toBeNull();
  });

  it("도구를 안 쓰면 예전처럼 assistant 노드 하나로 끝난다", async () => {
    vi.mocked(runTurn).mockImplementation(async (options: RunTurnOptions) => {
      options.onTextDelta("안녕");
      await options.onStepFinish?.({
        index: 0,
        text: "안녕하세요",
        reasoning: "",
        toolCalls: [],
        toolResults: [],
        usage: LAST_STEP_USAGE,
      });
      return { ...finalResult, text: "안녕하세요", usage: LAST_STEP_USAGE, steps: 1 };
    });

    await useChat.getState().send("안녕");

    const messages = useWorkspace.getState().messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe("안녕하세요");
    // 사용량은 평평한 모양으로 접혀 저장되고, 어느 모델이었는지도 함께 남는다.
    expect(messages[1].tokenUsage).toEqual({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 15,
      modelId: DEFAULT_MODEL_ID,
    });
    // 첫 assistant 노드에는 그때 보낸 컨텍스트 원문이 남아 있어야 한다 (인스펙터용).
    expect(messages[1].contextSnapshot).toMatchObject({ toolNames: expect.any(Array) });
    expect(useChat.getState().error).toBeNull();
  });
});
