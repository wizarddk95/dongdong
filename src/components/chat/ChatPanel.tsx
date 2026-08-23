import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApprovalPrompt } from "@/components/chat/ApprovalPrompt";
import { MentionPicker, useMentionPicker } from "@/components/chat/MentionPicker";
import { QuestionPrompt } from "@/components/chat/QuestionPrompt";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ContextModal } from "@/components/inspect/ContextModal";
import { MemoryModal } from "@/components/inspect/MemoryModal";
import { Button } from "@/components/Panel";
import { ImageThumb } from "@/components/chat/ImageThumb";
import { ContextRing, UsageBreakdown } from "@/components/UsageMeter";
import { APPROVAL_MODES } from "@/lib/ai/approval";
import { useT } from "@/lib/i18n/useT";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { acceptsImages, findModelOption, modelLabel } from "@/lib/ai/providers";
import { contextPayloadOf } from "@/lib/ai/runner";
import { MAX_IMAGE_EDGE } from "@/lib/ai/imageTokens";
import { summarizeToolCall } from "@/lib/ai/tools";
import {
  contextStatus,
  formatCost,
  lastCallUsage,
  readChainUsage,
  summarizeLiveUsage,
} from "@/lib/ai/usage";
import {
  attachImage,
  IMAGE_MEDIA_TYPES,
  isImageFile,
  MAX_IMAGES_PER_MESSAGE,
  type AttachedImage,
} from "@/lib/images";
import { buildIndex, pathTo, siblingsOf } from "@/lib/tree";
import { isDefaultZoom, zoomIn, zoomOut, zoomPercent } from "@/lib/zoom";
import { buildTurns, toBubbles, turnLabel } from "@/lib/turns";
import { useAgents } from "@/store/agents";
import { useApprovals } from "@/store/approvals";
import { useChat } from "@/store/chat";
import { useQuestions } from "@/store/questions";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

export function ChatPanel() {
  const t = useT();
  const messages = useWorkspace((state) => state.messages);
  const activeParentId = useWorkspace((state) => state.activeParentId);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const project = useWorkspace((state) => state.project);
  const instructions = useWorkspace((state) => state.instructions);
  const agentRuns = useAgents((state) => state.runs);
  // 승인을 기다리는 중인지 알아야 아래 진행 표시가 거짓말을 하지 않는다.
  const approvalQueue = useApprovals((state) => state.queue);
  // 사용자 선택을 기다리는 중인지도 마찬가지다 — "도구 실행 중" 만 떠 있으면
  // 사람이 답할 차례라는 것이 어디에도 안 적힌다.
  const questionQueue = useQuestions((state) => state.queue);

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
  const injectDateTime = useSettings((state) => state.injectDateTime);
  const shellApproval = useSettings((state) => state.shellApproval);
  const chatZoom = useSettings((state) => state.chatZoom);
  const updateSettings = useSettings((state) => state.update);

  const [draft, setDraft] = useState("");
  /**
   * 아직 보내지 않은 이미지 첨부. `draft` 와 같은 수명이라 스토어가 아니라 여기 산다.
   * 바이트는 이미 워크스페이스에 눕어 있고(`attachImage`), 여기 있는 건 참조와 크기뿐이다.
   */
  const [images, setImages] = useState<AttachedImage[]>([]);
  /** 붙이다 실패한 이유. 턴 에러(`error`)와 자리를 나눠 쓴다 — 원인이 다르다. */
  const [imageError, setImageError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  // contextMessageId 가 null 이면 "다음 턴에 나갈 컨텍스트" 미리보기.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextMessageId, setContextMessageId] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  /** 도구가 붙잡고 있는 시간(초). "언제 끝나나" 를 사람이 셀 수 있어야 한다. */
  const [toolElapsed, setToolElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // `@` 파일 참조 자동완성. 텍스트 규칙은 `lib/mention.ts`, 목록은 Rust 가 훑는다.
  const mention = useMentionPicker({
    textareaRef,
    text: draft,
    setText: setDraft,
    enabled: Boolean(project),
    projectPath: project?.rootPath,
  });

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
   * 도구가 몇 초째 붙잡고 있는지 센다.
   *
   * 화면에 "도구 실행 중" 만 떠 있으면 **승인을 기다리는 중인지 진짜로 도는 중인지**
   * 구별할 수 없고, 3초든 3분이든 똑같이 보인다 — 그래서 멀쩡히 도는 명령이
   * "무한 로딩" 으로 읽힌다. 상태 이름과 경과 시간을 같이 적어 그 오해를 없앤다.
   */
  useEffect(() => {
    if (pendingToolCalls.length === 0) {
      setToolElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setToolElapsed(0);
    const timer = setInterval(
      () => setToolElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1_000,
    );
    return () => clearInterval(timer);
  }, [pendingToolCalls.length]);

  /**
   * 대화 글씨 크기. 계단·판정은 전부 `lib/zoom.ts` 가 갖고 여기서는 적용만 한다
   * (키보드 · 휠 · 버튼이 같은 계단을 밟아야 한다).
   */
  const applyZoom = useCallback(
    (next: number) => {
      if (next === chatZoom) return;
      void updateSettings({ chatZoom: next });
    },
    [chatZoom, updateSettings],
  );

  /**
   * Ctrl + 휠.
   *
   * React 의 `onWheel` 로는 못 막는다 — 리액트가 루트에 **passive** 로 걸기 때문에
   * `preventDefault()` 가 무시되고 웹뷰가 창 전체를 확대해 버린다. 그래서 네이티브
   * 리스너를 `{ passive: false }` 로 직접 건다.
   *
   * 대화 목록만이 아니라 **창 전체**에 건다. 채팅 밖에서만 웹뷰 확대가 살아 있으면
   * 창이 통째로 커진 채로 남는데, 아래 Ctrl+0 이 이미 대화 배율을 잡고 있어
   * **되돌릴 길이 없다.** 이 앱에서 Ctrl 확대는 언제나 대화 크기 하나를 뜻한다.
   */
  useEffect(() => {
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      applyZoom(event.deltaY < 0 ? zoomIn(chatZoom) : zoomOut(chatZoom));
    }

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [chatZoom, applyZoom]);

  /**
   * Ctrl + / − / 0.
   *
   * 창 전체에 건다 — 입력칸에 커서를 둔 채로도 눌러야 하고, 그게 이 단축키를 쓰는
   * 가장 흔한 순간이다. 웹뷰 자체 확대(창 전체가 커지고 레이아웃이 무너진다)를
   * 대신 가로챈다.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      // `+` 는 자판마다 Shift 조합이 달라 키 이름이 여럿이다.
      const next =
        event.key === "=" || event.key === "+" || event.key === "Add"
          ? zoomIn(chatZoom)
          : event.key === "-" || event.key === "_" || event.key === "Subtract"
            ? zoomOut(chatZoom)
            : event.key === "0"
              ? 1
              : null;
      if (next === null) return;
      event.preventDefault();
      applyZoom(next);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chatZoom, applyZoom]);

  /**
   * 다음 메시지가 붙을 자리를 **턴 이름**으로 말한다.
   *
   * 활성 부모는 노드 하나지만, 사람이 그래프에서 고르는 단위는 턴이다 —
   * 카드가 부르는 이름(턴을 여는 앵커 노드 id)과 다른 자를 여기 적으면
   * 같은 자리를 두 화면이 서로 다른 이름으로 부르게 된다. 정확한 노드 id 는 툴팁에 남긴다.
   */
  const target = useMemo(() => {
    if (!activeParentId) return null;
    const turns = buildTurns(messages);
    const turn = turns.byId.get(turns.turnOfMessage.get(activeParentId) ?? "");
    // 턴을 못 찾는 건 트리가 꼬였을 때뿐이다. 그때는 노드 id 라도 보여준다.
    if (!turn) return { label: activeParentId.slice(0, 8), midway: false };
    return { label: turnLabel(turn), midway: turn.leafId !== activeParentId };
  }, [messages, activeParentId]);

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
      composeSystemPrompt(
        systemPrompt,
        useProjectInstructions ? instructions : null,
        // 게이지도 실제로 나갈 것과 같아야 한다 — 시각 블록도 페이로드의 일부다.
        injectDateTime ? new Date() : null,
      ),
      // 이미지 토큰 공식은 공급자마다 다르다 — 창의 주인과 같은 모델로 세야 한다.
      modelId,
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
  }, [
    path,
    messages,
    agentRuns,
    modelId,
    systemPrompt,
    useProjectInstructions,
    instructions,
    injectDateTime,
  ]);

  const selectedModel = findModelOption(modelId);
  const shownModelLabel = selectedModel ? modelLabel(selectedModel) : modelId;
  const canSend = Boolean(project && activeSessionId) && !running;

  async function submit() {
    const text = draft.trim();
    // 이미지만 붙이고 보내는 것도 정상이다 — 스토어의 판정과 같은 자를 쓴다.
    if ((!text && images.length === 0) || !canSend) return;

    const attached = images;
    setDraft("");
    setImages([]);
    setImageError(null);
    await send(text, attached);
  }

  /**
   * 붙여넣기 · 파일 선택에서 온 파일들을 첨부로 만든다.
   *
   * 실패는 **한 장씩** 삼킨다 — 다섯 장 중 한 장이 깨졌다고 나머지까지 버리면
   * 사람은 무엇이 문제였는지 모른 채 처음부터 다시 붙여야 한다.
   */
  const addImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (!project) {
        setImageError(t("image.needsProject"));
        return;
      }
      if (!acceptsImages(modelId)) {
        setImageError(t("image.noVision"));
        return;
      }

      const supported = files.filter(isImageFile);
      if (supported.length === 0) {
        setImageError(t("image.unsupported"));
        return;
      }

      const room = MAX_IMAGES_PER_MESSAGE - images.length;
      if (room <= 0) {
        setImageError(t("image.tooMany", { max: MAX_IMAGES_PER_MESSAGE }));
        return;
      }

      setAttaching(true);
      setImageError(supported.length > room ? t("image.tooMany", { max: MAX_IMAGES_PER_MESSAGE }) : null);
      try {
        for (const file of supported.slice(0, room)) {
          try {
            const attached = await attachImage(file, { projectPath: project.rootPath });
            // 같은 이미지를 두 번 붙이면 한 번만 남는다 (내용주소라 파일도 하나다).
            setImages((current) =>
              current.some((image) => image.sha === attached.sha) ? current : [...current, attached],
            );
          } catch (failure) {
            setImageError(
              t("image.failed", {
                error: failure instanceof Error ? failure.message : String(failure),
              }),
            );
          }
        }
      } finally {
        setAttaching(false);
      }
    },
    [images.length, modelId, project, t],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
        {path.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            {/* 빈 화면은 이 앱이 유일하게 큰 활자를 쓸 자리다 — 웨이트 300 의 디스플레이. */}
            <p className="text-display-md text-ink">
              {project ? t("chat.emptyTitle") : t("chat.emptyNoProject")}
            </p>
            <p className="text-body-sm text-ink-muted">
              {project ? t("chat.emptyBody") : t("chat.emptyNoProjectBody")}
            </p>
          </div>
        )}

        {/*
          확대는 **읽는 면에만** 건다. 스크롤 컨테이너가 아니라 그 안쪽을 감싸야
          컨테이너의 scrollHeight 가 커진 내용을 그대로 재고, 맨 아래로 따라 내려가는
          자동 스크롤이 어긋나지 않는다.
        */}
        <div className="space-y-2" style={{ zoom: chatZoom }}>
          {bubbles.map(({ message, toolNode }) => (
            <MessageBubble
              key={message.id}
              message={message}
              toolNode={toolNode}
              liveText={message.id === streamingMessageId ? streamingText : undefined}
              liveReasoning={message.id === streamingMessageId ? streamingReasoning : undefined}
              siblingCount={siblingsOf(index, message).length}
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
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-t border-hairline border-l-2 border-l-error bg-error-subtle px-3 py-2 text-caption text-ink">
          <span className="shrink-0 text-body-emphasis text-error">{t("app.error")}</span>
          <span className="flex-1 font-mono break-all">{error}</span>
          <button className="shrink-0 rounded-sm px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-hover hover:text-ink" onClick={clearError}>
            ✕
          </button>
        </div>
      )}

      <ApprovalPrompt />
      <QuestionPrompt />

      {pendingToolCalls.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-hairline bg-surface-1 px-3 py-1.5 text-caption text-ink">
          <span
            className={`animate-pulse ${
              questionQueue.length > 0
                ? "text-accent"
                : approvalQueue.length > 0
                  ? "text-warning"
                  : "text-accent"
            }`}
          >
            ●
          </span>
          <span className="text-body-emphasis">
            {questionQueue.length > 0
              ? t("chat.waitingChoice")
              : approvalQueue.length > 0
                ? t("chat.waitingApproval")
                : t("chat.runningTool")}
          </span>
          {pendingToolCalls.map((call) => (
            <span key={call.toolCallId} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono">
              {summarizeToolCall(call.toolName, call.input)}
            </span>
          ))}
          <span
            className="ml-auto shrink-0 tabular-nums text-ink-muted"
            title={
              questionQueue.length > 0
                ? t("chat.waitingChoiceHint")
                : approvalQueue.length > 0
                  ? t("chat.waitingApprovalHint")
                  : t("chat.runningToolHint")
            }
          >
            {toolElapsed}초
          </span>
        </div>
      )}

      <div className="shrink-0 border-t border-hairline p-3">
        <div className="mb-2 space-y-1.5">
          <ContextRing status={context} size={44} variant="full" />

          <div className="flex flex-wrap items-center gap-3 text-caption text-ink-muted">
            <span title={t("chat.branchCostHint")}>
              {t("chat.branchCost")}{" "}
              <span className="text-ink">{formatCost(pathUsage.cost, pathUsage.modelId)}</span>
            </span>
            <span title={t("chat.sessionCostHint")}>
              {t("chat.sessionCost")}{" "}
              <span className="text-ink">
                {formatCost(sessionUsage.cost, sessionUsage.primaryModelId)}
              </span>
            </span>
            {sessionUsage.calls > 0 && (
              <span>{t("sessions.calls", { count: sessionUsage.calls })}</span>
            )}
            <button
              className="ml-auto rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
              title={t("chat.usageHint")}
              onClick={() => setUsageOpen(!usageOpen)}
            >
              {usageOpen ? t("chat.usageClose") : t("chat.usageOpen")}
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
          <span className="text-ink">{shownModelLabel}</span>
          <button
            className="rounded-full border border-hairline px-2 py-0.5 transition-colors hover:bg-hover"
            title={
              (() => {
                const mode = APPROVAL_MODES.find((item) => item.id === shellApproval);
                return mode ? t(mode.descriptionKey) : t("chat.approvalToggleHint");
              })()
            }
            onClick={() =>
              void updateSettings({ shellApproval: shellApproval === "auto" ? "ask" : "auto" })
            }
          >
            {t("chat.shell")}{" "}
            <span className={shellApproval === "auto" ? "text-warning" : "text-ink"}>
              {shellApproval === "auto"
                ? t("approval.mode.auto.label")
                : t("approval.mode.ask.label")}
            </span>
          </button>
          {target ? (
            <span
              title={`${t("chat.targetHint", { id: activeParentId ?? "" })}${
                target.midway ? ` ${t("chat.targetMidwayHint")}` : ""
              }`}
            >
              {t("chat.turn")} <code className="font-mono">{target.label}</code>{" "}
              {target.midway ? t("chat.targetMidway") : t("chat.targetAfter")}
            </span>
          ) : (
            <span title={t("chat.rootHint")}>{t("chat.root")}</span>
          )}

          {instructions && useProjectInstructions && (
            <button
              className="rounded-full border border-hairline px-2 py-0.5 font-mono text-accent transition-colors hover:bg-hover"
              title={t("chat.instructionsHint", {
                path: instructions.path,
                chars: instructions.content.length.toLocaleString(),
              })}
              onClick={() => {
                setContextMessageId(null);
                setContextOpen(true);
              }}
            >
              {instructions.path}
            </button>
          )}

          {/*
            글씨 크기. 단축키만 두면 아무도 못 찾는다 — 눈이 불편해서 이 기능이 필요한
            사람일수록 더 그렇다. 지금 배율을 늘 적어 두고, 그 숫자를 누르면 100% 로 돌아온다.
          */}
          <span className="ml-auto flex items-center gap-0.5" title={t("chat.zoomHint")}>
            <button
              className="rounded-sm px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled"
              title={t("chat.zoomOut")}
              aria-label={t("chat.zoomOut")}
              disabled={chatZoom === zoomOut(chatZoom)}
              onClick={() => applyZoom(zoomOut(chatZoom))}
            >
              −
            </button>
            <button
              className={`rounded-sm px-1 py-0.5 tabular-nums transition-colors hover:bg-hover ${
                isDefaultZoom(chatZoom) ? "text-ink-muted" : "text-accent"
              }`}
              title={t("chat.zoomReset")}
              onClick={() => applyZoom(1)}
            >
              {t("chat.zoomLevel", { percent: zoomPercent(chatZoom) })}
            </button>
            <button
              className="rounded-sm px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled"
              title={t("chat.zoomIn")}
              aria-label={t("chat.zoomIn")}
              disabled={chatZoom === zoomIn(chatZoom)}
              onClick={() => applyZoom(zoomIn(chatZoom))}
            >
              +
            </button>
          </span>

          <span className="flex gap-1">
            <button
              className="rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
              title={t("chat.contextHint")}
              onClick={() => {
                setContextMessageId(null);
                setContextOpen(true);
              }}
            >
              {t("chat.viewContext")}
            </button>
            <button
              className="rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
              title={t("chat.memoryHint")}
              onClick={() => setMemoryOpen(true)}
            >
              {t("chat.viewMemory")}
            </button>
          </span>
        </div>

        {/*
          붙인 이미지는 **보내기 전에 보여야 한다** — 클립보드에서 무엇이 왔는지는
          붙여넣은 사람도 모를 때가 있고(스크린샷 두 장), 잘못 붙인 것을 되돌릴 길도 필요하다.
        */}
        {(images.length > 0 || imageError) && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {images.map((image) => (
              <ImageThumb
                key={image.sha}
                image={image}
                projectPath={project?.rootPath}
                onRemove={() => setImages((current) => current.filter((it) => it.sha !== image.sha))}
              />
            ))}
            {images.some((image) => image.resized) && (
              <span className="text-caption text-ink-subtle">
                {t("image.resized", { edge: MAX_IMAGE_EDGE })}
              </span>
            )}
            {imageError && <span className="text-caption text-error">{imageError}</span>}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <MentionPicker state={mention} />
            <textarea
              ref={textareaRef}
              value={draft}
              onPaste={(event) => {
                // 클립보드의 이미지는 `files` 로 온다(스크린샷은 이름 없는 파일이다).
                // 이미지가 하나라도 있으면 텍스트 붙여넣기는 막는다 — 안 그러면
                // 파일 경로 같은 부산물이 입력칸에 함께 떨어진다.
                const files = Array.from(event.clipboardData.files).filter(isImageFile);
                if (files.length === 0) return;
                event.preventDefault();
                void addImages(files);
              }}
              onChange={(event) => {
                setDraft(event.target.value);
                mention.sync();
              }}
              onClick={mention.sync}
              onKeyUp={mention.sync}
              onKeyDown={(event) => {
                // 목록이 열려 있으면 방향키·엔터는 목록이 먼저 가져간다.
                if (mention.onKeyDown(event)) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                canSend
                  ? t("chat.inputPlaceholder")
                  : t("chat.waiting")
              }
              rows={3}
              disabled={!project}
              className="min-h-0 w-full resize-none rounded-md border border-field-rule bg-field px-3.5 py-2.5 text-body-sm text-ink transition-colors placeholder:text-ink-subtle hover:border-ink-subtle focus:border-accent disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-1 disabled:text-ink-disabled"
            />
          </div>
          {/*
            파일 선택은 `plugin-dialog` 이 아니라 웹뷰의 `input[type=file]` 이다 —
            대화상자는 **경로**를 주는데 바탕화면 스크린샷은 프로젝트 루트 밖이라
            `resolve_within()` 이 막는다. 여기로 받으면 바이트가 곧바로 오므로
            루트 담장에 구멍을 낼 이유가 없다(`lib/images.ts` 의 머리말 참고).
          */}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_MEDIA_TYPES.join(",")}
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // 같은 파일을 연달아 고를 수 있게 값을 비운다 (안 그러면 change 가 안 뜬다).
              event.target.value = "";
              void addImages(files);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canSend || attaching || !acceptsImages(modelId)}
            title={acceptsImages(modelId) ? t("image.attachHint") : t("image.noVision")}
            aria-label={t("image.attach")}
            className="mb-0.5 shrink-0 rounded-md border border-field-rule px-2.5 py-2 text-ink-muted transition-colors hover:border-ink-subtle hover:text-ink disabled:cursor-not-allowed disabled:border-hairline disabled:text-ink-disabled"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {running ? (
            <Button
              variant="danger"
              size="md"
              onClick={stop}
              className="w-24"
              title={
                stopping
                  ? t("chat.stoppingHint")
                  : t("chat.stopHint")
              }
            >
              {stopping ? t("chat.stopping") : t("chat.stop")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={() => void submit()}
              disabled={!canSend || attaching || (!draft.trim() && images.length === 0)}
              className="w-24"
            >
              {t("chat.send")}
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
