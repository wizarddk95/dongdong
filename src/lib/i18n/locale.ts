/**
 * 화면 언어(로케일) 결정.
 *
 * `lib/theme.ts` 와 같은 자리에 있다 — 규칙은 순수 함수로 두고, 실제 적용(모듈 상태 갱신·
 * 리스너 통지)은 `index.ts` 가 한다. 색과 마찬가지로 언어도 **문자열은 여기 안 둔다**:
 * 여기 있는 건 "어느 언어인가" 뿐이고 문장은 `ko.ts` · `en.ts` 에 산다.
 */

/** 지원 언어. 늘리려면 여기와 사전 두 벌을 함께 늘린다. */
export type Locale = "ko" | "en";

export const LOCALES: Locale[] = ["ko", "en"];

/** 언어 이름은 **그 언어로** 적는다 — 지금 언어를 못 읽는 사람이 고르는 목록이기 때문. */
export const LOCALE_LABEL: Record<Locale, string> = {
  ko: "한국어",
  en: "English",
};

export const DEFAULT_LOCALE: Locale = "ko";

/**
 * 설정을 읽기 전(앱이 뜨는 첫 프레임)에도 언어를 알아야 문장이 한 번 바뀌어 보이지 않는다.
 * 테마와 같은 이유로 마지막 선택을 localStorage 에 복사해 둔다.
 * 진실의 원본은 `settings.json` 이고 이건 캐시일 뿐이다.
 */
export const LOCALE_STORAGE_KEY = "dongdong.locale";

/** 알 수 없는 값(옛 설정·손으로 고친 JSON)은 기본값으로 되돌린다. */
export function normalizeLocale(value: unknown): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}

/**
 * 처음 켰을 때 쓸 언어를 OS/브라우저 설정에서 짐작한다.
 * 한국어권이 아니면 영어로 연다 — 글로벌 사용자가 읽을 수 없는 화면을 먼저 보지 않게.
 */
export function detectLocale(languages?: readonly string[]): Locale {
  // 목록을 넘겨받았으면 그것만 본다 — 넘긴 쪽이 빈 목록을 줬다면 "모른다" 는 뜻이지
  // "환경에 물어봐 달라" 는 뜻이 아니다(그래야 테스트가 이 PC 의 로케일에 흔들리지 않는다).
  const list = languages ?? globalThis.navigator?.languages ?? [globalThis.navigator?.language ?? ""];
  return (list[0] ?? "").toLowerCase().startsWith("ko") ? "ko" : "en";
}

/**
 * 첫 프레임용 캐시 읽기. 캐시가 없으면 OS 설정으로 짐작한다.
 * (저장된 설정이 도착하면 `store/settings.ts` 가 다시 덮어쓴다)
 */
export function initialLocale(): Locale {
  try {
    const cached = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (cached) return normalizeLocale(cached);
  } catch {
    // 저장소가 막혀 있으면 짐작으로 간다.
  }
  return detectLocale();
}
