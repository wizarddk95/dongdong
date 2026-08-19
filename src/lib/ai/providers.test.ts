import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  MissingApiKeyError,
  findModelOption,
  hasCredentialFor,
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
    for (const option of MODEL_CATALOG) {
      expect(option.id).toBe(`${option.provider}:${option.modelId}`);
    }
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
