import { createOpenAI } from "@ai-sdk/openai";
import { tool } from "@ai-sdk/provider-utils";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createToolCallIndexer, repairSseLine, sseRepairStream, withSseRepair } from "@/lib/ai/sseRepair";

/** 구글 호환 계층이 실제로 보내는 모양 — `index` 가 없고 `extra_content` 가 붙는다. */
function geminiToolCallLine(id: string, name: string): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          role: "assistant",
          tool_calls: [
            {
              extra_content: { google: { thought_signature: "ErkKCrYK" } },
              function: { arguments: "{}", name },
              id,
              type: "function",
            },
          ],
        },
        index: 0,
      },
    ],
    model: "gemini-3.7-flash",
    object: "chat.completion.chunk",
  })}`;
}

function payloadOf(line: string): Record<string, any> {
  return JSON.parse(line.slice(line.indexOf("{")));
}

async function pump(chunks: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const reader = source.pipeThrough(sseRepairStream()).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("repairSseLine", () => {
  it("빠진 tool_calls[].index 를 채운다", () => {
    const line = repairSseLine(geminiToolCallLine("call_1", "list_directory"), createToolCallIndexer());
    expect(payloadOf(line).choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("한 턴의 도구 호출마다 다른 번호를 준다", () => {
    const indexer = createToolCallIndexer();
    const first = repairSseLine(geminiToolCallLine("call_1", "list_directory"), indexer);
    const second = repairSseLine(geminiToolCallLine("call_2", "read_file"), indexer);
    expect(payloadOf(first).choices[0].delta.tool_calls[0].index).toBe(0);
    expect(payloadOf(second).choices[0].delta.tool_calls[0].index).toBe(1);
  });

  it("같은 id 의 조각은 같은 번호로 이어 붙인다", () => {
    const indexer = createToolCallIndexer();
    repairSseLine(geminiToolCallLine("call_1", "list_directory"), indexer);
    const again = repairSseLine(geminiToolCallLine("call_1", "list_directory"), indexer);
    expect(payloadOf(again).choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it("공급자가 준 index 는 건드리지 않는다", () => {
    const original = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 3, id: "call_x", function: { name: "f" } } ] } }],
    })}`;
    expect(repairSseLine(original, createToolCallIndexer())).toBe(original);
  });

  it("본문 청크·[DONE]·JSON 이 아닌 줄은 원문 그대로 둔다", () => {
    const indexer = createToolCallIndexer();
    const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "안녕" } }] })}`;
    expect(repairSseLine(text, indexer)).toBe(text);
    expect(repairSseLine("data: [DONE]", indexer)).toBe("data: [DONE]");
    expect(repairSseLine("event: message", indexer)).toBe("event: message");
    expect(repairSseLine("data: tool_calls 아님", indexer)).toBe("data: tool_calls 아님");
  });
});

describe("sseRepairStream", () => {
  it("줄 한복판에서 청크가 끊겨도 복구한다", async () => {
    const line = geminiToolCallLine("call_1", "list_directory");
    const cut = Math.floor(line.length / 2);
    const out = await pump([`${line.slice(0, cut)}`, `${line.slice(cut)}\n\n`]);
    expect(payloadOf(out).choices[0].delta.tool_calls[0].index).toBe(0);
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("여러 이벤트가 한 청크에 와도 각각 번호를 받는다", async () => {
    const out = await pump([
      `${geminiToolCallLine("call_1", "list_directory")}\n\n${geminiToolCallLine("call_2", "read_file")}\n\ndata: [DONE]\n\n`,
    ]);
    const indices = out
      .split("\n")
      .filter((line) => line.includes("tool_calls"))
      .map((line) => payloadOf(line).choices[0].delta.tool_calls[0].index);
    expect(indices).toEqual([0, 1]);
    expect(out).toContain("data: [DONE]");
  });

  it("thought_signature 같은 다른 필드는 보존한다", async () => {
    const out = await pump([`${geminiToolCallLine("call_1", "list_directory")}\n\n`]);
    const call = payloadOf(out).choices[0].delta.tool_calls[0];
    expect(call.extra_content.google.thought_signature).toBe("ErkKCrYK");
    expect(call.function).toEqual({ arguments: "{}", name: "list_directory" });
  });
});

describe("withSseRepair", () => {
  it("SSE 응답만 보정하고 나머지는 그대로 통과시킨다", async () => {
    const sse = new Response(`${geminiToolCallLine("call_1", "list_directory")}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    const json = new Response(JSON.stringify({ error: { message: "nope" } }), {
      headers: { "content-type": "application/json" },
    });
    const calls: unknown[] = [];
    const wrapped = withSseRepair((async (input: unknown) => {
      calls.push(input);
      return calls.length === 1 ? sse : json;
    }) as unknown as typeof globalThis.fetch);

    const repaired = await wrapped("https://example.test/stream");
    expect(payloadOf(await repaired.text()).choices[0].delta.tool_calls[0].index).toBe(0);

    const passthrough = await wrapped("https://example.test/models");
    expect(passthrough).toBe(json);
  });
});

/**
 * 회귀 방지용. 사용자가 겪은 그 청크를 그대로 `@ai-sdk/openai` 의 chat 모델에 흘려
 * 보정 전에는 검증 오류로 죽고 보정 후에는 도구 호출이 나오는지 확인한다.
 */
describe("@ai-sdk/openai 스키마 통과", () => {
  const stream = [
    `${geminiToolCallLine("call_335908", "list_directory")}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
      model: "gemini-3.7-flash",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 10, prompt_tokens: 1250, total_tokens: 1519 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const fakeFetch = (async () =>
    new Response(stream, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof globalThis.fetch;

  async function partsFrom(fetchImpl: typeof globalThis.fetch): Promise<string[]> {
    const model = createOpenAI({
      name: "google",
      apiKey: "test",
      baseURL: "https://example.test/v1",
      fetch: fetchImpl,
    }).chat("gemini-3.7-flash");
    const result = streamText({
      model,
      prompt: "hi",
      // 실패 경로를 일부러 태우는 테스트라 SDK 의 기본 로거가 콘솔을 덮는다 → 삼킨다.
      onError: () => {},
      tools: {
        list_directory: tool({
          description: "목록",
          inputSchema: z.object({}),
          execute: async () => "ok",
        }),
      },
    });
    const parts: string[] = [];
    for await (const part of result.fullStream) parts.push(part.type);
    return parts;
  }

  it("보정하지 않으면 index 검증에서 스트림이 죽는다", async () => {
    expect(await partsFrom(fakeFetch)).toContain("error");
  });

  it("보정하면 도구 호출이 그대로 흐른다", async () => {
    const parts = await partsFrom(withSseRepair(fakeFetch));
    expect(parts).toContain("tool-call");
    expect(parts).not.toContain("error");
  });
});
