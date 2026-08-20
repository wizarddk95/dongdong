import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import type { LanguageModel } from "ai";

import {
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODEL_ID,
  LOCAL_MODEL_PRESETS,
  MODEL_CATALOG,
  MissingApiKeyError,
  buildModelOptions,
  fetchLocalModels,
  findModelOption,
  hasCredentialFor,
  normalizeBaseUrl,
  parseModelId,
  providerOptionsFor,
  resolveModel,
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
    expect(DEFAULT_MODEL_ID).toBe("anthropic:claude-opus-5");
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
  it("클라우드 카탈로그 뒤에 로컬 프리셋을 붙인다", () => {
    const options = buildModelOptions();
    expect(options.slice(0, MODEL_CATALOG.length)).toEqual(MODEL_CATALOG);
    expect(options).toEqual(expect.arrayContaining(LOCAL_MODEL_PRESETS));
  });

  it("서버에서 발견한 태그를 추가하되 프리셋과 중복되면 한 번만 넣는다", () => {
    const options = buildModelOptions(["gpt-oss:20b", "llama3.2:3b"]);
    const ids = options.map((option) => option.id);
    expect(ids.filter((id) => id === "local:gpt-oss:20b")).toHaveLength(1);
    expect(ids).toContain("local:llama3.2:3b");
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

describe("providerOptionsFor", () => {
  it("Anthropic 은 adaptive thinking + effort 를 붙인다", () => {
    const options = providerOptionsFor("anthropic:claude-opus-5", "xhigh");
    expect(options?.anthropic.thinking.type).toBe("adaptive");
    expect(options?.anthropic.effort).toBe("xhigh");
  });

  it("다른 공급자에는 붙이지 않는다", () => {
    expect(providerOptionsFor("openai:gpt-5.6", "high")).toBeUndefined();
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
