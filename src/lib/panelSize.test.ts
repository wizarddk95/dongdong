import { describe, expect, it } from "vitest";

import {
  CHAT_MIN,
  RIGHT_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampRightWidth,
  clampSidebarWidth,
  defaultRightWidth,
} from "@/lib/panelSize";

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

describe("clampSidebarWidth", () => {
  it("범위 안의 값은 그대로 둔다", () => {
    expect(clampSidebarWidth(300, 1600)).toBe(300);
  });

  it("세션 제목이 사라질 만큼 좁히지 못한다", () => {
    expect(clampSidebarWidth(20, 1600)).toBe(SIDEBAR_MIN);
  });

  it("아무리 끌어도 상한을 넘지 않는다", () => {
    expect(clampSidebarWidth(2000, 4000)).toBe(SIDEBAR_MAX);
  });

  it("창이 좁으면 채팅과 우측 패널의 하한만큼 자리를 내준다", () => {
    // 1000 - 420(채팅) - 320(우측) = 260 만 남는다.
    expect(clampSidebarWidth(400, 1000)).toBe(260);
  });

  it("남는 자리가 없어도 최소 폭은 지킨다 (창이 아주 좁을 때)", () => {
    expect(clampSidebarWidth(400, 500)).toBe(SIDEBAR_MIN);
  });
});
