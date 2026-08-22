/**
 * 화면 문구 사전.
 *
 * 규율은 색 토큰과 같다 — **컴포넌트에 문장을 직접 적지 않는다.** 전부 `ko.ts` · `en.ts`
 * 두 사전을 지나며, 키가 한쪽에만 있으면 타입체크가 잡는다(`en.ts` 가 `ko` 의 키로
 * 타입을 받는다). 사람 눈으로 두 파일을 대조할 필요가 없게 하려는 것이다.
 *
 * 리액트 밖(스토어·`lib/ai/*`)에서도 같은 문장이 필요하므로 현재 언어는 모듈 상태로
 * 둔다. 화면 갱신은 `useT()` 가 `useSyncExternalStore` 로 이 상태를 구독해서 한다 —
 * Zustand 스토어를 하나 더 만들지 않는 이유는, 언어가 스토어보다 **아래층**이기 때문이다
 * (스토어의 에러 문구도 번역을 부른다).
 */
import { en } from "@/lib/i18n/en";
import { ko } from "@/lib/i18n/ko";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  initialLocale,
  normalizeLocale,
  type Locale,
} from "@/lib/i18n/locale";

export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABEL,
  LOCALE_STORAGE_KEY,
  detectLocale,
  initialLocale,
  normalizeLocale,
  type Locale,
} from "@/lib/i18n/locale";

/** 사전의 키. `ko` 가 원본이고 `en` 은 같은 키를 모두 채워야 한다. */
export type MessageKey = keyof typeof ko;

export type Messages = Record<MessageKey, string>;

/** `{name}` 자리에 끼워 넣을 값. 숫자는 로케일 서식 없이 그대로 쓴다. */
export type MessageParams = Record<string, string | number>;

const DICTIONARIES: Record<Locale, Messages> = { ko, en };

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * 사전에서 문장을 꺼내 `{자리표}` 를 채운다.
 *
 * 키가 없으면 키 자체를 돌려준다 — 화면이 빈칸으로 남는 것보다 무엇이 빠졌는지
 * 보이는 편이 고치기 쉽다.
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
  const template = dict[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 어느 언어의 사전에서든 이 키의 문장과 같은가.
 *
 * 저장된 값이 "아직 사용자가 손대지 않은 기본값" 인지 알아볼 때 쓴다 — 세션 제목,
 * 기본 시스템 프롬프트처럼 **디스크에 문장 자체가 저장되는** 것들이다. 지금 언어로만
 * 비교하면 한국어로 만든 세션이 영어로 바꾼 뒤에 "사용자가 지은 제목" 으로 보인다.
 */
export function matchesAnyLocale(key: MessageKey, value: string): boolean {
  return LOCALE_LIST.some((locale) => DICTIONARIES[locale][key] === value);
}

const LOCALE_LIST: Locale[] = ["ko", "en"];

let current: Locale = initialLocale();
const listeners = new Set<() => void>();

/** 지금 언어. 리액트 밖에서 문장을 만들 때 쓴다. */
export function getLocale(): Locale {
  return current;
}

/**
 * 언어를 바꾸고 화면에 알린다. `<html lang>` 도 함께 맞춘다 —
 * 맞춤법 검사·스크린 리더·`:lang()` 이 그걸 본다.
 */
export function setLocale(value: unknown): Locale {
  const next = normalizeLocale(value);
  const root = globalThis.document?.documentElement;
  if (root) root.lang = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // 캐시가 막혀도 이번 세션의 언어는 이미 정해졌다. 다음 실행에서 한 번 깜빡일 뿐이다.
  }
  if (next === current) return next;
  current = next;
  for (const listener of listeners) listener();
  return next;
}

/** 언어 변경 구독. 해제 함수를 돌려준다. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 지금 언어로 문장 하나. 컴포넌트에서는 `useT()` 를 쓴다(언어가 바뀌면 다시 그려야 하므로). */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}
