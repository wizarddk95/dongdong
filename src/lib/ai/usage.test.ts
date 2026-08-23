import { describe, expect, it } from "vitest";

import {
  contextStatus,
  estimateCost,
  formatCost,
  formatTokens,
  formatUsd,
  readChainUsage,
  readNodeUsage,
  readUsage,
  summarizeLiveUsage,
  summarizeProjectUsage,
  summarizeSessionUsage,
  toStoredUsage,
  uncachedInputTokens,
  type Usage,
} from "@/lib/ai/usage";
import type { Message, SessionOverview } from "@/types/ipc";

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

function node(partial: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sessionId: "s1",
    parentId: null,
    role: "assistant",
    content: "",
    toolCalls: null,
    toolResults: null,
    contextSnapshot: null,
    tokenUsage: null,
    status: "complete",
    agentId: null,
    seq: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function overview(partial: Partial<SessionOverview> = {}): SessionOverview {
  return {
    id: "s1",
    projectId: "p1",
    title: "세션",
    parentSessionId: null,
    branchedFromMessageId: null,
    model: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    messageCount: 0,
    lastMessageAt: null,
    preview: null,
    agentRunCount: 0,
    usageByModel: [],
    lastUsage: null,
    lastUsageModel: null,
    ...partial,
  };
}

describe("readUsage", () => {
  it("AI SDK v7 의 중첩된 모양을 평평하게 접는다", () => {
    expect(
      readUsage({
        inputTokens: 1_000,
        inputTokenDetails: { noCacheTokens: 600, cacheReadTokens: 300, cacheWriteTokens: 100 },
        outputTokens: 200,
        outputTokenDetails: { textTokens: 150, reasoningTokens: 50 },
        totalTokens: 1_200,
      }),
    ).toEqual({
      inputTokens: 1_000,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1_200,
    });
  });

  it("옛 이름(cachedInputTokens)도 읽는다", () => {
    const parsed = readUsage({ inputTokens: 900, cachedInputTokens: 300, outputTokens: 40 });
    expect(parsed?.cacheReadTokens).toBe(300);
    // totalTokens 가 없으면 입력+출력으로 채운다.
    expect(parsed?.totalTokens).toBe(940);
  });

  it("저장해 둔 평평한 모양을 그대로 되읽는다", () => {
    const stored = toStoredUsage("anthropic:claude-opus-5", usage({ inputTokens: 10, outputTokens: 5 }));
    expect(stored?.modelId).toBe("anthropic:claude-opus-5");
    expect(readUsage(stored)?.inputTokens).toBe(10);
  });

  it("숫자가 하나도 없으면 null", () => {
    expect(readUsage(null)).toBeNull();
    expect(readUsage("usage")).toBeNull();
    expect(readUsage({ reasoning: "생각 중" })).toBeNull();
  });
});

describe("uncachedInputTokens", () => {
  it("전체 입력에서 캐시 몫을 뺀 것이 정가 청구분", () => {
    expect(
      uncachedInputTokens(usage({ inputTokens: 1_000, cacheReadTokens: 300, cacheWriteTokens: 100 })),
    ).toBe(600);
  });

  it("공급자 값이 어긋나도 음수가 되지 않는다", () => {
    expect(uncachedInputTokens(usage({ inputTokens: 100, cacheReadTokens: 300 }))).toBe(0);
  });
});

describe("estimateCost", () => {
  it("항목마다 제 요율을 쓴다 (캐시 쓰기는 5분 요율)", () => {
    const cost = estimateCost(
      "anthropic:claude-opus-5",
      usage({
        inputTokens: 100_000,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 10_000,
        outputTokens: 2_000,
      }),
    );

    expect(cost.input).toBeCloseTo(0.25); // 50K × $5/1M
    expect(cost.cacheRead).toBeCloseTo(0.02); // 40K × $0.5/1M
    expect(cost.cacheWrite).toBeCloseTo(0.0625); // 10K × $6.25/1M
    expect(cost.output).toBeCloseTo(0.05); // 2K × $25/1M
    expect(cost.total).toBeCloseTo(0.3825);
    expect(cost.unpriced).toBe(false);
    expect(cost.underestimated).toBe(false);
  });

  it("호출 하나면 롱컨텍스트 구간을 따진다", () => {
    const heavy = usage({ inputTokens: 300_000, outputTokens: 1_000 });
    const cost = estimateCost("openai:gpt-5.6-sol", heavy, { inputTokens: 300_000 });

    expect(cost.longContext).toBe(true);
    expect(cost.input).toBeCloseTo(3); // 300K × $10/1M (기본가 $5 가 아니다)
    expect(cost.output).toBeCloseTo(0.045); // 1K × $45/1M
  });

  it("합계에는 롱컨텍스트 판정을 걸지 않는다 (없던 요금이 생긴다)", () => {
    // 작은 호출 여러 번을 더해 문턱을 넘긴 값 — 실제로는 전부 기본 요율이었다.
    const summed = usage({ inputTokens: 300_000, outputTokens: 1_000 });
    const cost = estimateCost("openai:gpt-5.6-sol", summed);

    expect(cost.longContext).toBe(false);
    expect(cost.input).toBeCloseTo(1.5); // 300K × $5/1M
  });

  it("요율표에 없는 모델은 금액 대신 그 사실을 남긴다", () => {
    const cost = estimateCost("local:qwen3:8b", usage({ inputTokens: 5_000, outputTokens: 500 }));
    expect(cost.unpriced).toBe(true);
    expect(cost.total).toBe(0);
    expect(formatCost(cost, "local:qwen3:8b")).toBe("로컬");
  });

  it("모델을 모르면 계산하지 않는다", () => {
    expect(estimateCost(null, usage({ inputTokens: 100 })).unpriced).toBe(true);
  });
});

describe("contextStatus", () => {
  it("마지막 호출의 입력+출력이 다음 턴에 다시 실린다", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 700_000, cacheReadTokens: 600_000, outputTokens: 50_000 }),
    );

    expect(status.used).toBe(750_000);
    expect(status.cached).toBe(600_000);
    expect(status.window).toBe(1_000_000);
    expect(status.remaining).toBe(250_000);
    expect(status.ratio).toBeCloseTo(0.75);
    expect(status.level).toBe("danger");
  });

  // 문턱을 낮게 잡았다 — 창이 꽉 차기 한참 전에 갈아타라고 미리 말한다.
  it("4분의 1을 넘기면 주의, 5분의 2를 넘기면 위험", () => {
    const window = 200_000; // haiku 4.5
    const levelAt = (ratio: number) =>
      contextStatus("anthropic:claude-haiku-4-5", usage({ inputTokens: window * ratio })).level;

    expect(levelAt(0.24)).toBe("ok");
    expect(levelAt(0.25)).toBe("warn");
    expect(levelAt(0.39)).toBe("warn");
    expect(levelAt(0.4)).toBe("danger");
  });

  it("거의 가득 차면 danger", () => {
    expect(
      contextStatus("anthropic:claude-haiku-4-5", usage({ inputTokens: 190_000 })).level,
    ).toBe("danger");
  });

  it("창 크기를 모르는 모델은 비율을 만들어 내지 않는다", () => {
    const status = contextStatus("local:qwen3:8b", usage({ inputTokens: 4_000 }));
    expect(status.used).toBe(4_000);
    expect(status.window).toBeNull();
    expect(status.ratio).toBeNull();
    expect(status.level).toBe("unknown");
  });

  it("아직 호출이 없으면 0 에서 시작한다", () => {
    const status = contextStatus("anthropic:claude-opus-5", null);
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(1_000_000);
    expect(status.level).toBe("ok");
  });

  it("분모는 다음 턴에 쓸 모델의 창이다 — 모델을 바꾸면 여유가 달라진다", () => {
    const measured = usage({ inputTokens: 150_000, outputTokens: 2_000 });

    // 200K 짜리 haiku 로 재고 haiku 로 계속 쓰면 4분의 3이 찼다.
    const staying = contextStatus("anthropic:claude-haiku-4-5", measured);
    expect(staying.ratio).toBeCloseTo(0.76);
    expect(staying.level).toBe("danger");
    expect(staying.approximate).toBe(false);

    // 같은 대화를 1M 짜리 모델로 이어 보내면 같은 토큰이라도 한참 여유롭다.
    const switched = contextStatus("anthropic:claude-opus-5", measured, "anthropic:claude-haiku-4-5");
    expect(switched.used).toBe(152_000);
    expect(switched.window).toBe(1_000_000);
    expect(switched.ratio).toBeCloseTo(0.152);
    expect(switched.level).toBe("ok");
  });

  it("실측에 못을 박고 늘어난 만큼만 환산한다", () => {
    // 마지막 호출: 78,000자 페이로드를 27,000 토큰으로 실측 → 2.888…자/토큰
    // 지금 나갈 페이로드는 81,000자 = 3,000자가 늘었다 → 약 1,038 토큰.
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      { chars: 81_000, messageCount: 26, measuredChars: 78_000 },
    );

    expect(status.measuredTokens).toBe(27_000);
    expect(status.projectedTokens).toBe(1_038);
    expect(status.used).toBe(28_038);
    expect(status.estimated).toBe(true);
    expect(status.charsPerToken).toBeCloseTo(2.889, 3);
    // 인스펙터와 대조할 수 있게 페이로드 크기를 그대로 들고 다닌다.
    expect(status.chars).toBe(81_000);
    expect(status.messageCount).toBe(26);
  });

  it("앞쪽 노드로 분기하면 페이로드가 줄어 환산분이 음수가 된다", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      { chars: 39_000, messageCount: 12, measuredChars: 78_000 },
    );

    expect(status.projectedTokens).toBe(-13_500);
    expect(status.used).toBe(13_500);
  });

  it("페이로드가 그대로면 환산분이 없어 실측값 그대로다", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      { chars: 78_000, messageCount: 25, measuredChars: 78_000 },
    );

    expect(status.used).toBe(27_000);
    expect(status.estimated).toBe(false);
  });

  it("이미지 토큰은 자 수 환산에서 빼고 따로 더한다", () => {
    // 마지막 호출: 27,000 토큰 중 2,000 은 이미지 몫이다 → 글의 비율은 78,000 / 25,000 = 3.12자/토큰.
    // 이걸 빼지 않으면 78,000 / 27,000 = 2.889 가 되어 남은 대화를 과소평가한다.
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      {
        chars: 81_000,
        messageCount: 26,
        measuredChars: 78_000,
        imageTokens: 2_000,
        measuredImageTokens: 2_000,
      },
    );

    expect(status.charsPerToken).toBeCloseTo(3.12, 3);
    // 3,000자 늘었고 이미지는 그대로 → 3,000 / 3.12 ≈ 962
    expect(status.projectedTokens).toBe(962);
    expect(status.used).toBe(27_962);
  });

  it("이미지를 새로 붙이면 그 장수만큼 토큰이 는다 (환산이 아니라 공식으로)", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      {
        chars: 78_000,
        messageCount: 26,
        measuredChars: 78_000,
        // 앞선 호출에는 이미지가 없었고, 지금 1,048 토큰짜리 한 장을 붙였다.
        imageTokens: 1_048,
        measuredImageTokens: 0,
      },
    );

    // 자 수는 그대로이므로 늘어난 몫은 이미지뿐이다.
    expect(status.projectedTokens).toBe(1_048);
    expect(status.used).toBe(28_048);
    expect(status.estimated).toBe(true);
  });

  it("이미지를 뺀 분기는 그만큼 줄어든다", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      {
        chars: 78_000,
        messageCount: 26,
        measuredChars: 78_000,
        imageTokens: 0,
        measuredImageTokens: 1_048,
      },
    );

    expect(status.projectedTokens).toBe(-1_048);
    expect(status.used).toBe(25_952);
  });

  it("이미지 필드가 없는 옛 호출도 그대로 굴러간다", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
      "anthropic:claude-opus-5",
      { chars: 81_000, messageCount: 26, measuredChars: 78_000 },
    );

    expect(status.projectedTokens).toBe(1_038);
  });

  it("페이로드를 모르면(세션 카드) 마지막 호출의 입력+출력으로 물러난다", () => {
    const status = contextStatus(
      "anthropic:claude-opus-5",
      usage({ inputTokens: 27_000, outputTokens: 600 }),
    );

    expect(status.used).toBe(27_600);
    expect(status.estimated).toBe(false);
    expect(status.charsPerToken).toBeNull();
  });

  it("잰 모델과 쓸 모델이 다르면 근사치라고 표시한다 (토크나이저가 다르다)", () => {
    const measured = usage({ inputTokens: 27_000, outputTokens: 500 });

    expect(contextStatus("google:gemini-3.7-flash", measured, "anthropic:claude-haiku-4-5").approximate).toBe(
      true,
    );
    // 같은 모델로 한 턴 돌리고 나면 실측값이므로 근사 표시가 사라진다.
    expect(
      contextStatus("google:gemini-3.7-flash", measured, "google:gemini-3.7-flash").approximate,
    ).toBe(false);
    // 아직 아무 호출도 없으면 어긋날 값 자체가 없다.
    expect(contextStatus("google:gemini-3.7-flash", null, "anthropic:claude-haiku-4-5").approximate).toBe(
      false,
    );
  });
});

describe("readNodeUsage", () => {
  it("usage 에 박힌 모델을 가장 먼저 믿는다", () => {
    const message = node({
      tokenUsage: { inputTokens: 100, outputTokens: 10, modelId: "anthropic:claude-sonnet-5" },
      contextSnapshot: { modelId: "anthropic:claude-opus-5" },
    });
    expect(readNodeUsage(message, "anthropic:claude-fable-5")?.modelId).toBe(
      "anthropic:claude-sonnet-5",
    );
  });

  it("옛 노드는 컨텍스트 스냅샷의 모델로 되돌린다", () => {
    const message = node({
      tokenUsage: { inputTokens: 100, outputTokens: 10 },
      contextSnapshot: { modelId: "anthropic:claude-opus-5" },
    });
    expect(readNodeUsage(message)?.modelId).toBe("anthropic:claude-opus-5");
  });

  it("사용량이 없는 노드는 null", () => {
    expect(readNodeUsage(node({ role: "user", content: "안녕" }))).toBeNull();
  });
});

describe("readChainUsage", () => {
  it("체인의 노드들을 더하고 마지막 호출의 모델을 대표로 삼는다", () => {
    const chain = [
      node({ id: "a", role: "user" }),
      node({
        id: "b",
        tokenUsage: { inputTokens: 1_000, outputTokens: 100, modelId: "anthropic:claude-opus-5" },
      }),
      node({
        id: "c",
        tokenUsage: { inputTokens: 2_000, outputTokens: 200, modelId: "anthropic:claude-sonnet-5" },
      }),
    ];

    const chained = readChainUsage(chain);
    expect(chained.usage.inputTokens).toBe(3_000);
    expect(chained.usage.outputTokens).toBe(300);
    expect(chained.modelId).toBe("anthropic:claude-sonnet-5");
    // 노드마다 제 모델의 요율로 계산한 뒤 더한다.
    expect(chained.cost.total).toBeCloseTo(1_000 * 5e-6 + 100 * 25e-6 + 2_000 * 2e-6 + 200 * 10e-6);
  });
});

describe("summarizeSessionUsage", () => {
  it("모델마다 따로 요금을 매긴 뒤 더한다", () => {
    const summary = summarizeSessionUsage(
      overview({
        usageByModel: [
          {
            modelId: "anthropic:claude-opus-5",
            calls: 3,
            inputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          {
            modelId: "anthropic:claude-sonnet-5",
            calls: 2,
            inputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        ],
      }),
    );

    expect(summary.calls).toBe(5);
    expect(summary.modelCount).toBe(2);
    expect(summary.usage.inputTokens).toBe(2_000_000);
    // 같은 토큰이라도 단가가 다르다: $5 + $2. 먼저 합쳤다면 어느 쪽이든 틀린다.
    expect(summary.cost.total).toBeCloseTo(7);
  });

  it("호출이 없던 세션은 빈 요약", () => {
    expect(summarizeSessionUsage(overview()).calls).toBe(0);
    expect(summarizeSessionUsage(overview()).cost.total).toBe(0);
  });
});

describe("summarizeLiveUsage", () => {
  it("노드와 위임 실행을 함께 센다", () => {
    const messages = [
      node({
        id: "a",
        tokenUsage: { inputTokens: 1_000, outputTokens: 100, modelId: "anthropic:claude-opus-5" },
      }),
      node({
        id: "b",
        tokenUsage: { inputTokens: 2_000, outputTokens: 200, modelId: "anthropic:claude-opus-5" },
      }),
    ];
    const runs = [
      { tokenUsage: { inputTokens: 500, outputTokens: 50, modelId: "anthropic:claude-sonnet-5" } },
      // 아직 안 끝난 실행은 토큰이 없다.
      { tokenUsage: null },
    ];

    const summary = summarizeLiveUsage(messages, runs);
    expect(summary.calls).toBe(3);
    expect(summary.usage.inputTokens).toBe(3_500);
    expect(summary.modelCount).toBe(2);
    // 토큰을 더 많이 쓴 쪽이 대표 모델
    expect(summary.primaryModelId).toBe("anthropic:claude-opus-5");
  });
});

describe("summarizeProjectUsage", () => {
  it("세션을 가로질러 모델별로 합친다", () => {
    const row = (modelId: string, inputTokens: number) => ({
      modelId,
      calls: 1,
      inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });

    const total = summarizeProjectUsage([
      overview({ id: "s1", usageByModel: [row("anthropic:claude-opus-5", 1_000_000)] }),
      overview({
        id: "s2",
        usageByModel: [
          row("anthropic:claude-opus-5", 1_000_000),
          row("anthropic:claude-sonnet-5", 1_000_000),
        ],
      }),
    ]);

    expect(total.calls).toBe(3);
    expect(total.modelCount).toBe(2);
    expect(total.cost.total).toBeCloseTo(12); // $5 + $5 + $2
  });
});

describe("표시 형식", () => {
  it("아주 작은 금액도 0 으로 뭉개지 않는다", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00004)).toBe("$0.00004");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.42)).toBe("$0.420");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("토큰 수는 자리에 맞춰 줄인다", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2K");
    expect(formatTokens(123_456)).toBe("123K");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });

  it("요율을 모르는 항목이 있으면 '이상' 임을 밝힌다", () => {
    const cost = {
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total: 1,
      underestimated: true,
      unpriced: false,
      longContext: false,
    };
    expect(formatCost(cost, "anthropic:claude-opus-5")).toBe("≥$1.00");
  });
});
