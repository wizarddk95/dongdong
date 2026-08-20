import { useEffect, useMemo, useRef, useState } from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import { ContextModal } from "@/components/inspect/ContextModal";
import { MemoryModal } from "@/components/inspect/MemoryModal";
import { Button } from "@/components/Panel";
import { findModelOption } from "@/lib/ai/providers";
import { summarizeToolCall } from "@/lib/ai/skills";
import { buildIndex, pathTo, siblingsOf } from "@/lib/tree";
import { toBubbles } from "@/lib/turns";
import { useChat } from "@/store/chat";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

export function ChatPanel() {
  const messages = useWorkspace((state) => state.messages);
  const activeParentId = useWorkspace((state) => state.activeParentId);
  const setActiveParent = useWorkspace((state) => state.setActiveParent);
  const branchFrom = useWorkspace((state) => state.branchFrom);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const project = useWorkspace((state) => state.project);
  const instructions = useWorkspace((state) => state.instructions);

  const {
    running,
    stopping,
    streamingMessageId,
    streamingText,
    streamingReasoning,
    pendingToolCalls,
    error,
    send,
    stop,
    clearError,
  } = useChat();
  const modelId = useSettings((state) => state.modelId);
  const useProjectInstructions = useSettings((state) => state.useProjectInstructions);

  const [draft, setDraft] = useState("");
  // contextMessageId 가 null 이면 "다음 턴에 나갈 컨텍스트" 미리보기.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextMessageId, setContextMessageId] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 활성 경로(루트 → activeParent)가 곧 "지금 보고 있는 대화".
  // tool 노드는 자기를 부른 assistant 말풍선 안으로 접어 넣는다.
  const { path, bubbles, index } = useMemo(() => {
    const path = pathTo(messages, activeParentId);
    return { path, bubbles: toBubbles(path), index: buildIndex(messages) };
  }, [messages, activeParentId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [path.length, streamingText]);

  const modelLabel = findModelOption(modelId)?.label ?? modelId;
  const canSend = Boolean(project && activeSessionId) && !running;

  async function submit() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    await send(text);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {path.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-zinc-600">
            <p>{project ? "메시지를 보내 대화를 시작하세요." : "먼저 프로젝트 폴더를 여세요."}</p>
            <p className="text-[11px]">우측 그래프에서 턴 카드를 클릭하면 그 지점부터 이어집니다.</p>
          </div>
        )}

        {bubbles.map(({ message, toolNode }) => (
          <MessageBubble
            key={message.id}
            message={message}
            toolNode={toolNode}
            liveText={message.id === streamingMessageId ? streamingText : undefined}
            liveReasoning={message.id === streamingMessageId ? streamingReasoning : undefined}
            siblingCount={siblingsOf(index, message).length}
            onBranchHere={() => setActiveParent(message.parentId)}
            onBranchSession={() => void branchFrom(message.id)}
            onInspectContext={
              message.role === "assistant"
                ? () => {
                    setContextMessageId(message.id);
                    setContextOpen(true);
                  }
                : undefined
            }
          />
        ))}
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-t border-red-900 bg-red-950/60 px-3 py-2 text-[11px] text-red-200">
          <span className="flex-1 font-mono break-all">{error}</span>
          <button className="shrink-0 text-red-300 hover:text-red-100" onClick={clearError}>
            ✕
          </button>
        </div>
      )}

      {pendingToolCalls.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-amber-900/60 bg-amber-950/30 px-3 py-1.5 text-[11px] text-amber-200">
          <span className="animate-pulse">●</span>
          <span>도구 실행 중</span>
          {pendingToolCalls.map((call) => (
            <span key={call.toolCallId} className="rounded bg-black/30 px-1.5 py-0.5 font-mono">
              {summarizeToolCall(call.toolName, call.input)}
            </span>
          ))}
        </div>
      )}

      <div className="shrink-0 border-t border-zinc-800 p-2">
        <div className="mb-1.5 flex items-center gap-2 text-[10px] text-zinc-500">
          <span>{modelLabel}</span>
          {activeParentId ? (
            <span className="text-zinc-600">
              부모 노드 <code className="text-zinc-500">{activeParentId.slice(0, 8)}</code>
            </span>
          ) : (
            <span className="text-zinc-600">새 루트 노드로 시작</span>
          )}

          {instructions && useProjectInstructions && (
            <button
              className="rounded bg-emerald-950 px-1.5 py-0.5 text-emerald-300 hover:bg-emerald-900"
              title={`${instructions.path} 를 컨텍스트 맨 앞에 싣고 있습니다 (${instructions.content.length.toLocaleString()}자). 클릭하면 원문을 봅니다.`}
              onClick={() => {
                setContextMessageId(null);
                setContextOpen(true);
              }}
            >
              {instructions.path}
            </button>
          )}

          <span className="ml-auto flex gap-1">
            <button
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
              title="다음 턴에 LLM 으로 나갈 컨텍스트를 미리 봅니다"
              onClick={() => {
                setContextMessageId(null);
                setContextOpen(true);
              }}
            >
              현재 컨텍스트 보기
            </button>
            <button
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
              title="에이전트가 remember 로 저장한 내용을 봅니다"
              onClick={() => setMemoryOpen(true)}
            >
              현재 메모리 보기
            </button>
          </span>
        </div>

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={canSend ? "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)" : "대기 중…"}
            rows={3}
            disabled={!project}
            className="min-h-0 flex-1 resize-none rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <Button
              variant="danger"
              onClick={stop}
              className="h-9 px-3"
              title={
                stopping
                  ? "실행 중인 도구가 정리되는 중입니다"
                  : "이 턴과 딸린 서브에이전트를 모두 중단합니다"
              }
            >
              {stopping ? "중지 중…" : "중지"}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={!canSend || !draft.trim()}
              className="h-9 px-3"
            >
              전송
            </Button>
          )}
        </div>
      </div>

      <ContextModal
        open={contextOpen}
        messageId={contextMessageId}
        onClose={() => setContextOpen(false)}
      />
      <MemoryModal open={memoryOpen} onClose={() => setMemoryOpen(false)} />
    </div>
  );
}
