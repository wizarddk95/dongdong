import { tool } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { abortableTools, raceAbort, ToolAbortError } from "@/lib/ai/abort";

/** 영원히 끝나지 않는 도구 — 중단이 안 걸리면 턴도 끝나지 않는다. */
function hangingTool() {
  return tool({
    description: "never",
    inputSchema: z.object({}),
    execute: () => new Promise<string>(() => {}),
  });
}

function execute(definition: unknown, signal?: AbortSignal) {
  const executable = definition as {
    execute: (input: unknown, options: unknown) => unknown;
  };
  return executable.execute({}, { toolCallId: "call-1", messages: [], abortSignal: signal });
}

describe("raceAbort", () => {
  it("중단이 없으면 그대로 결과를 돌려준다", async () => {
    await expect(raceAbort(Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(raceAbort(Promise.resolve("ok"), new AbortController().signal)).resolves.toBe(
      "ok",
    );
  });

  it("이미 중단된 시그널이면 시작하지 않는다", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceAbort(Promise.resolve("ok"), controller.signal)).rejects.toBeInstanceOf(
      ToolAbortError,
    );
  });

  it("실행 중에 중단되면 곧바로 거절한다", async () => {
    const controller = new AbortController();
    const pending = raceAbort(new Promise<string>(() => {}), controller.signal, "read_file");

    controller.abort();

    await expect(pending).rejects.toThrow("중단되었습니다 (read_file)");
  });
});

describe("abortableTools", () => {
  it("끝나지 않는 도구도 중단으로 풀린다", async () => {
    const tools = abortableTools({ hang: hangingTool() });
    const controller = new AbortController();

    const pending = execute(tools.hang, controller.signal) as Promise<unknown>;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
  });

  it("중단 시그널이 없으면 원래 동작 그대로다", async () => {
    const tools = abortableTools({
      echo: tool({
        description: "echo",
        inputSchema: z.object({}),
        execute: async () => "결과",
      }),
    });

    await expect(execute(tools.echo)).resolves.toBe("결과");
  });

  it("도구 이름과 스키마는 그대로 유지된다", () => {
    const original = { hang: hangingTool() };
    const wrapped = abortableTools(original);

    expect(Object.keys(wrapped)).toEqual(["hang"]);
    expect(wrapped.hang.description).toBe(original.hang.description);
    expect(wrapped.hang.inputSchema).toBe(original.hang.inputSchema);
  });

  it("execute 가 없는 도구(공급자 실행형)는 건드리지 않는다", () => {
    const passthrough = {
      client_side: tool({ description: "브라우저에서 실행", inputSchema: z.object({}) }),
    };
    const wrapped = abortableTools(passthrough);

    expect(wrapped.client_side).toEqual(passthrough.client_side);
  });
});
