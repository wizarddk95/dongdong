import { useState } from "react";

import { JsonTree } from "@/components/inspect/JsonTree";
import { readToolCalls, readToolResults } from "@/lib/ai/runner";
import { summarizeToolCall } from "@/lib/ai/skills";
import type { Message } from "@/types/ipc";

interface MessageBubbleProps {
  message: Message;
  /** 스트리밍 중이면 DB 내용 대신 이 텍스트를 보여준다 */
  liveText?: string;
  liveReasoning?: string;
  siblingCount: number;
  onBranchHere: () => void;
  onBranchSession: () => void;
  /** 이 노드가 LLM 에 보낸 컨텍스트를 인스펙터로 연다 */
  onInspectContext?: () => void;
}

const ROLE_STYLE: Record<string, { wrap: string; label: string; badge: string }> = {
  user: {
    wrap: "ml-auto max-w-[85%] border-sky-800 bg-sky-950/50",
    label: "나",
    badge: "text-sky-300",
  },
  assistant: {
    wrap: "mr-auto max-w-[92%] border-zinc-800 bg-zinc-900/60",
    label: "에이전트",
    badge: "text-emerald-300",
  },
  tool: {
    wrap: "mr-auto max-w-[92%] border-amber-900 bg-amber-950/40",
    label: "도구",
    badge: "text-amber-300",
  },
  system: {
    wrap: "mr-auto max-w-[92%] border-zinc-800 bg-zinc-900/40",
    label: "시스템",
    badge: "text-zinc-400",
  },
};

function usageSummary(usage: unknown): string | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, number | undefined>;
  const parts: string[] = [];
  if (record.inputTokens != null) parts.push(`in ${record.inputTokens}`);
  if (record.outputTokens != null) parts.push(`out ${record.outputTokens}`);
  if (record.reasoningTokens) parts.push(`think ${record.reasoningTokens}`);
  if (record.cachedInputTokens) parts.push(`cached ${record.cachedInputTokens}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function MessageBubble({
  message,
  liveText,
  liveReasoning,
  siblingCount,
  onBranchHere,
  onBranchSession,
  onInspectContext,
}: MessageBubbleProps) {
  const [showReasoning, setShowReasoning] = useState(false);

  const style = ROLE_STYLE[message.role] ?? ROLE_STYLE.system;
  const streaming = message.status === "streaming";
  const isTool = message.role === "tool";
  const body = streaming ? (liveText ?? "") : message.content;
  const reasoning = isTool
    ? ""
    : streaming
      ? liveReasoning
      : ((message.toolResults as { reasoning?: string } | null)?.reasoning ?? "");
  const errorText = isTool
    ? undefined
    : (message.toolResults as { error?: string } | null)?.error;
  const usage = usageSummary(message.tokenUsage);
  const toolCalls = readToolCalls(message.toolCalls);

  return (
    <div className={`group rounded-lg border px-3 py-2 ${style.wrap}`}>
      <div className="mb-1 flex items-center gap-2 text-[10px]">
        <span className={`font-semibold ${style.badge}`}>{style.label}</span>
        {siblingCount > 1 && (
          <span className="rounded bg-violet-950 px-1 text-violet-300">
            분기 {siblingCount}개 중 하나
          </span>
        )}
        {usage && <span className="text-zinc-600">{usage}</span>}
        {message.status === "aborted" && <span className="text-amber-400">중단됨</span>}
        {!isTool && toolCalls.length > 0 && (
          <span className="rounded bg-amber-950 px-1 text-amber-300">
            도구 {toolCalls.length}회 호출
          </span>
        )}

        <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onInspectContext && (
            <button
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
              title="이 응답을 만들 때 LLM 에 실제로 보낸 컨텍스트를 봅니다"
              onClick={onInspectContext}
            >
              컨텍스트
            </button>
          )}
          <button
            className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
            title="이 노드의 부모로 돌아가 다른 답을 시도합니다 (같은 세션 안에서 분기)"
            onClick={onBranchHere}
          >
            여기서 다시
          </button>
          <button
            className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
            title="이 시점까지를 복제한 새 세션을 만듭니다"
            onClick={onBranchSession}
          >
            ⑂ 새 세션
          </button>
        </span>
      </div>

      {reasoning ? (
        <div className="mb-1.5">
          <button
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={() => setShowReasoning((value) => !value)}
          >
            {showReasoning ? "▾" : "▸"} 사고 과정 {streaming ? "(진행 중)" : ""}
          </button>
          {showReasoning && (
            <pre className="mt-1 whitespace-pre-wrap rounded bg-black/30 p-2 text-[11px] text-zinc-400">
              {reasoning}
            </pre>
          )}
        </div>
      ) : null}

      {isTool ? (
        <ToolCallList message={message} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-100">
          {body}
          {streaming && <span className="ml-0.5 animate-pulse text-emerald-400">▌</span>}
        </p>
      )}

      {errorText && (
        <p className="mt-1.5 rounded border border-red-900 bg-red-950/50 px-2 py-1 font-mono text-[11px] break-all text-red-300">
          {errorText}
        </p>
      )}
    </div>
  );
}

/** tool 노드 본문 — 호출 입력과 실행 결과를 접었다 펼 수 있게 보여준다. */
function ToolCallList({ message }: { message: Message }) {
  const calls = readToolCalls(message.toolCalls);
  const results = readToolResults(message.toolResults);

  if (calls.length === 0) {
    return (
      <p className="whitespace-pre-wrap break-words text-[12px] text-zinc-200">{message.content}</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {calls.map((call) => {
        const result = results.find((item) => item.toolCallId === call.toolCallId);
        const failed = result?.errorText != null;
        return (
          <ToolCallCard
            key={call.toolCallId}
            title={summarizeToolCall(call.toolName, call.input)}
            failed={failed}
            pending={!result}
            input={call.input}
            output={failed ? result?.errorText : result?.output}
          />
        );
      })}
    </div>
  );
}

function ToolCallCard({
  title,
  failed,
  pending,
  input,
  output,
}: {
  title: string;
  failed: boolean;
  pending: boolean;
  input: unknown;
  output: unknown;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded border border-amber-900/60 bg-black/20">
      <button
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-amber-950/40"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-amber-200">{title}</span>
        <span
          className={`shrink-0 text-[10px] ${
            pending ? "text-zinc-500" : failed ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {pending ? "실행 중" : failed ? "실패" : "완료"}
        </span>
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-amber-900/40 px-2 py-1.5">
          <div>
            <p className="mb-0.5 text-[10px] text-zinc-500">입력</p>
            <JsonTree value={input} defaultOpenDepth={2} />
          </div>
          <div>
            <p className="mb-0.5 text-[10px] text-zinc-500">{failed ? "오류" : "출력"}</p>
            <JsonTree value={output ?? null} defaultOpenDepth={1} />
          </div>
        </div>
      )}
    </div>
  );
}
