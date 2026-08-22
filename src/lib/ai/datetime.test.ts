import { describe, expect, it } from "vitest";

import { datetimeBlock, describeNow, formatOffset } from "@/lib/ai/datetime";

describe("formatOffset", () => {
  it("부호와 두 자리를 맞춘다", () => {
    expect(formatOffset(540)).toBe("UTC+09:00");
    expect(formatOffset(0)).toBe("UTC+00:00");
    expect(formatOffset(-330)).toBe("UTC-05:30");
    expect(formatOffset(-480)).toBe("UTC-08:00");
  });
});

describe("describeNow", () => {
  it("로컬 시각을 요일까지 적는다", () => {
    // 로컬 게터로 조립하므로 테스트를 도는 기계의 시간대와 무관하게 형식이 같다.
    const now = new Date(2026, 7, 22, 14, 3, 0);
    const info = describeNow(now);
    expect(info.local).toBe("2026-08-22 (토) 14:03");
    expect(info.year).toBe(2026);
    expect(info.iso).toBe(now.toISOString());
    expect(info.offset).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });

  it("한 자리 수도 두 자리로 채운다", () => {
    expect(describeNow(new Date(2026, 0, 5, 9, 7, 0)).local).toBe("2026-01-05 (월) 09:07");
  });
});

describe("datetimeBlock", () => {
  const block = datetimeBlock(new Date(2026, 7, 22, 14, 3, 0));

  it("제목과 시각을 싣는다", () => {
    expect(block).toContain("# 현재 시각");
    expect(block).toContain("2026-08-22 (토) 14:03");
  });

  it("이 값을 무엇에 쓸지까지 못 박는다", () => {
    // 시각만 적어 두면 모델이 읽고도 습관대로 옛 연도를 쓴다.
    expect(block).toContain("올해는 2026년입니다");
    expect(block).toContain("학습 시점의 연도를 쓰지 말고");
  });
});
