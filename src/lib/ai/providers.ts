/**
 * 다중 모델 라우팅 레이어.
 *
 * 모델은 `"<provider>:<modelId>"` 형태의 문자열 하나로 식별한다.
 * 새 공급자를 붙이려면 `resolveModel()` 에 분기를 추가하고,
 * `src-tauri/capabilities/default.json` 의 http 스코프에 도메인을 열어주면 된다.
 *
 * `local` 은 특정 회사가 아니라 **이 PC 에서 도는 OpenAI 호환 서버**를 가리킨다
 * (Ollama · LM Studio · llama.cpp server · vLLM). 키가 필요 없고 주소만 있으면 된다.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "openai" | "local";

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
  note?: string;

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
   * 캐시 TTL 티어가 없는 공급자(OpenAI)의 캐시 쓰기 단가 (= 입력가 × 1.25).
   * `null` 은 **그 세대에 캐시 쓰기 과금이 없다(무료)** 는 뜻이고,
   * 비워 두면 "모른다" 는 뜻이다 — 0 으로 두면 둘이 구분되지 않는다.
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

/** 추론 강도 지원값은 세대마다 다르다. 목록에 없는 값을 보내면 공급자가 거절한다. */
const EFFORTS_GPT_5_6: Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const EFFORTS_GPT_5_4: Effort[] = ["none", "low", "medium", "high", "xhigh"];
const EFFORTS_GPT_5_3_CODEX: Effort[] = ["low", "medium", "high", "xhigh"];
const EFFORTS_GPT_5: Effort[] = ["minimal", "low", "medium", "high"];

/** 공급자별 모델 목록. 라벨만 표시용이고 실제 호출에는 `modelId` 를 쓴다. */
export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "anthropic:claude-fable-5",
    provider: "anthropic",
    modelId: "claude-fable-5",
    label: "Claude Fable 5",
    note: "최상위 · 1M 컨텍스트 · 사고 항상 켜짐",
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
    note: "기본값 · 1M 컨텍스트",
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
];

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
    label: "gpt-oss 20B (로컬)",
    note: "MXFP4 14GB · 128K · 함수 호출 기본 탑재",
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
    label: `${modelId} (로컬)`,
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
    throw new Error(`로컬 서버가 ${response.status} 를 돌려줬습니다 (${normalizeBaseUrl(baseUrl)})`);
  }
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
    .filter(Boolean)
    .sort();
}

export const DEFAULT_MODEL_ID = "anthropic:claude-opus-5";

/**
 * 사고 강도. Anthropic 은 `providerOptionsFor()` 가 실제 요청에 실어 보낸다.
 * OpenAI 는 세대마다 받는 값이 달라서(`supportedEfforts`) 카탈로그에 기록만 해 두고
 * 아직 요청에는 싣지 않는다 — 목록에 없는 값을 보내면 공급자가 거절한다.
 */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** 프록시나 로컬 게이트웨이를 쓸 때. 비우면 각 공급자 기본값 */
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
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

export class MissingApiKeyError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(
      provider === "anthropic"
        ? "Anthropic API 키가 없습니다. 우측 상단 설정에서 입력하세요."
        : "OpenAI API 키가 없습니다. 우측 상단 설정에서 입력하세요.",
    );
    this.name = "MissingApiKeyError";
  }
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
      throw new Error(`알 수 없는 공급자입니다: ${provider}`);
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

export function providerOptionsFor(id: string, effort: Effort) {
  const { provider } = parseModelId(id);
  if (provider !== "anthropic") return undefined;
  if (findModelOption(id)?.supportsAdaptiveThinking === false) return undefined;

  return {
    anthropic: {
      thinking: { type: "adaptive" as const, display: "summarized" as const },
      effort,
    },
  };
}

export function hasCredentialFor(id: string, credentials: ProviderCredentials): boolean {
  const { provider } = parseModelId(id);
  // 로컬 서버는 키가 없는 게 정상이다. 대신 서버가 떠 있는지는 설정에서 확인한다.
  if (provider === "local") return true;
  const key =
    provider === "anthropic" ? credentials.anthropicApiKey : credentials.openaiApiKey;
  return Boolean(key?.trim());
}
