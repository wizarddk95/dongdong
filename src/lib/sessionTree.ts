/**
 * 세션 트리 유틸. `sessions.parent_session_id` 만으로 분기 관계를 복원한다.
 * 좌표 계산은 `lib/layout.ts` 의 `tidyLayout` 이 맡는다.
 */
import type { SessionOverview } from "@/types/ipc";

export interface SessionTreeIndex {
  byId: Map<string, SessionOverview>;
  /** parentSessionId(루트면 null) → 자식 세션들 */
  childrenOf: Map<string | null, SessionOverview[]>;
  roots: SessionOverview[];
}

/** 만든 시각 순. 같으면 id 로 안정 정렬한다. */
function byCreatedAt(a: SessionOverview, b: SessionOverview): number {
  return a.createdAt === b.createdAt
    ? a.id.localeCompare(b.id)
    : a.createdAt.localeCompare(b.createdAt);
}

/**
 * 부모가 목록에 없으면(원본이 지워졌거나 아카이브됨) 루트로 올린다.
 * 부모 사슬이 순환하면 그 세션도 루트로 끊는다 — 그리지 못하는 노드가 생기면 안 된다.
 */
export function buildSessionTree(sessions: SessionOverview[]): SessionTreeIndex {
  const byId = new Map(sessions.map((session) => [session.id, session]));

  const effectiveParent = (session: SessionOverview): string | null => {
    const parentId = session.parentSessionId;
    if (!parentId || parentId === session.id || !byId.has(parentId)) return null;

    // 사슬을 거슬러 올라가다 자기 자신을 다시 만나면 순환이다.
    const seen = new Set<string>([session.id]);
    let cursor = byId.get(parentId);
    while (cursor) {
      if (seen.has(cursor.id)) return null;
      seen.add(cursor.id);
      const next = cursor.parentSessionId;
      cursor = next ? byId.get(next) : undefined;
    }
    return parentId;
  };

  const childrenOf = new Map<string | null, SessionOverview[]>();
  for (const session of sessions) {
    const key = effectiveParent(session);
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(session);
    childrenOf.set(key, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort(byCreatedAt);

  return { byId, childrenOf, roots: childrenOf.get(null) ?? [] };
}

/** 루트 → 지정 세션까지의 경로. "어디서 갈라져 나왔는지" 표시에 쓴다. */
export function sessionPathTo(
  index: SessionTreeIndex,
  sessionId: string | null,
): SessionOverview[] {
  if (!sessionId) return [];

  const out: SessionOverview[] = [];
  const seen = new Set<string>();
  let current = index.byId.get(sessionId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current);
    const parentId = current.parentSessionId;
    current = parentId && index.byId.has(parentId) ? index.byId.get(parentId) : undefined;
  }
  return out;
}
