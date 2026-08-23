import { describe, expect, it } from "vitest";

import {
  fitWithinMaxEdge,
  imageTokens,
  MAX_IMAGE_EDGE,
  sumImageTokens,
} from "@/lib/ai/imageTokens";

describe("imageTokens — 공급자마다 다른 공식", () => {
  it("Anthropic 은 넓이×높이÷750", () => {
    expect(imageTokens("anthropic:claude-opus-5", { width: 1000, height: 750 })).toBe(1000);
    expect(imageTokens("anthropic:claude-opus-5", { width: 1568, height: 1568 })).toBe(
      Math.ceil((1568 * 1568) / 750),
    );
  });

  it("접두사가 없으면 Anthropic 으로 본다 (`parseModelId` 와 같은 판정)", () => {
    expect(imageTokens("claude-opus-5", { width: 1000, height: 750 })).toBe(1000);
  });

  it("Google 은 384px 안이면 한 장 값, 넘으면 768 타일마다 258", () => {
    expect(imageTokens("google:gemini-3.1-pro", { width: 384, height: 384 })).toBe(258);
    expect(imageTokens("google:gemini-3.1-pro", { width: 100, height: 100 })).toBe(258);
    // 769×769 → 2×2 타일
    expect(imageTokens("google:gemini-3.1-pro", { width: 769, height: 769 })).toBe(258 * 4);
    // 한 변만 커도 타일이 는다
    expect(imageTokens("google:gemini-3.1-pro", { width: 1000, height: 300 })).toBe(258 * 2);
  });

  it("OpenAI 는 768 로 줄인 뒤 512 타일마다 170 + 기본 85", () => {
    // 512×512 → 타일 하나
    expect(imageTokens("openai:gpt-5.6-sol", { width: 512, height: 512 })).toBe(85 + 170);
    // 768×768 → 2×2 타일 (짧은 변이 이미 768 이라 축소가 없다)
    expect(imageTokens("openai:gpt-5.6-sol", { width: 768, height: 768 })).toBe(85 + 170 * 4);
  });

  it("아주 큰 이미지도 OpenAI 쪽은 상자에 맞춰 접힌다", () => {
    // 4096×4096 → 2048 상자 → 짧은 변 768 → 768×768 → 4타일
    expect(imageTokens("openai:gpt-5.6-sol", { width: 4096, height: 4096 })).toBe(85 + 170 * 4);
  });

  it("픽셀을 모르면 0 이 아니라 null 이다 (0 으로 접으면 게이지가 조용히 거짓말한다)", () => {
    expect(imageTokens("anthropic:claude-opus-5", null)).toBeNull();
    expect(imageTokens("anthropic:claude-opus-5", { width: 0, height: 100 })).toBeNull();
    expect(imageTokens("anthropic:claude-opus-5", { width: -5, height: 100 })).toBeNull();
  });

  it("합계는 모르는 장을 빼고 센다", () => {
    const total = sumImageTokens("anthropic:claude-opus-5", [
      { width: 1000, height: 750 },
      null,
      { width: 1000, height: 750 },
    ]);
    expect(total).toBe(2000);
  });
});

describe("fitWithinMaxEdge — 얼마로 줄일지는 여기서만 정한다", () => {
  it("이미 작으면 그대로 둔다", () => {
    expect(fitWithinMaxEdge({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(fitWithinMaxEdge({ width: MAX_IMAGE_EDGE, height: 10 })).toEqual({
      width: MAX_IMAGE_EDGE,
      height: 10,
    });
  });

  it("긴 변을 상한에 맞추고 비율을 지킨다", () => {
    const fitted = fitWithinMaxEdge({ width: 3840, height: 2160 });
    expect(fitted.width).toBe(MAX_IMAGE_EDGE);
    expect(fitted.height).toBe(Math.round((2160 * MAX_IMAGE_EDGE) / 3840));
    expect(Math.max(fitted.width, fitted.height)).toBe(MAX_IMAGE_EDGE);
  });

  it("세로로 긴 이미지는 높이가 상한이 된다", () => {
    const fitted = fitWithinMaxEdge({ width: 500, height: 5000 });
    expect(fitted.height).toBe(MAX_IMAGE_EDGE);
    expect(fitted.width).toBe(Math.round((500 * MAX_IMAGE_EDGE) / 5000));
  });

  it("극단적으로 가는 이미지도 0px 가 되지 않는다", () => {
    const fitted = fitWithinMaxEdge({ width: 100_000, height: 1 });
    expect(fitted.width).toBe(MAX_IMAGE_EDGE);
    expect(fitted.height).toBeGreaterThanOrEqual(1);
  });
});
