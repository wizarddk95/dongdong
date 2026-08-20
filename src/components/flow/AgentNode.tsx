import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { isRunActive, runDuration, runStatusStyle } from "@/lib/agentRuns";
import type { AgentRun } from "@/types/ipc";

export const AGENT_WIDTH = 200;
export const AGENT_HEIGHT = 76;

export interface AgentNodeData extends Record<string, unknown> {
  run: AgentRun;
  isSelected: boolean;
  dimmed: boolean;
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;

/** 위임된 서브에이전트 하나. 발화한 턴에서 위/아래로 갈라져 나온다. */
export function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const { run, isSelected, dimmed } = data;
  const style = runStatusStyle(run.status);
  const elapsed = runDuration(run);

  return (
    <div
      style={{ width: AGENT_WIDTH, height: AGENT_HEIGHT }}
      className={`flex flex-col gap-1 rounded-lg border border-dashed border-fuchsia-800 bg-fuchsia-950/30 px-2 py-1.5 transition-opacity ${
        isSelected ? "ring-2 ring-violet-400" : ""
      } ${dimmed ? "opacity-45" : "opacity-100"}`}
    >
      {/* 턴 카드의 위/아래 어느 쪽에 놓이든 선이 자연스럽게 붙도록 핸들을 양쪽에 둔다. */}
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !bg-fuchsia-600"
      />
      <Handle
        type="target"
        id="bottom"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !bg-fuchsia-600"
      />

      <div className="flex items-center gap-1 text-[9px]">
        <span className={`rounded px-1 py-0.5 ${style.className}`}>{style.label}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-200">🤝 {run.name}</span>
        {elapsed && <span className="shrink-0 text-zinc-600">{elapsed}</span>}
      </div>

      <div className="h-1 shrink-0 overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full transition-all ${style.barClassName}`}
          style={{ width: `${Math.round((run.progress ?? 0) * 100)}%` }}
        />
      </div>

      <p className="line-clamp-2 flex-1 overflow-hidden text-[10px] leading-snug text-zinc-400">
        {isRunActive(run)
          ? (run.currentSkill ? `▶ ${run.currentSkill}` : "▶ 생각 중…")
          : (run.error ?? run.result ?? run.task)}
      </p>
    </div>
  );
}
