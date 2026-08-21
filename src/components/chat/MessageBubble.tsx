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
import { Tag } from "@/components/Panel";
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

/**
 * 역할을 색이 아니라 **자리와 면**으로 가른다 — 크로마틱 액센트는 청록 하나뿐이다.
 * 말풍선 꼬리 쪽 모서리만 덜 둥글게 깎아 말하는 쪽을 가리킨다.
 *   나     오른쪽 정렬 + 회색 면 (오른쪽 아래 모서리를 깎음)
 *   에이전트 왼쪽 정렬 + 흰 면 + 옅은 그림자
 *   도구   왼쪽 정렬 + 회색 면
 */
const ROLE_STYLE: Record<string, { wrap: string; label: string }> = {
  user: { wrap: "ml-auto max-w-[85%] rounded-br-xs border-hairline bg-surface-1", label: "나" },
  assistant: {
    wrap: "mr-auto max-w-[92%] rounded-bl-xs border-hairline bg-canvas elevate",
    label: "에이전트",
  },
  tool: {
    wrap: "mr-auto max-w-[92%] rounded-bl-xs border-hairline bg-surface-1",
    label: "도구",
  },
  system: { wrap: "mr-auto max-w-[92%] rounded-bl-xs border-hairline bg-surface-1", label: "시스템" },
};

/** 말풍선 위에 뜨는 보조 동작 — 배경 없이 글자만, 호버에서만 나타난다. */
const ACTION =
  "rounded-sm px-2 py-0.5 text-caption text-accent transition-colors hover:bg-hover";

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
  // 사용량은 LLM 호출이 있었던 assistant 노드에만 붙는다 (그 호출 하나의 몫).
  // 도구를 쓴 턴은 스텝마다 노드가 갈라지므로 말풍선마다 자기 호출의 값이 뜬다.
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
    <div className={`group rounded-lg border px-3.5 py-2.5 ${style.wrap}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-caption">
        <span className="text-body-emphasis text-ink">{style.label}</span>
        {siblingCount > 1 && <Tag title="같은 부모에서 갈라진 형제 턴이 있습니다">⑂ 분기 {siblingCount}</Tag>}
        {usage && (
          <UsageTag
            usage={usage.usage}
            cost={usage.cost}
            modelId={usage.modelId}
            showModel
          />
        )}
        {message.status === "aborted" && <span className="text-warning">중단됨</span>}

        <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onInspectContext && (
            <button
              className={ACTION}
              title="이 응답을 만들 때 LLM 에 실제로 보낸 컨텍스트를 봅니다"
              onClick={onInspectContext}
            >
              컨텍스트
            </button>
          )}
          <button
            className={ACTION}
            title="이 노드의 부모로 돌아가 다른 답을 시도합니다 (같은 세션 안에서 분기)"
            onClick={onBranchHere}
          >
            여기서 다시
          </button>
          <button
            className={ACTION}
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
            className="text-caption text-ink-muted hover:text-ink"
            onClick={() => setShowReasoning((value) => !value)}
          >
            {showReasoning ? "▾" : "▸"} 사고 과정 {streaming ? "(진행 중)" : ""}
          </button>
          {showReasoning && (
            <div className="mt-1 rounded-md bg-surface-1 p-2.5">
              <Markdown text={reasoning ?? ""} dim />
            </div>
          )}
        </div>
      ) : null}

      {isTool && toolCalls.length === 0 ? (
        // 짝을 잃은 tool 노드 — 저장해 둔 요약문이라도 보여준다.
        <p className="whitespace-pre-wrap break-words text-caption text-ink">{message.content}</p>
      ) : message.role === "user" ? (
        // 사용자가 친 글자는 마크다운으로 해석하지 않고 그대로 보여준다.
        <p className="whitespace-pre-wrap break-words text-body-sm leading-relaxed text-ink">
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
        <p className="mt-1.5 rounded-md border-l-2 border-error bg-error-subtle px-2.5 py-1.5 font-mono text-caption break-all text-ink">
          {errorText}
        </p>
      )}
    </div>
  );
}

/** 도구 실행 결과 한 줄 상태. 글자가 먼저 읽히고 색은 거들기만 한다. */
function StatusText({ pending, failed }: { pending: boolean; failed: boolean }) {
  const [text, tone] = pending
    ? ["실행 중", "text-ink-muted"]
    : failed
      ? ["실패", "text-error"]
      : ["완료", "text-success"];
  return <span className={`shrink-0 text-caption ${tone}`}>{text}</span>;
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

  const wrap = withGap ? "mt-2 border-t border-hairline pt-2" : "";

  // 하나뿐이면 카드 자체가 이미 접힌 한 줄이라 요약을 덧붙이지 않는다.
  if (calls.length === 1) return <div className={wrap}>{cards}</div>;

  const pending = calls.some(
    (call) => !results.some((item) => item.toolCallId === call.toolCallId),
  );
  const failedCount = results.filter((item) => item.errorText != null).length;

  return (
    <div className={wrap}>
      <button
        className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-caption transition-colors hover:bg-hover"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-ink-subtle">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 text-body-emphasis text-ink">도구 {calls.length}개</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">
          {calls.map((call) => summarizeToolCall(call.toolName, call.input)).join(" · ")}
        </span>
        {failedCount > 0 && !pending ? (
          <span className="shrink-0 text-caption text-error">{failedCount}건 실패</span>
        ) : (
          <StatusText pending={pending} failed={false} />
        )}
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
    <div className="overflow-hidden rounded-md border border-hairline bg-canvas">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-caption text-ink-subtle">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-ink">{title}</span>
        <StatusText pending={pending} failed={failed} />
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-hairline px-2 py-1.5">
          <div>
            <p className="mb-0.5 text-caption text-ink-muted">입력</p>
            <JsonTree value={input} defaultOpenDepth={2} />
          </div>
          <div>
            <p className="mb-0.5 text-caption text-ink-muted">{failed ? "오류" : "출력"}</p>
            <JsonTree value={output ?? null} defaultOpenDepth={1} />
          </div>
        </div>
      )}
    </div>
  );
}
