/**
 * LLM 한 턴 실행. Vercel AI SDK Core 의 `streamText` 를 직접 호출한다.
 *
 * 여기서는 DB 를 건드리지 않는다 — 저장은 `store/chat.ts` 가 맡는다.
 * 도구가 붙으면 한 턴이 여러 스텝(= LLM 호출)으로 늘어나므로,
 * 스텝이 끝날 때마다 `onStepFinish` 로 알려 주고 트리에 노드를 남기게 한다.
 */
import { streamText, stepCountIs } from "ai";
import type { ModelMessage, ToolResultPart, ToolSet } from "@ai-sdk/provider-utils";

import { abortableTools } from "@/lib/ai/abort";
import {
  providerOptionsFor,
  resolveModel,
  type Effort,
  type ProviderCredentials,
} from "@/lib/ai/providers";
import { lastCallNode, readUsage, type ContextPayload, type Usage } from "@/lib/ai/usage";
import { pathTo } from "@/lib/tree";
import type { Message } from "@/types/ipc";

/** LLM 으로 실제 전송되는 페이로드. Context Inspector 가 그대로 렌더링한다. */
export interface TurnContext {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  effort: Effort;
  maxSteps: number;
  /** 이 턴에 노출된 도구 이름들 */
  toolNames: string[];
  createdAt: string;
}

/** 대화 트리 노드에 저장되는 도구 호출 기록. assistant 노드의 `toolCalls`. */
export interface StoredToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** tool 노드의 `toolResults`. 실행이 실패했으면 `errorText` 가 채워진다. */
export interface StoredToolResult {
  toolCallId: string;
  toolName: string;
  output?: unknown;
  errorText?: string;
}

/** 스텝 하나(LLM 호출 한 번)의 결과. */
export interface StepRecord {
  index: number;
  text: string;
  reasoning: string;
  toolCalls: StoredToolCall[];
  toolResults: StoredToolResult[];
  /**
   * **이 호출 하나**가 쓴 토큰. 턴 누적이 아니다.
   * 대화는 매 스텝 전체가 다시 올라가므로 스텝을 더하면 앞부분이 몇 번이고 겹쳐 세어진다
   * — 요금은 그게 맞지만(스텝마다 실제로 청구된다) 컨텍스트 잔량은 아니다.
   * 그래서 스텝의 값은 그 스텝의 노드에만 남기고, 합계는 노드를 더해서 만든다.
   */
  usage: Usage | null;
}

export interface RunTurnOptions {
  context: TurnContext;
  credentials: ProviderCredentials;
  tools?: ToolSet;
  abortSignal?: AbortSignal;
  onTextDelta: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  /** 도구 호출이 확정된 순간 (실행 결과는 아직 없음) */
  onToolCall?: (call: StoredToolCall) => void;
  /** 스텝 종료. 도구를 썼다면 여기서 tool 노드를 만든다. */
  onStepFinish?: (step: StepRecord) => void | Promise<void>;
}

export interface RunTurnResult {
  /** 마지막 스텝의 텍스트 (= 최종 assistant 노드에 남을 내용) */
  text: string;
  reasoning: string;
  /**
   * 턴 전체(모든 스텝)의 합계. 공급자별 모양 차이는 여기서 이미 접혀 있다.
   * 노드를 남기지 않는 실행(서브에이전트)만 이 값을 저장한다 — 대화 트리는
   * 스텝마다 자기 노드에 자기 사용량을 남기므로 이걸 또 쓰면 이중으로 세어진다.
   */
  usage: Usage | null;
  /**
   * 마지막 스텝 하나의 사용량 = 최종 assistant 노드에 남길 값이자 컨텍스트 잔량의 기준.
   * 도구 스텝의 몫은 `onStepFinish` 가 이미 그 노드에 남겼으므로 여기서는 빠진다.
   */
  lastStepUsage: Usage | null;
  finishReason: string | null;
  aborted: boolean;
  steps: number;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 노드에 저장된 tool_calls JSON 을 복원한다. (assistant 노드는 없을 수도 있다) */
export function readToolCalls(value: unknown): StoredToolCall[] {
  return asArray(value).filter(
    (item): item is StoredToolCall =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as StoredToolCall).toolCallId === "string" &&
      typeof (item as StoredToolCall).toolName === "string",
  );
}

/**
 * 노드에 저장된 tool_results JSON 을 복원한다.
 * assistant 노드는 이 자리에 `{ reasoning }` 같은 객체를 쓰므로 배열이 아니면 무시한다.
 */
export function readToolResults(value: unknown): StoredToolResult[] {
  return asArray(value).filter(
    (item): item is StoredToolResult =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as StoredToolResult).toolCallId === "string" &&
      typeof (item as StoredToolResult).toolName === "string",
  );
}

/**
 * DB 의 대화 노드 체인을 LLM 이 받는 메시지 배열로 변환한다.
 *
 * assistant 노드의 도구 호출은 `tool-call` 파트로, tool 노드는 `role:"tool"` 메시지로
 * 복원한다. 짝이 맞지 않는 호출/결과(예: 도구 노드 직전에서 분기한 경우)는
 * 공급자가 거부하므로 여기서 걸러낸다.
 */
export function toModelMessages(chain: Message[]): ModelMessage[] {
  const calls = new Map<string, StoredToolCall>();
  const resolved = new Set<string>();

  for (const node of chain) {
    if (node.role === "assistant") {
      for (const call of readToolCalls(node.toolCalls)) calls.set(call.toolCallId, call);
    } else if (node.role === "tool") {
      for (const result of readToolResults(node.toolResults)) resolved.add(result.toolCallId);
    }
  }

  const out: ModelMessage[] = [];

  for (const node of chain) {
    // 시스템 프롬프트는 별도 인자로 넘기므로 체인에서는 건너뛴다.
    if (node.role === "system") continue;
    // 아직 스트리밍 중이거나 실패한 노드는 컨텍스트에 넣지 않는다.
    if (node.status === "streaming" || node.status === "error") continue;

    if (node.role === "user") {
      if (node.content.trim()) out.push({ role: "user", content: node.content });
      continue;
    }

    if (node.role === "assistant") {
      // 결과 노드가 없는 호출은 그대로 보내면 공급자가 에러를 낸다.
      const calls = readToolCalls(node.toolCalls).filter((call) =>
        resolved.has(call.toolCallId),
      );

      // 도구를 안 쓴 평범한 응답은 문자열 하나로 두는 편이 가볍다.
      if (calls.length === 0) {
        if (node.content.trim()) out.push({ role: "assistant", content: node.content });
        continue;
      }

      const parts: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
      if (node.content.trim()) parts.push({ type: "text", text: node.content });
      for (const call of calls) {
        parts.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        });
      }
      out.push({ role: "assistant", content: parts });
      continue;
    }

    // role === "tool"
    const results = readToolResults(node.toolResults).filter((result) =>
      calls.has(result.toolCallId),
    );
    if (results.length === 0) continue;

    out.push({
      role: "tool",
      content: results.map((result): ToolResultPart => {
        const output =
          result.errorText != null
            ? { type: "error-text" as const, value: result.errorText }
            : { type: "json" as const, value: result.output ?? null };
        return {
          type: "tool-result",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          // 저장된 값은 JSON 으로 왕복한 것이라 구조적으로 JSON 이 보장된다.
          output: output as ToolResultPart["output"],
        };
      }),
    });
  }

  return out;
}

/**
 * 이 페이로드가 몇 **자**인지.
 *
 * 들여쓰기 없는 원문 기준이다 — 인스펙터가 화면에 뿌리는 `JSON.stringify(…, null, 2)` 를
 * 재면 실제보다 30% 가까이 부푼다. 컨텍스트 게이지와 인스펙터가 **같은 수**를 말해야
 * 하므로 세는 곳을 여기 하나로 둔다. `system` 은 한 번만 센다(따로 더하면 두 번 세어진다).
 */
export function payloadChars(context: Pick<TurnContext, "system" | "messages">): number {
  return JSON.stringify({ system: context.system, messages: context.messages }).length;
}

/**
 * 컨텍스트 게이지가 쓸 페이로드 크기 — "지금 나갈 것" 과 "마지막 호출이 받았던 것".
 *
 * 채팅창 위 게이지와 인스펙터가 **같은 수**를 말해야 하므로 만드는 곳을 여기 하나로 둔다.
 * 기준점 호출의 페이로드는 그 노드의 부모까지의 체인으로 되만든다(인스펙터가 도구 스텝
 * 노드를 복원할 때와 같은 방식이다). system 은 그 노드의 스냅샷에 적힌 것을 그대로 쓴다 —
 * 그 사이 AGENTS.md 가 커졌다면 그 증가분도 환산 대상이어야 한다.
 */
export function contextPayloadOf(
  chain: Message[],
  allMessages: Message[],
  system: string,
): ContextPayload {
  const next = { system, messages: toModelMessages(chain) };
  const anchorNode = lastCallNode(chain);
  const anchor = anchorNode
    ? {
        system: (anchorNode.contextSnapshot as Partial<TurnContext> | null)?.system ?? system,
        messages: toModelMessages(pathTo(allMessages, anchorNode.parentId)),
      }
    : null;

  return {
    chars: payloadChars(next),
    messageCount: next.messages.length,
    measuredChars: anchor ? payloadChars(anchor) : null,
  };
}

export function buildTurnContext(options: {
  modelId: string;
  system: string;
  chain: Message[];
  effort: Effort;
  maxSteps: number;
  toolNames?: string[];
}): TurnContext {
  return {
    modelId: options.modelId,
    system: options.system,
    messages: toModelMessages(options.chain),
    effort: options.effort,
    maxSteps: options.maxSteps,
    toolNames: options.toolNames ?? [],
    createdAt: new Date().toISOString(),
  };
}

export async function runTurn({
  context,
  credentials,
  tools,
  abortSignal,
  onTextDelta,
  onReasoningDelta,
  onToolCall,
  onStepFinish,
}: RunTurnOptions): Promise<RunTurnResult> {
  const model = resolveModel(context.modelId, credentials);

  const result = streamText({
    model,
    system: context.system,
    messages: context.messages,
    // 도구에 중단을 붙여서 넘긴다 — 안 그러면 도구가 도는 동안 [중단]이 먹지 않는다.
    ...(tools && Object.keys(tools).length > 0 ? { tools: abortableTools(tools) } : {}),
    stopWhen: stepCountIs(context.maxSteps),
    providerOptions: providerOptionsFor(context.modelId, context.effort),
    abortSignal,
  });

  // 텍스트/사고 과정은 스텝 단위로 모은다. 트리에서도 스텝이 곧 노드다.
  let stepText = "";
  let stepReasoning = "";
  let stepCalls: StoredToolCall[] = [];
  let stepResults: StoredToolResult[] = [];
  let stepUsage: Usage | null = null;
  let steps = 0;

  let usage: Usage | null = null;
  let finishReason: string | null = null;
  let aborted = false;
  let streamError: unknown = null;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        stepText = "";
        stepReasoning = "";
        stepCalls = [];
        stepResults = [];
        stepUsage = null;
        break;
      case "text-delta":
        stepText += part.text;
        onTextDelta(part.text);
        break;
      case "reasoning-delta":
        stepReasoning += part.text;
        onReasoningDelta?.(part.text);
        break;
      case "tool-call": {
        const call: StoredToolCall = {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
        stepCalls.push(call);
        onToolCall?.(call);
        break;
      }
      case "tool-result":
        stepResults.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
        });
        break;
      case "tool-error":
        stepResults.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          errorText: part.error instanceof Error ? part.error.message : String(part.error),
        });
        break;
      case "finish-step":
        // 공급자·SDK 버전마다 모양이 다르므로 들어오는 자리에서 한 번만 접는다.
        stepUsage = readUsage(part.usage);
        // 도구를 쓴 스텝이면 여기서 노드가 갈라진다. DB 쓰기는 이 경계에서만 일어난다.
        await onStepFinish?.({
          index: steps,
          text: stepText,
          reasoning: stepReasoning,
          toolCalls: stepCalls,
          toolResults: stepResults,
          usage: stepUsage,
        });
        steps += 1;
        // 도구 스텝의 텍스트·사용량은 콜백이 이미 저장했다. 여기서 비워 두지 않으면
        // 턴이 곧바로 끝났을 때(최대 스텝 도달) 다음 노드에 같은 내용이 또 들어간다.
        if (stepCalls.length > 0) {
          stepText = "";
          stepReasoning = "";
          stepUsage = null;
        }
        break;
      case "finish":
        finishReason = part.finishReason;
        usage = readUsage(part.totalUsage);
        break;
      case "abort":
        aborted = true;
        break;
      case "error":
        // 스트림 안의 에러는 던지지 않고 모아뒀다가 루프 종료 후 처리한다.
        // (그래야 여기까지 받은 텍스트를 잃지 않는다)
        streamError = part.error;
        break;
      default:
        break;
    }
  }

  // 중단은 공급자마다 다른 모습으로 온다(끊긴 fetch, 도구 거절, abort 파트).
  // 시그널이 내려간 상태면 무조건 "중단"으로 취급해 에러 배너 대신 중단 표시를 남긴다.
  if (abortSignal?.aborted) aborted = true;

  if (streamError && !aborted) {
    throw streamError instanceof Error ? streamError : new Error(String(streamError));
  }

  // 마지막 스텝의 내용이 곧 최종 assistant 노드의 내용이다.
  return {
    text: stepText,
    reasoning: stepReasoning,
    usage,
    // 콜백이 가져간 스텝은 위에서 비워졌다 — 남아 있으면 그게 마지막 스텝의 몫이다.
    lastStepUsage: stepUsage,
    finishReason,
    aborted,
    steps,
  };
}
