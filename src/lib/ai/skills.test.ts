import { asSchema } from "@ai-sdk/provider-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildSkills, skillNames, summarizeToolCall } from "@/lib/ai/skills";

// 실제 IPC 는 Tauri 런타임이 필요하므로 통째로 가짜로 바꾼다.
vi.mock("@/lib/ipc", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  createDirectory: vi.fn(),
  deletePath: vi.fn(),
  pathInfo: vi.fn(),
  executeShellCommand: vi.fn(),
  upsertMemory: vi.fn(),
  listMemories: vi.fn(),
}));

import * as ipc from "@/lib/ipc";

const mocked = vi.mocked(ipc);

/** 도구 실행 헬퍼 — 테스트에서 필요 없는 실행 옵션은 비워 둔다. */
async function run(tool: unknown, input: unknown) {
  const executable = tool as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
    inputSchema: { parse?: (value: unknown) => unknown };
  };
  return executable.execute(input, { toolCallId: "call-1", messages: [], context: undefined });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildSkills", () => {
  it("토글에 따라 노출되는 도구가 달라진다", () => {
    const all = Object.keys(buildSkills());
    expect(all).toContain("read_file");
    expect(all).toContain("write_file");
    expect(all).toContain("execute_shell_command");
    expect(all).toContain("remember");

    const readOnly = Object.keys(
      buildSkills({ enabled: { fsWrite: false, shell: false, memory: false } }),
    );
    expect(readOnly).toEqual(["read_file", "list_directory", "path_info"]);

    expect(Object.keys(buildSkills({ enabled: { fsRead: false } }))).not.toContain("read_file");
  });

  it("delegate_task 는 위임 실행기를 넘겼을 때만 노출된다", async () => {
    // 서브에이전트에게 도구를 만들어 줄 때는 실행기를 생략해 재위임을 막는다.
    expect(Object.keys(buildSkills())).not.toContain("delegate_task");

    const onDelegate = vi.fn().mockResolvedValue({
      runId: "r1",
      name: "테스트 러너",
      status: "succeeded",
      result: "3건 실패",
    });
    const tools = buildSkills({ onDelegate });
    expect(Object.keys(tools)).toContain("delegate_task");

    const outcome = await run(tools.delegate_task, { name: "테스트 러너", task: "테스트 돌려" });
    expect(onDelegate).toHaveBeenCalledWith({ name: "테스트 러너", task: "테스트 돌려" });
    expect(outcome).toMatchObject({ runId: "r1", status: "succeeded" });

    // 토글을 끄면 실행기가 있어도 안 나온다.
    expect(
      Object.keys(buildSkills({ onDelegate, enabled: { subagents: false } })),
    ).not.toContain("delegate_task");
  });

  it("skillNames 는 활성 도구 이름만 돌려준다", () => {
    expect(skillNames({ enabled: { fsRead: false, fsWrite: false, memory: false } })).toEqual([
      "execute_shell_command",
    ]);
  });

  it("모든 도구가 설명과 입력 스키마를 갖는다", () => {
    for (const [name, tool] of Object.entries(buildSkills())) {
      const definition = tool as { description?: string; inputSchema?: unknown };
      expect(definition.description, `${name} 설명 누락`).toBeTruthy();
      expect(definition.inputSchema, `${name} 스키마 누락`).toBeTruthy();
    }
  });

  it("zod 스키마가 공급자에 보낼 JSON Schema 로 변환된다", () => {
    // 이 변환은 실제 요청 직전에 일어나므로, 여기서 막히면 런타임에야 터진다.
    for (const [name, tool] of Object.entries(buildSkills())) {
      const schema = asSchema((tool as { inputSchema: never }).inputSchema);
      const json = schema.jsonSchema as { type?: string; properties?: Record<string, unknown> };
      expect(json.type, `${name} JSON Schema 변환 실패`).toBe("object");
      expect(Object.keys(json.properties ?? {}).length, `${name} 속성 없음`).toBeGreaterThan(0);
    }
  });
});

describe("도구 실행", () => {
  it("read_file 은 IPC 결과를 LLM 이 읽기 좋은 형태로 줄인다", async () => {
    mocked.readFile.mockResolvedValue({
      path: "C:/p/src/App.tsx",
      relativePath: "src/App.tsx",
      content: "export default App",
      size: 18,
      truncated: false,
      isBinary: false,
    });

    const tools = buildSkills({ projectPath: "C:/p" });
    const result = await run(tools.read_file, { path: "src/App.tsx" });

    expect(mocked.readFile).toHaveBeenCalledWith("src/App.tsx", "C:/p");
    expect(result).toEqual({
      path: "src/App.tsx",
      content: "export default App",
      size: 18,
      truncated: false,
      isBinary: false,
    });
  });

  it("execute_shell_command 는 종료 코드와 출력을 함께 돌려준다", async () => {
    mocked.executeShellCommand.mockResolvedValue({
      command: "pnpm test",
      shell: "cmd",
      cwd: "C:/p",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      success: true,
      timedOut: false,
      truncated: false,
      durationMs: 42,
    });

    const tools = buildSkills();
    const result = (await run(tools.execute_shell_command, { command: "pnpm test" })) as Record<
      string,
      unknown
    >;

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("ok");
  });

  it("긴 쉘 출력은 잘라서 컨텍스트를 지킨다", async () => {
    mocked.executeShellCommand.mockResolvedValue({
      command: "cat big",
      shell: "cmd",
      cwd: "C:/p",
      stdout: "x".repeat(25_000),
      stderr: "",
      exitCode: 0,
      success: true,
      timedOut: false,
      truncated: false,
      durationMs: 1,
    });

    const result = (await run(buildSkills().execute_shell_command, { command: "cat big" })) as {
      stdout: string;
      truncated: boolean;
    };

    expect(result.stdout.length).toBeLessThan(25_000);
    expect(result.truncated).toBe(true);
  });

  it("remember 는 세션 스코프를 그대로 전달한다", async () => {
    mocked.upsertMemory.mockResolvedValue({
      id: "mem-1",
      projectId: "p1",
      sessionId: "s1",
      scope: "session",
      key: "할일",
      value: "테스트 붙이기",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const tools = buildSkills({ sessionId: "s1" });
    const result = await run(tools.remember, {
      key: "할일",
      value: "테스트 붙이기",
      scope: "session",
    });

    expect(mocked.upsertMemory).toHaveBeenCalledWith(
      { key: "할일", value: "테스트 붙이기", scope: "session", sessionId: "s1" },
      undefined,
    );
    expect(result).toEqual({ key: "할일", scope: "session", updatedAt: "2026-01-01T00:00:00Z" });
  });

  it("recall 은 key 로 걸러 준다", async () => {
    mocked.listMemories.mockResolvedValue([
      {
        id: "m1",
        projectId: "p1",
        sessionId: null,
        scope: "project",
        key: "빌드",
        value: "pnpm build",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        projectId: "p1",
        sessionId: null,
        scope: "project",
        key: "테스트",
        value: "pnpm test",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    const tools = buildSkills({ sessionId: "s1" });
    const all = (await run(tools.recall, {})) as { total: number };
    const one = (await run(tools.recall, { key: "빌드" })) as {
      total: number;
      memories: { value: string }[];
    };

    expect(mocked.listMemories).toHaveBeenCalledWith("s1", undefined);
    expect(all.total).toBe(2);
    expect(one.total).toBe(1);
    expect(one.memories[0].value).toBe("pnpm build");
  });
});

describe("summarizeToolCall", () => {
  it("경로/명령/키를 골라 한 줄로 줄인다", () => {
    expect(summarizeToolCall("read_file", { path: "src/App.tsx" })).toBe("read_file(src/App.tsx)");
    expect(summarizeToolCall("execute_shell_command", { command: "pnpm test" })).toBe(
      "execute_shell_command(pnpm test)",
    );
    expect(summarizeToolCall("remember", { key: "빌드", value: "…" })).toBe("remember(빌드)");
    expect(summarizeToolCall("delegate_task", { name: "테스트 러너", task: "…" })).toBe(
      "delegate_task(테스트 러너)",
    );
    expect(summarizeToolCall("recall", {})).toBe("recall");
  });

  it("아주 긴 인자는 잘라 낸다", () => {
    const summary = summarizeToolCall("execute_shell_command", { command: "x".repeat(200) });
    // 도구 이름 + 60자 + 말줄임 괄호
    expect(summary.length).toBe("execute_shell_command".length + 63);
    expect(summary.endsWith("…)")).toBe(true);
  });
});
