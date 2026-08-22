/**
 * 테스트 공통 준비.
 *
 * **화면 언어를 못 박는다.** 안 박으면 테스트가 그 PC 의 OS 언어를 따라간다 —
 * `initialLocale()` 이 `navigator.language` 로 짐작하기 때문이다. 한국어 윈도우에서는
 * `ko` 로 시작해 한국어 문구를 단언하는 테스트가 통과하지만, GitHub 러너(`en-US`)에서는
 * 같은 테스트가 전부 영어 문장을 받아 깨진다. 실제로 그렇게 깨졌다 — 로컬은 495개 초록,
 * CI 는 10개 빨강이었고 원인이 코드가 아니라 **개발자 PC 의 로케일**이었다.
 *
 * 기존 테스트 대부분이 한국어 문구를 단언하므로 `ko` 로 고정한다. 영어 경로는 그것대로
 * 명시적으로 확인한다(`lib/i18n/i18n.test.ts` · `store/settings.test.ts`).
 *
 * 매 테스트마다 되돌리는 이유는 **누수** 때문이다 — 한 테스트가 `en` 으로 바꿔 놓고 끝나면
 * 같은 파일의 다음 테스트가 영문 사전을 받는다(모듈 상태라 `it` 경계에서 안 돌아온다).
 */
import { beforeEach } from "vitest";

import { setLocale } from "@/lib/i18n";

setLocale("ko");

beforeEach(() => {
  setLocale("ko");
});
