/**
 * 채팅 턴 실행 상태.
 *
 * 흐름:
 *   1. user 노드를 DB 에 저장
 *   2. 그 노드 기준 조상 체인을 읽어 LLM 컨텍스트를 구성
 *   3. assistant 노드를 `status: "streaming"` 으로 미리 만들고 contextSnapshot 을 박아둠
 *   4. 토큰은 스토어에만 흘리고, 끝난 뒤 한 번만 DB 에 최종 저장
 *
 * 토큰마다 DB 를 쓰면 디스크 I/O 가 폭발하므로 마지막에 한 번만 쓴다.
 * 도구를 쓰면 한 턴이 여러 스텝으로 늘어나는데, 그때도 DB 쓰기는
 * "스텝 경계"에서만 일어난다: assistant 확정 → tool 노드 생성 → 다음 assistant 노드.
 */
import { create } from "zustand";

import { resolveMentions, withAttachments } from "@/lib/ai/attachments";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { errorMessage } from "@/lib/ai/errors";
import { buildTurnContext, runTurn, type StepRecord, type StoredToolCall } from "@/lib/ai/runner";
import { appendSkillCatalog, buildSkillTools } from "@/lib/ai/skills";
import { buildTools, summarizeToolCall } from "@/lib/ai/tools";
import { toStoredUsage } from "@/lib/ai/usage";
import { dispatchHooks, type HookEvent } from "@/lib/hooks";
import { matchesAnyLocale, t } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { extractMentions } from "@/lib/mention";
import { useAgents } from "@/store/agents";
import { useApprovals } from "@/store/approvals";
import { useQuestions } from "@/store/questions";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useSkills } from "@/store/skills";
import { useWorkspace } from "@/store/workspace";

interface ChatState {
  running: boolean;
  /** [중단]을 누른 뒤 턴이 실제로 풀릴 때까지 */
  stopping: boolean;
  /** 지금 스트리밍 중인 assistant 노드 id */
  streamingMessageId: string | null;
  streamingText: string;
  streamingReasoning: string;
  /** 결과를 기다리는 도구 호출 (실행 중 표시용) */
  pendingToolCalls: StoredToolCall[];
  error: string | null;

  send: (input: string) => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

let controller: AbortController | null = null;

/** 세션 제목이 기본값이면 첫 사용자 메시지로 갈아 끼운다. */
async function autoTitleSession(sessionId: string, firstMessage: string) {
  const workspace = useWorkspace.getState();
  const session = workspace.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  // 어느 언어의 기본 제목이든(그리고 옛 영문 기본값도) 아직 이름이 없는 것으로 본다.
  if (!matchesAnyLocale("session.untitled", session.title) && session.title !== "New Session")
    return;

  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 40);
  if (title) await workspace.renameSession(sessionId, title);
}

/**
 * 훅을 쏜다. 기다리지 않고, 실패해도 삼킨다 — 훅 때문에 턴이 흔들리면 안 된다.
 * (판정과 실행은 `lib/hooks.ts`)
 */
function fireHooks(event: HookEvent, status: string, startedAt: number, error?: string) {
  const settings = useSettings.getState();
  void dispatchHooks(
    {
      event,
      status,
      sessionId: useWorkspace.getState().activeSessionId ?? "",
      projectPath: useWorkspace.getState().project?.rootPath ?? "",
      durationMs: Date.now() - startedAt,
      error,
    },
    { builtinToggles: settings.builtinHooks, hooks: settings.hooks },
  ).catch(() => undefined);
}

/** tool 노드의 본문 — 트리 카드에서 한눈에 보이는 요약. */
function summarizeStep(step: StepRecord): string {
  return step.toolCalls
    .map((call) => {
      const result = step.toolResults.find((item) => item.toolCallId === call.toolCallId);
      const status = !result
        ? "…"
        : result.errorText != null
          ? t("chat.status.failed")
          : t("chat.status.done");
      return `${summarizeToolCall(call.toolName, call.input)} → ${status}`;
    })
    .join("\n");
}

export const useChat = create<ChatState>((set, get) => ({
  running: false,
  stopping: false,
  streamingMessageId: null,
  streamingText: "",
  streamingReasoning: "",
  pendingToolCalls: [],
  error: null,

  send: async (input) => {
    const text = input.trim();
    if (!text || get().running) return;

    const workspace = useWorkspace.getState();
    const settings = useSettings.getState();

    if (!workspace.project) {
      set({ error: t("chat.error.noProject") });
      return;
    }
    const sessionId = workspace.activeSessionId;
    if (!sessionId) {
      set({ error: t("chat.error.noSession") });
      return;
    }

    set({
      running: true,
      stopping: false,
      error: null,
      streamingText: "",
      streamingReasoning: "",
      pendingToolCalls: [],
    });
    controller = new AbortController();

    const startedAt = Date.now();
    // 오류로 끝난 턴에 "완료" 알림을 띄우지 않으려고 결말을 들고 다닌다.
    let outcome: { event: HookEvent; status: string; error?: string } = {
      event: "turnComplete",
      status: "complete",
    };
    fireHooks("turnStart", "running", startedAt);

    // 스텝이 진행되면서 "지금 쓰고 있는 assistant 노드"가 계속 바뀐다.
    let assistantId: string | null = null;

    try {
      // 1. `@` 로 지목한 파일을 지금 읽어 메시지에 함께 싣는다.
      //    도구 한 번을 아끼려는 게 아니라, 사용자가 이미 정해 준 것을 모델이 다시
      //    찾아 헤매지 않게 하려는 것이다. 실패한 참조도 사실대로 실린다.
      const mentions = extractMentions(text);
      const attachments = mentions.length
        ? await resolveMentions(mentions, { projectPath: workspace.project.rootPath })
        : [];

      // 사용자 노드 저장 (activeParentId 아래에 붙으므로 분기가 자연스럽게 생긴다)
      const userMessage = await workspace.addMessage({
        role: "user",
        content: withAttachments(text, attachments),
      });
      if (!userMessage) throw new Error(t("chat.error.userNodeFailed"));

      // 2. 루트 → 이 노드까지의 체인이 곧 LLM 컨텍스트
      const chain = await ipc.getMessagePath(userMessage.id);

      // 프로젝트 지침(AGENTS.md)은 매 턴 다시 읽는다 — 대화 중에 바뀔 수 있다.
      const instructions = settings.useProjectInstructions
        ? await workspace.loadInstructions()
        : null;

      // 스킬 문서도 같은 이유로 매 턴 다시 읽는다(에이전트가 직접 쓰기도 한다).
      // 실리는 것은 이름과 설명뿐이고, 본문은 모델이 `load_skill` 을 부를 때 들어간다.
      await useSkills.getState().refresh();
      const skills = useSkills.getState().enabled();
      const tools = {
        ...buildTools({
          enabled: settings.tools,
          sessionId,
          // 셸은 실행 직전에 사용자에게 묻는다(설정이 "자동 실행" 이면 게이트가 그냥 통과시킨다).
          requestApproval: (ask) => useApprovals.getState().request(ask),
          // 판단이 갈리는 자리에서는 모델이 넘겨짚지 않고 사람에게 목록으로 묻는다.
          requestChoice: (input) => useQuestions.getState().request(input),
          // 위임은 서브에이전트 스토어가 실행한다. 결과 요약만 도구 결과로 돌아온다.
          onDelegate: ({ name, task, signal }) =>
            useAgents.getState().spawn({ name, task, signal, parentMessageId: assistantId }),
        }),
        // 연결된 MCP 서버의 도구도 같은 ToolSet 에 합친다.
        ...(settings.tools.mcp ? useMcp.getState().tools() : {}),
        // 스킬이 하나라도 있으면 본문을 끌어올 통로(`load_skill`)를 함께 연다.
        ...buildSkillTools(skills),
      };
      const context = buildTurnContext({
        modelId: settings.modelId,
        system: composeSystemPrompt(
          appendSkillCatalog(settings.systemPrompt, skills),
          instructions,
          // 모델은 학습 시점을 "지금" 으로 착각한다 → 턴마다 실제 시각을 실어 준다.
          settings.injectDateTime ? new Date() : null,
        ),
        chain,
        effort: settings.effort,
        maxSteps: settings.maxSteps,
        toolNames: Object.keys(tools),
      });

      // 3. assistant 노드를 미리 만들어 컨텍스트 스냅샷을 남긴다
      const assistant = await workspace.addMessage({
        role: "assistant",
        content: "",
        status: "streaming",
        parentId: userMessage.id,
        contextSnapshot: context,
      });
      if (!assistant) throw new Error(t("chat.error.assistantNodeFailed"));
      assistantId = assistant.id;
      set({ streamingMessageId: assistant.id });

      void autoTitleSession(sessionId, text);

      // 4. 스트리밍
      const result = await runTurn({
        context,
        credentials: settings.credentials(),
        tools,
        abortSignal: controller.signal,
        onTextDelta: (delta) => set({ streamingText: get().streamingText + delta }),
        onReasoningDelta: (delta) =>
          set({ streamingReasoning: get().streamingReasoning + delta }),
        onToolCall: (call) => set({ pendingToolCalls: [...get().pendingToolCalls, call] }),
        onStepFinish: async (step) => {
          // 도구를 안 쓴 스텝이면 마지막 스텝이다 — 저장은 아래 5번에서 한 번에.
          if (step.toolCalls.length === 0 || !assistantId) return;

          // (a) 지금까지의 assistant 노드를 도구 호출과 함께 확정.
          //     이 스텝이 쓴 토큰은 이 노드에만 적는다 — 노드 하나가 LLM 호출 하나다.
          const savedAssistant = await ipc.updateMessage(assistantId, {
            content: step.text,
            status: "complete",
            toolCalls: step.toolCalls,
            tokenUsage: toStoredUsage(context.modelId, step.usage) ?? undefined,
            ...(step.reasoning ? { toolResults: { reasoning: step.reasoning } } : {}),
          });
          useWorkspace.getState().replaceMessage(savedAssistant);

          // (b) 실행 결과를 tool 노드로 트리에 남긴다
          const toolNode = await useWorkspace.getState().addMessage({
            role: "tool",
            parentId: assistantId,
            content: summarizeStep(step),
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
          });
          if (!toolNode) throw new Error(t("chat.error.toolNodeFailed"));

          // (c) 다음 스텝을 받을 assistant 노드. 메시지 본문은 조상 체인으로
          //     그대로 복원되므로 여기서는 설정값만 스냅샷으로 남긴다.
          const next = await useWorkspace.getState().addMessage({
            role: "assistant",
            content: "",
            status: "streaming",
            parentId: toolNode.id,
            contextSnapshot: {
              modelId: context.modelId,
              system: context.system,
              effort: context.effort,
              maxSteps: context.maxSteps,
              toolNames: context.toolNames,
              stepIndex: step.index + 1,
              derivedFrom: assistantId,
              createdAt: new Date().toISOString(),
            },
          });
          if (!next) throw new Error(t("chat.error.nextNodeFailed"));

          assistantId = next.id;
          set({
            streamingMessageId: next.id,
            streamingText: "",
            streamingReasoning: "",
            pendingToolCalls: [],
          });
        },
      });

      // 5. 최종 저장 — 마지막 스텝의 텍스트를 남긴다
      if (assistantId && !result.text.trim() && !result.reasoning.trim()) {
        // 도구 스텝 직후에 턴이 끝난 경우(최대 스텝 도달 등). 빈 노드를 트리에 남기지 않는다.
        await useWorkspace.getState().removeMessage(assistantId);
      } else if (assistantId) {
        const saved = await ipc.updateMessage(assistantId, {
          content: result.text,
          status: result.aborted ? "aborted" : "complete",
          // 마지막 **스텝 하나**의 사용량이다(턴 누적이 아니다). 앞 스텝의 몫은
          // 이미 자기 노드에 적혀 있고, 턴 합계는 노드를 더해서 만든다.
          // 어떤 모델로 부른 호출인지 함께 남긴다 — 나중에 모델을 바꿔도
          // 이 턴의 요금 추정이 흔들리지 않는다.
          tokenUsage: toStoredUsage(context.modelId, result.lastStepUsage) ?? undefined,
          ...(result.reasoning ? { toolResults: { reasoning: result.reasoning } } : {}),
        });
        useWorkspace.getState().replaceMessage(saved);
      }

      if (result.aborted) outcome = { event: "turnComplete", status: "aborted" };

      // 도구를 더 부르려는데 스텝 예산이 떨어진 상태 — 조용히 끝내면 사용자가 오해한다.
      if (result.finishReason === "tool-calls" && !result.aborted) {
        set({
          error: t("chat.error.maxSteps", { maxSteps: context.maxSteps }),
        });
      }
    } catch (error) {
      // 중단으로 끊긴 것은 실패가 아니다 — 에러 배너 대신 "중단됨" 으로 남긴다.
      const aborted = controller?.signal.aborted ?? false;
      const messageText = errorMessage(error);

      outcome = aborted
        ? { event: "turnComplete", status: "aborted" }
        : { event: "turnError", status: "error", error: messageText };
      if (!aborted) set({ error: messageText });

      // 빈 껍데기 노드가 트리에 남지 않도록 상태를 기록해 둔다.
      if (assistantId) {
        try {
          const saved = await ipc.updateMessage(assistantId, {
            content: get().streamingText,
            status: aborted ? "aborted" : "error",
            ...(aborted ? {} : { toolResults: { error: messageText } }),
          });
          useWorkspace.getState().replaceMessage(saved);
        } catch {
          // 저장까지 실패하면 화면의 에러 배너로 충분하다.
        }
      }
    } finally {
      controller = null;
      // 턴이 끝났는데 카드가 남아 있으면 누를 곳 없는 버튼이 된다.
      useApprovals.getState().clear();
      useQuestions.getState().clear();
      set({
        running: false,
        stopping: false,
        streamingMessageId: null,
        streamingText: "",
        streamingReasoning: "",
        pendingToolCalls: [],
      });
      fireHooks(outcome.event, outcome.status, startedAt, outcome.error);
    }
  },

  stop: () => {
    if (!get().running) return;
    // 도구가 실행 중이면 그 도구가 거절될 때까지 한 박자가 걸린다. 버튼 상태로 알려 준다.
    set({ stopping: true });
    controller?.abort();
  },

  clearError: () => set({ error: null }),
}));
