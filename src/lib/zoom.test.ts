import { describe, expect, it } from "vitest";

import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  isDefaultZoom,
  zoomIn,
  zoomOut,
  zoomPercent,
} from "@/lib/zoom";

describe("clampZoom", () => {
  it("범위를 벗어난 값을 자른다", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(1.3)).toBe(1.3);
  });

  it("숫자가 아니면 기본값 — settings.json 은 손으로 고쳐질 수 있다", () => {
    expect(clampZoom(undefined)).toBe(DEFAULT_ZOOM);
    expect(clampZoom("1.5")).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });
});

describe("계단", () => {
  it("오름차순이다 — 두 방향이 같은 계단을 밟으려면 순서가 맞아야 한다", () => {
    const sorted = [...ZOOM_STEPS].sort((a, b) => a - b);
    expect([...ZOOM_STEPS]).toEqual(sorted);
  });

  it("한 계단씩 오르내린다", () => {
    expect(zoomIn(1)).toBe(1.15);
    expect(zoomOut(1)).toBe(0.85);
    expect(zoomIn(zoomOut(1))).toBe(1);
  });

  it("계단 사이의 값에서도 가장 가까운 다음 계단으로 붙는다", () => {
    expect(zoomIn(1.05)).toBe(1.15);
    expect(zoomOut(1.05)).toBe(1);
  });

  it("끝에서는 더 가지 않는다", () => {
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
  });

  it("올렸다 내리면 정확히 제자리로 돌아온다 (부동소수 오차가 계단을 흘리지 않는다)", () => {
    let value = DEFAULT_ZOOM;
    for (let i = 0; i < ZOOM_STEPS.length; i += 1) value = zoomIn(value);
    for (let i = 0; i < ZOOM_STEPS.length; i += 1) value = zoomOut(value);
    expect(value).toBe(MIN_ZOOM);
    expect(zoomIn(value)).toBe(DEFAULT_ZOOM);
  });
});

describe("표시", () => {
  it("백분율은 정수로 떨어진다", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(1.15)).toBe(115);
    expect(zoomPercent(0.85)).toBe(85);
  });

  it("기본 크기인지 알려 준다", () => {
    expect(isDefaultZoom(1)).toBe(true);
    expect(isDefaultZoom(1.15)).toBe(false);
  });
});
