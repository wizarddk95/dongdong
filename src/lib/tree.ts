/**
 * 대화 트리 유틸. DB 의 `messages.parent_id` 만으로 트리를 복원한다.
 * 좌표 계산은 `lib/layout.ts`, 턴 묶음은 `lib/turns.ts` 담당.
 */
import type { Message } from "@/types/ipc";

export interface TreeIndex {
  byId: Map<string, Message>;
  childrenOf: Map<string | null, Message[]>;
  roots: Message[];
}

export function buildIndex(messages: Message[]): TreeIndex {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const childrenOf = new Map<string | null, Message[]>();
  const roots: Message[] = [];

  for (const message of messages) {
    // 부모가 같은 세션에 없으면(브랜치 복제 등) 루트로 취급한다.
    const parentId = message.parentId && byId.has(message.parentId) ? message.parentId : null;
    if (parentId === null) roots.push(message);

    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(message);
    childrenOf.set(parentId, siblings);
  }

  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.seq - b.seq);
  roots.sort((a, b) => a.seq - b.seq);

  return { byId, childrenOf, roots };
}

/** 루트 → 지정 노드까지의 경로. 채팅 패널이 보여주는 "현재 대화". */
export function pathTo(messages: Message[], leafId: string | null): Message[] {
  if (!leafId) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));

  const out: Message[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

/** 같은 부모를 공유하는 형제들 — "이 지점에 분기가 N개" 표시에 쓴다. */
export function siblingsOf(index: TreeIndex, message: Message): Message[] {
  const parentId =
    message.parentId && index.byId.has(message.parentId) ? message.parentId : null;
  return index.childrenOf.get(parentId) ?? [];
}
