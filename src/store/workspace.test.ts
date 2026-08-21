import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeleteOutcome, Message } from "@/types/ipc";

// DB 대신 메모리 테이블을 놓고, 스토어가 트리 상태를 어떻게 추스르는지만 본다.
vi.mock("@/lib/ipc", () => ({
  listMessages: vi.fn(),
  appendMessage: vi.fn(),
  deleteMessages: vi.fn(),
  restoreMessages: vi.fn(),
  copyMessages: vi.fn(),
}));

import * as ipc from "@/lib/ipc";
import { useWorkspace } from "@/store/workspace";

const mocked = vi.mocked(ipc);

/** u1 → a1 → u2 → a2 → u3 → a3 로 이어진 한 줄기. */
function chain(): Message[] {
  const roles = ["user", "assistant", "user", "assistant", "user", "assistant"] as const;
  return roles.map((role, index) => ({
    id: `m${index + 1}`,
    sessionId: "s1",
    parentId: index === 0 ? null : `m${index}`,
    role,
    content: `${role}${index + 1}`,
    toolCalls: null,
    toolResults: null,
    contextSnapshot: null,
    tokenUsage: null,
    status: "complete",
    agentId: null,
    seq: index + 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }));
}

let rows: Message[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  rows = chain();

  mocked.listMessages.mockImplementation(async () => [...rows]);

  // Rust 쪽 `delete_messages` 를 흉내 낸다 — 지운 노드의 자식은 조상에 이어 붙는다.
  mocked.deleteMessages.mockImplementation(async (ids) => {
    const doomed = new Set(ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const survivorOf = (parentId: string | null): string | null => {
      let cursor = parentId;
      while (cursor && doomed.has(cursor)) cursor = byId.get(cursor)?.parentId ?? null;
      return cursor;
    };

    const outcome: DeleteOutcome = {
      removed: rows.filter((row) => doomed.has(row.id)),
      reattached: rows
        .filter((row) => !doomed.has(row.id) && row.parentId && doomed.has(row.parentId))
        .map((row) => ({
          messageId: row.id,
          fromParentId: row.parentId,
          toParentId: survivorOf(row.parentId),
        })),
      detachedRuns: [],
    };

    rows = rows
      .filter((row) => !doomed.has(row.id))
      .map((row) => {
        const moved = outcome.reattached.find((item) => item.messageId === row.id);
        return moved ? { ...row, parentId: moved.toParentId } : row;
      });
    return outcome;
  });

  mocked.restoreMessages.mockImplementation(async (outcome) => {
    rows = [...rows, ...outcome.removed]
      .map((row) => {
        const moved = outcome.reattached.find((item) => item.messageId === row.id);
        return moved ? { ...row, parentId: moved.fromParentId } : row;
      })
      .sort((a, b) => a.seq - b.seq);
    return outcome.removed.length;
  });

  mocked.copyMessages.mockImplementation(async (sourceIds, targetParentId) => {
    const copies = sourceIds.map((id, index) => ({
      ...(rows.find((row) => row.id === id) as Message),
      id: `${id}-copy`,
      parentId: index === 0 ? targetParentId : `${sourceIds[index - 1]}-copy`,
      seq: rows.length + index + 1,
      tokenUsage: null,
      contextSnapshot: null,
    }));
    rows = [...rows, ...copies];
    return copies;
  });

  useWorkspace.setState({
    activeSessionId: "s1",
    messages: chain(),
    activeParentId: "m6",
    selectedMessageId: "m4",
    deletions: [],
    clipboard: null,
    error: null,
  });
});

describe("useWorkspace.removeNodes", () => {
  it("턴 하나만 지우면 뒤 대화가 살아남아 부모에 이어 붙는다", async () => {
    const ok = await useWorkspace.getState().removeNodes(["m3", "m4"], {
      cascade: false,
      label: "턴 #3",
    });

    expect(ok).toBe(true);
    const state = useWorkspace.getState();
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", "m5", "m6"]);
    expect(state.messages.find((m) => m.id === "m5")?.parentId).toBe("m2");
    // 지워진 노드를 가리키던 선택은 놓아주고, 살아 있는 활성 부모는 그대로 둔다.
    expect(state.selectedMessageId).toBeNull();
    expect(state.activeParentId).toBe("m6");
  });

  it("되돌리면 원래 부모까지 제자리로 돌아온다", async () => {
    await useWorkspace.getState().removeNodes(["m3", "m4"], { cascade: false, label: "턴 #3" });
    expect(useWorkspace.getState().deletions).toHaveLength(1);

    const undone = await useWorkspace.getState().undoDelete();

    expect(undone).toBe(true);
    const state = useWorkspace.getState();
    expect(state.messages).toHaveLength(6);
    expect(state.messages.find((m) => m.id === "m5")?.parentId).toBe("m4");
    expect(state.deletions).toHaveLength(0);
  });

  it("활성 부모가 사라지면 살아 있는 잎으로 옮긴다", async () => {
    await useWorkspace.getState().removeNodes(["m5", "m6"], { cascade: true, label: "턴 #5" });

    expect(useWorkspace.getState().activeParentId).toBe("m4");
  });

  it("되돌리기가 실패해도 스택에 남아 같은 오류를 반복하지 않는다", async () => {
    await useWorkspace.getState().removeNodes(["m3", "m4"], { cascade: false, label: "턴 #3" });
    mocked.restoreMessages.mockRejectedValueOnce(new Error("부모 노드가 이미 사라져"));

    const undone = await useWorkspace.getState().undoDelete();

    expect(undone).toBe(false);
    expect(useWorkspace.getState().deletions).toHaveLength(0);
    expect(useWorkspace.getState().error).toContain("부모 노드가 이미 사라져");
  });

  it("다른 세션에서 지운 것은 되돌리기 대상이 아니다", async () => {
    useWorkspace.setState({
      deletions: [
        {
          sessionId: "s2",
          label: "남의 세션",
          outcome: { removed: [], reattached: [], detachedRuns: [] },
        },
      ],
    });

    expect(await useWorkspace.getState().undoDelete()).toBe(false);
    expect(mocked.restoreMessages).not.toHaveBeenCalled();
  });
});

describe("useWorkspace 클립보드", () => {
  it("복사한 턴을 다른 노드 뒤에 붙이고 그 끝에서 대화를 잇는다", async () => {
    useWorkspace.getState().copyNodes(["m3", "m4"], "턴 #3");
    expect(useWorkspace.getState().clipboard?.messageIds).toEqual(["m3", "m4"]);

    await useWorkspace.getState().pasteNodes("m6");

    expect(mocked.copyMessages).toHaveBeenCalledWith(["m3", "m4"], "m6", "s1");
    const state = useWorkspace.getState();
    expect(state.messages.map((m) => m.id)).toContain("m4-copy");
    expect(state.messages.find((m) => m.id === "m3-copy")?.parentId).toBe("m6");
    expect(state.activeParentId).toBe("m4-copy");
    // 클립보드는 붙여넣은 뒤에도 남는다 — 여러 자리에 이어 붙일 수 있어야 한다.
    expect(state.clipboard).not.toBeNull();
  });

  it("클립보드가 비어 있으면 아무 일도 하지 않는다", async () => {
    expect(await useWorkspace.getState().pasteNodes("m6")).toBeNull();
    expect(mocked.copyMessages).not.toHaveBeenCalled();
  });
});

describe("useWorkspace.addMessage", () => {
  it("붙일 곳을 잃어도 새 뿌리를 만들지 않고 마지막 잎에 잇는다", async () => {
    mocked.appendMessage.mockImplementation(async (input) => ({
      ...chain()[0],
      id: "new",
      parentId: input.parentId ?? null,
      seq: 99,
    }));
    useWorkspace.setState({ activeParentId: null });

    await useWorkspace.getState().addMessage({ role: "user", content: "이어서" });

    expect(mocked.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "m6" }),
    );
  });
});
