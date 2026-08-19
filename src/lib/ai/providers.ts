/**
 * 다중 모델 라우팅 레이어.
 *
 * 모델은 `"<provider>:<modelId>"` 형태의 문자열 하나로 식별한다.
 * 새 공급자를 붙이려면 `PROVIDERS` 에 팩토리를 추가하고,
 * `src-tauri/capabilities/default.json` 의 http 스코프에 도메인을 열어주면 된다.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "openai";

export interface ModelOption {
  /** `provider:modelId` — 스토어와 DB 에 저장되는 식별자 */
  id: string;
  provider: ProviderId;
  modelId: string;
  label: string;
  note?: string;
}

/**
 * 웹뷰의 기본 `fetch` 는 브라우저 CORS 정책을 그대로 받는다.
 * Anthropic 은 브라우저 직접 호출을 막고 있어서, Rust(reqwest)를 경유하는
 * Tauri HTTP 플러그인으로 우회한다. 이 플러그인의 응답 body 는 실제
 * `ReadableStream` 이므로 SSE 토큰 스트리밍이 그대로 동작한다.
 */
const localFetch = tauriFetch as unknown as typeof globalThis.fetch;

/** 공급자별 모델 목록. 라벨만 표시용이고 실제 호출에는 `modelId` 를 쓴다. */
export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "anthropic:claude-opus-5",
    provider: "anthropic",
    modelId: "claude-opus-5",
    label: "Claude Opus 5",
    note: "기본값 · 1M 컨텍스트",
  },
  {
    id: "anthropic:claude-sonnet-5",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    note: "빠르고 저렴",
  },
  {
    id: "anthropic:claude-haiku-4-5",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    note: "서브에이전트용",
  },
  {
    id: "openai:gpt-5.6",
    provider: "openai",
    modelId: "gpt-5.6",
    label: "GPT-5.6",
  },
  {
    id: "openai:gpt-5.4-mini",
    provider: "openai",
    modelId: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
  },
];

export const DEFAULT_MODEL_ID = "anthropic:claude-opus-5";

/** Anthropic 만 지원하는 사고 강도. 다른 공급자에서는 무시된다. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** 프록시나 로컬 게이트웨이를 쓸 때. 비우면 각 공급자 기본값 */
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
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

export function findModelOption(id: string): ModelOption | undefined {
  return MODEL_CATALOG.find((option) => option.id === id);
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
    default:
      throw new Error(`알 수 없는 공급자입니다: ${provider}`);
  }
}

/**
 * 공급자별 옵션. Anthropic 4.6+ 모델은 `temperature` 를 거부하므로 넣지 않고,
 * 대신 adaptive thinking + effort 로 사고량을 조절한다.
 */
export function providerOptionsFor(id: string, effort: Effort) {
  const { provider } = parseModelId(id);
  if (provider !== "anthropic") return undefined;

  return {
    anthropic: {
      thinking: { type: "adaptive" as const, display: "summarized" as const },
      effort,
    },
  };
}

export function hasCredentialFor(id: string, credentials: ProviderCredentials): boolean {
  const { provider } = parseModelId(id);
  const key =
    provider === "anthropic" ? credentials.anthropicApiKey : credentials.openaiApiKey;
  return Boolean(key?.trim());
}
