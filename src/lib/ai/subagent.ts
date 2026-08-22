/**
 * 서브에이전트 한 명의 실행.
 *
 * 메인 에이전트가 `delegate_task` 를 부르면 여기서 별도의 대화(컨텍스트가 격리된)
 * 를 하나 돌린다. 대화 트리에는 노드를 남기지 않는다 — 서브에이전트의 진행 상황은
 * `agent_runs` 와 대시보드로 보여주고, 메인에게는 최종 요약만 돌려준다.
 */
import type { ToolSet } from "@ai-sdk/provider-utils";

import type { Effort, ProviderCredentials } from "@/lib/ai/providers";
import { runTurn, type TurnContext } from "@/lib/ai/runner";
import type { Usage } from "@/lib/ai/usage";
import { t } from "@/lib/i18n";

/**
 * 서브에이전트의 시스템 프롬프트. 화면 언어를 따라간다 —
 * 요약이 상위 에이전트를 거쳐 사용자에게 그대로 보이기 때문이다.
 */
export function subagentSystemPrompt(): string {
  return t("prompt.subagent");
}

export interface SubagentProgress {
  /** 0.0 ~ 1.0 — 스텝 예산 대비 진행률이지 작업 완성도가 아니다 */
  progress: number;
  /** 방금 실행한 도구 이름 */
  currentTool: string | null;
  steps: number;
}

export interface RunSubagentOptions {
  task: string;
  modelId: string;
  credentials: ProviderCredentials;
  tools: ToolSet;
  effort: Effort;
  maxSteps: number;
  /** 기본 프롬프트에 덧붙일 프로젝트별 안내 */
  extraInstructions?: string;
  abortSignal?: AbortSignal;
  onProgress?: (progress: SubagentProgress) => void;
}

export interface SubagentResult {
  text: string;
  steps: number;
  toolCalls: number;
  usage: Usage | null;
  finishReason: string | null;
  aborted: boolean;
}

/** 스텝 예산을 다 쓰기 전에는 100% 로 보이지 않게 한다 (아직 안 끝났으므로). */
function stepProgress(steps: number, maxSteps: number): number {
  if (maxSteps <= 0) return 0;
  return Math.min(steps / maxSteps, 0.95);
}

export function buildSubagentContext(options: RunSubagentOptions): TurnContext {
  const system = options.extraInstructions
    ? `${subagentSystemPrompt()}\n\n${options.extraInstructions}`
    : subagentSystemPrompt();

  return {
    modelId: options.modelId,
    system,
    messages: [{ role: "user", content: options.task }],
    effort: options.effort,
    maxSteps: options.maxSteps,
    toolNames: Object.keys(options.tools),
    createdAt: new Date().toISOString(),
  };
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
  const context = buildSubagentContext(options);
  let toolCalls = 0;
  let currentTool: string | null = null;

  const result = await runTurn({
    context,
    credentials: options.credentials,
    tools: options.tools,
    abortSignal: options.abortSignal,
    // 서브에이전트의 토큰은 UI 로 흘리지 않는다. 대시보드는 진행 상황만 본다.
    onTextDelta: () => {},
    onToolCall: (call) => {
      toolCalls += 1;
      currentTool = call.toolName;
      options.onProgress?.({
        progress: stepProgress(toolCalls, options.maxSteps),
        currentTool,
        steps: toolCalls,
      });
    },
    onStepFinish: (step) => {
      options.onProgress?.({
        progress: stepProgress(step.index + 1, options.maxSteps),
        currentTool: step.toolCalls.at(-1)?.toolName ?? currentTool,
        steps: step.index + 1,
      });
    },
  });

  return {
    text: result.text,
    steps: result.steps,
    toolCalls,
    usage: result.usage,
    finishReason: result.finishReason,
    aborted: result.aborted,
  };
}
