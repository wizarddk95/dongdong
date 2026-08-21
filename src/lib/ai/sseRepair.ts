/**
 * OpenAI 호환 SSE 스트림 보정.
 *
 * `@ai-sdk/openai` 의 스트리밍 청크 스키마는 `choices[].delta.tool_calls[].index` 를
 * **필수 number** 로 본다(OpenAI 본가는 항상 보낸다 — 같은 index 의 조각을 이어 붙여
 * 인자 문자열을 완성하는 구조라 index 가 스트림의 키다).
 *
 * 그런데 구글의 OpenAI 호환 계층(`GEMINI_BASE_URL`)은 도구 호출을 한 청크에 통째로
 * 실어 보내면서 `index` 를 **생략한다**. 그러면 첫 도구 호출이 나오는 순간
 * `Type validation failed: ... expected number, received undefined` 로 턴 전체가 날아간다
 * (본문 스트리밍만 하는 대화는 멀쩡하다 — 도구를 부를 때만 터진다).
 *
 * 그래서 응답 body 를 프로바이더에게 넘기기 전에 한 겹 지나가며 빠진 `index` 만 채운다.
 * 값은 **도구 호출 id 기준으로 등장 순서**를 매긴다 — 전부 0 으로 채우면 한 턴에
 * 도구를 둘 이상 부를 때 SDK 가 서로 다른 호출을 한 호출의 조각으로 이어 붙인다.
 *
 * 파싱하지 못한 줄·`[DONE]`·본문 청크는 **원문 그대로** 흘려보낸다. 보정은 없던 필드를
 * 채우는 일 하나뿐이고, 손대지 않은 바이트는 손대지 않은 채로 두는 것이 이 모듈의 계약이다.
 */

/** 스트림 하나가 유지하는 도구 호출 번호표. id 가 같으면 같은 번호를 준다. */
export interface ToolCallIndexer {
  seen: Map<string, number>;
  next: number;
}

export function createToolCallIndexer(): ToolCallIndexer {
  return { seen: new Map(), next: 0 };
}

function indexFor(indexer: ToolCallIndexer, id: unknown): number {
  if (typeof id !== "string" || id.length === 0) return indexer.next++;
  const known = indexer.seen.get(id);
  if (known !== undefined) return known;
  const assigned = indexer.next++;
  indexer.seen.set(id, assigned);
  return assigned;
}

/**
 * SSE 한 줄을 보정한다. `data:` 줄이 아니거나 JSON 이 아니면 원문 그대로 돌려준다.
 * (`data:` 뒤 공백 유무·줄 끝 `\r` 까지 원문을 보존한다 — 스트림을 다시 조립하는 쪽이 있다)
 */
export function repairSseLine(line: string, indexer: ToolCallIndexer): string {
  if (!line.startsWith("data:")) return line;
  if (!line.includes("tool_calls")) return line;

  const body = line.slice("data:".length);
  const trimmed = body.trim();
  if (!trimmed || trimmed === "[DONE]") return line;

  // 줄 끝의 `\r` 은 payload 가 아니라 줄바꿈의 일부다 — 떼어 두었다가 도로 붙인다.
  const cr = trimmed.endsWith("\r") ? "\r" : "";
  const payload = cr ? trimmed.slice(0, -1) : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return line;
  }

  if (!repairChunk(parsed, indexer)) return line;

  const lead = body.slice(0, body.length - body.trimStart().length);
  return `data:${lead}${JSON.stringify(parsed)}${cr}`;
}

/** 청크 객체를 제자리에서 고친다. 실제로 고쳤으면 `true`. */
function repairChunk(chunk: unknown, indexer: ToolCallIndexer): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return false;

  let changed = false;
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const delta = (choice as { delta?: unknown }).delta;
    if (typeof delta !== "object" || delta === null) continue;
    const calls = (delta as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;

    for (const call of calls) {
      if (typeof call !== "object" || call === null) continue;
      const slot = call as { index?: unknown; id?: unknown };
      if (typeof slot.index === "number") {
        // 공급자가 준 번호가 있으면 그대로 존중하되, 뒤에 올 무명 호출과 겹치지 않게 자리를 비켜 준다.
        indexer.next = Math.max(indexer.next, slot.index + 1);
        if (typeof slot.id === "string" && slot.id) indexer.seen.set(slot.id, slot.index);
        continue;
      }
      slot.index = indexFor(indexer, slot.id);
      changed = true;
    }
  }
  return changed;
}

/**
 * 바이트 스트림용 변환기. 청크 경계가 줄 한복판에 떨어질 수 있으므로 줄 단위로 버퍼링한다.
 * (완성되지 않은 마지막 줄은 다음 청크와 합쳐 처리하고, 스트림이 끝나면 그대로 내보낸다)
 */
export function sseRepairStream(): TransformStream<Uint8Array, Uint8Array> {
  const indexer = createToolCallIndexer();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (lines.length === 0) return;
      const out = lines.map((line) => repairSseLine(line, indexer)).join("\n");
      controller.enqueue(encoder.encode(`${out}\n`));
    },
    flush(controller) {
      pending += decoder.decode();
      if (!pending) return;
      controller.enqueue(encoder.encode(repairSseLine(pending, indexer)));
    },
  });
}

/**
 * `fetch` 를 한 겹 감싸 SSE 응답만 보정해서 돌려준다.
 * 스트림이 아닌 응답(JSON 에러 본문 · `/models` 목록)은 손대지 않고 그대로 통과시킨다.
 */
export function withSseRepair(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const body = response.body;
    if (!body) return response;
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;

    return new Response(body.pipeThrough(sseRepairStream()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
