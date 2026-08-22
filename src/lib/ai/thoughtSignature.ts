/**
 * 구글 OpenAI 호환 계층의 `thought_signature` 왕복.
 *
 * Gemini 3.x 는 함수 호출 청크에 서명을 실어 보내고
 *   `"tool_calls":[{ …, "extra_content":{"google":{"thought_signature":"EpoE…"}}}]`
 * **그 호출을 다시 올릴 때 같은 값이 붙어 있기를 요구한다**. `@ai-sdk/openai` 는 이 필드를
 * 모르므로 assistant 메시지를 재조립할 때 떨어뜨린다 → 도구를 부른 **다음** 요청이 통째로
 * 400 이 된다: `Function call is missing a thought_signature in functionCall parts.`
 *
 * 도구 호출은 성공하고 결과 노드까지 남은 뒤 그 다음 요청에서 죽기 때문에 "방금 붙인
 * 도구가 깨졌다" 처럼 보이지만, 도구와는 무관하다 — 내장 스킬도 똑같이 죽는다.
 *
 * `sseRepair` 와 같은 계약을 지킨다: **없던 필드를 채우는 일 하나뿐**이고, 채울 것이
 * 없으면 원문 문자열을 그대로 돌려준다. 응답 쪽은 아예 관찰만 하고 바이트를 손대지 않는다.
 */

/**
 * 도구 호출 id → 공급자가 붙여 보낸 `extra_content` 원문.
 *
 * 한 요청 안에서 끝나는 값이 아니라 **응답에서 주워 다음 요청에 되붙이는** 값이라
 * fetch 래퍼보다 오래 살아야 한다. 대화가 길어져도 무한히 자라지 않게 상한을 둔다.
 */
const remembered = new Map<string, unknown>();

/** 대화 하나가 만들 수 있는 도구 호출 수보다 넉넉하게. 넘으면 오래된 것부터 버린다. */
const MAX_REMEMBERED = 500;

export function rememberExtraContent(toolCallId: unknown, extra: unknown): void {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (extra === undefined || extra === null) return;

  // 같은 id 를 다시 보면 맨 뒤로 옮겨 둔다 (Map 은 삽입 순서를 지킨다).
  remembered.delete(toolCallId);
  remembered.set(toolCallId, extra);

  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next();
    if (oldest.done) break;
    remembered.delete(oldest.value);
  }
}

export function extraContentFor(toolCallId: string): unknown {
  return remembered.get(toolCallId);
}

/** 테스트에서 상태를 비운다. */
export function forgetExtraContent(): void {
  remembered.clear();
}

/** `choices[].delta` 와 `choices[].message` 양쪽에서 도구 호출 배열을 꺼낸다. */
function toolCallsIn(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];

  const out: unknown[] = [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    for (const key of ["delta", "message"] as const) {
      const slot = (choice as Record<string, unknown>)[key];
      if (typeof slot !== "object" || slot === null) continue;
      const calls = (slot as { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(calls)) out.push(...calls);
    }
  }
  return out;
}

/** 응답 SSE 한 줄에서 서명만 주워 둔다. 줄 자체는 건드리지 않는다. */
export function harvestSseLine(line: string): void {
  if (!line.startsWith("data:")) return;
  if (!line.includes("extra_content")) return;

  const payload = line.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }

  for (const call of toolCallsIn(parsed)) {
    if (typeof call !== "object" || call === null) continue;
    const slot = call as { id?: unknown; extra_content?: unknown };
    rememberExtraContent(slot.id, slot.extra_content);
  }
}

/**
 * 나가는 요청 본문의 `messages[].tool_calls[]` 에 기억해 둔 서명을 되붙인다.
 * 붙일 것이 없으면 **원문 문자열 그대로** 돌려준다.
 */
export function injectIntoRequestBody(body: string): string {
  if (!body.includes("tool_calls")) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;

  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return body;

  let changed = false;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;

    for (const call of calls) {
      if (typeof call !== "object" || call === null) continue;
      const slot = call as { id?: unknown; extra_content?: unknown };
      // 공급자가 이미 넣어 준 값이 있으면 그쪽이 우선이다.
      if (slot.extra_content !== undefined) continue;
      if (typeof slot.id !== "string") continue;

      const extra = remembered.get(slot.id);
      if (extra === undefined) continue;
      slot.extra_content = extra;
      changed = true;
    }
  }

  return changed ? JSON.stringify(parsed) : body;
}

/** 응답 바이트는 그대로 흘리면서 줄 단위로 서명만 주워 가는 관찰자. */
function harvestStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 원문 바이트를 먼저 내보낸다 — 이 변환기는 스트림을 지연시키지 않는다.
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      // 청크 경계가 줄 한복판에 떨어질 수 있으므로 마지막 조각은 다음 청크와 합친다.
      pending = lines.pop() ?? "";
      for (const line of lines) harvestSseLine(line);
    },
    flush() {
      pending += decoder.decode();
      if (pending) harvestSseLine(pending);
    },
  });
}

/**
 * `fetch` 를 한 겹 감싸 요청에는 서명을 되붙이고, 응답에서는 새 서명을 주워 둔다.
 * SSE 가 아닌 응답(에러 본문 · `/models`)은 손대지 않고 그대로 통과시킨다.
 */
export function withThoughtSignatures(
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const next =
      init && typeof init.body === "string"
        ? { ...init, body: injectIntoRequestBody(init.body) }
        : init;

    const response = await baseFetch(input, next);
    const body = response.body;
    if (!body) return response;
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return response;
    }

    return new Response(body.pipeThrough(harvestStream()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
