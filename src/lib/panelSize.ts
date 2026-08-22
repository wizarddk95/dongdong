/**
 * 패널 분할 폭 계산 — 세션 목록 ↔ 채팅 ↔ 우측 패널.
 *
 * 드래그 좌표를 그대로 쓰면 한쪽이 0 까지 줄어 화면이 망가진다.
 * 순수 함수로 떼어 두고 App 의 스플리터가 마우스 이동마다 호출한다.
 */

/** 우측 패널 최소 폭(px) — 탭 라벨이 한 줄에 들어가는 하한. */
export const RIGHT_MIN = 320;
/** 채팅 영역 최소 폭(px) — 입력창과 전송 버튼이 겹치지 않는 하한. */
export const CHAT_MIN = 420;
/** 처음 열었을 때 우측 패널 폭 비율. */
export const RIGHT_DEFAULT_RATIO = 0.4;

/** 컨테이너 폭 안에서 우측 패널 폭을 [RIGHT_MIN, 컨테이너-CHAT_MIN] 로 자른다. */
export function clampRightWidth(width: number, containerWidth: number): number {
  // 창이 너무 좁아 두 하한을 동시에 만족할 수 없으면 반씩 나눈다.
  const max = containerWidth - CHAT_MIN;
  if (max < RIGHT_MIN) return Math.max(0, Math.round(containerWidth / 2));
  return Math.round(Math.min(Math.max(width, RIGHT_MIN), max));
}

/** 저장된 값이 없거나 창 크기가 바뀌었을 때 쓸 기본 폭. */
export function defaultRightWidth(containerWidth: number): number {
  return clampRightWidth(containerWidth * RIGHT_DEFAULT_RATIO, containerWidth);
}

/* ─────────────── 세션 목록(좌측 사이드바) ─────────────── */

/** 세션 제목이 두어 글자는 보이는 하한. */
export const SIDEBAR_MIN = 160;
/** 넓혀도 이 이상은 안 간다 — 세션 목록이 화면의 주인공은 아니다. */
export const SIDEBAR_MAX = 480;
/** 기본 폭(= 예전의 `w-60`). 더블클릭하면 여기로 돌아온다. */
export const SIDEBAR_DEFAULT = 240;

/**
 * 사이드바 폭을 [SIDEBAR_MIN, SIDEBAR_MAX] 로 자른다.
 * 창이 좁으면 상한을 더 당긴다 — 사이드바가 채팅을 밀어내면 안 된다.
 */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  // 채팅과 우측 패널이 각자의 하한을 지킬 수 있는 만큼만 내준다.
  const room = windowWidth - CHAT_MIN - RIGHT_MIN;
  const max = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, room));
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), max));
}
