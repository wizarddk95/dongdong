/**
 * 테마(라이트 / 다크) 결정과 적용.
 *
 * 색은 전부 `index.css` 의 의미 토큰이고, 여기서 하는 일은
 * `<html data-theme="…">` 을 어느 값으로 둘지 정하는 것뿐이다.
 * 결정 규칙(순수)과 DOM 쓰기(부작용)를 갈라 둬서 규칙만 따로 테스트한다.
 */

/** 사용자가 고르는 값. `system` 은 OS 설정을 따라간다. */
export type ThemePreference = "light" | "dark" | "system";

/** 실제로 화면에 적용되는 값. */
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: ThemePreference[] = ["light", "dark", "system"];

export const THEME_LABEL: Record<ThemePreference, string> = {
  light: "라이트",
  dark: "다크",
  system: "시스템 설정",
};

export const DEFAULT_THEME: ThemePreference = "light";

/**
 * 설정을 읽기 전(앱이 뜨는 첫 프레임)에도 테마를 알아야 흰 화면이 번쩍이지 않는다.
 * Rust 의 settings.json 은 비동기라 늦으므로, 마지막 선택을 localStorage 에도
 * 복사해 두고 `index.html` 의 인라인 스크립트가 그걸 먼저 읽는다.
 * 진실의 원본은 어디까지나 settings.json 이고 이건 캐시일 뿐이다.
 */
export const THEME_STORAGE_KEY = "dongdong.theme";

/** 알 수 없는 값(옛 설정·손으로 고친 JSON)은 기본값으로 되돌린다. */
export function normalizeTheme(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME;
}

/** 선택값 + OS 취향 → 실제 적용할 테마. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** OS 가 다크를 원하는지. 브라우저 밖(테스트·SSR)에서는 false. */
export function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * `<html>` 에 테마를 새기고 선택값을 캐시한다.
 * `color-scheme` 도 함께 맞춰야 셀렉트 드롭다운·스크롤바 같은 네이티브 위젯이 따라온다.
 *
 * DOM 이 없는 곳(테스트 등)에서는 칠할 대상이 없으므로 계산만 하고 조용히 돌아간다.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark());
  const root = globalThis.document?.documentElement;
  if (!root) return resolved;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 저장이 막혀도 이번 세션의 테마는 이미 적용됐다. 다음 실행에서 깜빡일 뿐이다.
  }
  return resolved;
}

/**
 * OS 테마가 바뀌면 다시 그린다. `system` 을 고른 사용자에게만 의미가 있지만,
 * 구독 자체는 항상 걸어 두고 `applyTheme` 가 현재 선택값으로 재계산한다.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => undefined;
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
