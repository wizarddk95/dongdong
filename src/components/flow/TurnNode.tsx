import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { Turn } from "@/lib/turns";

export const TURN_WIDTH = 268;
export const TURN_HEIGHT = 128;

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
  streaming: { text: "● 생성 중", className: "text-emerald-300" },
  error: { text: "● 오류", className: "text-red-400" },
  aborted: { text: "● 중단", className: "text-amber-400" },
};

/** 한 턴(사용자 질문 + 응답 + 도구 스텝)을 카드 한 장으로 보여준다. */
export function TurnNode({ data }: NodeProps<TurnFlowNode>) {
  const { turn, isOnActivePath, isActiveParent, isSelected, branchCount, agentCount } = data;

  const ring = isSelected
    ? "ring-2 ring-violet-400"
    : isActiveParent
      ? "ring-2 ring-emerald-400"
      : "";
  const mark = STATUS_MARK[turn.status];

  return (
    <div
      style={{ width: TURN_WIDTH, height: TURN_HEIGHT }}
      className={`flex flex-col gap-1 rounded-lg border border-zinc-700 bg-zinc-900/90 px-2.5 py-2 text-left transition-opacity ${ring} ${
        isOnActivePath ? "opacity-100" : "opacity-45"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !bg-zinc-500" />

      <div className="flex items-center gap-1 text-[9px] tracking-wide text-zinc-500">
        <span className="font-semibold text-zinc-400">턴 #{turn.seq}</span>
        {mark && <span className={mark.className}>{mark.text}</span>}
        <span className="ml-auto flex items-center gap-1">
          {agentCount > 0 && (
            <span className="rounded bg-fuchsia-950/80 px-1 text-fuchsia-300">🤝{agentCount}</span>
          )}
          {branchCount > 1 && (
            <span className="rounded bg-violet-900/70 px-1 text-violet-200">⑂{branchCount}</span>
          )}
          <span className="text-zinc-600">{turn.nodes.length}노드</span>
        </span>
      </div>

      <p className="line-clamp-2 rounded bg-sky-950/50 px-1.5 py-1 text-[11px] leading-snug text-sky-100">
        🙋 {turn.userText.trim() || "(질문 없음 · 이어진 대화)"}
      </p>

      <p className="line-clamp-3 flex-1 overflow-hidden text-[11px] leading-snug text-zinc-300">
        🤖 {turn.assistantText.trim() || (turn.status === "streaming" ? "…" : "(응답 없음)")}
      </p>

      {turn.toolUses.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 overflow-hidden text-[9px]">
          {turn.toolUses.slice(0, 3).map((use) => (
            <span
              key={use.name}
              className="rounded bg-amber-950/60 px-1 py-0.5 font-mono text-amber-200"
            >
              🔧 {use.name}
              {use.count > 1 && ` ×${use.count}`}
            </span>
          ))}
          {turn.toolUses.length > 3 && (
            <span className="text-zinc-500">+{turn.toolUses.length - 3}</span>
          )}
          {turn.toolErrorCount > 0 && (
            <span className="text-red-400">실패 {turn.toolErrorCount}</span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !bg-zinc-500" />
      {/* 서브에이전트는 위/아래로 갈라지므로 전용 핸들을 따로 둔다. */}
      <Handle
        type="source"
        id="agents-top"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !bg-fuchsia-700"
      />
      <Handle
        type="source"
        id="agents-bottom"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !bg-fuchsia-700"
      />
    </div>
  );
}
