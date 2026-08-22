/**
 * 컴포넌트에서 문장 꺼내기.
 *
 * `t()` 를 그냥 부르면 언어를 바꿔도 그 화면은 다시 그려지지 않는다 —
 * 모듈 상태는 리액트가 모르기 때문이다. `useSyncExternalStore` 로 구독해서
 * 언어가 바뀌는 순간 쓰는 화면만 다시 그린다.
 */
import { useMemo, useSyncExternalStore } from "react";

import {
  getLocale,
  subscribeLocale,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from "@/lib/i18n";

export type TranslateFn = (key: MessageKey, params?: MessageParams) => string;

/** 지금 화면 언어. 언어에 따라 갈리는 것이 문장 말고 또 있을 때(날짜 서식 등) 쓴다. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/**
 * 언어에 묶인 번역 함수.
 *
 * 함수 정체성이 언어와 함께 바뀌므로 `useMemo`/`memo` 의 의존성에 넣어도 안전하다.
 */
export function useT(): TranslateFn {
  const locale = useLocale();
  return useMemo(() => (key, params) => translate(locale, key, params), [locale]);
}
