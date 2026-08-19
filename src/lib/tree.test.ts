import { describe, expect, it } from "vitest";

import { NODE_HEIGHT, buildIndex, layoutTree, pathTo, siblingsOf } from "@/lib/tree";
import type { Message } from "@/types/ipc";

/** 테스트용 최소 노드. 트리 로직은 id/parentId/seq 만 본다. */
function node(id: string, parentId: string | null, seq: number): Message {
  return {
    id,
    sessionId: "s1",
    parentId,
    role: seq % 2 === 1 ? "user" : "assistant",
    content: id,
    toolCalls: null,
    toolResults: null,
    contextSnapshot: null,
    tokenUsage: null,
    status: "complete",
    agentId: null,
    seq,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

//        a
//        |
//        b
//       / \
//      c   e     <- b 에서 갈라진 두 분기
//      |
//      d
const BRANCHED: Message[] = [
  node("a", null, 1),
  node("b", "a", 2),
  node("c", "b", 3),
  node("d", "c", 4),
  node("e", "b", 5),
];

describe("buildIndex", () => {
  it("부모별로 자식을 seq 순서로 모은다", () => {
    const index = buildIndex(BRANCHED);
    expect(index.roots.map((m) => m.id)).toEqual(["a"]);
    expect(index.childrenOf.get("b")?.map((m) => m.id)).toEqual(["c", "e"]);
    expect(index.childrenOf.get("d")).toBeUndefined();
  });

  it("부모가 목록에 없으면 루트로 취급한다", () => {
    // 브랜치 세션으로 복제하면 부모 id 가 다른 세션을 가리킬 수 있다.
    const orphan = [node("x", "missing-parent", 1), node("y", "x", 2)];
    const index = buildIndex(orphan);
    expect(index.roots.map((m) => m.id)).toEqual(["x"]);
  });
});

describe("pathTo", () => {
  it("루트에서 지정 노드까지의 경로를 순서대로 돌려준다", () => {
    expect(pathTo(BRANCHED, "d").map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("다른 분기를 타면 형제 쪽 노드는 포함되지 않는다", () => {
    const path = pathTo(BRANCHED, "e").map((m) => m.id);
    expect(path).toEqual(["a", "b", "e"]);
    expect(path).not.toContain("c");
  });

  it("빈 입력과 없는 id 는 빈 배열", () => {
    expect(pathTo(BRANCHED, null)).toEqual([]);
    expect(pathTo(BRANCHED, "nope")).toEqual([]);
  });

  it("부모 관계가 순환해도 멈춘다", () => {
    const cyclic = [node("p", "q", 1), node("q", "p", 2)];
    expect(pathTo(cyclic, "p").length).toBe(2);
  });
});

describe("siblingsOf", () => {
  it("같은 부모를 공유하는 노드 수를 센다", () => {
    const index = buildIndex(BRANCHED);
    const c = BRANCHED.find((m) => m.id === "c")!;
    const d = BRANCHED.find((m) => m.id === "d")!;
    expect(siblingsOf(index, c).map((m) => m.id)).toEqual(["c", "e"]);
    expect(siblingsOf(index, d).map((m) => m.id)).toEqual(["d"]);
  });
});

describe("layoutTree", () => {
  it("깊이에 따라 y 가 단조 증가한다", () => {
    const positioned = layoutTree(BRANCHED);
    const byId = new Map(positioned.map((p) => [p.message.id, p]));

    expect(byId.get("a")!.y).toBe(0);
    expect(byId.get("b")!.y).toBeGreaterThan(byId.get("a")!.y);
    expect(byId.get("c")!.y).toBe(byId.get("e")!.y); // 형제는 같은 줄
    expect(byId.get("d")!.y).toBe(3 * (NODE_HEIGHT + 56));
  });

  it("분기된 잎들이 서로 겹치지 않는다", () => {
    const positioned = layoutTree(BRANCHED);
    const byId = new Map(positioned.map((p) => [p.message.id, p]));
    expect(byId.get("d")!.x).not.toBe(byId.get("e")!.x);
  });

  it("부모는 자식들의 가운데에 놓인다", () => {
    const positioned = layoutTree(BRANCHED);
    const byId = new Map(positioned.map((p) => [p.message.id, p]));
    const center = (byId.get("c")!.x + byId.get("e")!.x) / 2;
    expect(byId.get("b")!.x).toBeCloseTo(center);
  });

  it("모든 노드에 좌표가 하나씩 배정된다", () => {
    expect(layoutTree(BRANCHED)).toHaveLength(BRANCHED.length);
    expect(layoutTree([])).toEqual([]);
  });
});
