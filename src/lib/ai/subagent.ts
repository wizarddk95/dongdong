/**
 * 서브에이전트 한 명의 실행.
 *
 * 메인 에이전트가 `delegate_task` 를 부르면 여기서 별도의 대화(컨텍스트가 격리된)
 * 를 하나 돌린다. 대화 트리에는 노드를 남기지 않는다 — 서브에이전트의 진행 상황은
 * `agent_runs` 와 대시보드로 보여주고, 메인에게는 최종 요약만 돌려준다.
 */
import type { ToolSet } from "@ai-sdk/provider-utils";

import type { Effort, ProviderCredentials } from "@/lib/ai/providers";
import { runTurn, type TokenUsage, type TurnContext } from "@/lib/ai/runner";

export const SUBAGENT_SYSTEM_PROMPT = `당신은 코딩 에이전트의 서브에이전트입니다. 하나의 작업만 끝까지 처리합니다.
- 도구로 직접 확인하세요. 파일을 읽지 않고 내용을 추측하지 않습니다.
- 사용자와 대화할 수 없습니다. 되물을 수 없으니 주어진 지시 안에서 판단합니다.
- 끝나면 마지막 답변에 결과를 요약합니다: 무엇을 했고, 무엇을 찾았고, 무엇이 남았는지.
- 요약은 상위 에이전트가 그대로 읽습니다. 사실만 간결하게 적습니다.`;

export interface SubagentProgress {
  /** 0.0 ~ 1.0 — 스텝 예산 대비 진행률이지 작업 완성도가 아니다 */
  progress: number;
  /** 방금 실행한 Skill */
  currentSkill: string | null;
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
  usage: TokenUsage | null;
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
    ? `${SUBAGENT_SYSTEM_PROMPT}\n\n${options.extraInstructions}`
    : SUBAGENT_SYSTEM_PROMPT;

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
  let currentSkill: string | null = null;

  const result = await runTurn({
    context,
    credentials: options.credentials,
    tools: options.tools,
    abortSignal: options.abortSignal,
    // 서브에이전트의 토큰은 UI 로 흘리지 않는다. 대시보드는 진행 상황만 본다.
    onTextDelta: () => {},
    onToolCall: (call) => {
      toolCalls += 1;
      currentSkill = call.toolName;
      options.onProgress?.({
        progress: stepProgress(toolCalls, options.maxSteps),
        currentSkill,
        steps: toolCalls,
      });
    },
    onStepFinish: (step) => {
      options.onProgress?.({
        progress: stepProgress(step.index + 1, options.maxSteps),
        currentSkill: step.toolCalls.at(-1)?.toolName ?? currentSkill,
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
