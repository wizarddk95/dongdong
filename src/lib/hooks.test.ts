import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ executeShellCommand: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => true) }));

import {
  BUILTIN_HOOKS,
  dispatchHooks,
  hooksFor,
  isBuiltinEnabled,
  notificationText,
  renderHookCommand,
  type HookConfig,
  type HookPayload,
} from "@/lib/hooks";
import * as ipc from "@/lib/ipc";
import { notify } from "@/lib/notify";

const payload: HookPayload = {
  event: "turnComplete",
  sessionId: "s1",
  projectPath: "C:/projects/x",
  status: "complete",
  durationMs: 4200,
};

function hook(partial: Partial<HookConfig>): HookConfig {
  return {
    id: "h1",
    name: "훅",
    event: "turnComplete",
    command: "echo done",
    enabled: true,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 셸 훅은 결과를 안 보지만 프로미스이긴 해야 한다.
  vi.mocked(ipc.executeShellCommand).mockResolvedValue({} as never);
});

describe("renderHookCommand", () => {
  it("자리표를 값으로 바꾼다", () => {
    expect(renderHookCommand("say {{event}} {{status}} {{durationMs}}", payload)).toBe(
      "say turnComplete complete 4200",
    );
  });

  it("모르는 자리표는 그대로 둔다 (오타를 조용히 지우지 않는다)", () => {
    expect(renderHookCommand("echo {{nope}}", payload)).toBe("echo {{nope}}");
  });

  it("명령을 갈라 놓을 수 있는 글자는 값에서 걷어낸다", () => {
    const rendered = renderHookCommand("echo {{project}}", {
      ...payload,
      projectPath: 'C:/x" && del /q *',
    });
    expect(rendered).not.toContain('"');
    expect(rendered).not.toContain("&&");
  });
});

describe("hooksFor / isBuiltinEnabled", () => {
  it("이벤트가 같고 켜진 훅만 고른다", () => {
    const hooks = [
      hook({ id: "a" }),
      hook({ id: "b", enabled: false }),
      hook({ id: "c", event: "turnStart" }),
    ];
    expect(hooksFor(hooks, "turnComplete").map((item) => item.id)).toEqual(["a"]);
  });

  it("설정에 없는 내장 훅은 자기 기본값을 따른다", () => {
    const complete = BUILTIN_HOOKS.find((item) => item.id === "notify-on-complete")!;
    expect(isBuiltinEnabled(complete, {})).toBe(true);
    expect(isBuiltinEnabled(complete, { "notify-on-complete": false })).toBe(false);
  });
});

describe("notificationText", () => {
  it("중단으로 끝난 턴을 완료라고 하지 않는다", () => {
    expect(notificationText({ ...payload, status: "aborted" }).title).toContain("중단");
  });

  it("오류는 이유를 본문에 싣는다", () => {
    const text = notificationText({
      ...payload,
      event: "turnError",
      status: "error",
      error: "400 Bad Request",
    });
    expect(text.body).toContain("400");
  });
});

describe("dispatchHooks", () => {
  it("내장 알림과 사용자 셸 훅을 함께 돌린다", async () => {
    await dispatchHooks(payload, {
      builtinToggles: {},
      hooks: [hook({ command: "echo {{status}}" })],
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(ipc.executeShellCommand).toHaveBeenCalledWith(
      "echo complete",
      expect.objectContaining({ cwd: "C:/projects/x" }),
    );
  });

  it("꺼 둔 내장 훅은 돌지 않는다", async () => {
    await dispatchHooks(payload, {
      builtinToggles: { "notify-on-complete": false },
      hooks: [],
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("다른 이벤트의 훅은 건드리지 않는다", async () => {
    await dispatchHooks(payload, {
      builtinToggles: {},
      hooks: [hook({ event: "turnError", command: "echo bad" })],
    });
    expect(ipc.executeShellCommand).not.toHaveBeenCalled();
  });

  it("셸 훅이 실패해도 던지지 않는다 — 턴을 흔들면 안 된다", async () => {
    vi.mocked(ipc.executeShellCommand).mockRejectedValueOnce(new Error("없는 명령"));
    await expect(
      dispatchHooks(payload, { builtinToggles: {}, hooks: [hook({})] }),
    ).resolves.toBeUndefined();
  });
});
