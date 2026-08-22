import { beforeEach, describe, expect, it } from "vitest";

import {
  extraContentFor,
  forgetExtraContent,
  harvestSseLine,
  injectIntoRequestBody,
  rememberExtraContent,
  withThoughtSignatures,
} from "@/lib/ai/thoughtSignature";

const SIGNATURE = { google: { thought_signature: "EpoECpcEARFNMg" } };

/** 구글이 실제로 흘리는 모양 — 도구 호출 한 개에 서명이 함께 실린다. */
function toolCallChunk(id: string, extra: unknown = SIGNATURE) {  // 서명 있는 청크
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: { name: "mcp__tavily__tavily_search", arguments: "{}" },
              ...(extra === undefined ? {} : { extra_content: extra }),
            },
          ],
        },
      },
    ],
  })}`;
}

/** SDK 가 재조립해 다시 올리는 요청 — 서명이 빠져 있다. */
function requestBody(ids: string[]) {
  return JSON.stringify({
    model: "gemini-3.7-flash",
    messages: [
      { role: "user", content: "책 추천" },
      {
        role: "assistant",
        content: "",
        tool_calls: ids.map((id) => ({
          id,
          type: "function",
          function: { name: "mcp__tavily__tavily_search", arguments: "{}" },
        })),
      },
      ...ids.map((id) => ({ role: "tool", tool_call_id: id, content: "결과" })),
    ],
  });
}

beforeEach(() => forgetExtraContent());

describe("harvestSseLine", () => {
  it("도구 호출 청크에서 서명을 주워 둔다", () => {
    harvestSseLine(toolCallChunk("call_868961"));
    expect(extraContentFor("call_868961")).toEqual(SIGNATURE);
  });

  it("스트리밍이 아닌 응답(message.tool_calls)에서도 줍는다", () => {
    harvestSseLine(
      `data: ${JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "call_1", extra_content: SIGNATURE }] } }],
      })}`,
    );
    expect(extraContentFor("call_1")).toEqual(SIGNATURE);
  });

  it("서명이 없는 줄·[DONE]·깨진 JSON 은 그냥 지나간다", () => {
    expect(() => {
      // 서명이 아직 안 붙은 청크 (본문만 흐르는 구간)
      harvestSseLine(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2" }] } }],
        })}`,
      );
      harvestSseLine("data: [DONE]");
      harvestSseLine("data: {깨진");
      harvestSseLine(": keep-alive");
    }).not.toThrow();
    expect(extraContentFor("call_2")).toBeUndefined();
  });
});

describe("injectIntoRequestBody", () => {
  it("기억해 둔 서명을 같은 id 의 호출에 되붙인다", () => {
    rememberExtraContent("call_868961", SIGNATURE);

    const patched = JSON.parse(injectIntoRequestBody(requestBody(["call_868961"])));
    expect(patched.messages[1].tool_calls[0].extra_content).toEqual(SIGNATURE);
    // 나머지는 그대로다.
    expect(patched.messages[1].tool_calls[0].function.name).toBe("mcp__tavily__tavily_search");
    expect(patched.messages[2].tool_call_id).toBe("call_868961");
  });

  it("한 턴에 도구를 여럿 부른 경우 각자의 서명을 붙인다", () => {
    rememberExtraContent("call_a", { google: { thought_signature: "AAA" } });
    rememberExtraContent("call_b", { google: { thought_signature: "BBB" } });

    const patched = JSON.parse(injectIntoRequestBody(requestBody(["call_a", "call_b"])));
    const calls = patched.messages[1].tool_calls;
    expect(calls[0].extra_content.google.thought_signature).toBe("AAA");
    expect(calls[1].extra_content.google.thought_signature).toBe("BBB");
  });

  it("붙일 것이 없으면 원문 문자열을 그대로 돌려준다", () => {
    const body = requestBody(["call_unknown"]);
    expect(injectIntoRequestBody(body)).toBe(body);

    const plain = JSON.stringify({ messages: [{ role: "user", content: "안녕" }] });
    expect(injectIntoRequestBody(plain)).toBe(plain);
    expect(injectIntoRequestBody("not json")).toBe("not json");
  });

  it("공급자가 이미 넣어 준 값은 덮어쓰지 않는다", () => {
    rememberExtraContent("call_1", { google: { thought_signature: "새것" } });
    const body = JSON.stringify({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", extra_content: { keep: "원본" } }] },
      ],
    });
    expect(injectIntoRequestBody(body)).toBe(body);
  });
});

describe("rememberExtraContent", () => {
  it("id 나 값이 없으면 담지 않는다", () => {
    rememberExtraContent(undefined, SIGNATURE);
    rememberExtraContent("", SIGNATURE);
    rememberExtraContent("call_1", undefined);
    rememberExtraContent("call_1", null);
    expect(extraContentFor("call_1")).toBeUndefined();
  });

  it("오래되면 버리되 최근 것은 남긴다", () => {
    for (let index = 0; index < 600; index += 1) {
      rememberExtraContent(`call_${index}`, { n: index });
    }
    expect(extraContentFor("call_0")).toBeUndefined();
    expect(extraContentFor("call_599")).toEqual({ n: 599 });
  });
});

describe("withThoughtSignatures", () => {
  function sseResponse(lines: string[]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  it("응답에서 주운 서명을 다음 요청에 되붙인다", async () => {
    const seen: string[] = [];
    const wrapped = withThoughtSignatures(async (_input, init) => {
      seen.push(String(init?.body ?? ""));
      return sseResponse([toolCallChunk("call_868961"), "data: [DONE]"]);
    });

    // 1) 첫 요청 — 아직 아는 서명이 없다. 응답을 끝까지 읽어야 줍는다.
    const first = await wrapped("https://gemini.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "책 추천" }] }),
    });
    expect(await first.text()).toContain("extra_content");

    // 2) 도구 결과를 들고 다시 올라가는 요청 — 여기서 붙는다.
    await wrapped("https://gemini.test/chat/completions", {
      method: "POST",
      body: requestBody(["call_868961"]),
    });

    const replay = JSON.parse(seen[1]);
    expect(replay.messages[1].tool_calls[0].extra_content).toEqual(SIGNATURE);
  });

  it("SSE 가 아닌 응답과 body 없는 요청은 손대지 않는다", async () => {
    const wrapped = withThoughtSignatures(
      async () => new Response('{"error":{"message":"nope"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await wrapped("https://gemini.test/models");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":{"message":"nope"}}');
  });
});
