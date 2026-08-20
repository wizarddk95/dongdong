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

/**
 * 로컬 OpenAI 호환 서버의 기본 주소. Ollama 는 11434, LM Studio 는 1234 를 쓴다.
 * (`src-tauri/capabilities/default.json` 이 localhost/127.0.0.1 을 이미 열어 두었다)
 */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/**
 * 로컬 오픈소스 모델 프리셋 — 16GB VRAM(RTX 5080) 기준으로 고른 것들.
 * 여기 목록은 "추천"일 뿐이고, 실제로 무엇이 깔려 있는지는
 * `fetchLocalModels()` 가 서버의 `/v1/models` 에서 직접 읽어온다.
 */
export const LOCAL_MODEL_PRESETS: ModelOption[] = [
  {
    id: "local:gpt-oss:20b",
    provider: "local",
    modelId: "gpt-oss:20b",
    label: "gpt-oss 20B (로컬)",
    note: "MXFP4 14GB · 128K · 함수 호출 기본 탑재 — 16GB 첫 후보",
  },
  {
    id: "local:qwen3-coder:30b",
    provider: "local",
    modelId: "qwen3-coder:30b",
    label: "Qwen3-Coder 30B-A3B (로컬)",
    note: "Q4 19GB · 256K · 코딩 최강이지만 16GB 는 일부 CPU 오프로드",
  },
  {
    id: "local:devstral:24b",
    provider: "local",
    modelId: "devstral:24b",
    label: "Devstral 24B (로컬)",
    note: "Q4 ~14GB · 에이전트용으로 학습된 밀집 모델",
  },
  {
    id: "local:qwen3:14b",
    provider: "local",
    modelId: "qwen3:14b",
    label: "Qwen3 14B (로컬)",
    note: "Q4 ~11GB · VRAM 안에 완전히 들어가 가장 빠름",
  },
];

/** 임의의 로컬 태그(`qwen3-coder:30b`)를 드롭다운에 넣을 수 있는 형태로 감싼다. */
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
 * 클라우드 카탈로그 + 로컬 프리셋 + 서버에서 실제로 발견된 태그(중복 제거).
 */
export function buildModelOptions(discoveredLocalModels: string[] = []): ModelOption[] {
  const options = [...MODEL_CATALOG, ...LOCAL_MODEL_PRESETS];
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

/** Anthropic 만 지원하는 사고 강도. 다른 공급자에서는 무시된다. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

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

export function findModelOption(id: string): ModelOption | undefined {
  return [...MODEL_CATALOG, ...LOCAL_MODEL_PRESETS].find((option) => option.id === id);
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
  // 로컬 서버는 키가 없는 게 정상이다. 대신 서버가 떠 있는지는 설정에서 확인한다.
  if (provider === "local") return true;
  const key =
    provider === "anthropic" ? credentials.anthropicApiKey : credentials.openaiApiKey;
  return Boolean(key?.trim());
}
