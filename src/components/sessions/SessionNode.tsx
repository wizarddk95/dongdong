import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { SessionOverview } from "@/types/ipc";

export const SESSION_WIDTH = 232;
export const SESSION_HEIGHT = 104;

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

  const ring = isSelected
    ? "ring-2 ring-violet-400"
    : isActive
      ? "ring-2 ring-emerald-400"
      : "";

  return (
    <div
      style={{ width: SESSION_WIDTH, height: SESSION_HEIGHT }}
      className={`flex flex-col gap-1 rounded-lg border border-zinc-700 bg-zinc-900/90 px-2.5 py-2 text-left ${ring}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !bg-zinc-500" />

      <div className="flex items-center gap-1 text-[9px] text-zinc-500">
        {session.branchedFromMessageId && (
          <span className="rounded bg-violet-950 px-1 text-violet-300">⑂ 분기</span>
        )}
        {isActive && <span className="text-emerald-400">● 열려 있음</span>}
        <span className="ml-auto">{shortTime(session.lastMessageAt ?? session.updatedAt)}</span>
      </div>

      <p className="truncate text-[12px] font-medium text-zinc-100">{session.title}</p>

      <p className="line-clamp-2 flex-1 overflow-hidden text-[10px] leading-snug text-zinc-500">
        {session.preview?.trim() || "(아직 대화 없음)"}
      </p>

      <div className="flex shrink-0 items-center gap-2 text-[9px] text-zinc-500">
        <span>노드 {session.messageCount}</span>
        {session.agentRunCount > 0 && (
          <span className="text-fuchsia-400">🤝 {session.agentRunCount}</span>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !bg-zinc-500" />
    </div>
  );
}
