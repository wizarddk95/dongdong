/**
 * `@` 파일 참조 — 입력칸의 텍스트를 다루는 순수 함수들.
 *
 * 화면(자동완성 목록·키보드 이동)은 `components/chat/MentionPicker.tsx`,
 * 실제 파일을 읽어 컨텍스트로 만드는 일은 `lib/ai/attachments.ts` 가 한다.
 * 여기서는 **커서 위치에서 지금 무엇을 치고 있는지**와 **고른 경로를 어떻게 끼워 넣는지**만 정한다.
 *
 * 규칙을 한 곳에 모아 두는 이유는 늘 같다 — 입력칸과 전송 경로가 `@` 를 서로 다르게 읽으면
 * 화면에서 고른 파일이 컨텍스트에는 안 실린다.
 */

/** 지금 커서가 걸쳐 있는 `@` 토큰. */
export interface MentionToken {
  /** `@` 의 인덱스 */
  start: number;
  /** 토큰 끝(= 커서 위치) */
  end: number;
  /** `@` 뒤에 지금까지 친 글자 */
  query: string;
}

/** `@` 앞에 올 수 있는 글자 — 이게 아니면 이메일 주소 같은 것이므로 참조로 보지 않는다. */
const OPENERS = new Set(["(", "[", "{", ",", "'", '"', "`"]);

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char) || OPENERS.has(char);
}

/**
 * 커서 바로 앞에서 열려 있는 `@` 토큰을 찾는다. 없으면 `null`.
 *
 * 따옴표로 연 참조(`@"내 문서.docx`)는 공백을 품을 수 있으므로 따로 본다 —
 * 우리가 공백 있는 경로를 그렇게 넣기 때문에 지우고 고쳐 쓸 때도 같은 규칙이어야 한다.
 */
export function activeMention(text: string, caret: number): MentionToken | null {
  const end = Math.max(0, Math.min(caret, text.length));

  // 1) 따옴표로 연 참조: 커서 앞쪽에서 가장 가까운 `@"` 를 찾는다.
  const quotedStart = text.lastIndexOf('@"', end - 1);
  // `@"` 두 글자가 커서 **앞에** 온전히 있어야 열린 토큰이다.
  if (quotedStart >= 0 && quotedStart + 2 <= end && isBoundary(text[quotedStart - 1])) {
    const inner = text.slice(quotedStart + 2, end);
    // 이미 닫혔거나 줄이 바뀌었으면 열린 토큰이 아니다.
    if (!inner.includes('"') && !inner.includes("\n")) {
      return { start: quotedStart, end, query: inner };
    }
  }

  // 2) 평범한 참조: 공백을 만나기 전에 `@` 가 나와야 한다.
  let index = end - 1;
  while (index >= 0) {
    const char = text[index];
    if (char === "@") {
      if (!isBoundary(text[index - 1])) return null;
      return { start: index, end, query: text.slice(index + 1, end) };
    }
    if (/\s/.test(char) || char === '"') return null;
    index -= 1;
  }
  return null;
}

/** 공백이 든 경로는 따옴표로 감싼다 — 안 그러면 다음 단어까지 경로로 읽힌다. */
export function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * 고른 경로를 토큰 자리에 끼워 넣는다.
 *
 * 디렉터리는 뒤에 `/` 만 붙이고 **공백을 넣지 않는다** — 곧바로 하위를 이어서 치도록.
 * 파일은 공백 한 칸을 붙여 다음 말을 바로 이어 쓰게 한다.
 */
export function applyMention(
  text: string,
  token: MentionToken,
  path: string,
  options: { isDir?: boolean } = {},
): { text: string; caret: number } {
  const inserted = `@${quotePath(options.isDir ? `${path.replace(/\/$/, "")}/` : path)}`;
  const tail = options.isDir ? "" : " ";
  // 이미 공백이 이어져 있으면 두 칸이 되지 않게 한다.
  const needsSpace = tail && !/^\s/.test(text.slice(token.end));

  const next = `${text.slice(0, token.start)}${inserted}${needsSpace ? tail : ""}${text.slice(token.end)}`;
  return { text: next, caret: token.start + inserted.length + (needsSpace ? tail.length : 0) };
}

/** 경로 끝에 붙어 온 문장 부호를 뗀다. `.` 은 확장자일 수 있어 건드리지 않는다. */
function trimTrailing(path: string): string {
  return path.replace(/[,;:)\]}]+$/, "");
}

/**
 * 보낼 텍스트에서 참조된 경로를 순서대로 뽑는다 (중복은 한 번만).
 * `user@example.com` 처럼 앞에 글자가 붙은 `@` 는 참조가 아니다.
 */
export function extractMentions(text: string): string[] {
  const pattern = /(^|[\s([{,])@(?:"([^"\n]+)"|([^\s"]+))/g;
  const found: string[] = [];

  for (const match of text.matchAll(pattern)) {
    const raw = match[2] ?? trimTrailing(match[3] ?? "");
    const path = raw.trim();
    if (!path || path === "/" || found.includes(path)) continue;
    found.push(path);
  }
  return found;
}
