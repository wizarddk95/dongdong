/**
 * 비밀값 가리기.
 *
 * 이 앱은 샌드박스 없이 사용자 권한으로 셸을 돌린다 — 모델이(혹은 남이 심어 둔 지시가)
 * `cat ~/.config/dongdong/settings.json` 한 줄만 부르면 API 키가 도구 출력으로 되돌아온다.
 * 그렇게 되돌아온 키는 그 자리에서 끝나지 않는다: 도구 결과는 DB(`.agent_workspace/local.db`)에
 * 남고 다음 턴 컨텍스트에 다시 실려 **공급자 서버로 나간다**.
 *
 * 그래서 도구 출력이 지나는 목(`tools.ts` 의 `clip()`)과 오류 문구(`errors.ts`)에서
 * 지금 설정에 들어 있는 비밀값을 문자열로 찾아 지운다. 프롬프트 주입을 막지는 못하지만
 * **키가 대화 기록과 남의 서버에 눌러 붙는 것**은 막는다.
 *
 * 한계는 분명히 해 둔다 — 모델이 키를 잘라 붙이거나(`echo ${KEY:0:10}`) 인코딩하면 못 잡는다.
 * 진짜 방벽은 위험한 도구를 끄는 것이고, 이건 그 앞에 세운 그물이다.
 */

import { t } from "@/lib/i18n";

/** 이보다 짧은 값은 등록하지 않는다. `local` 같은 자리채움이 본문을 걸레로 만든다. */
const MIN_SECRET_CHARS = 12;

export const REDACTED_KEY = "redact.masked" as const;

/** 가린 자리에 적히는 문구. 화면 언어를 따라간다. */
export function redactedLabel(): string {
  return t(REDACTED_KEY);
}

/** 지금 가려야 할 값들. 긴 것부터 지워야 접두사가 겹칠 때 조각이 남지 않는다. */
let secrets: string[] = [];

/**
 * 가릴 값을 갈아 끼운다. 설정이 바뀔 때마다 스토어가 부른다.
 * 빈 값·짧은 값·중복은 버린다.
 */
export function setRedactionSecrets(values: readonly (string | null | undefined)[]): void {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= MIN_SECRET_CHARS) unique.add(trimmed);
  }
  secrets = [...unique].sort((a, b) => b.length - a.length);
}

/** 지금 등록된 개수. 테스트와 설정 화면의 안내에 쓴다. */
export function redactionSecretCount(): number {
  return secrets.length;
}

/** 등록된 비밀값을 모두 가림 문구로 바꾼다. 없으면 원문 그대로. */
export function redact(text: string): string {
  if (!text || secrets.length === 0) return text;
  const mask = redactedLabel();
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(mask);
  }
  return out;
}
