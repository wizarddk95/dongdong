import { useEffect, useMemo, useRef, useState } from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import { ContextModal } from "@/components/inspect/ContextModal";
import { MemoryModal } from "@/components/inspect/MemoryModal";
import { Button } from "@/components/Panel";
import { ContextRing, UsageBreakdown } from "@/components/UsageMeter";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { findModelOption } from "@/lib/ai/providers";
import { contextPayloadOf } from "@/lib/ai/runner";
import { summarizeToolCall } from "@/lib/ai/skills";
import {
  contextStatus,
  formatCost,
  lastCallUsage,
  readChainUsage,
  summarizeLiveUsage,
} from "@/lib/ai/usage";
import { buildIndex, pathTo, siblingsOf } from "@/lib/tree";
import { toBubbles } from "@/lib/turns";
import { useAgents } from "@/store/agents";
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
  const agentRuns = useAgents((state) => state.runs);

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
  const systemPrompt = useSettings((state) => state.systemPrompt);

  const [draft, setDraft] = useState("");
  const [usageOpen, setUsageOpen] = useState(false);
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

  /**
   * 비용·컨텍스트는 DB 집계가 아니라 스토어의 노드에서 바로 센다 —
   * 방금 끝난 턴이 곧바로 반영돼야 하기 때문이다.
   *
   *   - 컨텍스트: **활성 경로의 마지막 호출**이 기준. 다음 턴에 그대로 다시 실린다.
   *   - 경로 비용: 지금 보고 있는 대화 줄기만.
   *   - 세션 비용: 버려진 분기와 서브에이전트까지 포함한 이 세션의 실제 지출.
   */
  const { context, pathUsage, sessionUsage } = useMemo(() => {
    // 지금 [전송]을 누르면 실제로 나갈 페이로드. 인스펙터의 "다음 턴 미리보기" 와
    // 같은 함수를 써야 두 화면이 같은 수를 말한다.
    const payload = contextPayloadOf(
      path,
      messages,
      composeSystemPrompt(systemPrompt, useProjectInstructions ? instructions : null),
    );

    const last = lastCallUsage(path, modelId);
    // 창 크기는 **지금 선택한 모델** 기준이다 — 다음 턴을 보낼 모델이 그것이므로.
    // 잰 모델(마지막 호출)이 다르면 `contextStatus` 가 근사치로 표시해 준다.
    return {
      context: contextStatus(modelId, last?.usage ?? null, last?.modelId ?? null, payload),
      pathUsage: readChainUsage(path, modelId),
      // 세션 합계는 활성 경로가 아니라 세션의 **모든** 노드를 센다.
      sessionUsage: summarizeLiveUsage(messages, agentRuns, modelId),
    };
  }, [path, messages, agentRuns, modelId, systemPrompt, useProjectInstructions, instructions]);

  const modelLabel = findModelOption(modelId)?.label ?? modelId;
  const canSend = Boolean(project && activeSessionId) && !running;

  async function submit() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    await send(text);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
        {path.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            {/* 빈 화면은 이 앱이 유일하게 큰 활자를 쓸 자리다 — 웨이트 300 의 디스플레이. */}
            <p className="text-display-md text-ink">
              {project ? "대화를 시작하세요" : "프로젝트를 여세요"}
            </p>
            <p className="text-body-sm text-ink-muted">
              {project
                ? "우측 그래프에서 턴 카드를 클릭하면 그 지점부터 이어집니다."
                : "상단의 [폴더 열기] 로 시작합니다."}
            </p>
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
        <div className="flex shrink-0 items-start gap-2 border-t border-hairline border-l-2 border-l-error bg-error-subtle px-3 py-2 text-caption text-ink">
          <span className="shrink-0 text-body-emphasis text-error">오류</span>
          <span className="flex-1 font-mono break-all">{error}</span>
          <button className="shrink-0 rounded-sm px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-hover hover:text-ink" onClick={clearError}>
            ✕
          </button>
        </div>
      )}

      {pendingToolCalls.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-hairline bg-surface-1 px-3 py-1.5 text-caption text-ink">
          <span className="animate-pulse text-accent">●</span>
          <span className="text-body-emphasis">도구 실행 중</span>
          {pendingToolCalls.map((call) => (
            <span key={call.toolCallId} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono">
              {summarizeToolCall(call.toolName, call.input)}
            </span>
          ))}
        </div>
      )}

      <div className="shrink-0 border-t border-hairline p-3">
        <div className="mb-2 space-y-1.5">
          <ContextRing status={context} size={44} variant="full" />

          <div className="flex flex-wrap items-center gap-3 text-caption text-ink-muted">
            <span title="지금 보고 있는 대화 줄기(활성 경로)에 든 비용입니다.">
              이 경로 <span className="text-ink">{formatCost(pathUsage.cost, pathUsage.modelId)}</span>
            </span>
            <span title="버려진 분기와 서브에이전트까지 포함한 이 세션 전체의 비용입니다.">
              세션{" "}
              <span className="text-ink">
                {formatCost(sessionUsage.cost, sessionUsage.primaryModelId)}
              </span>
            </span>
            {sessionUsage.calls > 0 && <span>LLM 호출 {sessionUsage.calls}회</span>}
            <button
              className="ml-auto rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
              title="세션 전체의 토큰을 항목별로 봅니다"
              onClick={() => setUsageOpen(!usageOpen)}
            >
              {usageOpen ? "토큰 내역 닫기" : "토큰 내역"}
            </button>
          </div>

          {usageOpen && (
            <UsageBreakdown
              usage={sessionUsage.usage}
              cost={sessionUsage.cost}
              modelId={sessionUsage.primaryModelId}
              calls={sessionUsage.calls}
            />
          )}
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-3 text-caption text-ink-muted">
          <span className="text-ink">{modelLabel}</span>
          {activeParentId ? (
            <span>
              부모 노드 <code className="font-mono">{activeParentId.slice(0, 8)}</code>
            </span>
          ) : (
            <span>새 루트 노드로 시작</span>
          )}

          {instructions && useProjectInstructions && (
            <button
              className="rounded-full border border-hairline px-2 py-0.5 font-mono text-accent transition-colors hover:bg-hover"
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
              className="rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
              title="다음 턴에 LLM 으로 나갈 컨텍스트를 미리 봅니다"
              onClick={() => {
                setContextMessageId(null);
                setContextOpen(true);
              }}
            >
              현재 컨텍스트 보기
            </button>
            <button
              className="rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
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
            className="min-h-0 flex-1 resize-none rounded-md border border-field-rule bg-field px-3.5 py-2.5 text-body-sm text-ink transition-colors placeholder:text-ink-subtle hover:border-ink-subtle focus:border-accent disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-1 disabled:text-ink-disabled"
          />
          {running ? (
            <Button
              variant="danger"
              size="md"
              onClick={stop}
              className="w-24"
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
              size="md"
              onClick={() => void submit()}
              disabled={!canSend || !draft.trim()}
              className="w-24"
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
