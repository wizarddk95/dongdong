/**
 * 채팅 본문용 초경량 마크다운 파서.
 *
 * 외부 라이브러리를 쓰지 않는다(기술 스택 고정). LLM 이 실제로 뱉는 문법
 * — 제목 · 강조 · 코드/코드블록 · 목록 · 인용 · 표 · 링크 · 수식 — 만 다룬다.
 * 스트리밍 중 잘린 코드펜스·수식도 제 모습으로 보여야 하므로 `closed` 를 남긴다.
 * 수식은 구분 기호만 걷어 내고 원문을 그대로 넘긴다 — LaTeX 해석은 그리는 쪽(KaTeX) 일이다.
 * 원문 HTML 은 파싱하지 않고 텍스트로 흘려보낸다(React 가 그대로 이스케이프).
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "math"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "image"; src: string; alt: string }
  | { type: "break" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** 체크박스 목록이 아니면 null */
  checked: boolean | null;
  children: BlockNode[];
}

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: number; children: InlineNode[] }
  | { type: "codeBlock"; lang: string | null; value: string; closed: boolean }
  | { type: "math"; value: string; closed: boolean }
  | { type: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { type: "blockquote"; children: BlockNode[] }
  | { type: "table"; align: Align[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

const ESCAPABLE = "$\\`*_{}[]()#+-.!|~<>";
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>[ \t]?/;
const LIST_RE = /^( {0,3})([-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const TASK_RE = /^\[([ xX])\][ \t]+/;
/** 디스플레이 수식의 여는 쪽. 닫는 짝은 `matchMathBlock()` 이 줄을 넘어가며 찾는다. */
const MATH_OPEN_RE = /^ {0,3}(\$\$|\\\[)/;

function isWordChar(ch: string | undefined): boolean {
  return ch != null && /[\p{L}\p{N}]/u.test(ch);
}

/** 마크다운으로 그려도 되는 파일인가 — 파일 뷰어의 [미리보기] 버튼이 이걸 보고 뜬다. */
export function isMarkdownPath(path: string): boolean {
  // 확장자만 본다. 경로 구분자는 OS 마다 다르므로 마지막 점 뒤만 떼어 낸다.
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return ["md", "markdown", "mdx", "mdown", "mkd"].includes(name.slice(dot + 1).toLowerCase());
}

/* ------------------------------------------------------------------ 블록 */

export function parseMarkdown(source: string): BlockNode[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    isMathBlockStart(line)
  );
}

function parseBlocks(lines: string[]): BlockNode[] {
  const out: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // 코드 펜스 — 닫히지 않으면(스트리밍 중) 남은 줄 전부를 코드로 본다.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`);
      const lang = fence[2].trim().split(/\s+/)[0] || null;
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        if (closing.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      out.push({ type: "codeBlock", lang, value: body.join("\n"), closed });
      continue;
    }

    // 디스플레이 수식 — 코드펜스보다 약하고(코드 안의 `$$` 는 글자다) 나머지보다 세다.
    const math = matchMathBlock(lines, i);
    if (math) {
      out.push(math.node);
      i = math.next;
      if (math.tail) out.push({ type: "paragraph", children: parseInline(math.tail) });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
      out.push({ type: "heading", level: heading[1].length, children: parseInline(text) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      out.push({ type: "blockquote", children: parseBlocks(body) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      out.push({ type: "table", align, header, rows });
      continue;
    }

    if (LIST_RE.test(line)) {
      const parsed = parseList(lines, i);
      out.push(parsed.node);
      i = parsed.next;
      continue;
    }

    // 문단 — 빈 줄이나 다른 블록 시작 전까지. 줄바꿈은 그대로 살린다.
    const buf: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push({ type: "paragraph", children: parseInline(buf.join("\n")) });
  }

  return out;
}

/**
 * `$$ … $$` / `\[ … \]` 를 한 블록으로 떼어 낸다.
 *
 * 여는 줄 뒤에 글자가 남으면(`$$x$$ 는 …`) 블록이 아니라 문단이므로 null 을 준다 —
 * 그 경우는 인라인 수식이 받는다. 닫는 짝이 없으면(스트리밍 중) 남은 줄 전부를 수식으로
 * 보되 `closed: false` 로 표시한다.
 */
function matchMathBlock(
  lines: string[],
  start: number,
): { node: BlockNode; next: number; tail?: string } | null {
  const open = MATH_OPEN_RE.exec(lines[start]);
  if (!open) return null;

  const closer = open[1] === "$$" ? "$$" : "\\]";
  const first = lines[start].slice(open[0].length);
  const inFirst = first.indexOf(closer);

  // 한 줄로 끝나는 경우
  if (inFirst >= 0) {
    if (first.slice(inFirst + closer.length).trim()) return null;
    return {
      node: { type: "math", value: first.slice(0, inFirst).trim(), closed: true },
      next: start + 1,
    };
  }

  const body = first.trim() ? [first] : [];
  let i = start + 1;
  while (i < lines.length) {
    const at = lines[i].indexOf(closer);
    if (at < 0) {
      body.push(lines[i]);
      i++;
      continue;
    }
    if (lines[i].slice(0, at).trim()) body.push(lines[i].slice(0, at));
    const tail = lines[i].slice(at + closer.length).trim();
    return {
      node: { type: "math", value: dedent(body).join("\n").trim(), closed: true },
      next: i + 1,
      tail: tail || undefined,
    };
  }

  return {
    node: { type: "math", value: dedent(body).join("\n").trim(), closed: false },
    next: lines.length,
  };
}

/** 블록 안에서만 쓰는 공통 들여쓰기 제거 — 목록 안의 수식이 통째로 밀려 있어도 정렬이 산다. */
function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.length - line.trimStart().length);
  const pad = indents.length ? Math.min(...indents) : 0;
  return pad ? lines.map((line) => line.slice(pad)) : lines;
}

/** `startsBlock()` 과 `matchMathBlock()` 이 같은 판정을 쓰도록 한 곳에 둔다. */
function isMathBlockStart(line: string): boolean {
  const open = MATH_OPEN_RE.exec(line);
  if (!open) return false;
  const rest = line.slice(open[0].length);
  const at = rest.indexOf(open[1] === "$$" ? "$$" : "\\]");
  return at < 0 || !rest.slice(at + 2).trim();
}

function parseList(lines: string[], start: number): { node: BlockNode; next: number } {
  const first = LIST_RE.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  let loose = false;
  let i = start;

  while (i < lines.length) {
    const match = LIST_RE.exec(lines[i]);
    if (!match || ordered !== /\d/.test(match[2])) break;

    const contentIndent = match[0].length;
    const buf: string[] = [lines[i].slice(contentIndent)];
    i++;

    let blanks = 0;
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) {
        blanks++;
        i++;
        continue;
      }
      const indent = current.length - current.trimStart().length;
      if (indent >= contentIndent) {
        if (blanks > 0) {
          for (let n = 0; n < blanks; n++) buf.push("");
          loose = true;
          blanks = 0;
        }
        buf.push(current.slice(contentIndent));
        i++;
        continue;
      }
      if (blanks > 0 || LIST_RE.test(current)) break;
      // 들여쓰기 없는 이어짐(lazy continuation)
      buf.push(current.trimStart());
      i++;
    }
    // 빈 줄 뒤에 같은 종류의 항목이 이어지면 loose 목록.
    const next = i < lines.length ? LIST_RE.exec(lines[i]) : null;
    if (blanks > 0 && next && ordered === /\d/.test(next[2])) loose = true;

    let checked: boolean | null = null;
    const task = TASK_RE.exec(buf[0]);
    if (task) {
      checked = task[1] !== " ";
      buf[0] = buf[0].slice(task[0].length);
    }
    items.push({ checked, children: parseBlocks(buf) });
  }

  return {
    node: { type: "list", ordered, start: startNum, tight: !loose, items },
    next: i,
  };
}

function isDelimiterRow(line: string): boolean {
  const text = line.trim();
  if (!text.includes("|") || !text.includes("-")) return false;
  return /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(text);
}

function alignOf(cell: string): Align {
  const text = cell.trim();
  const left = text.startsWith(":");
  const right = text.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);

  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (text[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += text[i];
  }
  cells.push(cur.trim());
  return cells;
}

/* ------------------------------------------------------------------ 인라인 */

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  let i = 0;

  const flush = () => {
    if (text) {
      nodes.push({ type: "text", value: text });
      text = "";
    }
  };

  while (i < source.length) {
    const ch = source[i];

    // `\(…\)` · `\[…\]` — 이스케이프 분기보다 먼저 봐야 한다(안 그러면 여는 기호가 글자로 풀린다).
    if (ch === "\\" && (source[i + 1] === "(" || source[i + 1] === "[")) {
      const math = matchLatexMath(source, i);
      if (math) {
        flush();
        nodes.push({ type: "math", value: math.value });
        i = math.end;
        continue;
      }
    }

    // `$…$` · `$$…$$`
    if (ch === "$") {
      const math = matchDollarMath(source, i);
      if (math) {
        flush();
        nodes.push({ type: "math", value: math.value });
        i = math.end;
        continue;
      }
    }

    if (ch === "\\" && ESCAPABLE.includes(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      flush();
      nodes.push({ type: "break" });
      i++;
      continue;
    }

    // 인라인 코드가 가장 강하다 — 안쪽 문법을 해석하지 않는다.
    if (ch === "`") {
      const span = matchCodeSpan(source, i);
      if (span) {
        flush();
        nodes.push({ type: "code", value: span.value });
        i = span.end;
        continue;
      }
      text += "`";
      i++;
      continue;
    }

    if (ch === "!" && source[i + 1] === "[") {
      const link = matchLink(source, i + 1);
      if (link) {
        flush();
        nodes.push({ type: "image", src: link.href, alt: link.label });
        i = link.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLink(source, i);
      if (link) {
        flush();
        nodes.push({ type: "link", href: link.href, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(source.slice(i));
      if (auto) {
        flush();
        nodes.push({
          type: "link",
          href: auto[1],
          children: [{ type: "text", value: auto[1].replace(/^mailto:/, "") }],
        });
        i += auto[0].length;
        continue;
      }
    }

    // 맨몸 URL
    if ((ch === "h" || ch === "H") && !isWordChar(source[i - 1])) {
      const bare = /^https?:\/\/[^\s<>()[\]]+/i.exec(source.slice(i));
      if (bare) {
        const href = bare[0].replace(/[.,;:!?'"]+$/, "");
        flush();
        nodes.push({ type: "link", href, children: [{ type: "text", value: href }] });
        i += href.length;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const emphasis = matchEmphasis(source, i);
      if (emphasis) {
        flush();
        nodes.push(emphasis.node);
        i = emphasis.end;
        continue;
      }
    }

    text += ch;
    i++;
  }

  flush();
  return nodes;
}

/** `\(…\)` / `\[…\]`. 닫는 짝이 없으면 null — 그러면 여느 이스케이프로 되돌아간다. */
function matchLatexMath(source: string, start: number): { value: string; end: number } | null {
  const closer = source[start + 1] === "(" ? "\\)" : "\\]";
  const at = source.indexOf(closer, start + 2);
  if (at < 0) return null;
  const value = source.slice(start + 2, at).trim();
  return value ? { value, end: at + 2 } : null;
}

/**
 * `$…$` / `$$…$$`.
 *
 * 통화 표기를 수식으로 오인하지 않는 것이 전부다("$5 와 $10 을"). 여는 `$` 뒤에 공백이
 * 오면 안 되고, 닫는 `$` 앞에 공백이 오거나 뒤에 숫자가 붙으면 짝으로 안 친다.
 * 빈 줄을 건너뛰지도 않는다 — 문단을 넘어가며 삼키면 본문이 통째로 사라진다.
 *
 * 첫 후보가 조건에 걸리면 **거기서 포기한다**(다음 `$` 를 찾아 나서지 않는다).
 * 계속 찾게 두면 "가격은 $5 와 $10 이다. 합은 $x$ 이다" 에서 맨 앞 `$` 가 저 뒤 수식의
 * 닫는 `$` 와 짝을 지어 문장 하나를 통째로 삼킨다. 수식 안에 맨몸 `$` 가 들어갈 일은
 * 없으므로(넣으려면 `\$`) 잃는 것도 없다.
 */
function matchDollarMath(source: string, start: number): { value: string; end: number } | null {
  const size = source[start + 1] === "$" ? 2 : 1;
  const from = start + size;
  if (!source[from] || /\s/.test(source[from])) return null;

  for (let i = from; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "\n" && source[i + 1] === "\n") return null;
    if (source[i] !== "$") continue;

    let run = 0;
    while (source[i + run] === "$") run++;
    if (run < size) continue;
    if (/\s/.test(source[i - 1] ?? " ")) return null;
    if (size === 1 && /\d/.test(source[i + 1] ?? "")) return null;

    const value = source.slice(from, i).trim();
    return value ? { value, end: i + size } : null;
  }
  return null;
}

function matchCodeSpan(source: string, start: number): { value: string; end: number } | null {
  let size = 0;
  while (source[start + size] === "`") size++;

  let i = start + size;
  while (i < source.length) {
    if (source[i] !== "`") {
      i++;
      continue;
    }
    let run = 0;
    while (source[i + run] === "`") run++;
    if (run === size) {
      let value = source.slice(start + size, i).replace(/\n/g, " ");
      if (value.length > 2 && value.startsWith(" ") && value.endsWith(" ") && value.trim()) {
        value = value.slice(1, -1);
      }
      return { value, end: i + size };
    }
    i += run;
  }
  return null;
}

/** `[label](href "title")` — 대괄호·괄호 중첩을 세면서 자른다. */
function matchLink(
  source: string,
  start: number,
): { label: string; href: string; end: number } | null {
  let depth = 0;
  let i = start;
  let labelEnd = -1;
  for (; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) {
        labelEnd = i;
        break;
      }
    }
  }
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;

  depth = 0;
  let hrefEnd = -1;
  for (i = labelEnd + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        hrefEnd = i;
        break;
      }
    }
  }
  if (hrefEnd < 0) return null;

  const target = source.slice(labelEnd + 2, hrefEnd).trim();
  const href = target.replace(/\s+["'].*$/s, "").trim();
  return { label: source.slice(start + 1, labelEnd), href, end: hrefEnd + 1 };
}

function matchEmphasis(source: string, start: number): { node: InlineNode; end: number } | null {
  const ch = source[start];
  let run = 0;
  while (source[start + run] === ch) run++;

  // `~` 는 취소선(`~~`)만 인정한다.
  const candidates = ch === "~" ? (run >= 2 ? [2] : []) : [3, 2, 1].filter((n) => n <= run);
  const prev = source[start - 1];

  for (const size of candidates) {
    const marker = ch.repeat(size);
    const inner = start + size;
    // 여는 쪽: 바로 뒤가 공백이면 강조가 아니다. `_` 는 단어 안에서 무시(snake_case).
    if (!source[inner] || /\s/.test(source[inner])) continue;
    if (ch === "_" && isWordChar(prev)) continue;

    const close = findCloser(source, inner, marker, ch === "_");
    if (close <= inner) continue; // 닫는 짝이 없거나 내용이 비었다

    const children = parseInline(source.slice(inner, close));
    const end = close + size;
    if (ch === "~") return { node: { type: "del", children }, end };
    if (size === 1) return { node: { type: "em", children }, end };
    if (size === 2) return { node: { type: "strong", children }, end };
    return { node: { type: "strong", children: [{ type: "em", children }] }, end };
  }
  return null;
}

function findCloser(source: string, from: number, marker: string, underscore: boolean): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "\n" && source[i + 1] === "\n") return -1;
    if (!source.startsWith(marker, i)) continue;
    // 닫는 쪽: 바로 앞이 공백이면 안 되고, `_` 는 단어 안에서 끝나면 안 된다.
    if (/\s/.test(source[i - 1] ?? " ")) continue;
    if (underscore && isWordChar(source[i + marker.length])) continue;
    return i;
  }
  return -1;
}
