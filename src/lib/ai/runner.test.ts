import { describe, expect, it } from "vitest";

import {
  buildTurnContext,
  contextPayloadOf,
  payloadChars,
  readToolCalls,
  readToolResults,
  toModelMessages,
} from "@/lib/ai/runner";
import { extraContentFor, forgetExtraContent } from "@/lib/ai/thoughtSignature";
import type { Message } from "@/types/ipc";

function node(partial: Partial<Message> & Pick<Message, "role" | "content">): Message {
  return {
    id: "m1",
    sessionId: "s1",
    parentId: null,
    toolCalls: null,
    toolResults: null,
    contextSnapshot: null,
    tokenUsage: null,
    status: "complete",
    agentId: null,
    seq: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

/** assistant(도구 호출) → tool(결과) 로 이어지는 한 스텝 */
function toolStep(id: string, callId: string, output: unknown) {
  return [
    node({
      id: `${id}-a`,
      role: "assistant",
      content: "파일을 읽어볼게요",
      toolCalls: [{ toolCallId: callId, toolName: "read_file", input: { path: "src/App.tsx" } }],
    }),
    node({
      id: `${id}-t`,
      role: "tool",
      content: "read_file(src/App.tsx) → 완료",
      toolCalls: [{ toolCallId: callId, toolName: "read_file", input: { path: "src/App.tsx" } }],
      toolResults: [{ toolCallId: callId, toolName: "read_file", output }],
    }),
  ];
}

describe("toModelMessages — 도구", () => {
  it("assistant 의 도구 호출과 tool 노드를 정식 파트로 복원한다", () => {
    const chain = [
      node({ id: "u", role: "user", content: "App.tsx 좀 봐줘" }),
      ...toolStep("s1", "call-1", { content: "export default App" }),
      node({ id: "final", role: "assistant", content: "간단한 컴포넌트입니다" }),
    ];

    expect(toModelMessages(chain)).toEqual([
      { role: "user", content: "App.tsx 좀 봐줘" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "파일을 읽어볼게요" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "src/App.tsx" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "json", value: { content: "export default App" } },
          },
        ],
      },
      { role: "assistant", content: "간단한 컴포넌트입니다" },
    ]);
  });

  it("실행이 실패한 도구는 error-text 로 넘긴다", () => {
    const chain = [
      node({ id: "u", role: "user", content: "지워줘" }),
      node({
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [{ toolCallId: "c1", toolName: "delete_path", input: { path: "x" } }],
      }),
      node({
        id: "t",
        role: "tool",
        content: "delete_path(x) → 실패",
        toolResults: [
          { toolCallId: "c1", toolName: "delete_path", errorText: "찾을 수 없습니다: x" },
        ],
      }),
    ];

    const messages = toModelMessages(chain);
    // 텍스트가 비어 있어도 도구 호출만으로 assistant 메시지가 만들어져야 한다.
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "delete_path", input: { path: "x" } },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "delete_path",
          output: { type: "error-text", value: "찾을 수 없습니다: x" },
        },
      ],
    });
  });

  it("결과 노드가 없는 도구 호출은 떨어뜨린다 (도구 직전에서 분기한 경우)", () => {
    const chain = [
      node({ id: "u", role: "user", content: "봐줘" }),
      node({
        id: "a",
        role: "assistant",
        content: "읽어볼게요",
        toolCalls: [{ toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }],
      }),
    ];

    // 짝 없는 tool_use 를 그대로 보내면 공급자가 400 을 낸다.
    expect(toModelMessages(chain)).toEqual([
      { role: "user", content: "봐줘" },
      { role: "assistant", content: "읽어볼게요" },
    ]);
  });

  it("호출 없는 tool 노드도 떨어뜨린다", () => {
    const chain = [
      node({ id: "u", role: "user", content: "봐줘" }),
      node({
        id: "t",
        role: "tool",
        content: "고아 노드",
        toolResults: [{ toolCallId: "없음", toolName: "read_file", output: {} }],
      }),
    ];

    expect(toModelMessages(chain)).toEqual([{ role: "user", content: "봐줘" }]);
  });

  it("assistant 의 reasoning 저장 형식은 도구 결과로 오해하지 않는다", () => {
    const chain = [
      node({ id: "u", role: "user", content: "안녕" }),
      node({
        id: "a",
        role: "assistant",
        content: "안녕하세요",
        toolResults: { reasoning: "인사에 답한다" },
      }),
    ];

    expect(toModelMessages(chain)).toEqual([
      { role: "user", content: "안녕" },
      { role: "assistant", content: "안녕하세요" },
    ]);
  });
});

describe("readToolCalls / readToolResults", () => {
  it("배열이 아니거나 형식이 다른 값은 무시한다", () => {
    expect(readToolCalls(null)).toEqual([]);
    expect(readToolCalls({ reasoning: "x" })).toEqual([]);
    expect(readToolCalls([{ toolName: "read_file" }])).toEqual([]);
    expect(readToolResults([{ toolCallId: "c1" }])).toEqual([]);
  });

  it("형식이 맞는 항목만 통과시킨다", () => {
    const calls = readToolCalls([
      { toolCallId: "c1", toolName: "read_file", input: {} },
      { broken: true },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
  });
});


describe("contextPayloadOf — 게이지가 쓸 페이로드 크기", () => {
  const usage = { inputTokens: 1_000, outputTokens: 50, totalTokens: 1_050 };

  /** user → assistant(실측 있음) → user 로 이어지는 흐름. */
  const chain = [
    node({ id: "u1", role: "user", content: "안녕", seq: 1 }),
    node({
      id: "a1",
      parentId: "u1",
      role: "assistant",
      content: "반갑습니다",
      seq: 2,
      tokenUsage: usage,
      contextSnapshot: { modelId: "anthropic:claude-opus-5", system: "SYS", messages: [] },
    }),
    node({ id: "u2", parentId: "a1", role: "user", content: "하나 더", seq: 3 }),
  ];

  it("기준점 호출이 받았던 페이로드를 조상 체인으로 되만든다", () => {
    const payload = contextPayloadOf(chain, chain, "SYS");

    // 지금 나갈 것 = 세 메시지 전부.
    expect(payload.messageCount).toBe(3);
    expect(payload.chars).toBe(payloadChars({ system: "SYS", messages: toModelMessages(chain) }));

    // 기준점(a1)이 받았던 것 = 그 앞의 user 하나뿐. 답변과 새 질문은 그 뒤에 붙었다.
    expect(payload.measuredChars).toBe(
      payloadChars({ system: "SYS", messages: toModelMessages(chain.slice(0, 1)) }),
    );
    expect(payload.measuredChars!).toBeLessThan(payload.chars);
  });

  it("기준점의 system 은 그 노드의 스냅샷을 쓴다 (그 뒤 지침이 커졌으면 증가분이 잡힌다)", () => {
    const payload = contextPayloadOf(chain, chain, "SYS + 새로 커진 AGENTS.md");

    // 지금 나갈 쪽만 길어진 system 을 싣는다 → 그 차이가 환산 대상으로 남는다.
    expect(payload.measuredChars).toBe(
      payloadChars({ system: "SYS", messages: toModelMessages(chain.slice(0, 1)) }),
    );
  });

  it("실측 호출이 하나도 없으면 비율을 만들 수 없다", () => {
    const fresh = [node({ id: "u1", role: "user", content: "안녕" })];
    expect(contextPayloadOf(fresh, fresh, "SYS").measuredChars).toBeNull();
  });
});

describe("buildTurnContext — 공급자 부가 필드 되살리기", () => {
  const signature = { google: { thought_signature: "EpoE" } };

  it("저장된 호출의 extraContent 를 다시 기억시킨다", () => {
    // 앱을 다시 켠 직후처럼 창고가 빈 상태.
    forgetExtraContent();
    const [assistant, tool] = toolStep("s1", "call-1", { content: "ok" });
    const chain = [
      node({ id: "u", role: "user", content: "읽어줘" }),
      {
        ...assistant,
        toolCalls: [
          { toolCallId: "call-1", toolName: "read_file", input: {}, extraContent: signature },
        ],
      },
      tool,
    ];

    buildTurnContext({
      modelId: "google:gemini-3.7-flash",
      system: "",
      chain,
      effort: "medium",
      maxSteps: 12,
    });

    // 요청에 되붙이는 일은 fetch 겹이 한다 — 여기서는 창고가 찼는지만 본다.
    expect(extraContentFor("call-1")).toEqual(signature);
  });

  it("부가 필드가 없던 대화는 아무것도 담지 않는다", () => {
    forgetExtraContent();
    buildTurnContext({
      modelId: "anthropic:claude-opus-5",
      system: "",
      chain: [node({ id: "u", role: "user", content: "안녕" }), ...toolStep("s1", "call-9", {})],
      effort: "medium",
      maxSteps: 12,
    });
    expect(extraContentFor("call-9")).toBeUndefined();
  });
});
