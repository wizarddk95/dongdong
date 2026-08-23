/**
 * 토큰 사용량 · 비용 추정 · 컨텍스트 잔량.
 *
 * usage 모양은 공급자마다 다르고 AI SDK 버전에 따라서도 바뀐다(v5 는 평평한 필드,
 * v7 은 `inputTokenDetails` 로 한 겹 들어갔다) → 받는 즉시 `Usage` 하나로 접어서
 * 저장하고, 화면·집계는 이 모양만 본다.
 *
 * **비용은 저장하지 않고 언제나 요율표(`providers.ts`)로 다시 계산한다.**
 * 저장해 두면 노드별 합과 세션 집계(SQL 은 토큰만 더한다)가 서로 어긋난다.
 * 대신 usage 안에 그때 쓴 `modelId` 를 박아 둔다 — 나중에 모델을 바꿔도
 * 옛 턴의 요율이 흔들리지 않게.
 *
 * 어디까지나 **추정치**다. 공급자 청구서가 아니다.
 */
import {
  effectivePricing,
  findModelOption,
  parseModelId,
  type PricingQuery,
} from "@/lib/ai/providers";
import { getLocale, t } from "@/lib/i18n";
import type { Message, SessionModelUsage, SessionOverview } from "@/types/ipc";

/** LLM 호출 한 번(또는 여러 번의 합)이 쓴 토큰. */
export interface Usage {
  /** 캐시 읽기·쓰기를 **포함한** 전체 입력 토큰 */
  inputTokens: number;
  /** 캐시에서 읽어 온 입력 (싸다) */
  cacheReadTokens: number;
  /** 캐시에 새로 적은 입력 (비싸다) */
  cacheWriteTokens: number;
  outputTokens: number;
  /** 출력 중 사고 토큰. `outputTokens` 에 이미 포함돼 있다 */
  reasoningTokens: number;
  totalTokens: number;
}

/** DB 의 `token_usage` 컬럼에 실제로 들어가는 모양. */
export interface StoredUsage extends Usage {
  /** 이 호출에 쓴 모델 (`provider:modelId`) */
  modelId: string;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * 아무 모양의 usage JSON 을 `Usage` 로 접는다. 숫자가 하나도 없으면 null.
 *
 * 받아들이는 모양:
 *   - AI SDK v7: `{ inputTokens, inputTokenDetails: { cacheReadTokens, … }, … }`
 *   - 여기서 저장한 평평한 모양 (`StoredUsage`)
 *   - 옛 기록: `cachedInputTokens` / `reasoningTokens` 가 최상위에 있던 시절
 */
export function readUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Record<string, unknown>;
  const input = record(raw.inputTokenDetails);
  const output = record(raw.outputTokenDetails);

  const inputTokens = num(raw.inputTokens);
  const outputTokens = num(raw.outputTokens);
  const totalTokens = num(raw.totalTokens);
  const cacheReadTokens =
    num(input.cacheReadTokens) ?? num(raw.cacheReadTokens) ?? num(raw.cachedInputTokens);
  const cacheWriteTokens = num(input.cacheWriteTokens) ?? num(raw.cacheWriteTokens);
  const reasoningTokens = num(output.reasoningTokens) ?? num(raw.reasoningTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

/** DB 에 넣을 모양으로 만든다. usage 가 없으면 컬럼을 비워 둔다. */
export function toStoredUsage(modelId: string, usage: Usage | null): StoredUsage | null {
  return usage ? { ...usage, modelId } : null;
}

/**
 * 캐시를 타지 않아 **정가로 청구되는** 입력 토큰.
 * `inputTokens` 가 캐시분을 포함하므로 빼서 구한다(따로 저장하지 않는다 — 합산 시 어긋난다).
 */
export function uncachedInputTokens(usage: Usage): number {
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export function sumUsage(items: Usage[]): Usage {
  return items.reduce(addUsage, EMPTY_USAGE);
}

export function hasTokens(usage: Usage | null): usage is Usage {
  return usage != null && (usage.inputTokens > 0 || usage.outputTokens > 0);
}

// ------------------------------------------------------------------ 비용

/** 항목별 추정 비용 (USD). */
export interface Cost {
  /** 캐시를 타지 않은 입력 */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  /** 요율을 모르는 항목이 섞여 있다 — 총액이 실제보다 **적다** */
  underestimated: boolean;
  /** 요율표에 아예 없는 모델(로컬 모델 등). 금액을 말할 수 없다 */
  unpriced: boolean;
  /** 롱컨텍스트 요율 구간에 들어간 호출이었다 */
  longContext: boolean;
}

const ZERO_COST: Cost = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  total: 0,
  underestimated: false,
  unpriced: false,
  longContext: false,
};

/** 1M 토큰당 요율을 실제 토큰 수에 적용한다. `null` 은 "과금 항목 없음" 이라 0 원. */
function charge(tokens: number, pricePerMillion: number | null | undefined): number {
  if (pricePerMillion == null) return 0;
  return (tokens * pricePerMillion) / 1_000_000;
}

/** 토큰을 썼는데 그 항목의 요율을 모르면 총액이 과소 추정된다. */
function missing(tokens: number, pricePerMillion: number | null | undefined): boolean {
  return tokens > 0 && pricePerMillion === undefined;
}

/**
 * 이 사용량의 추정 요금.
 *
 * 롱컨텍스트 구간은 **호출 하나**의 입력 크기로 판정된다 — 문턱을 넘으면 그 호출
 * 전체가 비싼 요율이다(초과분만 비싼 게 아니다). 그래서 `query.inputTokens` 를
 * 넘겨줄 때만 구간을 따진다. 여러 호출을 합친 값에 그 판정을 걸면
 * "합쳐 보니 문턱을 넘었다" 는 이유로 없던 롱컨텍스트 요금이 생긴다.
 * 세션·프로젝트 합계는 그래서 기본 요율로 계산한다 — 그 구간을 탄 호출이
 * 섞여 있었다면 실제보다 **적게** 나온다.
 */
export function estimateCost(
  modelId: string | null,
  usage: Usage | null,
  query: PricingQuery = {},
): Cost {
  if (!usage || !modelId) return { ...ZERO_COST, unpriced: !modelId };

  const pricing = effectivePricing(modelId, query);
  if (!pricing) return { ...ZERO_COST, unpriced: true };

  // 카탈로그는 Anthropic 계열의 캐시 쓰기 단가를 지속시간별(5분 · 1시간)로 들고 있다.
  // SDK 는 어느 쪽으로 적었는지 알려주지 않으므로 기본값인 5분 요율로 잡는다.
  const option = findModelOption(modelId);
  const cacheWritePrice =
    pricing.cacheWrite ??
    (option?.cacheWrite5m != null ? option.cacheWrite5m * pricing.multiplier : undefined);

  const uncached = uncachedInputTokens(usage);
  const cost: Cost = {
    input: charge(uncached, pricing.inputPrice),
    cacheRead: charge(usage.cacheReadTokens, pricing.cacheRead),
    cacheWrite: charge(usage.cacheWriteTokens, cacheWritePrice),
    output: charge(usage.outputTokens, pricing.outputPrice),
    total: 0,
    underestimated:
      pricing.longContextRateUnknown ||
      missing(uncached, pricing.inputPrice) ||
      missing(usage.cacheReadTokens, pricing.cacheRead) ||
      missing(usage.cacheWriteTokens, cacheWritePrice) ||
      missing(usage.outputTokens, pricing.outputPrice),
    // 입력·출력 단가가 둘 다 없으면 요율표에 값이 없는 모델이다(로컬 모델 프리셋 등).
    unpriced: pricing.inputPrice === undefined && pricing.outputPrice === undefined,
    longContext: pricing.longContext,
  };
  cost.total = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
  return cost;
}

export function addCost(a: Cost, b: Cost): Cost {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    total: a.total + b.total,
    underestimated: a.underestimated || b.underestimated,
    unpriced: a.unpriced || b.unpriced,
    longContext: a.longContext || b.longContext,
  };
}

/** 로컬 서버 모델은 토큰을 아무리 써도 청구서가 없다 — "요율 미상" 과 구분해서 말한다. */
export function isLocalModel(modelId: string | null): boolean {
  if (!modelId) return false;
  return parseModelId(modelId).provider === "local";
}

// ---------------------------------------------------------------- 컨텍스트

export type ContextLevel = "ok" | "warn" | "danger" | "unknown";

/** 컨텍스트 창을 얼마나 먹었는지. */
export interface ContextStatus {
  /**
   * 다음 턴에 **다시 실려 나갈** 토큰 = 마지막 호출의 입력 + 그 답변.
   * (대화는 매 턴 전체가 다시 올라가므로 누적 합이 아니라 마지막 호출이 기준이다)
   */
  used: number;
  /** `used` 중 캐시에서 읽힌 몫 */
  cached: number;
  /** 마지막 답변의 출력 토큰 — 다음 턴에는 입력으로 바뀐다 */
  output: number;
  /** 모델의 컨텍스트 창. 모르면 null */
  window: number | null;
  remaining: number | null;
  /** 0~1. 창 크기를 모르면 null */
  ratio: number | null;
  level: ContextLevel;
  /** 창의 주인 = **다음 턴에 쓸 모델**. 게이지의 분모는 이 모델의 것이다 */
  modelId: string | null;
  /** `used` 를 실제로 센 모델. 다음 턴에 쓸 모델과 다를 수 있다 */
  measuredModelId: string | null;
  /** 잰 모델과 쓸 모델이 달라 토크나이저가 어긋난다 → 근사치 */
  approximate: boolean;
  /** `used` 중 공급자가 실제로 세어 준 몫 */
  measuredTokens: number;
  /** 그 호출 이후 늘어난(양수) · 분기로 줄어든(음수) 만큼의 환산 몫 */
  projectedTokens: number;
  /** 환산분이 섞여 있다 — 그만큼은 아직 아무도 세지 않았다 */
  estimated: boolean;
  /** 다음 턴에 나갈 페이로드의 문자 수. 인스펙터가 적는 "N자" 와 같은 수 */
  chars: number | null;
  /** 그 페이로드의 LLM 메시지 수. 인스펙터의 "메시지 N개" 와 같은 수 */
  messageCount: number | null;
  /** 이 대화가 실측으로 만들어 낸 자/토큰 비율 */
  charsPerToken: number | null;
}

/** 다음 턴에 나갈 페이로드의 크기. 이게 있어야 "지금" 을 말할 수 있다. */
export interface ContextPayload {
  /** 다음 턴에 나갈 페이로드의 문자 수 (`payloadChars()`) */
  chars: number;
  /** 그 페이로드의 LLM 메시지 수 */
  messageCount: number;
  /** 마지막 호출이 **받았던** 페이로드의 문자 수. 이게 있어야 비율이 나온다 */
  measuredChars: number | null;
  /**
   * 다음 턴에 나갈 **이미지**의 추정 토큰 (`lib/ai/imageTokens.ts`).
   *
   * 이미지는 페이로드에 참조 한 토막으로만 실린다 — 자 수는 거의 0인데 토큰은 수천이다.
   * 자 수 환산에 섞으면 비율이 통째로 망가지므로 따로 세어 따로 더한다.
   */
  imageTokens?: number;
  /** 기준점 호출이 실었던 이미지의 추정 토큰. 비율을 낼 때 실측 토큰에서 이만큼을 뺀다 */
  measuredImageTokens?: number | null;
}

/** `projectTokens()` 의 결과. */
export interface TokenProjection {
  used: number;
  /** 공급자가 세어 준 몫 */
  measured: number;
  /** 환산한 몫 (부호 있음) */
  projected: number;
  charsPerToken: number | null;
}

/**
 * **지금 보내면** 몇 토큰이 나가는지.
 *
 * 마지막 호출은 공급자가 정확히 세어 줬지만, 그 뒤에 붙은 것(그 답변, 새 사용자 메시지)은
 * 아직 아무도 센 적이 없다. 그렇다고 전체를 자/토큰 어림으로 갈아 끼우면 정확한 수를
 * 버리고 어림으로 바꾸는 꼴이다 → **실측에 못을 박고 늘어난 만큼만** 환산한다.
 *
 * 비율도 일반론("4자당 1토큰")이 아니라 이 대화가 방금 만들어 낸 값이다 —
 * 마지막 호출이 받은 페이로드의 문자 수 ÷ 그 호출의 입력 토큰. 매 턴 다시 보정된다.
 *
 * 그래프에서 앞쪽 노드로 분기하면 페이로드가 **줄어든다** — 그때는 환산분이 음수다.
 *
 * 페이로드를 모르면(세션 카드는 DB 집계만 갖고 있어 다시 만들 수 없다) 옛 어림으로
 * 물러난다: 마지막 호출의 입력+출력. 답변이 다음 턴엔 입력으로 바뀌므로 대략 맞지만,
 * 다시 실리지 않는 사고 토큰까지 함께 세는 만큼 조금 크게 잡힌다.
 */
export function projectTokens(
  usage: Usage | null,
  payload: ContextPayload | null,
): TokenProjection {
  if (!usage) return { used: 0, measured: 0, projected: 0, charsPerToken: null };

  if (
    !payload ||
    payload.measuredChars == null ||
    payload.measuredChars <= 0 ||
    usage.inputTokens <= 0
  ) {
    const used = usage.inputTokens + usage.outputTokens;
    return { used, measured: used, projected: 0, charsPerToken: null };
  }

  // 실측 토큰에는 그 호출이 실었던 이미지 몫이 섞여 있다. 그런데 그 이미지는 페이로드에
  // 참조 한 토막으로만 잡히므로, 빼지 않으면 분모만 커져 비율이 통째로 망가진다
  // (이미지 한 장 붙인 뒤 남은 대화 전체를 과소평가하게 된다).
  const measuredImages = payload.measuredImageTokens ?? 0;
  const textTokens = usage.inputTokens - measuredImages;
  if (textTokens <= 0) {
    const used = usage.inputTokens + usage.outputTokens;
    return { used, measured: used, projected: 0, charsPerToken: null };
  }

  const charsPerToken = payload.measuredChars / textTokens;
  const projectedText = Math.round((payload.chars - payload.measuredChars) / charsPerToken);
  // 이미지는 환산이 아니라 공식으로 센다 — 늘어난(또는 분기로 줄어든) 장수만큼만.
  const projected = projectedText + ((payload.imageTokens ?? 0) - measuredImages);

  return {
    used: Math.max(0, usage.inputTokens + projected),
    measured: usage.inputTokens,
    projected,
    charsPerToken,
  };
}

// 창이 꽉 차기 전에 미리 갈아타라고 문턱을 낮게 잡았다 —
// 앞부분이 길수록 매 턴 다시 올라가는 양이 늘어 값도 품질도 같이 나빠진다.
export const CONTEXT_WARN_RATIO = 0.25;
export const CONTEXT_DANGER_RATIO = 0.4;

function contextLevel(ratio: number | null): ContextLevel {
  if (ratio === null) return "unknown";
  if (ratio >= CONTEXT_DANGER_RATIO) return "danger";
  if (ratio >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}

/**
 * 컨텍스트 잔량 — **지금 보내면 얼마가 나가는가**.
 *
 * 분자는 `projectTokens()` 가 만든다: 마지막 호출의 실측값에 못을 박고, 그 뒤로
 * 페이로드가 늘거나 준 만큼만 환산해 더한다. `payload` 를 안 주면 마지막 호출의
 * 입력+출력으로 물러난다(세션 카드).
 *
 * 넘겨받는 `usage` 는 반드시 **호출 하나**의 것이어야 한다. 여러 호출을
 * 더한 값을 넣으면(도구를 쓴 턴은 스텝마다 대화 전체가 다시 올라간다) 겹쳐 센
 * 앞부분까지 "지금 차 있는 양"으로 보여 게이지가 몇 배로 부푼다.
 * 2026-08 이전에 저장된 노드는 턴 누적이 마지막 노드에 몰려 있어 이 값이 부풀어 있다.
 *
 * 분모는 **다음 턴에 쓸 모델**(`modelId`)의 창이다 — 지금 차 있는 양이 궁금한 이유가
 * "이 대화를 이어서 보낼 수 있나" 이기 때문이다. 창 크기는 모델마다 200K~1M 로
 * 다섯 배씩 차이가 나므로, 모델을 바꾸면 같은 대화라도 여유가 완전히 달라진다.
 *
 * 분자는 `measuredModelId` 가 실제로 세어 준 값이다. 둘이 다르면 토크나이저가 달라
 * 실제로는 ±10% 안팎에서 어긋난다 → `approximate` 로 표시만 하고 값을 지어내지 않는다.
 * 그 모델로 한 턴만 돌리면 실측값으로 저절로 갈아 끼워진다.
 */
export function contextStatus(
  modelId: string | null,
  usage: Usage | null,
  measuredModelId: string | null = modelId,
  payload: ContextPayload | null = null,
): ContextStatus {
  const projection = projectTokens(usage, payload);
  const used = projection.used;
  const window = (modelId ? findModelOption(modelId)?.contextWindow : undefined) ?? null;
  const ratio = window ? Math.min(1, used / window) : null;

  return {
    used,
    cached: usage?.cacheReadTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    window,
    remaining: window ? Math.max(0, window - used) : null,
    ratio,
    level: contextLevel(ratio),
    modelId,
    measuredModelId,
    approximate: used > 0 && measuredModelId != null && measuredModelId !== modelId,
    measuredTokens: projection.measured,
    projectedTokens: projection.projected,
    estimated: projection.projected !== 0,
    chars: payload?.chars ?? null,
    messageCount: payload?.messageCount ?? null,
    charsPerToken: projection.charsPerToken,
  };
}

// ------------------------------------------------------------------ 노드/세션

/** 노드 하나가 남긴 사용량 + 그때 쓴 모델. LLM 호출이 없던 노드면 null. */
export interface NodeUsage {
  usage: Usage;
  modelId: string | null;
  cost: Cost;
}

/**
 * 노드에서 사용량을 읽는다.
 *
 * 모델은 usage 안의 `modelId` 를 먼저 보고, 없으면(옛 기록) 그 노드의 컨텍스트
 * 스냅샷에 남은 모델을 쓴다 — Rust 의 세션 집계와 같은 순서다.
 */
export function readNodeUsage(message: Message, fallbackModelId?: string | null): NodeUsage | null {
  const usage = readUsage(message.tokenUsage);
  if (!usage) return null;

  const stored = record(message.tokenUsage).modelId;
  const snapshot = record(message.contextSnapshot).modelId;
  const modelId =
    (typeof stored === "string" && stored) ||
    (typeof snapshot === "string" && snapshot) ||
    fallbackModelId ||
    null;

  // 노드 하나 = LLM 호출 하나이므로 여기서는 롱컨텍스트 구간을 따질 수 있다.
  return { usage, modelId, cost: estimateCost(modelId, usage, { inputTokens: usage.inputTokens }) };
}

/** 노드 묶음(턴 · 활성 경로)의 합계. 마지막 호출의 모델을 대표로 삼는다. */
export function readChainUsage(messages: Message[], fallbackModelId?: string | null): NodeUsage {
  const nodes = messages
    .map((message) => readNodeUsage(message, fallbackModelId))
    .filter((item): item is NodeUsage => item !== null);

  return {
    usage: sumUsage(nodes.map((item) => item.usage)),
    modelId: nodes.at(-1)?.modelId ?? fallbackModelId ?? null,
    cost: nodes.map((item) => item.cost).reduce(addCost, ZERO_COST),
  };
}

/**
 * 활성 경로에서 **가장 최근** LLM 호출 노드 (컨텍스트 잔량의 기준점).
 * 그 호출이 받은 페이로드를 트리에서 다시 만들려면 usage 말고 노드 자체가 필요하다.
 */
export function lastCallNode(messages: Message[]): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (readUsage(messages[index].tokenUsage)) return messages[index];
  }
  return null;
}

/** 활성 경로에서 **가장 최근** LLM 호출만 골라낸다 (컨텍스트 잔량 기준점). */
export function lastCallUsage(messages: Message[], fallbackModelId?: string | null): NodeUsage | null {
  const node = lastCallNode(messages);
  return node ? readNodeUsage(node, fallbackModelId) : null;
}

/** 세션(또는 프로젝트) 누적 사용량. */
export interface UsageSummary {
  usage: Usage;
  cost: Cost;
  /** LLM 호출 수 (메인 턴 + 위임 실행) */
  calls: number;
  /** 토큰을 가장 많이 쓴 모델 — 카드에 한 줄만 적을 때 쓴다 */
  primaryModelId: string | null;
  /** 이 세션에 등장한 모델 수. 2 이상이면 대표 모델만으로는 설명이 안 된다 */
  modelCount: number;
}

export const EMPTY_SUMMARY: UsageSummary = {
  usage: EMPTY_USAGE,
  cost: ZERO_COST,
  calls: 0,
  primaryModelId: null,
  modelCount: 0,
};

function usageOfModelRow(row: SessionModelUsage): Usage {
  return {
    inputTokens: row.inputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.inputTokens + row.outputTokens,
  };
}

/** 모델 하나에 대한 합계 조각. */
interface UsageGroup {
  usage: Usage;
  modelId: string | null;
  calls: number;
}

/**
 * 조각들을 하나의 요약으로 접는다.
 *
 * 같은 모델끼리 먼저 합친 뒤 **모델별로 따로 요금을 매기고** 더한다 —
 * 단가가 다른 토큰을 먼저 합쳐 버리면 값이 틀어진다.
 */
function summarizeGroups(groups: UsageGroup[]): UsageSummary {
  if (groups.length === 0) return EMPTY_SUMMARY;

  const byModel = new Map<string, UsageGroup>();
  for (const group of groups) {
    const key = group.modelId ?? "";
    const merged = byModel.get(key);
    if (merged) {
      merged.usage = addUsage(merged.usage, group.usage);
      merged.calls += group.calls;
    } else {
      byModel.set(key, { ...group });
    }
  }

  const sorted = [...byModel.values()].sort(
    (a, b) =>
      b.usage.inputTokens + b.usage.outputTokens - (a.usage.inputTokens + a.usage.outputTokens),
  );

  return {
    usage: sumUsage(sorted.map((group) => group.usage)),
    cost: sorted
      .map((group) => estimateCost(group.modelId, group.usage))
      .reduce(addCost, ZERO_COST),
    calls: sorted.reduce((total, group) => total + group.calls, 0),
    primaryModelId: sorted[0].modelId,
    modelCount: sorted.length,
  };
}

/** 세션 카드용 누적 사용량 (DB 집계). */
export function summarizeSessionUsage(overview: SessionOverview): UsageSummary {
  return summarizeGroups(
    (overview.usageByModel ?? []).map((row) => ({
      usage: usageOfModelRow(row),
      modelId: row.modelId,
      calls: row.calls,
    })),
  );
}

/**
 * 지금 열려 있는 세션의 누적 사용량을 **로컬 캐시**로 낸다.
 *
 * 세션 카드의 집계(`summarizeSessionUsage`)는 DB 를 다시 읽어야 갱신되는데,
 * 채팅 화면은 방금 끝난 턴이 곧바로 반영돼야 한다 → 스토어에 들고 있는
 * 노드와 위임 실행에서 직접 센다. 두 경로의 계산 규칙은 같다.
 */
export function summarizeLiveUsage(
  messages: Message[],
  runs: { tokenUsage: unknown }[] = [],
  fallbackModelId?: string | null,
): UsageSummary {
  const entries: { usage: Usage; modelId: string | null }[] = [];

  for (const message of messages) {
    const node = readNodeUsage(message, fallbackModelId);
    if (node) entries.push({ usage: node.usage, modelId: node.modelId });
  }
  for (const run of runs) {
    const usage = readUsage(run.tokenUsage);
    if (!usage) continue;
    const stored = record(run.tokenUsage).modelId;
    entries.push({
      usage,
      modelId: (typeof stored === "string" && stored) || fallbackModelId || null,
    });
  }

  return summarizeGroups(entries.map((entry) => ({ ...entry, calls: 1 })));
}

/** 프로젝트 전체 합계 (세션 맵 헤더). */
export function summarizeProjectUsage(overviews: SessionOverview[]): UsageSummary {
  return summarizeGroups(
    overviews.flatMap((overview) =>
      (overview.usageByModel ?? []).map((row) => ({
        usage: usageOfModelRow(row),
        modelId: row.modelId,
        calls: row.calls,
      })),
    ),
  );
}

/**
 * 세션 카드의 컨텍스트 게이지 — 그 세션의 가장 최근 호출이 분자,
 * **지금 선택된 모델**의 창이 분모다("이 세션을 지금 이어서 쓰면 얼마나 차 있나").
 */
export function sessionContextStatus(
  overview: SessionOverview,
  modelId: string | null,
): ContextStatus {
  const measured = overview.lastUsageModel ?? overview.model;
  return contextStatus(modelId ?? measured, readUsage(overview.lastUsage), measured);
}

// -------------------------------------------------------------------- 표시

/** 아주 작은 금액이 `$0.00` 으로 뭉개지지 않게 자릿수를 늘린다. */
export function formatUsd(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** 화면에 짧게 적을 모델 이름. 카탈로그에 없는 모델(직접 입력)은 공급자 접두어만 뗀다. */
export function formatModelLabel(modelId: string | null): string {
  if (!modelId) return t("usage.unknownModel");
  return findModelOption(modelId)?.label ?? parseModelId(modelId).modelId;
}

/** 카드처럼 좁은 자리에 쓰는 짧은 토큰 수. */
export function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 툴팁·인스펙터용 정확한 수 (`12,345`).
 * 자릿수 구분자는 화면 언어를 따라간다 — 숫자만 한국식으로 남으면 그 줄만 튀어 보인다.
 */
export function formatExact(value: number): string {
  return Math.round(value).toLocaleString(getLocale() === "ko" ? "ko-KR" : "en-US");
}

/**
 * 금액 한 조각. 모델을 모르거나 로컬 모델이면 금액 대신 이유를 말한다.
 * ("$0" 으로 적으면 공짜인지 못 세는 건지 구분이 안 된다)
 */
export function formatCost(cost: Cost, modelId: string | null): string {
  if (isLocalModel(modelId)) return t("usage.local");
  if (cost.unpriced) return t("usage.unknownRate");
  return `${cost.underestimated ? "≥" : ""}${formatUsd(cost.total)}`;
}

/** 사용량 한 줄 요약 — 말풍선·카드에 붙인다. */
export function formatUsageLine(usage: Usage): string {
  const parts = [`↑${formatTokens(usage.inputTokens)}`, `↓${formatTokens(usage.outputTokens)}`];
  if (usage.cacheReadTokens > 0)
    parts.push(t("usage.cache", { tokens: formatTokens(usage.cacheReadTokens) }));
  if (usage.reasoningTokens > 0)
    parts.push(t("usage.reasoning", { tokens: formatTokens(usage.reasoningTokens) }));
  return parts.join(" · ");
}

/** 마우스를 올렸을 때 보여줄 항목별 내역. */
export function usageTooltip(usage: Usage, cost: Cost, modelId: string | null): string {
  const lines = [
    modelId ? t("usage.model", { modelId }) : t("usage.unknownModel"),
    t("usage.inputBreakdown", {
      input: formatExact(usage.inputTokens),
      fresh: formatExact(uncachedInputTokens(usage)),
      cacheRead: formatExact(usage.cacheReadTokens),
      cacheWrite: formatExact(usage.cacheWriteTokens),
    }),
    usage.reasoningTokens > 0
      ? t("usage.outputWithReasoning", {
          output: formatExact(usage.outputTokens),
          reasoning: formatExact(usage.reasoningTokens),
        })
      : t("usage.outputBreakdown", { output: formatExact(usage.outputTokens) }),
  ];

  if (isLocalModel(modelId)) {
    lines.push(t("usage.freeLocal"));
  } else if (cost.unpriced) {
    lines.push(t("usage.noRate"));
  } else {
    lines.push(
      t("usage.costBreakdown", {
        total: formatUsd(cost.total),
        input: formatUsd(cost.input),
        cacheRead: formatUsd(cost.cacheRead),
        cacheWrite: formatUsd(cost.cacheWrite),
        output: formatUsd(cost.output),
      }),
    );
    if (cost.longContext) lines.push(t("usage.longContext"));
    if (cost.underestimated) lines.push(t("usage.partialRate"));
  }
  return lines.join("\n");
}
