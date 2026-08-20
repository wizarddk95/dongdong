import { describe, expect, it } from "vitest";

import { buildTurns, siblingTurns, turnSubtree } from "@/lib/turns";
import type { Message, MessageRole } from "@/types/ipc";

function node(
  id: string,
  parentId: string | null,
  seq: number,
  role: MessageRole,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    sessionId: "s1",
    parentId,
    role,
    content: `${id} 본문`,
    toolCalls: null,
    toolResults: null,
    contextSnapshot: null,
    tokenUsage: null,
    status: "complete",
    agentId: null,
    seq,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

const call = (id: string, name: string) => ({ toolCallId: id, toolName: name, input: {} });

//  u1 ─ a1 ─ t1 ─ a2      (도구 1스텝을 낀 한 턴)
//                   └ u2 ─ a3   (다음 턴)
const WITH_TOOL: Message[] = [
  node("u1", null, 1, "user"),
  node("a1", "u1", 2, "assistant", { toolCalls: [call("c1", "read_file")] }),
  node("t1", "a1", 3, "tool", {
    toolCalls: [call("c1", "read_file")],
    toolResults: [{ toolCallId: "c1", toolName: "read_file", output: "ok" }],
  }),
  node("a2", "t1", 4, "assistant"),
  node("u2", "a2", 5, "user"),
  node("a3", "u2", 6, "assistant"),
];

describe("buildTurns", () => {
  it("user 노드를 앵커로 assistant/tool 스텝을 한 턴에 접는다", () => {
    const index = buildTurns(WITH_TOOL);
    expect(index.turns.map((t) => t.id)).toEqual(["u1", "u2"]);

    const first = index.byId.get("u1")!;
    expect(first.nodes.map((n) => n.id)).toEqual(["u1", "a1", "t1", "a2"]);
    expect(first.leafId).toBe("a2");
    expect(first.userText).toBe("u1 본문");
    expect(first.assistantText).toBe("a2 본문");
    expect(first.toolUses).toEqual([{ name: "read_file", count: 1 }]);
    expect(first.toolErrorCount).toBe(0);
  });

  it("다음 턴은 앞 턴을 부모로 갖는다", () => {
    const index = buildTurns(WITH_TOOL);
    const second = index.byId.get("u2")!;
    expect(second.parentTurnId).toBe("u1");
    expect(second.branchPointId).toBe("a2");
    expect(index.roots.map((t) => t.id)).toEqual(["u1"]);
    expect(index.childrenOf.get("u1")?.map((t) => t.id)).toEqual(["u2"]);
    expect(index.turnOfMessage.get("t1")).toBe("u1");
  });

  it("같은 지점에서 다시 질문하면 형제 턴이 된다", () => {
    const branched = [...WITH_TOOL, node("u3", "a2", 7, "user"), node("a4", "u3", 8, "assistant")];
    const index = buildTurns(branched);
    const siblings = siblingTurns(index, index.byId.get("u3")!);
    expect(siblings.map((t) => t.id)).toEqual(["u2", "u3"]);
    expect(index.byId.get("u3")!.parentTurnId).toBe("u1");
  });

  it("턴 중간 스텝에서 분기하면 branchPointId 가 부모 턴의 leafId 와 다르다", () => {
    const midway = [...WITH_TOOL, node("u4", "a1", 7, "user")];
    const index = buildTurns(midway);
    const turn = index.byId.get("u4")!;
    expect(turn.parentTurnId).toBe("u1");
    expect(turn.branchPointId).toBe("a1");
    expect(turn.branchPointId).not.toBe(index.byId.get("u1")!.leafId);
  });

  it("도구 실패와 스트리밍 상태가 턴으로 올라온다", () => {
    const messages = [
      node("u1", null, 1, "user"),
      node("a1", "u1", 2, "assistant"),
      node("t1", "a1", 3, "tool", {
        toolCalls: [call("c1", "shell"), call("c2", "shell")],
        toolResults: [
          { toolCallId: "c1", toolName: "shell", errorText: "boom" },
          { toolCallId: "c2", toolName: "shell", output: "ok" },
        ],
      }),
      node("a2", "t1", 4, "assistant", { status: "streaming" }),
    ];
    const turn = buildTurns(messages).byId.get("u1")!;
    expect(turn.toolUses).toEqual([{ name: "shell", count: 2 }]);
    expect(turn.toolErrorCount).toBe(1);
    expect(turn.status).toBe("streaming");
  });

  it("부모가 목록에 없는 노드(브랜치 복제본)도 루트 턴이 된다", () => {
    const orphan = [
      node("a0", "다른-세션-노드", 1, "assistant"),
      node("u1", "a0", 2, "user"),
    ];
    const index = buildTurns(orphan);
    expect(index.roots.map((t) => t.id)).toEqual(["a0"]);
    expect(index.byId.get("a0")!.userText).toBe("");
    expect(index.byId.get("u1")!.parentTurnId).toBe("a0");
  });

  it("부모 관계가 순환해도 모든 노드가 어딘가의 턴에 들어간다", () => {
    const cyclic = [node("p", "q", 1, "assistant"), node("q", "p", 2, "assistant")];
    const index = buildTurns(cyclic);
    expect(index.turnOfMessage.size).toBe(2);
  });

  it("빈 입력은 빈 인덱스", () => {
    const index = buildTurns([]);
    expect(index.turns).toEqual([]);
    expect(index.roots).toEqual([]);
  });
});

describe("turnSubtree", () => {
  it("자기 자신과 하위 턴의 메시지를 모두 모은다", () => {
    const branched = [...WITH_TOOL, node("u3", "a2", 7, "user"), node("a4", "u3", 8, "assistant")];
    const index = buildTurns(branched);

    const all = turnSubtree(index, "u1");
    expect(all.turnIds.sort()).toEqual(["u1", "u2", "u3"]);
    expect(all.messageIds).toHaveLength(8);

    const leafOnly = turnSubtree(index, "u2");
    expect(leafOnly.turnIds).toEqual(["u2"]);
    expect(leafOnly.messageIds.sort()).toEqual(["a3", "u2"]);
  });

  it("없는 턴 id 는 빈 결과", () => {
    const index = buildTurns(WITH_TOOL);
    expect(turnSubtree(index, "nope")).toEqual({ turnIds: [], messageIds: [] });
  });
});
