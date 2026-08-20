/**
 * 도구 실행에 "중단"을 붙이는 얇은 래퍼.
 *
 * AI SDK 는 스트림에서 청크를 읽을 때만 `abortSignal` 을 확인한다
 * (`streamText` 의 pull 루프 — 청크가 하나 도착해야 abort 를 관측한다).
 * 그런데 도구가 도는 동안에는 청크가 하나도 흐르지 않는다.
 * 그래서 도구가 스스로 풀리지 않으면 [중단]을 눌러도 턴이 끝나지 않는다 —
 * 셸 명령(기본 타임아웃 120초)이나 MCP 호출(60초)이 끝날 때까지 아무 일도 일어나지 않았다.
 *
 * 여기서 도구 실행을 중단 시그널과 경주시켜, 중단 즉시 도구가 거절되도록 만든다.
 * 도구가 거절되면 tool-error 청크가 흐르고, 그 순간 AI SDK 가 abort 를 관측해 스트림을 닫는다.
 *
 * 백그라운드에 남는 실제 작업(셸 프로세스 등)은 각 도구가 따로 정리한다
 * (`skills.ts` 의 `execute_shell_command` → `cancelShellCommand`).
 */
import type { ToolSet } from "@ai-sdk/provider-utils";

/** 중단으로 도구가 끊겼을 때. 트리에는 tool-error 로 남는다. */
export class ToolAbortError extends Error {
  constructor(toolName?: string) {
    super(toolName ? `중단되었습니다 (${toolName})` : "중단되었습니다");
    this.name = "ToolAbortError";
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/** 작업과 중단 시그널을 경주시킨다. 중단이 이기면 `ToolAbortError` 로 거절한다. */
export function raceAbort<T>(
  work: PromiseLike<T>,
  signal?: AbortSignal,
  toolName?: string,
): Promise<T> {
  if (!signal) return Promise.resolve(work);
  if (signal.aborted) return Promise.reject(new ToolAbortError(toolName));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolAbortError(toolName));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * ToolSet 의 모든 도구에 중단을 붙인다. `runner.ts` 가 streamText 에 넘기기 직전에 한 번 감싼다.
 * (Skill · MCP · 위임까지 한 곳에서 처리된다)
 */
export function abortableTools<T extends ToolSet>(tools: T): T {
  const wrapped: Record<string, unknown> = {};

  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (typeof execute !== "function") {
      wrapped[name] = definition;
      continue;
    }

    wrapped[name] = {
      ...definition,
      execute: (input: never, options: { abortSignal?: AbortSignal }) => {
        const result = execute(input, options as Parameters<typeof execute>[1]);
        // 결과를 스트리밍하는 도구(AsyncIterable)는 건드리지 않는다.
        if (!isThenable(result)) return result;
        return raceAbort(result, options?.abortSignal, name);
      },
    };
  }

  return wrapped as T;
}
