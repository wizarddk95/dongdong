import { describe, expect, it } from "vitest";

import { buildSessionTree, sessionPathTo } from "@/lib/sessionTree";
import type { SessionOverview } from "@/types/ipc";

function session(
  id: string,
  parentSessionId: string | null,
  createdAt: string,
  extra: Partial<SessionOverview> = {},
): SessionOverview {
  return {
    id,
    projectId: "p1",
    title: id,
    parentSessionId,
    branchedFromMessageId: parentSessionId ? `${parentSessionId}-node` : null,
    model: null,
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    messageCount: 0,
    lastMessageAt: null,
    preview: null,
    agentRunCount: 0,
    ...extra,
  };
}

//  a ─ b ─ d
//    └ c
const TREE: SessionOverview[] = [
  session("c", "a", "2026-01-03T00:00:00Z"),
  session("a", null, "2026-01-01T00:00:00Z"),
  session("d", "b", "2026-01-04T00:00:00Z"),
  session("b", "a", "2026-01-02T00:00:00Z"),
];

describe("buildSessionTree", () => {
  it("부모 세션 아래로 분기 세션을 모은다", () => {
    const index = buildSessionTree(TREE);
    expect(index.roots.map((s) => s.id)).toEqual(["a"]);
    expect(index.childrenOf.get("a")?.map((s) => s.id)).toEqual(["b", "c"]); // 만든 순
    expect(index.childrenOf.get("b")?.map((s) => s.id)).toEqual(["d"]);
    expect(index.childrenOf.get("d")).toBeUndefined();
  });

  it("부모가 목록에 없으면 루트로 올린다", () => {
    const index = buildSessionTree([session("x", "지워진-세션", "2026-01-01T00:00:00Z")]);
    expect(index.roots.map((s) => s.id)).toEqual(["x"]);
  });

  it("자기 자신을 부모로 가리켜도 루트가 된다", () => {
    const index = buildSessionTree([session("x", "x", "2026-01-01T00:00:00Z")]);
    expect(index.roots.map((s) => s.id)).toEqual(["x"]);
  });

  it("부모 사슬이 순환하면 끊어 루트로 만든다", () => {
    const cyclic = [
      session("p", "q", "2026-01-01T00:00:00Z"),
      session("q", "p", "2026-01-02T00:00:00Z"),
    ];
    const index = buildSessionTree(cyclic);
    expect(index.roots).toHaveLength(2);
  });

  it("빈 목록은 빈 인덱스", () => {
    const index = buildSessionTree([]);
    expect(index.roots).toEqual([]);
    expect(index.byId.size).toBe(0);
  });
});

describe("sessionPathTo", () => {
  it("루트에서 해당 세션까지의 분기 경로를 돌려준다", () => {
    const index = buildSessionTree(TREE);
    expect(sessionPathTo(index, "d").map((s) => s.id)).toEqual(["a", "b", "d"]);
    expect(sessionPathTo(index, "a").map((s) => s.id)).toEqual(["a"]);
  });

  it("없는 id 와 null 은 빈 배열", () => {
    const index = buildSessionTree(TREE);
    expect(sessionPathTo(index, null)).toEqual([]);
    expect(sessionPathTo(index, "nope")).toEqual([]);
  });
});
