/**
 * 대화 "턴" 모델.
 *
 * DB 는 노드 하나하나(`user` → `assistant` → `tool` → `assistant` …)를 저장하지만,
 * 사람이 다루는 단위는 "질문 하나와 그에 대한 응답 전체"다.
 * 여기서 노드 체인을 되접어 턴으로 묶는다 — 스키마를 바꾸지 않는 순수 파생 계산이다.
 */
import { splitAttachments } from "@/lib/ai/attachments";
import { readToolCalls, readToolResults } from "@/lib/ai/runner";
import { readChainUsage, type Cost, type Usage } from "@/lib/ai/usage";
import { buildIndex } from "@/lib/tree";
import type { Message } from "@/types/ipc";

export type TurnStatus = "complete" | "streaming" | "error" | "aborted";

export interface ToolUse {
  name: string;
  count: number;
}

export interface Turn {
  /** 앵커 노드 id — 턴을 여는 user 노드 */
  id: string;
  anchor: Message;
  /** 앵커 + 흡수한 assistant/tool 노드 (seq 순) */
  nodes: Message[];
  /** 이 턴의 마지막 노드. 다음 턴이 붙을 부모(activeParent)가 된다. */
  leafId: string;
  parentTurnId: string | null;
  /** 부모 턴의 어느 노드에서 갈라졌는지 (= anchor.parentId) */
  branchPointId: string | null;
  userText: string;
  /** 마지막 assistant 노드의 본문 */
  assistantText: string;
  toolUses: ToolUse[];
  /** 실패한 도구 결과 수 */
  toolErrorCount: number;
  /** 이 턴의 노드들이 쓴 토큰 합계. LLM 호출이 없었으면 전부 0 */
  usage: Usage;
  /** 그 토큰의 추정 요금 */
  cost: Cost;
  /** 이 턴을 돌린 모델. 옛 기록이라 모를 수도 있다 */
  modelId: string | null;
  status: TurnStatus;
  seq: number;
}

export interface TurnIndex {
  turns: Turn[];
  byId: Map<string, Turn>;
  /** messageId → turnId */
  turnOfMessage: Map<string, string>;
  /** parentTurnId(없으면 null) → 자식 턴들 */
  childrenOf: Map<string | null, Turn[]>;
  roots: Turn[];
}

const STATUS_RANK: Record<TurnStatus, number> = {
  streaming: 3,
  error: 2,
  aborted: 1,
  complete: 0,
};

function toStatus(raw: string): TurnStatus {
  return raw === "streaming" || raw === "error" || raw === "aborted" ? raw : "complete";
}

/**
 * 노드 목록을 턴으로 묶는다.
 *
 * 앵커는 (a) `user` 노드, 또는 (b) 부모가 목록에 없는 루트 노드다.
 * 앵커에서 자식 방향으로 내려가며 다음 앵커를 만나기 전까지의 후손을 전부 흡수한다.
 */
export function buildTurns(messages: Message[]): TurnIndex {
  const index = buildIndex(messages);

  const isAnchor = (message: Message) =>
    message.role === "user" ||
    !message.parentId ||
    !index.byId.has(message.parentId);

  const anchors = [...messages].filter(isAnchor).sort((a, b) => a.seq - b.seq);
  const anchorIds = new Set(anchors.map((m) => m.id));

  const turnOfMessage = new Map<string, string>();
  const byId = new Map<string, Turn>();
  const turns: Turn[] = [];

  const absorb = (anchor: Message) => {
    // 앵커에서 시작해 다음 앵커 전까지의 후손을 모은다.
    const nodes: Message[] = [];
    const stack: Message[] = [anchor];
    while (stack.length > 0) {
      const current = stack.pop() as Message;
      if (turnOfMessage.has(current.id)) continue; // 방어: 부모 관계가 꼬인 경우
      nodes.push(current);
      turnOfMessage.set(current.id, anchor.id);
      for (const child of index.childrenOf.get(current.id) ?? []) {
        if (!anchorIds.has(child.id)) stack.push(child);
      }
    }
    nodes.sort((a, b) => a.seq - b.seq);

    const memberIds = new Set(nodes.map((m) => m.id));
    // 턴 안에서 자식이 없는 노드가 이 턴의 끝. 여러 개면 가장 나중 것.
    const leaves = nodes.filter((node) =>
      (index.childrenOf.get(node.id) ?? []).every((child) => !memberIds.has(child.id)),
    );
    const leaf = (leaves.length > 0 ? leaves : nodes).reduce((best, current) =>
      current.seq > best.seq ? current : best,
    );

    const assistants = nodes.filter((node) => node.role === "assistant");
    const lastAssistant = assistants.at(-1);

    // 도구 사용은 tool 노드에 남는다. 이름별로 접어 배지 하나로 보여준다.
    const counts = new Map<string, number>();
    let toolErrorCount = 0;
    for (const node of nodes) {
      if (node.role !== "tool") continue;
      for (const call of readToolCalls(node.toolCalls)) {
        counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
      }
      for (const result of readToolResults(node.toolResults)) {
        if (result.errorText != null) toolErrorCount += 1;
      }
    }

    const status = nodes
      .map((node) => toStatus(node.status))
      .reduce<TurnStatus>(
        (best, current) => (STATUS_RANK[current] > STATUS_RANK[best] ? current : best),
        "complete",
      );

    const parentId = anchor.parentId && index.byId.has(anchor.parentId) ? anchor.parentId : null;

    // 사용량은 assistant 노드에만 붙는다(턴 전체 합이 마지막 노드에 한 번).
    // 그래도 턴 안의 모든 노드를 훑는다 — 중간에 분기·재시도로 여러 개가 남을 수 있다.
    const { usage, cost, modelId } = readChainUsage(nodes);

    const turn: Turn = {
      id: anchor.id,
      anchor,
      nodes,
      leafId: leaf.id,
      parentTurnId: parentId ? (turnOfMessage.get(parentId) ?? null) : null,
      branchPointId: parentId,
      // `@` 첨부 블록은 카드에서 뺀다 — 파일 하나가 붙으면 카드가 그 원문으로 뒤덮인다.
      // (모델은 통째로 받는다. 접는 규칙은 채팅 말풍선과 같은 함수를 쓴다)
      userText: anchor.role === "user" ? splitAttachments(anchor.content).body : "",
      assistantText: lastAssistant?.content ?? "",
      toolUses: [...counts.entries()].map(([name, count]) => ({ name, count })),
      toolErrorCount,
      usage,
      cost,
      modelId,
      status,
      seq: anchor.seq,
    };

    turns.push(turn);
    byId.set(turn.id, turn);
  };

  for (const anchor of anchors) absorb(anchor);
  // 부모 관계가 순환하면 어느 앵커에서도 닿지 않는 노드가 남는다. 그것도 턴으로 남긴다.
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (!turnOfMessage.has(message.id)) {
      anchorIds.add(message.id);
      absorb(message);
    }
  }

  const childrenOf = new Map<string | null, Turn[]>();
  for (const turn of turns) {
    const key = turn.parentTurnId;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(turn);
    childrenOf.set(key, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.seq - b.seq);

  return {
    turns,
    byId,
    turnOfMessage,
    childrenOf,
    roots: childrenOf.get(null) ?? [],
  };
}

/** 채팅 말풍선 하나 — assistant 노드와 그 노드가 부른 도구의 결과를 한 덩어리로 본다. */
export interface Bubble {
  message: Message;
  /** `message` 가 부른 도구들의 결과 노드. 없으면 null. */
  toolNode: Message | null;
}

/**
 * 활성 경로(선형 체인)를 말풍선 목록으로 접는다.
 *
 * tool 노드는 자기를 만든 assistant 말풍선 안으로 흡수된다 —
 * "에이전트 말풍선 + 도구 말풍선" 두 겹으로 갈라져 대화가 늘어지는 걸 막는다.
 * 부모를 잃은 tool 노드(체인이 꼬인 경우)는 예전처럼 홀로 남긴다.
 */
export function toBubbles(chain: Message[]): Bubble[] {
  const bubbles: Bubble[] = [];

  for (const message of chain) {
    const previous = bubbles.at(-1);
    const absorbable =
      message.role === "tool" &&
      previous != null &&
      previous.toolNode === null &&
      previous.message.role === "assistant" &&
      previous.message.id === message.parentId;

    if (absorbable) previous.toolNode = message;
    else bubbles.push({ message, toolNode: null });
  }

  return bubbles;
}

/**
 * 화면에 쓰는 턴 이름 — 앵커 노드 id 앞 8자.
 *
 * 순번(`seq`)은 **세션 안 삽입 순서**라 분기·복사·붙여넣기를 하고 나면 그래프에서의
 * 자리와 어긋난다(루트 바로 다음 카드가 #7 로 뜬다). 반면 id 는 어디로 옮겨도 그대로고,
 * 그래프 카드와 채팅 입력칸이 **같은 이름**으로 같은 자리를 부르도록 이 함수 하나만 쓴다
 * (입력칸은 활성 부모가 낀 턴을 이 이름으로 부르고, 정확한 노드 id 는 툴팁에 남긴다).
 */
export function turnLabel(turn: Turn): string {
  return turn.id.slice(0, 8);
}

/**
 * 이 턴 하나만 지울 수 있는지. 못 지우면 이유를 돌려준다 (버튼 툴팁에 그대로 쓴다).
 *
 * 세션의 뿌리는 하나여야 한다 — 갈래가 둘 이상인 루트 턴만 도려내면
 * 남은 갈래들이 저마다 뿌리가 되어 한 세션에 대화가 여러 그루로 갈라진다.
 * **판정은 Rust 의 `delete_messages` 와 같아야 한다** — 화면에서 눌리는데
 * DB 가 거절하면 그 자체가 버그로 읽힌다.
 */
export function soloDeleteBlocker(index: TurnIndex, turn: Turn): string | null {
  const children = index.childrenOf.get(turn.id) ?? [];
  if (turn.branchPointId === null && children.length > 1) {
    return `이 턴은 대화의 뿌리인데 아래로 ${children.length}갈래가 갈라져 있습니다. 이 턴만 지우면 뿌리가 여러 개가 됩니다 — [아래까지 삭제] 를 쓰세요.`;
  }
  return null;
}

/** 같은 부모 턴을 공유하는 형제들 — "이 지점에 분기가 N개" 표시에 쓴다. */
export function siblingTurns(index: TurnIndex, turn: Turn): Turn[] {
  return index.childrenOf.get(turn.parentTurnId) ?? [];
}

/**
 * 턴을 지울 때 함께 사라지는 것들.
 * DB 는 `messages.parent_id` 의 CASCADE 로 하위 트리를 통째로 지우므로
 * 확인 문구와 서브에이전트 기록 정리에 이 목록을 쓴다.
 */
export function turnSubtree(
  index: TurnIndex,
  turnId: string,
): { turnIds: string[]; messageIds: string[] } {
  const turnIds: string[] = [];
  const messageIds: string[] = [];
  const seen = new Set<string>();
  const stack = [turnId];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    const turn = index.byId.get(current);
    if (!turn) continue;
    turnIds.push(turn.id);
    messageIds.push(...turn.nodes.map((node) => node.id));
    for (const child of index.childrenOf.get(turn.id) ?? []) stack.push(child.id);
  }

  return { turnIds, messageIds };
}
