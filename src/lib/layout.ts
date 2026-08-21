/**
 * 방향 무관 tidy tree 배치.
 *
 * 대화 턴 그래프와 서브에이전트 레인이 같은 규칙으로 놓이므로
 * 배치 로직은 여기 하나만 둔다. 깊이는 가로(x), 형제는 세로(y)로 흐른다.
 */

export interface Lanes {
  /** 노드 위쪽으로 비워 둘 추가 레인 수 */
  above: number;
  /** 노드 아래쪽으로 비워 둘 추가 레인 수 */
  below: number;
}

export interface TidyInput<T> {
  roots: T[];
  childrenOf: (item: T) => T[];
  idOf: (item: T) => string;
  nodeWidth: number;
  nodeHeight: number;
  gapX?: number;
  gapY?: number;
  /** 서브에이전트처럼 노드에 매달릴 것들의 자리를 미리 비워 둔다. */
  lanesOf?: (item: T) => Lanes;
}

export interface Placement {
  x: number;
  y: number;
  depth: number;
}

const NO_LANES: Lanes = { above: 0, below: 0 };

/**
 * 잎 노드를 위에서부터 차례로 놓고, 부모는 자식들의 가운데에 맞춘다.
 * `lanesOf` 로 요청한 여백만큼 커서를 더 밀어 형제와 겹치지 않게 한다.
 */
export function tidyLayout<T>(input: TidyInput<T>): Map<string, Placement> {
  const {
    roots,
    childrenOf,
    idOf,
    nodeWidth,
    nodeHeight,
    gapX = 60,
    gapY = 28,
    lanesOf,
  } = input;

  const stepX = nodeWidth + gapX;
  const stepY = nodeHeight + gapY;
  const out = new Map<string, Placement>();

  // 같은 노드를 두 번 놓지 않는다 (부모 관계가 꼬여도 무한 재귀를 막는다).
  const seen = new Set<string>();
  let cursor = 0;

  const place = (item: T, depth: number): number => {
    const id = idOf(item);
    if (seen.has(id)) return out.get(id)?.y ?? 0;
    seen.add(id);

    const lanes = lanesOf?.(item) ?? NO_LANES;
    const children = childrenOf(item);

    let y: number;
    if (children.length === 0) {
      cursor += lanes.above;
      y = cursor * stepY;
      cursor += 1 + lanes.below;
    } else {
      // 자식을 먼저 놓고 그 가운데로 맞춘다. 자기 레인은 자식 쪽 여백으로 흡수된다.
      const before = cursor;
      const centers = children.map((child) => place(child, depth + 1));
      y = (centers[0] + centers[centers.length - 1]) / 2;

      // 자식들이 차지한 폭이 자기 레인보다 좁으면 남는 만큼 커서를 더 민다.
      const used = cursor - before;
      const need = 1 + lanes.above + lanes.below;
      if (used < need) cursor = before + need;
    }

    out.set(id, { x: depth * stepX, y, depth });
    return y;
  };

  for (const root of roots) place(root, 0);
  return out;
}
