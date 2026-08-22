/**
 * `@` 로 참조한 파일을 **보내기 직전에 읽어** 사용자 메시지에 함께 싣는다.
 *
 * 왜 도구(`read_file`)를 시키지 않고 미리 읽는가: 사용자가 이미 어떤 파일인지 정해 준
 * 상황에서 모델이 한 스텝을 더 써서 그걸 읽는 것은 왕복 한 번과 토큰 한 뭉치를 그냥 버리는
 * 일이다. 참조는 사람의 지시이므로 그 자리에서 컨텍스트가 되는 게 맞다.
 *
 * 실린 내용은 사용자 노드의 `content` 에 그대로 저장된다 — 대화 트리를 되짚어도, 인스펙터를
 * 열어도 **그때 무엇이 들어갔는지가 남는다**(나중에 파일이 바뀌어도 그 턴의 기록은 그대로다).
 * 채팅 말풍선에서는 접어 둔다(`splitAttachments`).
 *
 * ## 텍스트가 아닌 파일 (엑셀 · 워드 · PDF · 이미지)
 *
 * 본문을 실을 수 없다. 이 앱에는 문서 파서도 비전 파이프라인도 없고, 있다 해도 xlsx 를
 * 문자열로 펴서 컨텍스트에 붓는 건 대개 낭비다. 그래서 **자리표(stub)만 싣는다**:
 * 경로 · 종류 · 크기와 "어떻게 열어야 하는지" 한 줄이다. 엑셀/워드/PDF 는 이미 내장 스킬이
 * 있으므로(`lib/ai/builtinSkills.ts`) 그 스킬 이름을 짚어 준다 — 모델이 `load_skill` 로
 * 절차를 열고 Python 으로 직접 읽는 길이 그대로 이어진다.
 */
import { clip } from "@/lib/ai/tools";
import * as ipc from "@/lib/ipc";

/** 첨부 블록의 경계. 말풍선에서 접을 때와 모델이 읽을 때 같은 표를 쓴다. */
export const ATTACH_OPEN = "<attached_files>";
export const ATTACH_CLOSE = "</attached_files>";

export type AttachmentKind =
  /** 본문을 실었다 */
  | "text"
  /** 디렉터리 — 목록만 실었다 */
  | "dir"
  /** 엑셀·워드·PDF 등 — 자리표만 실었다 */
  | "document"
  /** 그 밖의 바이너리 (이미지·압축·실행 파일) */
  | "binary"
  /** 못 찾았거나 읽지 못했다 */
  | "missing";

export interface Attachment {
  /** 사용자가 친 경로 원문 */
  path: string;
  /** 프로젝트 루트 기준 상대 경로 (해석에 실패하면 원문 그대로) */
  displayPath: string;
  kind: AttachmentKind;
  /** 파일 크기 (바이트) */
  size: number;
  /** 블록에 실제로 들어간 본문 */
  body: string;
  /** 본문 대신/함께 남기는 한 줄 설명 */
  note?: string;
  /** 본문이 상한에 걸려 잘렸는가 */
  truncated: boolean;
}

/** 파일 하나가 차지할 수 있는 최대 글자. 도구 출력과 같은 자를 쓴다. */
export const MAX_ATTACHMENT_CHARS = 20_000;
/** 한 메시지의 첨부 전체 상한. 이걸 넘으면 남은 파일은 자리표로만 싣는다. */
export const MAX_TOTAL_ATTACHMENT_CHARS = 60_000;
/** 디렉터리를 참조했을 때 보여줄 항목 수. */
const MAX_DIR_ENTRIES = 200;

/**
 * 본문을 실을 수 없는 문서 형식과, 그걸 여는 내장 스킬.
 * 스킬이 없는 형식은 `skill` 을 비워 두고 일반적인 안내만 한다.
 */
const DOCUMENT_TYPES: Record<string, { label: string; skill?: string }> = {
  xlsx: { label: "엑셀 문서", skill: "xlsx" },
  xlsm: { label: "엑셀 문서(매크로)", skill: "xlsx" },
  xls: { label: "엑셀 문서(구형 바이너리)", skill: "xlsx" },
  csv: { label: "CSV 표", skill: "xlsx" },
  docx: { label: "워드 문서", skill: "docx" },
  doc: { label: "워드 문서(구형 바이너리)", skill: "docx" },
  pdf: { label: "PDF 문서", skill: "pdf" },
  pptx: { label: "파워포인트 문서" },
  ppt: { label: "파워포인트 문서(구형 바이너리)" },
  hwp: { label: "한글 문서" },
  hwpx: { label: "한글 문서" },
};

/** 코드 펜스에 붙일 언어. 없으면 빈 문자열. */
const FENCE_LANGUAGE: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  ps1: "powershell",
  xml: "xml",
  svg: "xml",
};

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 본문을 실을 수 없는 문서 형식인가. */
export function documentTypeOf(path: string): { label: string; skill?: string } | null {
  return DOCUMENT_TYPES[extensionOf(path)] ?? null;
}

/** 사람이 읽는 크기. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 내용을 감쌀 펜스. 파일 안에 백틱 세 개가 있으면 블록이 그 자리에서 끊기므로
 * 본문에 든 가장 긴 백틱 줄보다 하나 더 길게 연다.
 */
function fenceFor(body: string): string {
  let longest = 2;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(longest + 1);
}

function stub(
  path: string,
  displayPath: string,
  kind: AttachmentKind,
  size: number,
  note: string,
): Attachment {
  return { path, displayPath, kind, size, body: "", note, truncated: false };
}

/**
 * 참조된 경로 하나를 첨부로 만든다. 실패해도 던지지 않는다 —
 * 오타 하나로 메시지 전송이 통째로 막히면 안 되고, "그 파일은 못 찾았다" 는
 * 사실 자체가 모델에게도 쓸모 있는 정보다.
 *
 * `budget` 은 남은 전체 글자 수다. 다 쓰면 남은 파일은 자리표로만 실린다.
 */
export async function resolveMention(
  path: string,
  options: { projectPath?: string; budget?: number } = {},
): Promise<Attachment> {
  const budget = options.budget ?? MAX_TOTAL_ATTACHMENT_CHARS;

  let info;
  try {
    info = await ipc.pathInfo(path, options.projectPath);
  } catch (error) {
    return stub(path, path, "missing", 0, `읽을 수 없습니다: ${errorText(error)}`);
  }
  if (!info.exists) {
    return stub(path, path, "missing", 0, "이 경로에는 아무것도 없습니다. 경로를 다시 확인하세요.");
  }

  if (info.isDir) {
    try {
      const entries = await ipc.listDirectory(path, { projectPath: options.projectPath });
      const shown = entries.slice(0, MAX_DIR_ENTRIES);
      const lines = shown.map((entry) => (entry.isDir ? `${entry.name}/` : entry.name));
      const { text, clipped } = clip(lines.join("\n"), Math.max(500, budget));
      return {
        path,
        displayPath: path.replace(/\/$/, ""),
        kind: "dir",
        size: 0,
        body: text,
        note:
          entries.length > shown.length
            ? `디렉터리 · 항목 ${entries.length}개 중 ${shown.length}개만 표시`
            : `디렉터리 · 항목 ${entries.length}개`,
        truncated: clipped || entries.length > shown.length,
      };
    } catch (error) {
      return stub(path, path, "missing", 0, `디렉터리를 읽을 수 없습니다: ${errorText(error)}`);
    }
  }

  // 문서 형식은 열어 보지도 않는다 — 열어 봤자 바이너리라 실을 수 없다.
  const document = documentTypeOf(path);
  if (document) {
    const how = document.skill
      ? `본문은 싣지 않았습니다. 내용이 필요하면 \`load_skill("${document.skill}")\` 로 절차를 연 뒤 Python 으로 이 경로를 직접 읽으세요.`
      : "본문은 싣지 않았습니다. 내용이 필요하면 이 형식을 읽을 수 있는 도구나 라이브러리를 셸로 확인한 뒤 처리하세요.";
    return stub(path, path, "document", info.size, `${document.label} · ${formatBytes(info.size)} — ${how}`);
  }

  if (budget <= 0) {
    return stub(
      path,
      path,
      "text",
      info.size,
      `앞선 첨부가 이미 한도를 채워 본문을 싣지 못했습니다 (${formatBytes(info.size)}). 필요하면 read_file 로 직접 읽으세요.`,
    );
  }

  try {
    const file = await ipc.readFile(path, options.projectPath);
    if (file.isBinary) {
      return stub(
        path,
        file.relativePath,
        "binary",
        file.size,
        `바이너리 파일 · ${formatBytes(file.size)} — 텍스트가 아니라 본문을 실을 수 없습니다.`,
      );
    }

    const { text, clipped } = clip(file.content, Math.min(MAX_ATTACHMENT_CHARS, budget));
    return {
      path,
      displayPath: file.relativePath,
      kind: "text",
      size: file.size,
      body: text,
      truncated: clipped || file.truncated,
    };
  } catch (error) {
    return stub(path, path, "missing", info.size, `읽을 수 없습니다: ${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 참조된 경로들을 순서대로 첨부로 만든다. 전체 상한을 함께 관리한다. */
export async function resolveMentions(
  paths: string[],
  options: { projectPath?: string } = {},
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  let budget = MAX_TOTAL_ATTACHMENT_CHARS;

  for (const path of paths) {
    const attachment = await resolveMention(path, { projectPath: options.projectPath, budget });
    budget -= attachment.body.length;
    out.push(attachment);
  }
  return out;
}

/** 첨부 하나의 제목 줄. 말풍선의 칩과 블록의 헤더가 같은 문구를 쓴다. */
export function attachmentTitle(attachment: Attachment): string {
  const suffix =
    attachment.kind === "text"
      ? `${attachment.body.length.toLocaleString()}자${attachment.truncated ? ", 일부 생략" : ""}`
      : attachment.kind === "dir"
        ? "디렉터리"
        : attachment.kind === "missing"
          ? "없음"
          : formatBytes(attachment.size);
  return `${attachment.displayPath} (${suffix})`;
}

/**
 * 사용자 메시지 뒤에 붙는 첨부 블록.
 *
 * "이미 읽어 뒀다" 를 맨 앞에 못 박는다 — 안 그러면 모델이 같은 파일을 `read_file` 로
 * 한 번 더 읽는다(그게 습관이다).
 */
export function attachmentBlock(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";

  const parts = attachments.map((attachment) => {
    const header = `## ${attachmentTitle(attachment)}`;
    if (attachment.kind === "text" || attachment.kind === "dir") {
      const fence = fenceFor(attachment.body);
      const language = attachment.kind === "dir" ? "" : (FENCE_LANGUAGE[extensionOf(attachment.path)] ?? "");
      const note = attachment.note ? `${attachment.note}\n` : "";
      return `${header}\n${note}${fence}${language}\n${attachment.body}\n${fence}`;
    }
    return `${header}\n${attachment.note ?? ""}`;
  });

  return [
    ATTACH_OPEN,
    "사용자가 @ 로 지목한 파일입니다. 아래 내용은 이미 읽어서 실어 두었으니 같은 파일을 다시 읽지 마세요.",
    "",
    parts.join("\n\n"),
    ATTACH_CLOSE,
  ].join("\n");
}

/** 본문과 첨부 블록을 잇는다. 첨부가 없으면 본문 그대로. */
export function withAttachments(text: string, attachments: Attachment[]): string {
  const block = attachmentBlock(attachments);
  return block ? `${text}\n\n${block}` : text;
}

/**
 * 저장된 사용자 메시지를 본문과 첨부 블록으로 다시 가른다.
 * 말풍선이 첨부를 접어 두기 위해 쓴다 (모델은 통째로 받는다).
 */
export function splitAttachments(content: string): { body: string; block: string | null } {
  const start = content.indexOf(ATTACH_OPEN);
  if (start < 0) return { body: content, block: null };

  const end = content.indexOf(ATTACH_CLOSE, start);
  if (end < 0) return { body: content, block: null };

  const block = content.slice(start, end + ATTACH_CLOSE.length);
  const body = (content.slice(0, start) + content.slice(end + ATTACH_CLOSE.length)).trim();
  return { body, block };
}

/** 첨부 블록에서 제목 줄만 뽑는다 (접힌 상태에서 보여줄 칩). */
export function attachmentTitles(block: string): string[] {
  return block
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}
