import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { Tag } from "@/components/Panel";
import { UsageTag } from "@/components/UsageMeter";
import { hasTokens } from "@/lib/ai/usage";
import type { Turn } from "@/lib/turns";

/**
 * 카드 치수는 12px 활자 + 넉넉한 행간에 맞춰 잡혀 있다.
 * 줄이면 도구 배지와 토큰 줄이 겹친다 — 글자를 줄이는 대신 카드를 키운다.
 */
export const TURN_WIDTH = 300;
export const TURN_HEIGHT = 196;

export interface TurnNodeData extends Record<string, unknown> {
  turn: Turn;
  isOnActivePath: boolean;
  isActiveParent: boolean;
  isSelected: boolean;
  branchCount: number;
  agentCount: number;
}

export type TurnFlowNode = Node<TurnNodeData, "turn">;

const STATUS_MARK: Record<string, { text: string; className: string }> = {
  streaming: { text: "● 생성 중", className: "text-accent" },
  error: { text: "● 오류", className: "text-error" },
  aborted: { text: "● 중단", className: "text-warning" },
};

/** 한 턴(사용자 질문 + 응답 + 도구 스텝)을 카드 한 장으로 보여준다. */
export function TurnNode({ data }: NodeProps<TurnFlowNode>) {
  const { turn, isOnActivePath, isActiveParent, isSelected, branchCount, agentCount } = data;

  /*
   * 선택과 활성 부모를 색으로 가르지 않는다 — 액센트는 하나뿐이므로
   * 선택은 2px 파란 테두리, 활성 부모는 잉크색 테두리로 **굵기와 명도**가 구분한다.
   */
  const edge = isSelected
    ? "border-2 border-accent"
    : isActiveParent
      ? "border-2 border-hairline-strong"
      : "border border-hairline";

  const mark = STATUS_MARK[turn.status];

  return (
    <div
      style={{ width: TURN_WIDTH, height: TURN_HEIGHT }}
      className={`flex flex-col gap-1.5 rounded-lg bg-canvas px-3 py-2.5 text-left elevate transition-opacity ${edge} ${
        isOnActivePath ? "opacity-100" : "opacity-45"
      }`}
    >
      <Handle type="target" position={Position.Left} />

      <div className="flex items-center gap-1.5 text-caption text-ink-muted">
        <span className="text-body-emphasis text-ink">턴 #{turn.seq}</span>
        {mark && <span className={mark.className}>{mark.text}</span>}
        <span className="ml-auto flex items-center gap-1">
          {agentCount > 0 && <Tag title="이 턴에서 위임된 서브에이전트">위임 {agentCount}</Tag>}
          {/* 같은 줄에 서는 배지라 둘 다 낱말+숫자로 읽히게 맞춘다. */}
          {branchCount > 1 && <Tag title="같은 지점에서 갈라진 형제 턴">분기 {branchCount}</Tag>}
          <span className="text-ink-subtle">{turn.nodes.length}노드</span>
        </span>
      </div>

      {/*
       * 누가 말했는지는 **면**이 가른다 — 질문은 회색 상자 안에, 응답은 맨 바탕에.
       * 채팅 말풍선과 같은 규칙이라 아이콘 없이도 읽힌다.
       */}
      <p className="line-clamp-2 rounded-md bg-surface-1 px-2.5 py-1.5 text-caption leading-snug text-ink">
        {turn.userText.trim() || "(질문 없음 · 이어진 대화)"}
      </p>

      <p className="line-clamp-3 flex-1 overflow-hidden text-caption leading-snug text-ink-muted">
        {turn.assistantText.trim() || (turn.status === "streaming" ? "…" : "(응답 없음)")}
      </p>

      {turn.toolUses.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 overflow-hidden text-caption">
          {turn.toolUses.slice(0, 3).map((use) => (
            <span
              key={use.name}
              className="rounded-full border border-hairline px-2 py-0.5 font-mono text-ink-muted"
            >
              {use.name}
              {use.count > 1 && ` ×${use.count}`}
            </span>
          ))}
          {turn.toolUses.length > 3 && (
            <span className="text-ink-subtle">+{turn.toolUses.length - 3}</span>
          )}
          {turn.toolErrorCount > 0 && (
            <span className="text-error">실패 {turn.toolErrorCount}</span>
          )}
        </div>
      )}

      {hasTokens(turn.usage) && (
        <UsageTag
          usage={turn.usage}
          cost={turn.cost}
          modelId={turn.modelId}
          className="shrink-0"
        />
      )}

      <Handle type="source" position={Position.Right} />
      {/* 서브에이전트는 위/아래로 갈라지므로 전용 핸들을 따로 둔다. */}
      <Handle type="source" id="agents-top" position={Position.Top} />
      <Handle type="source" id="agents-bottom" position={Position.Bottom} />
    </div>
  );
}
