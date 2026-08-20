import { useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { JsonTree } from "@/components/inspect/JsonTree";
import {
  readToolCalls,
  readToolResults,
  type StoredToolCall,
  type StoredToolResult,
} from "@/lib/ai/runner";
import { summarizeToolCall } from "@/lib/ai/skills";
import { readNodeUsage } from "@/lib/ai/usage";
import { UsageTag } from "@/components/UsageMeter";
import type { Message } from "@/types/ipc";

interface MessageBubbleProps {
  message: Message;
  /** 이 노드가 부른 도구들의 결과 노드. 말풍선 안에 접어서 함께 보여준다. */
  toolNode?: Message | null;
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

export function MessageBubble({
  message,
  toolNode,
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
  // 사용량은 턴을 마무리한 assistant 노드에만 붙는다 (그 턴 전체의 합계).
  const usage = readNodeUsage(message);

  // 도구 호출은 assistant 노드에, 결과는 그 아래 tool 노드에 나뉘어 저장된다.
  // 화면에서는 둘을 한 말풍선으로 합쳐 보여준다.
  const toolCalls = isTool
    ? readToolCalls(message.toolCalls)
    : (() => {
        const own = readToolCalls(message.toolCalls);
        return own.length > 0 ? own : readToolCalls(toolNode?.toolCalls);
      })();
  const toolResults = readToolResults((isTool ? message : toolNode)?.toolResults);

  return (
    <div className={`group rounded-lg border px-3 py-2 ${style.wrap}`}>
      <div className="mb-1 flex items-center gap-2 text-[10px]">
        <span className={`font-semibold ${style.badge}`}>{style.label}</span>
        {siblingCount > 1 && (
          <span className="rounded bg-violet-950 px-1 text-violet-300">
            분기 {siblingCount}개 중 하나
          </span>
        )}
        {usage && (
          <UsageTag
            usage={usage.usage}
            cost={usage.cost}
            modelId={usage.modelId}
            className="text-[10px]"
          />
        )}
        {message.status === "aborted" && <span className="text-amber-400">중단됨</span>}

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
            <div className="mt-1 rounded bg-black/30 p-2">
              <Markdown text={reasoning ?? ""} dim />
            </div>
          )}
        </div>
      ) : null}

      {isTool && toolCalls.length === 0 ? (
        // 짝을 잃은 tool 노드 — 저장해 둔 요약문이라도 보여준다.
        <p className="whitespace-pre-wrap break-words text-[12px] text-zinc-200">
          {message.content}
        </p>
      ) : message.role === "user" ? (
        // 사용자가 친 글자는 마크다운으로 해석하지 않고 그대로 보여준다.
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-100">
          {body}
        </p>
      ) : !isTool && (streaming || body) ? (
        // 스트리밍 커서는 본문 끝에 붙여 마지막 블록 안에서 흐르게 한다.
        <Markdown text={streaming ? `${body}▌` : body} />
      ) : null}

      {toolCalls.length > 0 && (
        <ToolCallList calls={toolCalls} results={toolResults} withGap={!isTool && Boolean(body)} />
      )}

      {errorText && (
        <p className="mt-1.5 rounded border border-red-900 bg-red-950/50 px-2 py-1 font-mono text-[11px] break-all text-red-300">
          {errorText}
        </p>
      )}
    </div>
  );
}

/**
 * 한 스텝에서 부른 도구들 — 기본은 한 줄 요약으로 접어 둔다.
 * 도구를 여러 번 부르는 턴에서 대화가 아래로 끝없이 늘어지는 걸 막는다.
 */
function ToolCallList({
  calls,
  results,
  withGap,
}: {
  calls: StoredToolCall[];
  results: StoredToolResult[];
  withGap: boolean;
}) {
  const [open, setOpen] = useState(false);

  const cards = calls.map((call) => {
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
  });

  const wrap = withGap ? "mt-2 border-t border-zinc-800 pt-2" : "";

  // 하나뿐이면 카드 자체가 이미 접힌 한 줄이라 요약을 덧붙이지 않는다.
  if (calls.length === 1) return <div className={wrap}>{cards}</div>;

  const pending = calls.some(
    (call) => !results.some((item) => item.toolCallId === call.toolCallId),
  );
  const failedCount = results.filter((item) => item.errorText != null).length;
  const status = pending ? "실행 중" : failedCount > 0 ? `${failedCount}건 실패` : "완료";

  return (
    <div className={wrap}>
      <button
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-amber-950/40"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 text-amber-300">도구 {calls.length}개</span>
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">
          {calls.map((call) => summarizeToolCall(call.toolName, call.input)).join(" · ")}
        </span>
        <span
          className={`shrink-0 text-[10px] ${
            pending ? "text-zinc-500" : failedCount > 0 ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {status}
        </span>
      </button>

      {open && <div className="mt-1.5 space-y-1.5">{cards}</div>}
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
