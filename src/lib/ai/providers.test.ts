import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import type { LanguageModel } from "ai";

import type { Effort } from "@/lib/ai/providers";
import {
  ANTHROPIC_EFFORTS,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODEL_ID,
  GEMINI_BASE_URL,
  GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS,
  LOCAL_MODEL_PRESETS,
  LONG_CONTEXT_THRESHOLD_TOKENS,
  MODEL_CATALOG,
  MissingApiKeyError,
  REGIONAL_PROCESSING_MULTIPLIER,
  buildModelOptions,
  canonicalModelId,
  defaultEffortFor,
  effectivePricing,
  fetchLocalModels,
  findModelOption,
  hasCredentialFor,
  normalizeBaseUrl,
  parseModelId,
  providerOptionsFor,
  effortOptionsFor,
  resolveEffort,
  resolveModel,
  sendsEffort,
  supportedEffortsFor,
} from "@/lib/ai/providers";
import { toModelMessages } from "@/lib/ai/runner";
import type { Message } from "@/types/ipc";

function node(partial: Partial<Message> & Pick<Message, "role" | "content">): Message {
  return {
    id: "m1",
    sessionId: "s1",
    parentId: null,
    toolCalls: null,
    toolResults: null,
    contextSnapshot: null,
    tokenUsage: null,
    status: "complete",
    agentId: null,
    seq: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("parseModelId", () => {
  it("provider:modelId 를 분리한다", () => {
    expect(parseModelId("anthropic:claude-opus-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    expect(parseModelId("openai:gpt-5.6")).toEqual({ provider: "openai", modelId: "gpt-5.6" });
  });

  it("모델 id 안의 콜론은 첫 번째만 구분자로 쓴다", () => {
    expect(parseModelId("openai:org:model")).toEqual({ provider: "openai", modelId: "org:model" });
  });

  it("접두사가 없으면 anthropic 으로 본다", () => {
    expect(parseModelId("claude-opus-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
  });
});

describe("모델 카탈로그", () => {
  it("기본 모델이 카탈로그에 있다", () => {
    expect(findModelOption(DEFAULT_MODEL_ID)).toBeDefined();
    expect(DEFAULT_MODEL_ID).toBe("google:gemini-3.7-flash");
  });

  it("카탈로그의 id 는 provider 필드와 일치한다", () => {
    for (const option of [...MODEL_CATALOG, ...LOCAL_MODEL_PRESETS]) {
      expect(option.id).toBe(`${option.provider}:${option.modelId}`);
    }
  });

  it("로컬 프리셋도 findModelOption 으로 찾힌다", () => {
    expect(findModelOption("local:gpt-oss:20b")?.provider).toBe("local");
  });

  it("모델 태그 안의 콜론이 있어도 provider 는 local 로 파싱된다", () => {
    expect(parseModelId("local:gpt-oss:20b")).toEqual({
      provider: "local",
      modelId: "gpt-oss:20b",
    });
  });
});

describe("로컬 모델 목록 구성", () => {
  it("서버에서 발견한 것이 없으면 로컬 항목도 없다", () => {
    // 프리셋을 미리 깔아 두면 안 깔린 모델을 고를 수 있게 되고, 호출은 404 로 죽는다.
    const options = buildModelOptions();
    expect(options).toEqual(MODEL_CATALOG);
    expect(options.some((option) => option.provider === "local")).toBe(false);
  });

  it("서버가 알려준 태그만 클라우드 카탈로그 뒤에 붙인다", () => {
    const options = buildModelOptions(["gpt-oss:20b", "llama3.2:3b"]);
    expect(options.slice(0, MODEL_CATALOG.length)).toEqual(MODEL_CATALOG);
    expect(options.filter((option) => option.provider === "local").map((o) => o.id)).toEqual([
      "local:gpt-oss:20b",
      "local:llama3.2:3b",
    ]);
  });

  it("같은 태그가 두 번 와도 한 번만 넣는다", () => {
    const ids = buildModelOptions(["gpt-oss:20b", "gpt-oss:20b"]).map((option) => option.id);
    expect(ids.filter((id) => id === "local:gpt-oss:20b")).toHaveLength(1);
  });

  it("발견된 태그에는 프리셋의 라벨·설명을 입힌다", () => {
    const [preset] = LOCAL_MODEL_PRESETS;
    const found = buildModelOptions([preset.modelId]).find((option) => option.id === preset.id);
    expect(found).toEqual(preset);
    // 프리셋에 없는 태그는 태그 그대로 보여 준다.
    const unknown = buildModelOptions(["llama3.2:3b"]).find((o) => o.id === "local:llama3.2:3b");
    expect(unknown?.label).toBe("llama3.2:3b (로컬)");
    expect(unknown?.note).toBeUndefined();
  });
});

describe("normalizeBaseUrl", () => {
  it("비어 있으면 Ollama 기본 주소", () => {
    expect(normalizeBaseUrl()).toBe(DEFAULT_LOCAL_BASE_URL);
    expect(normalizeBaseUrl("   ")).toBe(DEFAULT_LOCAL_BASE_URL);
  });

  it("끝의 슬래시만 정리한다", () => {
    expect(normalizeBaseUrl("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });
});

describe("자격 증명 게이트", () => {
  it("해당 공급자의 키가 있어야 true", () => {
    const credentials = { anthropicApiKey: "sk-ant-x", openaiApiKey: "" };
    expect(hasCredentialFor("anthropic:claude-opus-5", credentials)).toBe(true);
    expect(hasCredentialFor("openai:gpt-5.6", credentials)).toBe(false);
  });

  it("공백뿐인 키는 없는 것으로 본다", () => {
    expect(hasCredentialFor("anthropic:claude-opus-5", { anthropicApiKey: "   " })).toBe(false);
  });

  it("키 없이 모델을 만들면 MissingApiKeyError", () => {
    expect(() => resolveModel("anthropic:claude-opus-5", {})).toThrow(MissingApiKeyError);
    expect(() => resolveModel("openai:gpt-5.6", {})).toThrow(MissingApiKeyError);
  });

  it("로컬 서버는 키 없이도 통과한다", () => {
    expect(hasCredentialFor("local:gpt-oss:20b", {})).toBe(true);
    expect(resolveModel("local:gpt-oss:20b", {})).toBeTruthy();
  });

  it("키가 있으면 모델 인스턴스를 만든다", () => {
    const model = resolveModel("anthropic:claude-opus-5", { anthropicApiKey: "sk-ant-test" });
    expect(model).toBeTruthy();
  });
});

describe("resolveEffort · effortOptionsFor", () => {
  it("모델이 받는 값이면 그대로 나간다", () => {
    expect(resolveEffort("openai:gpt-5.6-terra", "xhigh")).toBe("xhigh");
    expect(resolveEffort("google:gemini-3.1-flash-lite", "minimal")).toBe("minimal");
  });

  it("목록 밖이면 크기 순서상 가장 가까운 값으로 당긴다", () => {
    // Gemini 3.7 은 low~high 만 받는다.
    expect(resolveEffort("google:gemini-3.7-flash", "max")).toBe("high");
    expect(resolveEffort("google:gemini-3.7-flash", "xhigh")).toBe("high");
    expect(resolveEffort("google:gemini-3.7-flash", "minimal")).toBe("low");
    expect(resolveEffort("google:gemini-3.7-flash", "none")).toBe("low");
    // GPT-5 세대는 minimal~high 만 받는다.
    expect(resolveEffort("openai:gpt-5", "max")).toBe("high");
    expect(resolveEffort("openai:gpt-5", "none")).toBe("minimal");
  });

  it("목록이 없는 Anthropic 은 고른 값을 그대로 보낸다", () => {
    expect(resolveEffort("anthropic:claude-opus-5", "max")).toBe("max");
  });

  it("안 나가는 모델은 undefined", () => {
    expect(resolveEffort("local:gpt-oss:20b", "high")).toBeUndefined();
    expect(resolveEffort("anthropic:claude-haiku-4-5-20251001", "high")).toBeUndefined();
  });

  it("당긴 값도 그 모델이 받는 값 안에 있다 (카탈로그 전체)", () => {
    const everyEffort: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const option of MODEL_CATALOG) {
      for (const effort of everyEffort) {
        const resolved = resolveEffort(option.id, effort);
        if (resolved === undefined) continue;
        const supported = supportedEffortsFor(option.id);
        if (supported) expect(supported).toContain(resolved);
      }
    }
  });

  it("드롭다운 목록은 그 모델이 받는 값이다", () => {
    expect(effortOptionsFor("google:gemini-3.7-flash")).toEqual(["low", "medium", "high"]);
    expect(effortOptionsFor("openai:gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // Anthropic 은 카탈로그에 목록이 없다 → 공통 범위를 쓴다.
    expect(effortOptionsFor("anthropic:claude-opus-5")).toEqual(ANTHROPIC_EFFORTS);
  });

  it("드롭다운에 뿌린 값은 그대로 나간다 (당겨지지 않는다)", () => {
    for (const option of MODEL_CATALOG) {
      if (!sendsEffort(option.id)) continue;
      for (const effort of effortOptionsFor(option.id)) {
        expect(resolveEffort(option.id, effort)).toBe(effort);
      }
    }
  });
});

describe("providerOptionsFor", () => {
  it("Anthropic 은 adaptive thinking + effort 를 붙인다", () => {
    expect(providerOptionsFor("anthropic:claude-opus-5", "xhigh")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
    });
  });

  it("adaptive 를 지원하는 모델에는 모두 붙는다", () => {
    for (const id of [
      "anthropic:claude-fable-5",
      "anthropic:claude-opus-5",
      "anthropic:claude-sonnet-5",
    ]) {
      expect(providerOptionsFor(id, "high")).toMatchObject({
        anthropic: { thinking: { type: "adaptive" } },
      });
    }
  });

  it("adaptive 를 모르는 모델(Haiku 4.5)에는 thinking·effort 를 보내지 않는다", () => {
    // 보내면 공급자가 400 을 낸다.
    expect(providerOptionsFor("anthropic:claude-haiku-4-5-20251001", "high")).toBeUndefined();
    // 옛 id 로 저장돼 있어도 마찬가지여야 한다.
    expect(providerOptionsFor("anthropic:claude-haiku-4-5", "high")).toBeUndefined();
  });

  it("카탈로그에 없는 Anthropic 모델은 붙이는 쪽이 기본값", () => {
    expect(providerOptionsFor("anthropic:claude-opus-6", "max")).toMatchObject({
      anthropic: { effort: "max" },
    });
  });

  it("OpenAI 는 reasoningEffort 로 붙인다", () => {
    expect(providerOptionsFor("openai:gpt-5.6-terra", "max")).toEqual({
      openai: { reasoningEffort: "max" },
    });
    // 별칭으로 저장돼 있어도 같은 값이 나가야 한다.
    expect(providerOptionsFor("openai:gpt-5.6", "none")).toEqual({
      openai: { reasoningEffort: "none" },
    });
  });

  it("Gemini 도 `openai` 키를 쓴다 — SDK 의 chat 모델이 그 키로만 읽는다", () => {
    // `createOpenAI({ name: "google" })` 의 이름을 따라가지 않는다(@ai-sdk/openai).
    expect(providerOptionsFor("google:gemini-3.7-flash", "high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("모델이 안 받는 값은 가장 가까운 값으로 당겨서 보낸다", () => {
    // 설정은 하나뿐인데 모델마다 받는 값이 다르다 → 400 대신 한 칸 옆으로.
    expect(providerOptionsFor("google:gemini-3.7-flash", "max")).toEqual({
      openai: { reasoningEffort: "high" },
    });
    expect(providerOptionsFor("google:gemini-3.7-flash", "minimal")).toEqual({
      openai: { reasoningEffort: "low" },
    });
  });

  it("로컬 서버와 목록을 모르는 모델에는 붙이지 않는다", () => {
    expect(providerOptionsFor("local:gpt-oss:20b", "high")).toBeUndefined();
    // 카탈로그에 없는 OpenAI·Gemini 모델은 받는 값을 모른다 → 안 보낸다.
    expect(providerOptionsFor("openai:gpt-9-turbo", "high")).toBeUndefined();
    expect(providerOptionsFor("google:gemini-9-flash", "high")).toBeUndefined();
  });
});

describe("sendsEffort", () => {
  it("adaptive 를 아는 Anthropic 모델만 사고 강도를 실어 보낸다", () => {
    expect(sendsEffort("anthropic:claude-opus-5")).toBe(true);
    expect(sendsEffort("anthropic:claude-fable-5")).toBe(true);
  });

  it("adaptive 를 모르는 Anthropic 모델에는 안 보낸다 (보내면 400)", () => {
    expect(sendsEffort("anthropic:claude-haiku-4-5-20251001")).toBe(false);
  });

  it("OpenAI·Gemini 는 카탈로그가 받는 값을 아는 모델에만 보낸다", () => {
    expect(sendsEffort("openai:gpt-5.6-terra")).toBe(true);
    expect(sendsEffort("google:gemini-3.7-flash")).toBe(true);
    // 목록을 모르면 무엇을 보내도 400 이 날 수 있다 → 안 보낸다.
    expect(supportedEffortsFor("openai:gpt-9-turbo")).toBeUndefined();
    expect(sendsEffort("openai:gpt-9-turbo")).toBe(false);
  });

  it("로컬 서버는 사고 강도 개념이 없다", () => {
    expect(sendsEffort("local:gpt-oss:20b")).toBe(false);
  });

  it("카탈로그에 없는 Anthropic 모델은 보내는 쪽이 기본값", () => {
    // Anthropic 은 목록이 아니라 adaptive 지원 여부로 갈린다 — 모르면 붙인다.
    expect(sendsEffort("anthropic:claude-future-9")).toBe(true);
  });

  it("providerOptionsFor 와 판정이 어긋나지 않는다 (설정 화면이 이걸 보고 잠근다)", () => {
    for (const option of [...MODEL_CATALOG, ...LOCAL_MODEL_PRESETS]) {
      expect(providerOptionsFor(option.id, "high") !== undefined).toBe(sendsEffort(option.id));
    }
  });
});

describe("defaultEffortFor", () => {
  it("권장값이 있는 모델은 그 값을 돌려준다", () => {
    expect(defaultEffortFor("anthropic:claude-opus-5")).toBe("high");
    expect(defaultEffortFor("anthropic:claude-sonnet-5")).toBe("high");
  });

  it("권장값이 없으면 undefined (현재 설정을 그대로 둔다)", () => {
    expect(defaultEffortFor("anthropic:claude-fable-5")).toBeUndefined();
    expect(defaultEffortFor("anthropic:claude-haiku-4-5-20251001")).toBeUndefined();
    expect(defaultEffortFor("local:qwen3:14b")).toBeUndefined();
    expect(defaultEffortFor("anthropic:claude-opus-6")).toBeUndefined();
  });
});

describe("canonicalModelId", () => {
  it("옛 모델 id 를 현재 카탈로그 id 로 되돌린다", () => {
    expect(canonicalModelId("anthropic:claude-haiku-4-5")).toBe(
      "anthropic:claude-haiku-4-5-20251001",
    );
    expect(findModelOption("anthropic:claude-haiku-4-5")?.label).toBe("Claude Haiku 4.5");
  });

  it("모르는 id 는 그대로 통과시킨다", () => {
    expect(canonicalModelId("local:qwen3:14b")).toBe("local:qwen3:14b");
  });
});

describe("toModelMessages", () => {
  it("system 노드는 제외한다 (system 은 별도 인자로 전달)", () => {
    const chain = [
      node({ id: "a", role: "system", content: "너는 에이전트다" }),
      node({ id: "b", role: "user", content: "안녕" }),
    ];
    expect(toModelMessages(chain)).toEqual([{ role: "user", content: "안녕" }]);
  });

  it("스트리밍 중이거나 실패한 노드는 컨텍스트에 넣지 않는다", () => {
    const chain = [
      node({ id: "a", role: "user", content: "질문" }),
      node({ id: "b", role: "assistant", content: "부분 응답", status: "streaming" }),
      node({ id: "c", role: "assistant", content: "실패", status: "error" }),
    ];
    expect(toModelMessages(chain)).toEqual([{ role: "user", content: "질문" }]);
  });

  it("내용이 빈 노드는 건너뛴다", () => {
    const chain = [
      node({ id: "a", role: "user", content: "  " }),
      node({ id: "b", role: "assistant", content: "응답" }),
    ];
    expect(toModelMessages(chain)).toEqual([{ role: "assistant", content: "응답" }]);
  });

  it("순서를 보존한다", () => {
    const chain = [
      node({ id: "a", role: "user", content: "1" }),
      node({ id: "b", role: "assistant", content: "2" }),
      node({ id: "c", role: "user", content: "3" }),
    ];
    expect(toModelMessages(chain).map((m) => m.content)).toEqual(["1", "2", "3"]);
  });
});

describe("Anthropic 요청 헤더", () => {
  it("브라우저 직접 호출 허용 헤더를 붙인다 (Tauri 가 Origin 을 강제로 넣는다)", async () => {
    // 실제 전송은 mock 으로 가로채고, 헤더만 확인한다.
    const { fetch: mockFetch } = await import("@tauri-apps/plugin-http");
    const spy = vi.mocked(mockFetch);
    spy.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "stub", message: "stub" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }) as never,
    );

    // resolveModel 의 반환 타입은 `string | LanguageModelV3` 유니온이라 좁혀 준다.
    const model = resolveModel("anthropic:claude-opus-5", {
      anthropicApiKey: "sk-ant-test",
    }) as Exclude<LanguageModel, string>;
    try {
      // 응답은 stub 이라 파싱에서 실패한다. 여기서는 나간 헤더만 본다.
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "안녕" }] }],
      });
    } catch {
      // 무시
    }

    expect(spy).toHaveBeenCalled();
    const headers = new Headers(spy.mock.calls[0][1]?.headers as HeadersInit);
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
  });
});

describe("로컬 서버 호출", () => {
  it("`/v1/models` 를 읽어 태그만 뽑아 정렬한다", async () => {
    const { fetch: mockFetch } = await import("@tauri-apps/plugin-http");
    const spy = vi.mocked(mockFetch);
    spy.mockReset();
    spy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "qwen3:14b" }, { id: "gpt-oss:20b" }, {}] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as never,
    );

    await expect(fetchLocalModels("http://localhost:11434/v1/")).resolves.toEqual([
      "gpt-oss:20b",
      "qwen3:14b",
    ]);
    expect(spy.mock.calls[0][0]).toBe("http://localhost:11434/v1/models");
  });

  it("Responses API 가 아니라 /chat/completions 로 보낸다 (Ollama 는 이것만 구현한다)", async () => {
    const { fetch: mockFetch } = await import("@tauri-apps/plugin-http");
    const spy = vi.mocked(mockFetch);
    spy.mockReset();
    spy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "stub" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }) as never,
    );

    const model = resolveModel("local:gpt-oss:20b", {
      localBaseUrl: "http://127.0.0.1:1234/v1",
    }) as Exclude<LanguageModel, string>;
    try {
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "안녕" }] }],
      });
    } catch {
      // 응답이 stub 이라 파싱에서 실패한다. 여기서는 나간 주소만 본다.
    }

    expect(spy.mock.calls[0][0]).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).model).toBe("gpt-oss:20b");
  });
});

describe("Anthropic 모델 메타데이터", () => {
  const anthropic = MODEL_CATALOG.filter((option) => option.provider === "anthropic");

  it("Anthropic 항목은 가격·컨텍스트 정보를 모두 갖는다", () => {
    expect(anthropic).toHaveLength(4);
    for (const option of anthropic) {
      expect(option.inputPrice).toBeGreaterThan(0);
      expect(option.outputPrice).toBeGreaterThan(0);
      expect(option.contextWindow).toBeGreaterThan(0);
      expect(option.maxOutput).toBeGreaterThan(0);
      expect(option.trainingCutoff).toMatch(/^\d{4}-\d{2}$/);
      expect(option.supportsPromptCaching).toBe(true);
      expect(option.batchDiscount).toBe(0.5);
    }
  });

  it("캐시 단가는 입력가의 배수 규칙(×1.25 / ×2 / ×0.1)을 지킨다", () => {
    for (const option of anthropic) {
      const input = option.inputPrice!;
      expect(option.cacheWrite5m).toBeCloseTo(input * 1.25, 10);
      expect(option.cacheWrite1h).toBeCloseTo(input * 2, 10);
      expect(option.cacheRead).toBeCloseTo(input * 0.1, 10);
    }
  });

  it("adaptive 를 모르는 모델에는 defaultEffort 를 달지 않는다", () => {
    // effort 는 adaptive thinking 모델에만 있는 파라미터다. 달아 두면 400 을 부른다.
    for (const option of anthropic) {
      if (option.supportsAdaptiveThinking) continue;
      expect(option.defaultEffort).toBeUndefined();
    }
  });

  it("adaptive 와 구형 extended thinking 은 동시에 켜지지 않는다", () => {
    for (const option of anthropic) {
      expect(option.supportsAdaptiveThinking && option.supportsExtendedThinking).toBe(false);
    }
  });
});

describe("OpenAI 모델 메타데이터", () => {
  const openai = MODEL_CATALOG.filter((option) => option.provider === "openai");

  it("OpenAI 항목은 가격·컨텍스트 정보를 모두 갖는다", () => {
    expect(openai).toHaveLength(13);
    for (const option of openai) {
      expect(option.inputPrice).toBeGreaterThan(0);
      expect(option.outputPrice).toBeGreaterThan(0);
      expect(option.contextWindow).toBeGreaterThan(0);
      expect(option.maxOutput).toBe(128_000);
      expect(option.trainingCutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(option.batchDiscount).toBe(0.5);
    }
  });

  it("캐시 읽기는 세대와 무관하게 입력가의 10%", () => {
    for (const option of openai) {
      if (!option.supportsPromptCaching) {
        // 캐싱이 없는 Pro 계열은 "0 원" 이 아니라 "과금 항목 없음" 이다.
        expect(option.cacheRead).toBeNull();
        continue;
      }
      expect(option.cacheRead).toBeCloseTo(option.inputPrice! * 0.1, 10);
    }
  });

  it("캐시 쓰기 과금은 GPT-5.6 세대에만 있고(= 입력가 × 1.25) 그 이전은 null", () => {
    for (const option of openai) {
      if (option.modelId.startsWith("gpt-5.6")) {
        expect(option.cacheWrite).toBeCloseTo(option.inputPrice! * 1.25, 10);
      } else {
        // undefined("모른다") 가 아니라 null("무료") 이어야 구분이 산다.
        expect(option.cacheWrite).toBeNull();
      }
    }
  });

  it("롱컨텍스트 요율은 입력 2배 · 출력 1.5배 규칙을 지킨다", () => {
    const withLongContext = openai.filter((option) => option.longContextPricing);
    expect(withLongContext.map((option) => option.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
    ]);
    for (const option of withLongContext) {
      const long = option.longContextPricing!;
      expect(option.longContextThresholdTokens).toBe(LONG_CONTEXT_THRESHOLD_TOKENS);
      expect(long.inputPrice).toBeCloseTo(option.inputPrice! * 2, 10);
      expect(long.outputPrice).toBeCloseTo(option.outputPrice! * 1.5, 10);
      if (long.cacheRead !== null) expect(long.cacheRead).toBeCloseTo(long.inputPrice * 0.1, 10);
    }
  });

  it("Cyber 는 문턱만 알고 요율은 공개돼 있지 않다", () => {
    const cyber = findModelOption("openai:gpt-5.6-cyber")!;
    expect(cyber.longContextThresholdTokens).toBe(LONG_CONTEXT_THRESHOLD_TOKENS);
    expect(cyber.longContextPricing).toBeNull();
  });

  it("Responses API 전용 모델을 플래그로 구분한다", () => {
    const only = openai.filter((option) => option.responsesApiOnly).map((option) => option.modelId);
    expect(only).toEqual(["gpt-5.5-pro", "gpt-5.4-pro", "gpt-5.3-codex"]);
  });

  it("추론 강도 지원값은 세대마다 다르다", () => {
    expect(supportedEffortsFor("openai:gpt-5.6-terra")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(supportedEffortsFor("openai:gpt-5.4")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(supportedEffortsFor("openai:gpt-5.3-codex")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(supportedEffortsFor("openai:gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
    // Anthropic 항목에는 목록이 없다 — 호출부가 제한하지 않는다.
    expect(supportedEffortsFor("anthropic:claude-opus-5")).toBeUndefined();
  });

  it("gpt-5.6 은 sol 의 별칭이고 항목을 따로 만들지 않는다", () => {
    expect(canonicalModelId("openai:gpt-5.6")).toBe("openai:gpt-5.6-sol");
    expect(findModelOption("openai:gpt-5.6")?.label).toBe("GPT-5.6 Sol");
    expect(openai.filter((option) => option.modelId === "gpt-5.6")).toHaveLength(0);
  });

  it("움직이는 별칭(daybreak-*)은 가격을 들고 있는 항목으로도 별칭으로도 넣지 않는다", () => {
    // 대상 모델이 바뀌면 가격이 통째로 달라진다 — 고정하면 조용히 틀린 값을 쓴다.
    for (const id of ["openai:daybreak-blue-latest", "openai:daybreak-red-latest"]) {
      expect(findModelOption(id)).toBeUndefined();
      expect(canonicalModelId(id)).toBe(id);
    }
  });
});

describe("Google Gemini 모델 메타데이터", () => {
  const google = MODEL_CATALOG.filter((option) => option.provider === "google");

  it("Gemini 항목은 가격·컨텍스트 정보를 모두 갖는다", () => {
    expect(google).toHaveLength(7);
    for (const option of google) {
      expect(option.inputPrice).toBeGreaterThan(0);
      expect(option.outputPrice).toBeGreaterThan(0);
      expect(option.contextWindow).toBe(1_048_576);
      expect(option.maxOutput).toBe(65_536);
      expect(option.trainingCutoff).toMatch(/^\d{4}-\d{2}$/);
      expect(option.batchDiscount).toBe(0.5);
      expect(option.supportsPromptCaching).toBe(true);
    }
  });

  it("캐시 읽기는 입력가의 10%", () => {
    for (const option of google) {
      expect(option.cacheRead).toBeCloseTo(option.inputPrice! * 0.1, 10);
    }
  });

  it("캐시 쓰기는 입력가와 같다 — Gemini 는 생성 요금이 따로 없고 입력 단가로 받는다", () => {
    for (const option of google) {
      // `null`(무료) 로 두면 estimateCost 가 그 토큰을 0 원으로 세어 과소 추정한다.
      expect(option.cacheWrite).toBeCloseTo(option.inputPrice!, 10);
    }
  });

  it("계층 요율은 3.1 Pro 계열만 갖고 문턱은 200K", () => {
    const tiered = google.filter((option) => option.longContextPricing);
    expect(tiered.map((option) => option.modelId)).toEqual([
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
    for (const option of tiered) {
      expect(option.longContextThresholdTokens).toBe(GEMINI_LONG_CONTEXT_THRESHOLD_TOKENS);
      const long = option.longContextPricing!;
      expect(long.inputPrice).toBe(4);
      expect(long.outputPrice).toBe(18);
      expect(long.cacheRead).toBe(0.4);
      // 상위 구간에서도 캐시 생성은 그 구간의 입력 단가로 과금된다.
      expect(long.cacheWrite).toBe(long.inputPrice);
    }
  });

  it("customtools 는 별칭이 아니라 별도 항목이다 (엔드포인트가 다르다)", () => {
    // 별칭으로 두면 canonicalModelId 가 저장된 id 를 3.1 Pro 로 덮어써서 호출이 빗나간다.
    const id = "google:gemini-3.1-pro-preview-customtools";
    expect(canonicalModelId(id)).toBe(id);
    expect(findModelOption(id)?.modelId).toBe("gemini-3.1-pro-preview-customtools");
  });

  it("제외하기로 한 모델은 카탈로그에 없다", () => {
    for (const modelId of [
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]) {
      expect(findModelOption(`google:${modelId}`)).toBeUndefined();
    }
  });

  it("thinking 레벨은 문서가 명시한 모델만 갖는다", () => {
    // 3.7 Flash 는 `minimal` 을 받지 않는다 — 보내면 에러다.
    expect(supportedEffortsFor("google:gemini-3.7-flash")).toEqual(["low", "medium", "high"]);
    expect(supportedEffortsFor("google:gemini-3.1-flash-lite")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    // 나머지는 공개된 목록이 없다 → undefined (호출부가 제한하지 않는다).
    expect(supportedEffortsFor("google:gemini-3.6-flash")).toBeUndefined();
  });

  it("Anthropic 전용 옵션(adaptive thinking)은 붙이지 않는다", () => {
    const options = providerOptionsFor("google:gemini-3.7-flash", "high");
    expect(options).toEqual({ openai: { reasoningEffort: "high" } });
    expect(options?.anthropic).toBeUndefined();
  });

  it("2.5 Flash-Lite 가 카탈로그 전체 최저가다", () => {
    const cheapest = [...MODEL_CATALOG].sort((a, b) => a.inputPrice! - b.inputPrice!)[0];
    expect(cheapest.id).toBe("google:gemini-2.5-flash-lite");
  });
});

describe("Gemini 계층 요율", () => {
  it("문턱 이하면 기본 요율", () => {
    const pricing = effectivePricing("google:gemini-3.1-pro-preview", { inputTokens: 200_000 })!;
    expect(pricing.longContext).toBe(false);
    expect(pricing.inputPrice).toBe(2);
    expect(pricing.outputPrice).toBe(12);
    expect(pricing.cacheRead).toBe(0.2);
  });

  it("200K 를 1 토큰만 넘어도 요청 전체가 상위 구간 요율", () => {
    const pricing = effectivePricing("google:gemini-3.1-pro-preview", { inputTokens: 200_001 })!;
    expect(pricing.longContext).toBe(true);
    expect(pricing.inputPrice).toBe(4);
    expect(pricing.outputPrice).toBe(18);
    expect(pricing.cacheRead).toBe(0.4);
    expect(pricing.longContextRateUnknown).toBe(false);
  });

  it("Flash 계열은 프롬프트가 아무리 커도 구간이 바뀌지 않는다", () => {
    const pricing = effectivePricing("google:gemini-3.7-flash", { inputTokens: 1_000_000 })!;
    expect(pricing.longContext).toBe(false);
  });
});

describe("Gemini 호출", () => {
  it("OpenAI 호환 경로의 /chat/completions 로 보낸다 (구글은 Responses API 가 없다)", async () => {
    const { fetch: mockFetch } = await import("@tauri-apps/plugin-http");
    const spy = vi.mocked(mockFetch);
    spy.mockReset();
    spy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "stub" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }) as never,
    );

    const model = resolveModel("google:gemini-3.7-flash", {
      googleApiKey: "AIza-test",
    }) as Exclude<LanguageModel, string>;
    try {
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "안녕" }] }],
      });
    } catch {
      // 응답이 stub 이라 파싱에서 실패한다. 여기서는 나간 주소·모델만 본다.
    }

    expect(spy.mock.calls[0][0]).toBe(`${GEMINI_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).model).toBe("gemini-3.7-flash");
    const headers = new Headers(spy.mock.calls[0][1]?.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer AIza-test");
  });

  it("키가 없으면 MissingApiKeyError 를 던진다", () => {
    expect(() => resolveModel("google:gemini-3.7-flash", {})).toThrow(MissingApiKeyError);
    expect(() => resolveModel("google:gemini-3.7-flash", {})).toThrow(/Google Gemini/);
    expect(hasCredentialFor("google:gemini-3.7-flash", { openaiApiKey: "sk-test" })).toBe(false);
    expect(hasCredentialFor("google:gemini-3.7-flash", { googleApiKey: "AIza-test" })).toBe(true);
  });
});

describe("effectivePricing", () => {
  it("문턱 이하면 기본 요율", () => {
    const pricing = effectivePricing("openai:gpt-5.6-sol", { inputTokens: 272_000 })!;
    expect(pricing.longContext).toBe(false);
    expect(pricing.inputPrice).toBe(5);
    expect(pricing.outputPrice).toBe(30);
    expect(pricing.cacheWrite).toBe(6.25);
    expect(pricing.multiplier).toBe(1);
  });

  it("문턱을 1 토큰만 넘어도 요청 전체가 롱컨텍스트 요율", () => {
    const pricing = effectivePricing("openai:gpt-5.6-sol", { inputTokens: 272_001 })!;
    expect(pricing.longContext).toBe(true);
    expect(pricing.inputPrice).toBe(10);
    expect(pricing.cacheRead).toBe(1);
    expect(pricing.cacheWrite).toBe(12.5);
    expect(pricing.outputPrice).toBe(45);
  });

  it("롱컨텍스트 요율이 공개되지 않은 모델은 그 사실을 알린다", () => {
    const pricing = effectivePricing("openai:gpt-5.6-cyber", { inputTokens: 300_000 })!;
    expect(pricing.longContext).toBe(true);
    expect(pricing.longContextRateUnknown).toBe(true);
    // 기본 요율을 그대로 돌려주므로 호출부는 과소 추정임을 알아야 한다.
    expect(pricing.inputPrice).toBe(12.5);
  });

  it("문턱이 없는 모델은 입력이 아무리 커도 구간이 바뀌지 않는다", () => {
    const pricing = effectivePricing("openai:gpt-5.1", { inputTokens: 399_000 })!;
    expect(pricing.longContext).toBe(false);
    expect(pricing.longContextRateUnknown).toBe(false);
  });

  it("서비스 티어는 가격표가 아니라 배수로 적용된다", () => {
    expect(effectivePricing("openai:gpt-5.6-terra", { serviceTier: "batch" })?.inputPrice).toBe(1);
    expect(effectivePricing("openai:gpt-5.6-terra", { serviceTier: "flex" })?.outputPrice).toBe(6);
    // fast 는 2026-07-30 에 priority 에서 개명된 같은 티어다.
    expect(effectivePricing("openai:gpt-5.6-terra", { serviceTier: "fast" })?.inputPrice).toBe(4);
    expect(effectivePricing("openai:gpt-5.6-terra", { serviceTier: "priority" })?.inputPrice).toBe(
      4,
    );
  });

  it("티어 배수와 롱컨텍스트 요율은 함께 걸린다", () => {
    const pricing = effectivePricing("openai:gpt-5.6-terra", {
      inputTokens: 500_000,
      serviceTier: "batch",
    })!;
    expect(pricing.inputPrice).toBe(2);
    expect(pricing.outputPrice).toBe(9);
    expect(pricing.multiplier).toBe(0.5);
  });

  it("지역 처리 엔드포인트는 10% 가산", () => {
    const pricing = effectivePricing("openai:gpt-5.6-terra", { regional: true })!;
    expect(pricing.multiplier).toBeCloseTo(REGIONAL_PROCESSING_MULTIPLIER, 10);
    expect(pricing.inputPrice).toBeCloseTo(2.2, 10);
  });

  it("과금 항목이 없는 자리(null)는 배수를 곱해도 null 로 남는다", () => {
    const pricing = effectivePricing("openai:gpt-5.4", { serviceTier: "batch" })!;
    expect(pricing.cacheWrite).toBeNull();
    expect(pricing.cacheRead).toBeCloseTo(0.125, 10);
  });

  it("Anthropic 항목도 같은 함수로 조회된다", () => {
    const pricing = effectivePricing("anthropic:claude-opus-5", { serviceTier: "batch" })!;
    expect(pricing.inputPrice).toBe(2.5);
    expect(pricing.longContext).toBe(false);
  });

  it("카탈로그에 없는 모델은 undefined", () => {
    expect(effectivePricing("openai:gpt-9")).toBeUndefined();
  });
});
