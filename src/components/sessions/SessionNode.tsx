import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { Tag } from "@/components/Panel";
import { ContextGauge, UsageTag } from "@/components/UsageMeter";
import { sessionContextStatus, summarizeSessionUsage } from "@/lib/ai/usage";
import type { SessionOverview } from "@/types/ipc";

export const SESSION_WIDTH = 276;
/** 비용 줄 + 컨텍스트 게이지가 아래 두 줄을 더 쓴다. */
export const SESSION_HEIGHT = 168;

export interface SessionNodeData extends Record<string, unknown> {
  session: SessionOverview;
  isActive: boolean;
  isSelected: boolean;
}

export type SessionFlowNode = Node<SessionNodeData, "session">;

function shortTime(value: string | null): string {
  if (!value) return "기록 없음";
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 세션 맵의 카드 한 장. 더블클릭하면 그 세션의 채팅으로 들어간다. */
export function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  const { session, isActive, isSelected } = data;

  const summary = summarizeSessionUsage(session);
  const context = sessionContextStatus(session);

  // 턴 카드와 같은 규칙 — 선택은 파란 2px, 열려 있음은 잉크 2px.
  const edge = isSelected
    ? "border-2 border-accent"
    : isActive
      ? "border-2 border-hairline-strong"
      : "border border-hairline";

  return (
    <div
      style={{ width: SESSION_WIDTH, height: SESSION_HEIGHT }}
      className={`flex flex-col gap-1.5 rounded-lg bg-canvas px-3 py-2.5 text-left elevate ${edge}`}
    >
      <Handle type="target" position={Position.Left} />

      <div className="flex items-center gap-1.5 text-caption text-ink-muted">
        {session.branchedFromMessageId && <Tag title="다른 세션에서 갈라져 나왔습니다">⑂ 분기</Tag>}
        {isActive && <span className="text-accent">● 열려 있음</span>}
        <span className="ml-auto">{shortTime(session.lastMessageAt ?? session.updatedAt)}</span>
      </div>

      <p className="truncate text-body-emphasis text-ink">{session.title}</p>

      <p className="line-clamp-2 flex-1 overflow-hidden text-caption leading-snug text-ink-muted">
        {session.preview?.trim() || "(아직 대화 없음)"}
      </p>

      <div className="flex shrink-0 items-center gap-2 text-caption text-ink-muted">
        <span>노드 {session.messageCount}</span>
        {session.agentRunCount > 0 && <span>위임 {session.agentRunCount}</span>}
        <UsageTag
          usage={summary.usage}
          cost={summary.cost}
          modelId={summary.primaryModelId}
          className="ml-auto"
        />
      </div>

      {/* 이 세션을 이어서 쓸 수 있는지 — 카드에서 바로 보이게 한다. */}
      <ContextGauge
        status={context}
        modelId={session.lastUsageModel ?? session.model}
        className="shrink-0"
      />

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
