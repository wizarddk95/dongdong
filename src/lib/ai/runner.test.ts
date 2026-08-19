import { describe, expect, it } from "vitest";

import { readToolCalls, readToolResults, toModelMessages } from "@/lib/ai/runner";
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
