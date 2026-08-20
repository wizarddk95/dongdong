/**
 * 지금 화면에 적용된 테마를 React 로 읽어 온다.
 *
 * 색은 전부 CSS 토큰이라 대부분의 컴포넌트는 이걸 알 필요가 없다.
 * React Flow 처럼 **자바스크립트로 명암을 넘겨야 하는** 라이브러리에만 쓴다.
 *
 * (`lib/theme.ts` 에 두지 않는 이유 — 거기는 `store/settings.ts` 가 import 하는
 *  순수 모듈이라, 반대로 스토어를 가져오면 순환 참조가 된다.)
 */
import { useEffect, useState } from "react";

import { resolveTheme, systemPrefersDark, watchSystemTheme, type ResolvedTheme } from "@/lib/theme";
import { useSettings } from "@/store/settings";

export function useResolvedTheme(): ResolvedTheme {
  const preference = useSettings((state) => state.theme);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => watchSystemTheme(() => setPrefersDark(systemPrefersDark())), []);

  return resolveTheme(preference, prefersDark);
}
