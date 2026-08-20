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
}

export const CONTEXT_WARN_RATIO = 0.7;
export const CONTEXT_DANGER_RATIO = 0.9;

function contextLevel(ratio: number | null): ContextLevel {
  if (ratio === null) return "unknown";
  if (ratio >= CONTEXT_DANGER_RATIO) return "danger";
  if (ratio >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}

/**
 * 컨텍스트 잔량. **마지막 LLM 호출**의 입력+출력을 쓴 것으로 본다.
 * 도구 결과가 붙으면 실제로는 조금 더 늘지만, 다음 호출 전까지는 알 수 없다.
 */
export function contextStatus(modelId: string | null, usage: Usage | null): ContextStatus {
  const used = usage ? usage.inputTokens + usage.outputTokens : 0;
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

/** 활성 경로에서 **가장 최근** LLM 호출만 골라낸다 (컨텍스트 잔량 기준점). */
export function lastCallUsage(messages: Message[], fallbackModelId?: string | null): NodeUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const node = readNodeUsage(messages[index], fallbackModelId);
    if (node) return node;
  }
  return null;
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

/** 세션 카드의 컨텍스트 게이지 — 그 세션의 가장 최근 호출이 기준. */
export function sessionContextStatus(overview: SessionOverview): ContextStatus {
  return contextStatus(
    overview.lastUsageModel ?? overview.model,
    readUsage(overview.lastUsage),
  );
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

/** 카드처럼 좁은 자리에 쓰는 짧은 토큰 수. */
export function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** 툴팁·인스펙터용 정확한 수 (`12,345`). */
export function formatExact(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

/**
 * 금액 한 조각. 모델을 모르거나 로컬 모델이면 금액 대신 이유를 말한다.
 * ("$0" 으로 적으면 공짜인지 못 세는 건지 구분이 안 된다)
 */
export function formatCost(cost: Cost, modelId: string | null): string {
  if (isLocalModel(modelId)) return "로컬";
  if (cost.unpriced) return "요율 미상";
  return `${cost.underestimated ? "≥" : ""}${formatUsd(cost.total)}`;
}

/** 사용량 한 줄 요약 — 말풍선·카드에 붙인다. */
export function formatUsageLine(usage: Usage): string {
  const parts = [`↑${formatTokens(usage.inputTokens)}`, `↓${formatTokens(usage.outputTokens)}`];
  if (usage.cacheReadTokens > 0) parts.push(`캐시 ${formatTokens(usage.cacheReadTokens)}`);
  if (usage.reasoningTokens > 0) parts.push(`사고 ${formatTokens(usage.reasoningTokens)}`);
  return parts.join(" · ");
}

/** 마우스를 올렸을 때 보여줄 항목별 내역. */
export function usageTooltip(usage: Usage, cost: Cost, modelId: string | null): string {
  const lines = [
    modelId ? `모델 ${modelId}` : "모델 미상",
    `입력 ${formatExact(usage.inputTokens)} (신규 ${formatExact(uncachedInputTokens(usage))} · 캐시읽기 ${formatExact(usage.cacheReadTokens)} · 캐시쓰기 ${formatExact(usage.cacheWriteTokens)})`,
    `출력 ${formatExact(usage.outputTokens)}${usage.reasoningTokens > 0 ? ` (사고 ${formatExact(usage.reasoningTokens)})` : ""}`,
  ];

  if (isLocalModel(modelId)) {
    lines.push("로컬 서버 모델 — 토큰 요금 없음");
  } else if (cost.unpriced) {
    lines.push("요율표에 없는 모델이라 금액을 계산하지 못했습니다");
  } else {
    lines.push(
      `요금 추정 ${formatUsd(cost.total)} = 입력 ${formatUsd(cost.input)} + 캐시읽기 ${formatUsd(cost.cacheRead)} + 캐시쓰기 ${formatUsd(cost.cacheWrite)} + 출력 ${formatUsd(cost.output)}`,
    );
    if (cost.longContext) lines.push("롱컨텍스트 구간 요율이 적용됐습니다");
    if (cost.underestimated) lines.push("일부 항목의 요율을 몰라 실제보다 적게 잡혔습니다");
  }
  return lines.join("\n");
}
