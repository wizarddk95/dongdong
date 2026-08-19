import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/tree";
import type { Message } from "@/types/ipc";

export interface MessageNodeData extends Record<string, unknown> {
  message: Message;
  isOnActivePath: boolean;
  isActiveParent: boolean;
  isSelected: boolean;
  branchCount: number;
}

export type MessageFlowNode = Node<MessageNodeData, "message">;

const ROLE_ACCENT: Record<string, string> = {
  user: "border-sky-600 bg-sky-950/70",
  assistant: "border-emerald-600 bg-emerald-950/70",
  tool: "border-amber-600 bg-amber-950/70",
  system: "border-zinc-600 bg-zinc-900/70",
};

const ROLE_LABEL: Record<string, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
  system: "SYSTEM",
};

export function MessageNode({ data }: NodeProps<MessageFlowNode>) {
  const { message, isOnActivePath, isActiveParent, isSelected, branchCount } = data;

  const accent = ROLE_ACCENT[message.role] ?? ROLE_ACCENT.system;
  const ring = isSelected
    ? "ring-2 ring-violet-400"
    : isActiveParent
      ? "ring-2 ring-emerald-400"
      : "";

  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex flex-col rounded-lg border px-2.5 py-2 text-left transition-opacity ${accent} ${ring} ${
        isOnActivePath ? "opacity-100" : "opacity-45"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !bg-zinc-500" />

      <div className="flex items-center justify-between gap-1 text-[9px] tracking-wide text-zinc-400">
        <span className="font-semibold">{ROLE_LABEL[message.role] ?? message.role}</span>
        <span className="flex items-center gap-1">
          {message.status === "streaming" && <span className="text-emerald-300">● 생성 중</span>}
          {message.status === "error" && <span className="text-red-400">● 오류</span>}
          {message.status === "aborted" && <span className="text-amber-400">● 중단</span>}
          {branchCount > 1 && (
            <span className="rounded bg-violet-900/70 px-1 text-violet-200">⑂{branchCount}</span>
          )}
          <span className="text-zinc-600">#{message.seq}</span>
        </span>
      </div>

      <p className="mt-1 line-clamp-3 overflow-hidden text-[11px] leading-snug text-zinc-200">
        {message.content.trim() || (message.status === "streaming" ? "…" : "(빈 노드)")}
      </p>

      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !bg-zinc-500" />
    </div>
  );
}
