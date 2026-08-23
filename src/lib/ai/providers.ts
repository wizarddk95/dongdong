/**
 * 다중 모델 라우팅 레이어.
 *
 * 모델은 `"<provider>:<modelId>"` 형태의 문자열 하나로 식별한다.
 * 새 공급자를 붙이려면 `resolveModel()` 에 분기를 추가하고,
 * `src-tauri/capabilities/default.json` 의 http 스코프에 도메인을 열어주면 된다.
 *
 * `local` 은 특정 회사가 아니라 **이 PC 에서 도는 OpenAI 호환 서버**를 가리킨다
 * (Ollama · LM Studio · llama.cpp server · vLLM). 키가 필요 없고 주소만 있으면 된다.
 *
 * `google` 은 Gemini Developer API(ai.google.dev)다. 스택에 `@ai-sdk/google` 을 새로 들이지 않고
 * 구글이 함께 제공하는 **OpenAI 호환 엔드포인트**를 `@ai-sdk/openai` 로 부른다(`GEMINI_BASE_URL`).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { LanguageModel } from "ai";

import { withSseRepair } from "@/lib/ai/sseRepair";
import { withThoughtSignatures } from "@/lib/ai/thoughtSignature";
import { getLocale, t } from "@/lib/i18n";

export type ProviderId = "anthropic" | "openai" | "google" | "local";

/**
 * 롱컨텍스트 구간 요율 (USD / 1M tokens).
 * `cacheRead` / `cacheWrite` 가 `null` 이면 그 세대는 해당 과금 자체가 없다는 뜻이다.
 */
export interface LongContextPricing {
  inputPrice: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  outputPrice: number;
}

export interface ModelOption {
  /** `provider:modelId` — 스토어와 DB 에 저장되는 식별자 */
  id: string;
  provider: ProviderId;
  modelId: string;
  label: string;
  /** 드롭다운에 붙는 한 줄 설명 (한국어) */
  note?: string;
  /** 같은 설명의 영어 대역. 없으면 `note` 를 그대로 쓴다 */
  noteEn?: string;

  // --- 아래는 모두 선택 필드. 값을 아는 모델에만 채운다(모르는 값은 비워 둔다) ---

  /** 입력 단가. **USD / 1M tokens** */
  inputPrice?: number;
  /** 출력 단가. USD / 1M tokens */
  outputPrice?: number;
  /** 프롬프트 캐시 5분 쓰기 단가 (= 입력가 × 1.25) */
  cacheWrite5m?: number;
  /** 프롬프트 캐시 1시간 쓰기 단가 (= 입력가 × 2) */
  cacheWrite1h?: number;
  /** 프롬프트 캐시 읽기 단가 (= 입력가 × 0.1). `null` 은 이 모델에 캐시 읽기 과금이 없다는 뜻 */
  cacheRead?: number | null;
  /** 컨텍스트 창(토큰). 1M 모델도 전 구간 동일 단가라 구간별 가격은 없다 */
  contextWindow?: number;
  /** 한 응답의 최대 출력 토큰 */
  maxOutput?: number;
  /** 학습 기준일 (`YYYY-MM`, 일자까지 공개된 모델은 `YYYY-MM-DD`) */
  trainingCutoff?: string;
  /** 이 토큰 수 미만의 접두사는 캐시되지 않는다 */
  minCacheTokens?: number;

  supportsPromptCaching?: boolean;
  /** `thinking: { type: "adaptive" }` */
  supportsAdaptiveThinking?: boolean;
  /** 구형 `thinking: { type: "enabled", budget_tokens }` */
  supportsExtendedThinking?: boolean;
  supportsVision?: boolean;
  supportsToolUse?: boolean;

  /** 같은 텍스트가 몇 배 토큰이 되는지 (추정용) */
  tokenizerMultiplier?: number;
  /**
   * 공식 문서가 "이 모델의 `effort` 기본값" 이라고 못박은 값만 넣는다(추측 금지).
   * 현재 문서가 명시한 건 Opus 4.8 · Opus 5 · Sonnet 5 = `high` 뿐이다.
   * - Fable 5: 문서에 기본값이 없다 → 비워 둔다(사용자가 쓰던 강도를 유지).
   * - Haiku 4.5: adaptive 를 모르는 모델이라 `effort` 자체를 못 받는다 → **넣으면 안 된다**.
   */
  defaultEffort?: Effort;
  /** Batch API 할인율. 0.5 = 입력·출력 50% (캐싱 할인과 중첩 가능) */
  batchDiscount?: number;

  // --- 아래는 OpenAI 쪽 개념. Anthropic 항목에서는 비워 둔다 ---

  /**
   * 캐시 TTL 티어가 없는 공급자(OpenAI · Google)의 캐시 쓰기 단가 (OpenAI 는 입력가 × 1.25).
   * `null` 은 **그 세대에 캐시 쓰기 과금이 없다(무료)** 는 뜻이고,
   * 비워 두면 "모른다" 는 뜻이다 — 0 으로 두면 둘이 구분되지 않는다.
   *
   * Gemini 는 캐시 **생성 요금**이 따로 없고 생성 시점 토큰을 그냥 입력 단가로 받는다 →
   * `null`(무료)이 아니라 **입력가와 같은 값**을 넣는다. 대신 Gemini 만 있는 시간당
   * 캐시 저장 비용(per 1M tokens per hour)은 이 스키마에 담을 칸이 없다(카탈로그 주석 참고).
   */
  cacheWrite?: number | null;
  /**
   * 입력 토큰이 이 수를 넘으면 **그 요청 전체**가 `longContextPricing` 요율로 과금된다
   * (초과분만이 아니다). OpenAI 현행 기준 272,000.
   */
  longContextThresholdTokens?: number;
  /** 롱컨텍스트 구간 요율. `null` 은 공개된 요율이 없다는 뜻(기본 요율로 추정하면 과소 추정) */
  longContextPricing?: LongContextPricing | null;
  /** Chat Completions 에서는 동작하지 않고 Responses API 로만 부를 수 있다 */
  responsesApiOnly?: boolean;
  /** 이 모델이 받는 추론 강도 값. 세대마다 다르다 */
  supportedEfforts?: Effort[];
}

/**
 * 웹뷰의 기본 `fetch` 는 브라우저 CORS 정책을 그대로 받는다.
 * Anthropic 은 브라우저 직접 호출을 막고 있어서, Rust(reqwest)를 경유하는
 * Tauri HTTP 플러그인으로 우회한다. 이 플러그인의 응답 body 는 실제
 * `ReadableStream` 이므로 SSE 토큰 스트리밍이 그대로 동작한다.
 */
const localFetch = tauriFetch as unknown as typeof globalThis.fetch;

/**
 * 구글의 OpenAI 호환 계층은 도구를 쓸 때 두 군데가 어긋난다. 둘 다 fetch 를 감싸 메운다.
 *
 * 1. 도구 호출 청크에 `tool_calls[].index` 를 넣지 않는데 `@ai-sdk/openai` 의 스키마는
 *    그걸 필수로 본다 → 도구를 부르는 **그 순간** 타입 검증 실패로 턴이 날아간다
 *    (`lib/ai/sseRepair.ts`).
 * 2. Gemini 3.x 는 호출에 `extra_content.google.thought_signature` 를 실어 보내고 다시
 *    올릴 때 그 값을 요구하는데 SDK 가 모르고 떨어뜨린다 → 도구를 부른 **다음** 요청이
 *    400 이 된다 (`lib/ai/thoughtSignature.ts`).
 *
 * 바깥 겹이 요청을 손보므로 순서가 이렇다 — 안쪽(sseRepair)이 고친 응답을 바깥이 읽는다.
 */
const geminiFetch = withThoughtSignatures(withSseRepair(localFetch));

/**
 * Tauri HTTP 플러그인(Rust)은 요청마다 웹뷰 주소로 `Origin` 헤더를 강제로 붙인다
 * (`tauri-plugin-http/src/commands.rs` — "ensure we have an Origin header set").
 * Anthropic 은 `Origin` 이 붙은 요청을 브라우저 직접 호출로 보고
 * `anthropic-dangerous-direct-browser-access` 없이는 거부한다.
 *
 * 이 앱에서는 키가 사용자 PC 밖으로 나가지 않고(설정 디렉터리의 `settings.json`),
 * 실제 요청도 웹뷰가 아니라 Rust(reqwest)가 보내므로 이 헤더를 켜도 노출 위험이 없다.
 */
const ANTHROPIC_DIRECT_HEADERS: Record<string, string> = {
  "anthropic-dangerous-direct-browser-access": "true",
};

/**
 * OpenAI 롱컨텍스트 문턱. 입력이 이 수를 넘으면 **요청 전체**가 롱컨텍스트 요율이 된다 —
 * 초과분만 비싸지는 게 아니라 272,001 번째 토큰 하나 때문에 앞의 272,000 개도 같이 오른다.
 */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

/**
 * Gemini 3.1 Pro 의 계층 요율 문턱. 프롬프트가 이 수를 넘으면 입력·출력·캐시 단가가
 * 모두 상위 구간으로 바뀐다 — OpenAI 의 272K 와 같은 "요청 전체" 규칙이다.
 */
export const GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

/** 추론 강도 지원값은 세대마다 다르다. 목록에 없는 값을 보내면 공급자가 거절한다. */
const EFFORTS_GPT_5_6: Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const EFFORTS_GPT_5_4: Effort[] = ["none", "low", "medium", "high", "xhigh"];
const EFFORTS_GPT_5_3_CODEX: Effort[] = ["low", "medium", "high", "xhigh"];
const EFFORTS_GPT_5: Effort[] = ["minimal", "low", "medium", "high"];
/** Gemini 3.7 Flash 는 `minimal` 을 받지 않는다 — 지정하면 에러다. */
const EFFORTS_GEMINI_3_7: Effort[] = ["low", "medium", "high"];
const EFFORTS_GEMINI_3_1_LITE: Effort[] = ["minimal", "low", "medium", "high"];

/** 공급자별 모델 목록. 라벨만 표시용이고 실제 호출에는 `modelId` 를 쓴다. */
export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "anthropic:claude-fable-5",
    provider: "anthropic",
    modelId: "claude-fable-5",
    label: "Claude Fable 5",
    note: "최상위 · 1M 컨텍스트 · 사고 항상 켜짐",
    noteEn: "Top tier · 1M context · thinking always on",
    inputPrice: 10,
    outputPrice: 50,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-01",
    minCacheTokens: 512,
    supportsPromptCaching: true,
    supportsAdaptiveThinking: true,
    supportsExtendedThinking: false,
    supportsVision: true,
    supportsToolUse: true,
    tokenizerMultiplier: 1.3,
    // defaultEffort 없음 — 문서가 Fable 5 의 effort 기본값을 명시하지 않는다.
    batchDiscount: 0.5,
  },
  {
    id: "anthropic:claude-opus-5",
    provider: "anthropic",
    modelId: "claude-opus-5",
    label: "Claude Opus 5",
    note: "Anthropic 최상위급 · 1M 컨텍스트",
    noteEn: "Anthropic flagship class · 1M context",
    inputPrice: 5,
    outputPrice: 25,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-05",
    minCacheTokens: 512,
    supportsPromptCaching: true,
    supportsAdaptiveThinking: true,
    supportsExtendedThinking: false,
    supportsVision: true,
    supportsToolUse: true,
    tokenizerMultiplier: 1.3,
    defaultEffort: "high",
    batchDiscount: 0.5,
  },
  {
    id: "anthropic:claude-sonnet-5",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    note: "빠르고 저렴",
    noteEn: "Fast and cheap",
    inputPrice: 2,
    outputPrice: 10,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.2,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-01",
    minCacheTokens: 1024,
    supportsPromptCaching: true,
    supportsAdaptiveThinking: true,
    supportsExtendedThinking: false,
    supportsVision: true,
    supportsToolUse: true,
    tokenizerMultiplier: 1.3,
    defaultEffort: "high",
    batchDiscount: 0.5,
  },
  {
    id: "anthropic:claude-haiku-4-5-20251001",
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    note: "서브에이전트 · 분류 · 라우팅용 저비용 티어 · 200K 컨텍스트",
    noteEn: "Low-cost tier for subagents, classification and routing · 200K context",
    inputPrice: 1,
    outputPrice: 5,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
    contextWindow: 200_000,
    maxOutput: 64_000,
    trainingCutoff: "2025-07",
    minCacheTokens: 4096,
    supportsPromptCaching: true,
    supportsAdaptiveThinking: false,
    supportsExtendedThinking: true,
    supportsVision: true,
    supportsToolUse: true,
    tokenizerMultiplier: 1,
    // defaultEffort 없음 — adaptive 미지원 모델이라 effort 를 보내면 400 이다.
    batchDiscount: 0.5,
  },

  // --- OpenAI 프론티어 (GPT-5.6 세대) ---
  // 이 세대부터 캐시 **쓰기**가 과금된다(입력가 × 1.25, 최소 30분 유지).
  // 이전 세대는 캐시 쓰기가 무료라 `cacheWrite: null` 로 구분한다.
  // 넷 다 입력이 272K 를 넘으면 그 요청 전체가 롱컨텍스트 요율로 바뀐다.
  {
    id: "openai:gpt-5.6-sol",
    provider: "openai",
    modelId: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    note: "프론티어 최상위 · 1.05M 컨텍스트 · 고난도 에스컬레이션용",
    noteEn: "Frontier top tier · 1.05M context · for hard escalations",
    inputPrice: 5,
    outputPrice: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-02-16",
    supportsPromptCaching: true,
    defaultEffort: "medium",
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 10, cacheRead: 1, cacheWrite: 12.5, outputPrice: 45 },
    supportedEfforts: EFFORTS_GPT_5_6,
  },
  {
    id: "openai:gpt-5.6-terra",
    provider: "openai",
    modelId: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    note: "OpenAI 쪽 기본값 · 1.05M 컨텍스트 · 성능 대비 저렴",
    noteEn: "The OpenAI default · 1.05M context · cheap for what it does",
    inputPrice: 2,
    outputPrice: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-02-16",
    supportsPromptCaching: true,
    defaultEffort: "medium",
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 4, cacheRead: 0.4, cacheWrite: 5, outputPrice: 18 },
    supportedEfforts: EFFORTS_GPT_5_6,
  },
  {
    id: "openai:gpt-5.6-luna",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    note: "대량·저비용 (요약 · 분류 · 서브에이전트)",
    noteEn: "High volume, low cost (summarizing · classification · subagents)",
    inputPrice: 0.2,
    outputPrice: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-02-16",
    supportsPromptCaching: true,
    defaultEffort: "medium",
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 0.4, cacheRead: 0.04, cacheWrite: 0.5, outputPrice: 1.8 },
    supportedEfforts: EFFORTS_GPT_5_6,
  },
  {
    id: "openai:gpt-5.6-cyber",
    provider: "openai",
    modelId: "gpt-5.6-cyber",
    label: "GPT-5.6 Cyber",
    note: "보안 특화 · Daybreak 프로그램 별도 승인 필요",
    noteEn: "Security-specialized · needs separate Daybreak program approval",
    inputPrice: 12.5,
    outputPrice: 75,
    cacheRead: 1.25,
    cacheWrite: 15.625,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2026-02-16",
    supportsPromptCaching: true,
    defaultEffort: "medium",
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    // 문턱은 같지만 요율이 공개돼 있지 않다 → 기본 요율로 추정하면 과소 추정이라는 것만 알린다.
    longContextPricing: null,
    supportedEfforts: EFFORTS_GPT_5_6,
  },

  // --- OpenAI 이전 세대 (현재도 API 판매 중) ---
  // 여기부터는 캐시 쓰기가 무료다 → `cacheWrite: null` ("0 원" 이 아니라 "과금 항목 없음").
  {
    id: "openai:gpt-5.5",
    provider: "openai",
    modelId: "gpt-5.5",
    label: "GPT-5.5",
    note: "이전 세대 프론티어 · 1.05M 컨텍스트",
    noteEn: "Previous-generation frontier · 1.05M context",
    inputPrice: 5,
    outputPrice: 30,
    cacheRead: 0.5,
    cacheWrite: null,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-12-01",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 10, cacheRead: 1, cacheWrite: null, outputPrice: 45 },
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5.5-pro",
    provider: "openai",
    modelId: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    note: "장고형 · 응답에 수 분 · Responses API 전용",
    noteEn: "Long-running · takes minutes to answer · Responses API only",
    inputPrice: 30,
    outputPrice: 180,
    // 문서에 캐시 입력 단가 자체가 없다 → 캐싱 미지원으로 본다.
    cacheRead: null,
    cacheWrite: null,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-12-01",
    supportsPromptCaching: false,
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 60, cacheRead: null, cacheWrite: null, outputPrice: 270 },
    responsesApiOnly: true,
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5.4",
    provider: "openai",
    modelId: "gpt-5.4",
    label: "GPT-5.4",
    inputPrice: 2.5,
    outputPrice: 15,
    cacheRead: 0.25,
    cacheWrite: null,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-08-31",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 5, cacheRead: 0.5, cacheWrite: null, outputPrice: 22.5 },
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5.4-mini",
    provider: "openai",
    modelId: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    inputPrice: 0.75,
    outputPrice: 4.5,
    cacheRead: 0.075,
    cacheWrite: null,
    contextWindow: 400_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-08-31",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5.4-nano",
    provider: "openai",
    modelId: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    inputPrice: 0.2,
    outputPrice: 1.25,
    cacheRead: 0.02,
    cacheWrite: null,
    contextWindow: 400_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-08-31",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5.4-pro",
    provider: "openai",
    modelId: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    note: "장고형 · 응답에 수 분 · Responses API 전용",
    noteEn: "Long-running · takes minutes to answer · Responses API only",
    inputPrice: 30,
    outputPrice: 180,
    cacheRead: null,
    cacheWrite: null,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-08-31",
    supportsPromptCaching: false,
    batchDiscount: 0.5,
    longContextThresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 60, cacheRead: null, cacheWrite: null, outputPrice: 270 },
    responsesApiOnly: true,
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5.3-codex",
    provider: "openai",
    modelId: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    note: "코딩 특화 · Responses API 전용",
    noteEn: "Coding-specialized · Responses API only",
    inputPrice: 1.75,
    outputPrice: 14,
    cacheRead: 0.175,
    cacheWrite: null,
    contextWindow: 400_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-08-31",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    responsesApiOnly: true,
    supportedEfforts: EFFORTS_GPT_5_3_CODEX,
  },
  {
    id: "openai:gpt-5.1",
    provider: "openai",
    modelId: "gpt-5.1",
    label: "GPT-5.1",
    inputPrice: 1.25,
    outputPrice: 10,
    cacheRead: 0.125,
    cacheWrite: null,
    contextWindow: 400_000,
    maxOutput: 128_000,
    trainingCutoff: "2025-08-31",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    supportedEfforts: EFFORTS_GPT_5_4,
  },
  {
    id: "openai:gpt-5",
    provider: "openai",
    modelId: "gpt-5",
    label: "GPT-5",
    inputPrice: 1.25,
    outputPrice: 10,
    cacheRead: 0.125,
    cacheWrite: null,
    contextWindow: 400_000,
    maxOutput: 128_000,
    trainingCutoff: "2024-09-30",
    supportsPromptCaching: true,
    batchDiscount: 0.5,
    supportedEfforts: EFFORTS_GPT_5,
  },

  // --- Google Gemini (Gemini Developer API · ai.google.dev) ---
  //
  // 가격은 전부 **Standard 티어 · 유료(Paid) 기준, USD / 1M tokens** 이며
  // 출력 단가에는 thinking(추론) 토큰이 포함된다. (출처: ai.google.dev/gemini-api/docs/pricing, 2026-08-21 확인)
  //
  // 스키마에 자리가 없어 여기 주석으로만 남기는 것들:
  //
  // 1) **캐시 저장 비용(per 1M tokens per hour)**. Gemini 의 캐싱은 Anthropic/OpenAI 와 구조가 다르다 —
  //    캐시를 **만들 때 따로 받는 쓰기 요금이 없고**(생성 시점 토큰은 그냥 입력 단가로 과금),
  //    대신 캐시를 **들고 있는 시간**에 요금이 붙는다. 명시적(explicit) 캐시만 저장비가 나가고
  //    암묵적(implicit) 캐시는 저장비 없이 히트 할인만 받는다.
  //      gemini-3.7-flash · 3.6-flash                             $0.50 /1M/hr
  //      gemini-3.5-flash-lite · 3.1-flash-lite · 2.5-flash-lite  $1.00 /1M/hr
  //      gemini-3.1-pro-preview(+customtools)                     $4.50 /1M/hr
  //    특히 Pro 계열의 $4.50/1M/hr 는 **장시간 에이전트 세션에서 무시할 수 없다** —
  //    200K 프롬프트를 한 시간 물고 있으면 그것만으로 $0.90 이다. 토큰 수가 아니라 시간에 붙는
  //    과금이라 이 앱의 사용량 집계(토큰 기반)로는 절대 잡히지 않는다.
  //    → 그래서 `cacheWrite` 는 `null`("무료") 이 아니라 **입력가와 같은 값**을 넣는다.
  //      캐시 생성 토큰이 입력 단가로 과금되는 실제 규칙과 맞고, `null` 로 두면
  //      `estimateCost()` 가 그 토큰을 0 원으로 세어 과소 추정한다.
  //
  // 2) **프로모션 가격 만료일과 예정가**. 3.7 Flash · 3.6 Flash 의 아래 값은 프로모션이며
  //    **2026-12-31 까지만** 유효하다. 2027-01-01 부터 두 모델 모두 정상가로 오른다:
  //      입력 $0.75 → $1.50 · 출력 $3.75 → $7.50 · 캐시읽기 $0.075 → $0.15 · 캐시저장 $0.50 → $1.00 /1M/hr
  //    (카탈로그에 가격 유효기간 필드가 없다 — 그날이 오면 이 값들을 손으로 갈아야 한다)
  //
  // 3) **서비스 티어 배수**. `SERVICE_TIER_MULTIPLIERS` 는 batch 0.5 · flex 0.5 까지는 Gemini 와 같지만
  //    priority 는 Gemini 가 **1.8x**, 표에는 2 로 박혀 있다(OpenAI 기준). 모델별 티어 배수를 두는
  //    필드가 없어 그대로 둔다 — Gemini 를 priority 로 부르면 요금이 약 11% 과대 추정된다.
  //
  // 4) 지원 thinking 레벨이 문서에 명시된 모델만 `supportedEfforts` 를 채웠다(추측 금지).
  //
  // 목록에서 뺀 모델: gemini-3.5-flash · gemini-3-flash-preview · gemini-2.5-pro · gemini-2.5-flash
  // (가격 대비 매력이 없거나 상위 모델로 대체됐다. 카탈로그에 넣은 적이 없어 deprecated 표시할 대상도 없다)
  {
    id: "google:gemini-3.7-flash",
    provider: "google",
    modelId: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    note: "기본값 · 1M 컨텍스트 · 프로모션가(2026-12-31까지)",
    noteEn: "The default · 1M context · promotional pricing (through 2026-12-31)",
    inputPrice: 0.75,
    outputPrice: 3.75,
    cacheRead: 0.075,
    // 캐시 생성 토큰은 입력 단가로 과금된다(별도 쓰기 요금 없음). 시간당 저장비는 위 주석 참고.
    cacheWrite: 0.75,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    // 일부 도메인은 2025-01 기준이다 — 카탈로그가 기준일을 하나만 들고 있어 최신 쪽을 적는다.
    trainingCutoff: "2026-03",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
    // `minimal` 을 지정하면 에러를 돌려준다 — 목록에 넣으면 안 된다.
    supportedEfforts: EFFORTS_GEMINI_3_7,
  },
  {
    id: "google:gemini-3.6-flash",
    provider: "google",
    modelId: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    note: "이전 세대 Flash · 1M 컨텍스트 · 프로모션가(2026-12-31까지)",
    noteEn: "Previous-generation Flash · 1M context · promotional pricing (through 2026-12-31)",
    inputPrice: 0.75,
    outputPrice: 3.75,
    cacheRead: 0.075,
    cacheWrite: 0.75,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    // 3.7 Flash 와 같다 — 일부 도메인은 2025-01.
    trainingCutoff: "2026-03",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
    // supportedEfforts 없음 — 문서가 이 모델의 thinking 레벨을 명시하지 않는다.
  },
  {
    id: "google:gemini-3.1-pro-preview",
    provider: "google",
    modelId: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (preview)",
    note: "프리뷰 · 프롬프트 200K 초과 시 전 항목 단가 2배 이상",
    noteEn: "Preview · past a 200K prompt every rate more than doubles",
    inputPrice: 2,
    outputPrice: 12,
    cacheRead: 0.2,
    cacheWrite: 2,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    trainingCutoff: "2025-01",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
    // OpenAI 의 272K 문턱과 같은 규칙이다 — 프롬프트가 200K 를 넘으면 **그 요청 전체**가 상위 구간 요율.
    longContextThresholdTokens: GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 4, cacheRead: 0.4, cacheWrite: 4, outputPrice: 18 },
  },
  {
    id: "google:gemini-3.1-pro-preview-customtools",
    provider: "google",
    modelId: "gemini-3.1-pro-preview-customtools",
    label: "Gemini 3.1 Pro customtools (preview)",
    note: "커스텀 툴(view_file · search_code) + bash 에이전틱 워크플로 특화",
    noteEn: "Tuned for agentic workflows with custom tools (view_file · search_code) plus bash",
    // 3.1 Pro 와 가격·컨텍스트·출력·기준일이 전부 같지만 **별도 엔드포인트**라 항목을 따로 둔다.
    // 별칭(`MODEL_ID_ALIASES`)으로 두면 `canonicalModelId()` 가 저장된 id 를 3.1 Pro 로 덮어써서
    // 정작 이 엔드포인트로는 영영 호출되지 않는다. 커스텀 툴 이점이 없는 작업에서는 품질이 흔들릴 수 있다.
    inputPrice: 2,
    outputPrice: 12,
    cacheRead: 0.2,
    cacheWrite: 2,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    trainingCutoff: "2025-01",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
    longContextThresholdTokens: GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS,
    longContextPricing: { inputPrice: 4, cacheRead: 0.4, cacheWrite: 4, outputPrice: 18 },
  },
  {
    id: "google:gemini-3.5-flash-lite",
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    note: "경량 · 1M 컨텍스트",
    noteEn: "Lightweight · 1M context",
    inputPrice: 0.3,
    outputPrice: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    trainingCutoff: "2026-03",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
  },
  {
    id: "google:gemini-3.1-flash-lite",
    provider: "google",
    modelId: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    note: "경량 · 1M 컨텍스트",
    noteEn: "Lightweight · 1M context",
    inputPrice: 0.25,
    outputPrice: 1.5,
    cacheRead: 0.025,
    cacheWrite: 0.25,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    trainingCutoff: "2025-01",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
    supportedEfforts: EFFORTS_GEMINI_3_1_LITE,
  },
  {
    id: "google:gemini-2.5-flash-lite",
    provider: "google",
    modelId: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    note: "카탈로그 전체 최저가 · 대량 분류 · 서브에이전트용",
    noteEn: "Cheapest in the catalog · bulk classification · subagents",
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheRead: 0.01,
    cacheWrite: 0.1,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    trainingCutoff: "2025-01",
    supportsPromptCaching: true,
    supportsVision: true,
    supportsToolUse: true,
    batchDiscount: 0.5,
  },
];

/**
 * Gemini Developer API 의 **OpenAI 호환** 베이스 주소.
 *
 * `@ai-sdk/google` 을 새로 들이는 대신 이 경로를 `@ai-sdk/openai` 로 부른다(스택 고정).
 * 네이티브 `v1beta/models/...:streamGenerateContent` 가 아니라 `/chat/completions` 라
 * `resolveModel()` 에서도 `.chat()` 을 쓴다 — 구글은 Responses API 를 구현하지 않았다.
 *
 * 이 도메인은 `src-tauri/capabilities/default.json` 의 `http:default` 스코프에도 열려 있어야 한다.
 */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * 로컬 OpenAI 호환 서버의 기본 주소. Ollama 는 11434, LM Studio 는 1234 를 쓴다.
 * (`src-tauri/capabilities/default.json` 이 localhost/127.0.0.1 을 이미 열어 두었다)
 */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/**
 * 로컬 모델의 **표시용 메타데이터 표**. 목록이 아니라 라벨·설명 사전이다.
 *
 * 드롭다운에 무엇이 뜨는지는 여기가 아니라 `fetchLocalModels()` 가 서버의
 * `/v1/models` 에서 읽어온 결과가 정한다 — 여기 있는 태그를 서버가 갖고 있으면
 * `localModelOption()` 이 밋밋한 태그 대신 이 라벨을 입혀 준다.
 */
export const LOCAL_MODEL_PRESETS: ModelOption[] = [
  {
    id: "local:gpt-oss:20b",
    provider: "local",
    modelId: "gpt-oss:20b",
    label: "gpt-oss 20B",
    note: "MXFP4 14GB · 128K · 함수 호출 기본 탑재",
    noteEn: "MXFP4 14GB · 128K · function calling built in",
  },
];

/** 임의의 로컬 태그(`gpt-oss:20b`)를 드롭다운에 넣을 수 있는 형태로 감싼다. */
export function localModelOption(modelId: string): ModelOption {
  const preset = LOCAL_MODEL_PRESETS.find((option) => option.modelId === modelId);
  if (preset) return preset;
  return {
    id: `local:${modelId}`,
    provider: "local",
    modelId,
    label: modelId,
  };
}

/**
 * 드롭다운에 뿌릴 전체 목록.
 * 클라우드 카탈로그 + **로컬 서버가 갖고 있다고 답한 태그**(중복 제거).
 *
 * 프리셋은 여기 섞지 않는다. 안 깔린 모델을 고르면 호출이 404 로 죽는데,
 * 목록만 봐서는 그게 "설치됨" 인지 "추천" 인지 구분할 수 없기 때문이다.
 * 대신 발견된 태그에 프리셋의 라벨·설명을 입힌다(`localModelOption`).
 */
export function buildModelOptions(discoveredLocalModels: string[] = []): ModelOption[] {
  const options = [...MODEL_CATALOG];
  const seen = new Set(options.map((option) => option.id));
  for (const modelId of discoveredLocalModels) {
    const option = localModelOption(modelId);
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  return options;
}

/** 끝의 슬래시만 정리한다. 비어 있으면 기본 주소. */
export function normalizeBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return DEFAULT_LOCAL_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

/**
 * 로컬 서버에 깔린 모델 목록을 읽는다 (OpenAI 호환 `GET /v1/models`).
 * Ollama · LM Studio · vLLM 모두 같은 모양으로 응답한다.
 * 서버가 꺼져 있으면 fetch 가 그대로 실패하므로 호출부에서 잡아 안내한다.
 */
export async function fetchLocalModels(baseUrl?: string): Promise<string[]> {
  const response = await localFetch(`${normalizeBaseUrl(baseUrl)}/models`);
  if (!response.ok) {
    throw new Error(t("error.localServerStatus", { status: response.status, baseUrl: normalizeBaseUrl(baseUrl) }));
  }
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
    .filter(Boolean)
    .sort();
}

export const DEFAULT_MODEL_ID = "google:gemini-3.7-flash";

/**
 * 사고 강도. Anthropic 은 `providerOptionsFor()` 가 실제 요청에 실어 보낸다.
 * OpenAI 는 세대마다 받는 값이 달라서(`supportedEfforts`) 카탈로그에 기록만 해 두고
 * 아직 요청에는 싣지 않는다 — 목록에 없는 값을 보내면 공급자가 거절한다.
 */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Gemini Developer API 키 (Google AI Studio 에서 발급) */
  googleApiKey?: string;
  /** 프록시나 로컬 게이트웨이를 쓸 때. 비우면 각 공급자 기본값 */
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  /** 비우면 `GEMINI_BASE_URL` (OpenAI 호환 경로) */
  googleBaseUrl?: string;
  /** 로컬 OpenAI 호환 서버 주소. 비우면 `DEFAULT_LOCAL_BASE_URL` */
  localBaseUrl?: string;
  /** 로컬 서버가 키를 요구할 때만 (대부분 불필요) */
  localApiKey?: string;
}

export function parseModelId(id: string): { provider: ProviderId; modelId: string } {
  const separator = id.indexOf(":");
  if (separator === -1) {
    // 접두사가 없으면 Anthropic 으로 간주한다 (마이그레이션 편의).
    return { provider: "anthropic", modelId: id };
  }
  const provider = id.slice(0, separator) as ProviderId;
  return { provider, modelId: id.slice(separator + 1) };
}

/**
 * 예전에 쓰던 모델 id → 현재 카탈로그 id.
 * 이미 저장된 `settings.json` 과 DB 의 `context_snapshot` 이 옛 id 를 들고 있어서,
 * 카탈로그의 id 를 바꾸면 드롭다운에서 "직접 입력" 으로 떨어지고
 * 모델 능력 조회(`findModelOption`)도 빗나간다.
 */
const MODEL_ID_ALIASES: Record<string, string> = {
  "anthropic:claude-haiku-4-5": "anthropic:claude-haiku-4-5-20251001",
  // `gpt-5.6` 은 `gpt-5.6-sol` 을 가리키는 같은 세대 별칭이다.
  // 항목을 둘로 만들면 가격표가 두 벌이 되므로 별칭으로만 둔다.
  "openai:gpt-5.6": "openai:gpt-5.6-sol",
  // `daybreak-blue-latest` / `daybreak-red-latest` 는 여기 넣지 않는다.
  // 새 모델이 나오면 가리키는 대상과 가격이 바뀌는 **움직이는** 별칭인데,
  // 이 표는 저장된 id 를 실제로 덮어쓴다(`canonicalModelId`) — 넣으면 최신 추종이
  // 조용히 특정 버전 고정으로 바뀌고, 가격 조회도 옛 대상 것을 물고 있게 된다.
};

/** 옛 id 를 현재 id 로 되돌린다. 모르는 id 는 그대로 통과시킨다. */
export function canonicalModelId(id: string): string {
  return MODEL_ID_ALIASES[id] ?? id;
}

export function findModelOption(id: string): ModelOption | undefined {
  const canonical = canonicalModelId(id);
  return [...MODEL_CATALOG, ...LOCAL_MODEL_PRESETS].find((option) => option.id === canonical);
}

/**
 * 서비스 티어 배수. 티어마다 가격표를 따로 두지 않고 기본 요율에 곱한다
 * (모델이 늘어날 때마다 가격이 티어 수만큼 복제되는 걸 막는다).
 * `fast` 는 2026-07-30 에 `priority` 에서 이름만 바뀐 같은 티어라 값이 같다.
 */
export const SERVICE_TIER_MULTIPLIERS = {
  standard: 1,
  batch: 0.5,
  flex: 0.5,
  fast: 2,
  priority: 2,
} as const;

export type ServiceTier = keyof typeof SERVICE_TIER_MULTIPLIERS;

/**
 * 지역 처리(데이터 레지던시) 엔드포인트 가산. 2026-03-05 이후 출시 모델만 쓸 수 있는데
 * 카탈로그가 출시일을 들고 있지 않아 모델별로 판정하지 않는다 —
 * 호출부가 그 엔드포인트로 보낸다고 알려줄 때만 곱한다.
 */
export const REGIONAL_PROCESSING_MULTIPLIER = 1.1;

export interface PricingQuery {
  /** 이번 요청의 입력 토큰 수. 롱컨텍스트 구간 판정에만 쓴다 */
  inputTokens?: number;
  serviceTier?: ServiceTier;
  /** 지역 처리 엔드포인트로 보내는가 */
  regional?: boolean;
}

/** `null` = 그 모델에 해당 과금 항목이 없다, `undefined` = 값을 모른다. */
export interface EffectivePricing {
  inputPrice?: number;
  outputPrice?: number;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  /** 롱컨텍스트 요율 구간에 들어갔는가 */
  longContext: boolean;
  /** 구간에는 들어갔지만 공개된 요율이 없어 기본 요율을 그대로 쓴 경우 — **과소 추정** */
  longContextRateUnknown: boolean;
  /** 기본 요율에 곱한 값 (서비스 티어 × 지역 처리) */
  multiplier: number;
}

function scale(price: number | null | undefined, multiplier: number) {
  if (price === null || price === undefined) return price;
  return price * multiplier;
}

/**
 * 그 요청에 실제로 적용되는 1M 토큰당 요율.
 *
 * 롱컨텍스트는 **구간 합산이 아니다** — 입력이 문턱을 넘으면 그 요청 전체가
 * 비싼 요율로 계산된다. 그래서 초과분만 따로 곱하지 않고 요율표 자체를 갈아 끼운다.
 * 카탈로그에 없는 모델이면 `undefined`.
 */
export function effectivePricing(id: string, query: PricingQuery = {}): EffectivePricing | undefined {
  const option = findModelOption(id);
  if (!option) return undefined;

  const threshold = option.longContextThresholdTokens;
  const longContext = threshold !== undefined && (query.inputTokens ?? 0) > threshold;
  const long = longContext ? option.longContextPricing : undefined;

  const tier = query.serviceTier ?? "standard";
  // Batch 할인은 모델별로 다를 수 있어 카탈로그 값이 있으면 그쪽을 쓴다.
  const tierMultiplier =
    tier === "batch"
      ? (option.batchDiscount ?? SERVICE_TIER_MULTIPLIERS.batch)
      : SERVICE_TIER_MULTIPLIERS[tier];
  const multiplier = tierMultiplier * (query.regional ? REGIONAL_PROCESSING_MULTIPLIER : 1);

  return {
    inputPrice: scale(long ? long.inputPrice : option.inputPrice, multiplier) ?? undefined,
    outputPrice: scale(long ? long.outputPrice : option.outputPrice, multiplier) ?? undefined,
    cacheRead: scale(long ? long.cacheRead : option.cacheRead, multiplier),
    cacheWrite: scale(long ? long.cacheWrite : option.cacheWrite, multiplier),
    longContext,
    longContextRateUnknown: longContext && !long,
    multiplier,
  };
}

/** 그 모델이 받는 추론 강도 목록. 모르면 `undefined` (호출부가 제한하지 않는다). */
export function supportedEffortsFor(id: string): Effort[] | undefined {
  return findModelOption(id)?.supportedEfforts;
}

/** 안내 문구에 쓰는 공급자 이름. `local` 은 키를 요구하지 않아 목록에 없다. */
const PROVIDER_LABELS: Partial<Record<ProviderId, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
};

export class MissingApiKeyError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(t("error.missingApiKey", { provider: PROVIDER_LABELS[provider] ?? provider }));
    this.name = "MissingApiKeyError";
  }
}

/**
 * 드롭다운에 적을 모델 이름. 로컬 서버 모델만 꼬리표를 붙여 클라우드와 가른다
 * (목록이 한 줄로 이어져 있어 표시가 없으면 어디서 도는 모델인지 안 보인다).
 */
export function modelLabel(option: Pick<ModelOption, "label" | "provider">): string {
  return option.provider === "local" ? `${option.label} ${t("model.localSuffix")}` : option.label;
}

/** 모델 한 줄 설명. 영어 대역이 있으면 화면 언어를 따라간다. */
export function modelNote(option: Pick<ModelOption, "note" | "noteEn">): string | undefined {
  return getLocale() === "en" ? (option.noteEn ?? option.note) : option.note;
}

/** `provider:modelId` 를 AI SDK 의 LanguageModel 인스턴스로 해석한다. */
export function resolveModel(id: string, credentials: ProviderCredentials): LanguageModel {
  const { provider, modelId } = parseModelId(id);

  switch (provider) {
    case "anthropic": {
      const apiKey = credentials.anthropicApiKey?.trim();
      if (!apiKey) throw new MissingApiKeyError("anthropic");
      return createAnthropic({
        apiKey,
        fetch: localFetch,
        headers: ANTHROPIC_DIRECT_HEADERS,
        ...(credentials.anthropicBaseUrl ? { baseURL: credentials.anthropicBaseUrl } : {}),
      })(modelId);
    }
    case "openai": {
      const apiKey = credentials.openaiApiKey?.trim();
      if (!apiKey) throw new MissingApiKeyError("openai");
      return createOpenAI({
        apiKey,
        fetch: localFetch,
        ...(credentials.openaiBaseUrl ? { baseURL: credentials.openaiBaseUrl } : {}),
      })(modelId);
    }
    case "google": {
      const apiKey = credentials.googleApiKey?.trim();
      if (!apiKey) throw new MissingApiKeyError("google");
      // `.chat()` 이 중요하다 — 기본 팩토리는 Responses API 로 가는데
      // Gemini 의 호환 계층은 `/chat/completions` 만 구현했다(로컬 서버와 같은 이유).
      return createOpenAI({
        name: "google",
        apiKey,
        baseURL: credentials.googleBaseUrl?.trim() || GEMINI_BASE_URL,
        fetch: geminiFetch,
      }).chat(modelId);
    }
    case "local": {
      // 로컬 서버는 대부분 인증이 없다. AI SDK 는 키가 비면 예외를 내므로 자리채움을 넣는다.
      // `.chat()` 이 중요하다 — 기본 팩토리는 Responses API 로 가는데,
      // Ollama/LM Studio 가 구현한 건 `/v1/chat/completions` 뿐이다.
      return createOpenAI({
        name: "local",
        apiKey: credentials.localApiKey?.trim() || "local",
        baseURL: normalizeBaseUrl(credentials.localBaseUrl),
        fetch: localFetch,
      }).chat(modelId);
    }
    default:
      throw new Error(t("error.unknownProvider", { provider }));
  }
}

/**
 * 공급자별 옵션. Anthropic 4.6+ 모델은 `temperature` 를 거부하므로 넣지 않고,
 * 대신 adaptive thinking + effort 로 사고량을 조절한다.
 *
 * 다만 이건 **모델마다 다르다**. Haiku 4.5 처럼 adaptive 를 모르는 구형 모델에
 * `thinking`/`effort` 를 보내면 공급자가 400 을 낸다 — 서브에이전트용으로 고르면
 * 바로 터진다. 카탈로그의 `supportsAdaptiveThinking` 을 보고 지원하는 모델에만 붙인다.
 *
 * 구형 `thinking: { type: "enabled", budget_tokens }` 는 켜지 않는다.
 * 예산 토큰 수를 임의로 정해야 하는데 그건 사용자가 결정할 몫이다 — 사고 없이 부른다.
 *
 * 카탈로그에 없는 id(사용자가 직접 넣은 신모델)는 붙이는 쪽을 기본값으로 둔다.
 */
/**
 * 그 모델에 권장되는 사고 강도. 카탈로그에 값이 없으면 `undefined` —
 * 호출부는 현재 설정을 그대로 두면 된다.
 */
export function defaultEffortFor(id: string): Effort | undefined {
  return findModelOption(id)?.defaultEffort;
}

/**
 * 이 모델에 사고 강도를 **실제로 실어 보내는가**.
 *
 * - Anthropic: adaptive thinking 을 아는 모델만. 모르는 모델(Haiku 4.5)에 보내면 400 이다.
 * - OpenAI · Gemini: 카탈로그가 `supportedEfforts` 로 받는 값을 아는 모델만.
 *   세대마다 받는 값이 달라서, 목록을 모르는 모델(사용자가 직접 적은 신모델)에
 *   임의로 보내면 그 역시 400 이다 — 모르면 안 보내는 쪽이 안전하다.
 * - 로컬 서버: 개념 자체가 없다.
 *
 * 설정 화면은 이 값을 보고 드롭다운을 잠그고, 인스펙터는 "미전송" 으로 적는다 —
 * 안 그러면 아무 데도 안 가는 값을 고르게 하고, 간 적 없는 값을 갔다고 보여 준다.
 * `providerOptionsFor()` 가 같은 함수를 쓰므로 화면과 실제 요청이 어긋날 수 없다.
 */
export function sendsEffort(id: string): boolean {
  const { provider } = parseModelId(id);
  if (provider === "local") return false;
  if (provider === "anthropic") return findModelOption(id)?.supportsAdaptiveThinking !== false;
  return supportedEffortsFor(id) !== undefined;
}

/**
 * 이미지를 받는 모델인가.
 *
 * **`MODEL_CATALOG` 은 사용자 소유**라 비어 있는 항목을 우리가 채우지 않는다. 그래서 답은
 * 셋이다 — 카탈로그가 `true` 라고 적어 둔 것, `false` 라고 적어 둔 것, **아무 말이 없는 것**.
 * 아무 말이 없으면 막지 않는다: 지금 카탈로그의 OpenAI 항목들이 그렇고, 이걸 "지원 안 함"
 * 으로 접으면 멀쩡히 이미지를 받는 모델에서 첨부 버튼이 사라진다.
 * 사용자가 어떤 모델을 `false` 로 적어 두면 그때 게이트가 살아난다.
 */
export type VisionSupport = "yes" | "no" | "unknown";

export function visionSupport(id: string): VisionSupport {
  const flag = findModelOption(id)?.supportsVision;
  if (flag === true) return "yes";
  if (flag === false) return "no";
  return "unknown";
}

/**
 * 이미지를 실어 보낼 수 있는가. 화면(첨부 버튼·붙여넣기)과 전송 경로가 같은 함수를 쓴다 —
 * 판정을 UI 에 따로 적으면 반드시 어긋난다.
 */
export function acceptsImages(id: string): boolean {
  return visionSupport(id) !== "no";
}

/** 강도의 크기 순서. "가장 가까운 값" 을 찾을 때의 기준자다. */
const EFFORT_ORDER: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Anthropic 항목에는 `supportedEfforts` 가 없다(문서가 목록을 못박지 않는다).
 * 드롭다운에는 이 범위를 뿌린다 — `none`·`minimal` 은 Anthropic 쪽 값이 아니다.
 */
export const ANTHROPIC_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** 설정 드롭다운에 뿌릴 값 목록. 카탈로그가 아는 모델은 그 모델이 받는 값만 보여 준다. */
export function effortOptionsFor(id: string): Effort[] {
  return supportedEffortsFor(id) ?? ANTHROPIC_EFFORTS;
}

/** 목록 밖 값이면 크기 순서상 가장 가까운 값. 같은 거리면 낮은 쪽(덜 쓰는 쪽)으로 당긴다. */
function nearestEffort(effort: Effort, supported: Effort[]): Effort | undefined {
  const target = EFFORT_ORDER.indexOf(effort);
  let best: Effort | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 이 모델에 **실제로 나가는** 강도. `undefined` 는 안 나간다는 뜻이다.
 *
 * 설정의 강도는 하나인데 모델마다 받는 값이 다르다(GPT-5.6 은 `max` 까지, Gemini 3.7 은
 * `low~high`, 3.7 에 `minimal` 을 보내면 에러). 그래서 목록 밖 값은 **가장 가까운 값으로
 * 당겨서** 보낸다 — 400 으로 턴을 통째로 날리는 것보다 한 칸 옆의 강도로 답을 받는 게 낫다.
 * 무엇으로 당겼는지는 인스펙터가 그대로 보여 준다(같은 함수로 다시 계산한다).
 */
export function resolveEffort(id: string, effort: Effort): Effort | undefined {
  if (!sendsEffort(id)) return undefined;
  const supported = supportedEffortsFor(id);
  if (!supported) return effort;
  return supported.includes(effort) ? effort : nearestEffort(effort, supported);
}

/**
 * 공급자별 사고 옵션. 키가 갈린다:
 * - Anthropic: adaptive thinking + `effort` (`temperature` 는 4.6+ 가 거부한다)
 * - OpenAI · **Gemini**: `openai.reasoningEffort`. Gemini 도 OpenAI 호환 계층(`.chat()`)을
 *   타는데, `@ai-sdk/openai` 의 chat 모델은 providerOptions 를 **`"openai"` 고정 키**로
 *   읽는다(`createOpenAI({ name })` 를 따라가지 않는다). 그래서 `google:` 도 같은 키다.
 *   대신 SDK 가 모델 id 로 추론 모델 여부를 판정하는데(`^gpt-`) `gemini-*` 는 거기 안 걸려
 *   "reasoningEffort is not supported" 경고를 남긴다 — 값은 그대로 실려 나가므로 무해하다.
 */
export function providerOptionsFor(id: string, effort: Effort): ProviderOptions | undefined {
  const resolved = resolveEffort(id, effort);
  if (!resolved) return undefined;

  if (parseModelId(id).provider === "anthropic") {
    return {
      anthropic: {
        thinking: { type: "adaptive" as const, display: "summarized" as const },
        effort: resolved,
      },
    };
  }
  return { openai: { reasoningEffort: resolved } };
}

export function hasCredentialFor(id: string, credentials: ProviderCredentials): boolean {
  const { provider } = parseModelId(id);
  // 로컬 서버는 키가 없는 게 정상이다. 대신 서버가 떠 있는지는 설정에서 확인한다.
  if (provider === "local") return true;
  const key =
    provider === "anthropic"
      ? credentials.anthropicApiKey
      : provider === "google"
        ? credentials.googleApiKey
        : credentials.openaiApiKey;
  return Boolean(key?.trim());
}
