import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { Tag } from "@/components/Panel";
import { UsageTag } from "@/components/UsageMeter";
import { hasTokens } from "@/lib/ai/usage";
import { t, type MessageKey } from "@/lib/i18n";
import { turnLabel, type Turn } from "@/lib/turns";

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

const STATUS_MARK: Record<string, { textKey: MessageKey; className: string }> = {
  streaming: { textKey: "turnNode.streaming", className: "text-accent" },
  error: { textKey: "turnNode.error", className: "text-error" },
  aborted: { textKey: "turnNode.aborted", className: "text-warning" },
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
        {/*
          * 순번 대신 앵커 노드의 id 를 쓴다 — 순번은 삽입 순서라 분기·붙여넣기 뒤에
          * 그래프의 자리와 어긋난다. id 는 채팅 입력칸이 부르는 이름과 같은 자다.
          */}
        <span
          className="font-mono text-body-emphasis text-ink"
          title={t("turnNode.idHint", { id: turn.id, nodes: turn.nodes.length })}
        >
          {turnLabel(turn)}
        </span>
        {mark && <span className={mark.className}>{t(mark.textKey)}</span>}
        <span className="ml-auto flex items-center gap-1">
          {agentCount > 0 && (
            <Tag title={t("turnNode.delegatedHint")}>
              {t("turnNode.delegated", { count: agentCount })}
            </Tag>
          )}
          {/* 같은 줄에 서는 배지라 둘 다 낱말+숫자로 읽히게 맞춘다. */}
          {branchCount > 1 && (
            <Tag title={t("turnNode.branchHint")}>
              {t("turnNode.branch", { count: branchCount })}
            </Tag>
          )}
          <span className="text-ink-subtle">{t("turnNode.nodes", { count: turn.nodes.length })}</span>
        </span>
      </div>

      {/*
       * 누가 말했는지는 **면**이 가른다 — 질문은 회색 상자 안에, 응답은 맨 바탕에.
       * 채팅 말풍선과 같은 규칙이라 아이콘 없이도 읽힌다.
       */}
      <p className="line-clamp-2 rounded-md bg-surface-1 px-2.5 py-1.5 text-caption leading-snug text-ink">
        {turn.userText.trim() || t("turnNode.noQuestion")}
      </p>

      <p className="line-clamp-3 flex-1 overflow-hidden text-caption leading-snug text-ink-muted">
        {turn.assistantText.trim() || (turn.status === "streaming" ? "…" : t("turnNode.noAnswer"))}
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
