import { describe, expect, it } from "vitest";

import { tidyLayout } from "@/lib/layout";

interface N {
  id: string;
  children: N[];
}

const n = (id: string, ...children: N[]): N => ({ id, children });

//   a ─ b ─ c ─ d
//         └ e
const TREE = n("a", n("b", n("c", n("d")), n("e")));

function layout(roots: N[], lanesOf?: (item: N) => { above: number; below: number }) {
  return tidyLayout({
    roots,
    childrenOf: (item) => item.children,
    idOf: (item) => item.id,
    nodeWidth: 100,
    nodeHeight: 50,
    gapX: 20,
    gapY: 10,
    lanesOf,
  });
}

describe("tidyLayout", () => {
  it("깊이가 가로로 흐른다", () => {
    const map = layout([TREE]);
    expect(map.get("a")!.x).toBe(0);
    expect(map.get("b")!.x).toBe(120);
    expect(map.get("c")!.x).toBe(240);
    expect(map.get("d")!.x).toBe(360);
    // 형제는 같은 열
    expect(map.get("e")!.x).toBe(map.get("c")!.x);
    expect(map.get("d")!.depth).toBe(3);
  });

  it("분기된 잎들이 세로로 겹치지 않는다", () => {
    const map = layout([TREE]);
    expect(map.get("d")!.y).not.toBe(map.get("e")!.y);
    expect(Math.abs(map.get("d")!.y - map.get("e")!.y)).toBeGreaterThanOrEqual(60);
  });

  it("부모는 자식들의 가운데에 놓인다", () => {
    const map = layout([TREE]);
    const center = (map.get("d")!.y + map.get("e")!.y) / 2;
    expect(map.get("b")!.y).toBeCloseTo(center);
  });

  it("lanesOf 로 요청한 위/아래 여백만큼 형제가 밀린다", () => {
    // 잎 두 개. 첫 잎이 아래로 2레인을 요구하면 다음 잎은 그만큼 내려가야 한다.
    const roots = [n("root", n("x"), n("y"))];
    const plain = layout(roots);
    const spaced = layout(roots, (item) =>
      item.id === "x" ? { above: 0, below: 2 } : { above: 0, below: 0 },
    );

    const plainGap = plain.get("y")!.y - plain.get("x")!.y;
    const spacedGap = spaced.get("y")!.y - spaced.get("x")!.y;
    expect(spacedGap).toBe(plainGap * 3); // 레인 2개만큼 더 벌어진다
  });

  it("위쪽 레인을 요구하면 첫 노드도 아래로 내려간다", () => {
    const map = layout([n("solo")], () => ({ above: 1, below: 1 }));
    expect(map.get("solo")!.y).toBe(60); // 위로 1레인 비움
  });

  it("모든 노드에 좌표가 하나씩 배정되고, 빈 입력은 빈 맵", () => {
    const map = layout([TREE]);
    expect(map.size).toBe(5);
    expect(layout([]).size).toBe(0);
  });

  it("부모 관계가 순환해도 멈춘다", () => {
    const p: N = { id: "p", children: [] };
    const q: N = { id: "q", children: [p] };
    p.children.push(q);
    expect(layout([p]).size).toBe(2);
  });
});
