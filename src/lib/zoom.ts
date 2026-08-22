/**
 * 대화 창 확대·축소 배율(순수).
 *
 * 기본 활자는 도구 창 기준의 13px 이라 오래 읽으면 눈이 먼저 지친다. 그렇다고
 * 토큰 자체를 키우면 화면 전체가 헐거워지므로 **읽는 면(대화 목록)만** 배율을 갖는다.
 *
 * 배율은 자유 실수가 아니라 **단계**다 — 휠 한 칸이 0.01 씩 움직이면 같은 크기로 다시
 * 돌아가지 못하고, [기본 크기로] 없이는 100% 를 맞출 수도 없다. 브라우저 확대와 같은
 * 감각으로 계단을 밟는다.
 *
 * 판정을 여기 한 곳에 모아 두는 이유는 키보드(Ctrl +/-)·휠·버튼이 **같은 계단**을
 * 밟아야 하기 때문이다. 세 곳에 따로 적으면 반드시 어긋난다.
 */

/** 밟을 수 있는 배율. 오름차순이어야 한다. */
export const ZOOM_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;

export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** 부동소수 비교용 여유. `1.15 - 1` 같은 계산이 계단에 정확히 안 떨어진다. */
const EPSILON = 1e-6;

/**
 * 저장된 값·바깥에서 온 값을 쓸 수 있는 배율로 만든다.
 * 숫자가 아니거나 NaN 이면 기본값 — 설정 파일이 손으로 고쳐질 수 있다.
 */
export function clampZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ZOOM;
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

/** 한 계단 크게. 이미 최대면 그대로. */
export function zoomIn(current: number): number {
  const value = clampZoom(current);
  return ZOOM_STEPS.find((step) => step > value + EPSILON) ?? MAX_ZOOM;
}

/** 한 계단 작게. 이미 최소면 그대로. */
export function zoomOut(current: number): number {
  const value = clampZoom(current);
  const smaller = ZOOM_STEPS.filter((step) => step < value - EPSILON);
  return smaller.length > 0 ? smaller[smaller.length - 1] : MIN_ZOOM;
}

/** 화면에 적는 백분율. 계단이 0.15 단위라 반올림해야 "115%" 로 떨어진다. */
export function zoomPercent(value: number): number {
  return Math.round(clampZoom(value) * 100);
}

/** 기본 크기인가 — [기본 크기로] 버튼을 내줄지 정한다. */
export function isDefaultZoom(value: number): boolean {
  return Math.abs(clampZoom(value) - DEFAULT_ZOOM) < EPSILON;
}
