import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { isRunActive, runDuration, runStatusStyle } from "@/lib/agentRuns";
import { t } from "@/lib/i18n";
import type { AgentRun } from "@/types/ipc";

export const AGENT_WIDTH = 236;
export const AGENT_HEIGHT = 104;

export interface AgentNodeData extends Record<string, unknown> {
  run: AgentRun;
  isSelected: boolean;
  dimmed: boolean;
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;

/**
 * 위임된 서브에이전트 하나. 발화한 턴에서 위/아래로 갈라져 나온다.
 * 턴 카드와는 **점선 테두리**로 구분한다 — 아이콘이나 별도의 브랜드 색을 쓰지 않는다.
 */
export function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const { run, isSelected, dimmed } = data;
  const style = runStatusStyle(run.status);
  const elapsed = runDuration(run);

  return (
    <div
      style={{ width: AGENT_WIDTH, height: AGENT_HEIGHT }}
      className={`flex flex-col gap-1.5 rounded-lg border-dashed bg-surface-1 px-3 py-2.5 transition-opacity ${
        isSelected ? "border-2 border-accent" : "border border-field-rule"
      } ${dimmed ? "opacity-45" : "opacity-100"}`}
    >
      {/* 턴 카드의 위/아래 어느 쪽에 놓이든 선이 자연스럽게 붙도록 핸들을 양쪽에 둔다. */}
      <Handle type="target" id="top" position={Position.Top} />
      <Handle type="target" id="bottom" position={Position.Bottom} />

      <div className="flex items-center gap-1.5 text-caption">
        <span className={`shrink-0 rounded-full px-2 py-0.5 ${style.className}`}>{t(style.labelKey)}</span>
        <span className="min-w-0 flex-1 truncate text-ink">{run.name}</span>
        {elapsed && <span className="shrink-0 text-ink-subtle">{elapsed}</span>}
      </div>

      <div className="h-1 shrink-0 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-all ${style.barClassName}`}
          style={{ width: `${Math.round((run.progress ?? 0) * 100)}%` }}
        />
      </div>

      <p className="line-clamp-2 flex-1 overflow-hidden text-caption leading-snug text-ink-muted">
        {isRunActive(run)
          ? (run.currentTool ? `▶ ${run.currentTool}` : t("agents.thinking"))
          : (run.error ?? run.result ?? run.task)}
      </p>
    </div>
  );
}
