/**
 * "지금이 언제인가" 를 컨텍스트에 싣는다.
 *
 * 모델은 자기 학습이 끝난 시점을 현재로 착각한다 — 그래서 "최신" 을 물으면 한두 해 전
 * 자료를 찾고, 웹 검색 도구를 줘도 지난 연도를 쿼리에 박아 넣는다. 실제로 2026년에
 * 물어도 "2024/2025" 로 검색하는 일이 계속 생겼다.
 *
 * 고치는 방법은 하나다: **매 턴 지금 시각을 알려 준다.** 대화 노드에 박아 두면 옛 턴의
 * 시각이 화석으로 남으므로, 시스템 프롬프트 쪽에 싣고 턴마다 새로 만든다
 * (`composeSystemPrompt`). 무엇이 실제로 나갔는지는 인스펙터로 그대로 보인다.
 */

/** 프롬프트에 실을 시각 정보. 사람이 읽는 줄과 기계가 읽는 ISO 를 함께 준다. */
export interface NowInfo {
  /** `2026-08-22 (토) 14:03` — 사용자의 로컬 시각 */
  local: string;
  /** `2026-08-22T05:03:11.000Z` */
  iso: string;
  /** IANA 시간대 이름 (`Asia/Seoul`). 알아내지 못하면 빈 문자열 */
  timeZone: string;
  /** `UTC+09:00` */
  offset: string;
  /** 로컬 기준 연도. "올해" 를 물었을 때의 답 */
  year: number;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function pad(value: number, size = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(size, "0");
}

/** 분 단위 오프셋을 `UTC+09:00` 모양으로. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 이 환경의 IANA 시간대 이름. 못 알아내면 빈 문자열(그래도 오프셋은 있다). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * 지금을 프롬프트에 실을 모양으로 만든다.
 *
 * `Intl` 에 기대지 않고 `Date` 의 로컬 게터로 직접 조립한다 — 웹뷰마다 로케일 데이터가
 * 달라 같은 시각이 다른 문장으로 나오면 인스펙터로 볼 때 혼란스럽고, 테스트도 흔들린다.
 */
export function describeNow(now: Date = new Date()): NowInfo {
  const offsetMinutes = -now.getTimezoneOffset();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  return {
    local: `${date} (${WEEKDAYS[now.getDay()]}) ${time}`,
    iso: now.toISOString(),
    timeZone: localTimeZone(),
    offset: formatOffset(offsetMinutes),
    year: now.getFullYear(),
  };
}

/**
 * 시스템 프롬프트에 붙는 블록.
 *
 * 시각만 적어 두면 모델이 그걸 읽고도 습관대로 옛 연도를 쓴다 — 그래서 "이 값을
 * 무엇에 쓰라" 까지 한 줄로 못 박는다.
 */
export function datetimeBlock(now: Date = new Date()): string {
  const info = describeNow(now);
  const zone = info.timeZone ? `${info.timeZone}, ${info.offset}` : info.offset;

  return [
    "# 현재 시각",
    `${info.local} (${zone})`,
    `UTC 기준: ${info.iso}`,
    "",
    `- 사용자가 말하는 "오늘 · 지금 · 최근 · 올해" 는 이 시각 기준입니다. 올해는 ${info.year}년입니다.`,
    "- 최신 정보를 찾을 때 학습 시점의 연도를 쓰지 말고 위 날짜를 기준으로 삼으세요.",
    "- 이 값은 턴마다 새로 실립니다. 앞선 대화에 적힌 시각은 그때의 값입니다.",
  ].join("\n");
}
