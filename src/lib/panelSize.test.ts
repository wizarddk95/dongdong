import { describe, expect, it } from "vitest";

import { CHAT_MIN, RIGHT_MIN, clampRightWidth, defaultRightWidth } from "@/lib/panelSize";

describe("clampRightWidth", () => {
  it("범위 안의 값은 그대로 둔다", () => {
    expect(clampRightWidth(600, 1600)).toBe(600);
  });

  it("우측 패널이 최소 폭 아래로 내려가지 않는다", () => {
    expect(clampRightWidth(50, 1600)).toBe(RIGHT_MIN);
  });

  it("채팅 영역 최소 폭을 남긴다", () => {
    expect(clampRightWidth(1500, 1600)).toBe(1600 - CHAT_MIN);
  });

  it("창이 두 하한보다 좁으면 반씩 나눈다", () => {
    expect(clampRightWidth(900, 600)).toBe(300);
  });

  it("소수점 좌표는 정수로 떨어진다", () => {
    expect(clampRightWidth(600.4, 1600)).toBe(600);
  });
});

describe("defaultRightWidth", () => {
  it("넓은 창에서는 비율대로 잡는다", () => {
    expect(defaultRightWidth(1600)).toBe(640);
  });

  it("좁은 창에서도 최소 폭을 지킨다", () => {
    expect(defaultRightWidth(800)).toBe(RIGHT_MIN);
  });
});
