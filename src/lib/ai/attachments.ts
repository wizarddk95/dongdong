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
 * ## 이미지
 *
 * 이미지는 본문이 아니라 **바이트**로 실린다. 사용자 노드의 `content` 에는 마커 한 줄
 * (`<image sha="…" …/>`)만 남고, 실제 바이트는 `.agent_workspace/attachments/<sha>.<ext>` 에
 * 내용주소로 눕는다. 그렇게 나눈 이유는 두 가지다.
 *
 * 1. 원본 경로만 적어 두면 스크린샷을 지우는 순간 **그 턴의 기록이 사라진다.** 첨부의
 *    대전제는 "그때 무엇이 들어갔는지가 남는다" 이고, 이미지에서 오히려 더 중요하다.
 * 2. base64 를 `content` 에 넣으면 말풍선 · 인스펙터 · `payloadChars()` 가 전부 메가바이트
 *    문자열을 만지게 되고, `context_snapshot` 이 스텝마다 그걸 복사한다.
 *
 * 마커 → 실제 바이트로 바꾸는 일은 전송 직전 하이드레이션(`runner.ts`)이 한다.
 *
 * ## 텍스트가 아닌 파일 (엑셀 · 워드 · PDF)
 *
 * 본문을 실을 수 없다. 이 앱에는 문서 파서가 없고, 있다 해도 xlsx 를
 * 문자열로 펴서 컨텍스트에 붓는 건 대개 낭비다. 그래서 **자리표(stub)만 싣는다**:
 * 경로 · 종류 · 크기와 "어떻게 열어야 하는지" 한 줄이다. 엑셀/워드/PDF 는 이미 내장 스킬이
 * 있으므로(`lib/ai/builtinSkills.ts`) 그 스킬 이름을 짚어 준다 — 모델이 `load_skill` 로
 * 절차를 열고 Python 으로 직접 읽는 길이 그대로 이어진다.
 */
import { clip } from "@/lib/ai/tools";
import { t, type MessageKey } from "@/lib/i18n";
import {
  attachProjectImage,
  imageMediaTypeOf,
  MAX_IMAGES_PER_MESSAGE,
} from "@/lib/images";
import * as ipc from "@/lib/ipc";

/** 첨부 블록의 경계. 말풍선에서 접을 때와 모델이 읽을 때 같은 표를 쓴다. */
export const ATTACH_OPEN = "<attached_files>";
export const ATTACH_CLOSE = "</attached_files>";

export type AttachmentKind =
  /** 본문을 실었다 */
  | "text"
  /** 이미지 — 마커만 남기고 바이트는 워크스페이스에 눕혔다 */
  | "image"
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
  /** `kind === "image"` 일 때의 바이트 참조와 크기 */
  image?: ImageAttachment;
}

/**
 * 이미지 첨부 하나. 여기 있는 것이 **마커에 적히는 전부**다 —
 * 이 정보만으로 (a) 바이트를 되찾고 (b) 토큰을 세고 (c) 화면에 크기를 적을 수 있어야 한다.
 */
export interface ImageAttachment {
  /** 웹뷰가 계산한 SHA-256 (소문자 hex 64자) = 파일 이름이자 참조 키 */
  sha: string;
  mediaType: string;
  /** 저장된 바이트 기준 픽셀 크기 (축소 후) — 토큰을 세는 자다 */
  width: number;
  height: number;
  /** 저장된 바이트 수 */
  size: number;
  /** 사람이 읽을 이름. 붙여넣기처럼 이름이 없으면 만들어 붙인다 */
  name: string;
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
const DOCUMENT_TYPES: Record<string, { labelKey: MessageKey; skill?: string }> = {
  xlsx: { labelKey: "attachment.kind.xlsx", skill: "xlsx" },
  xlsm: { labelKey: "attachment.kind.xlsm", skill: "xlsx" },
  xls: { labelKey: "attachment.kind.xls", skill: "xlsx" },
  csv: { labelKey: "attachment.kind.csv", skill: "xlsx" },
  docx: { labelKey: "attachment.kind.docx", skill: "docx" },
  doc: { labelKey: "attachment.kind.doc", skill: "docx" },
  pdf: { labelKey: "attachment.kind.pdf", skill: "pdf" },
  pptx: { labelKey: "attachment.kind.pptx" },
  ppt: { labelKey: "attachment.kind.ppt" },
  hwp: { labelKey: "attachment.kind.hwp" },
  hwpx: { labelKey: "attachment.kind.hwp" },
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
export function documentTypeOf(path: string): { labelKey: MessageKey; skill?: string } | null {
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

/** `@` 참조를 푸는 데 필요한 바깥 사정. */
export interface MentionOptions {
  projectPath?: string;
  /**
   * 지금 고른 모델이 이미지를 받는가. 화면의 첨부 버튼과 **같은 판정**(`acceptsImages()`)이
   * 여기까지 와야 한다 — 안 오면 `@shot.png` 한 줄이 턴을 400 으로 끊는다.
   * 안 주면 막지 않는다(모르는 모델을 잠그면 멀쩡한 모델에서 기능이 사라진다).
   */
  acceptsImages?: boolean;
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
  options: MentionOptions & { budget?: number; imageSlots?: number } = {},
): Promise<Attachment> {
  const budget = options.budget ?? MAX_TOTAL_ATTACHMENT_CHARS;
  const imageSlots = options.imageSlots ?? MAX_IMAGES_PER_MESSAGE;

  let info;
  try {
    info = await ipc.pathInfo(path, options.projectPath);
  } catch (error) {
    return stub(path, path, "missing", 0, t("attachment.unreadable", { error: errorText(error) }));
  }
  if (!info.exists) {
    return stub(path, path, "missing", 0, t("attachment.missing"));
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
            ? t("attachment.dirPartial", { total: entries.length, shown: shown.length })
            : t("attachment.dir", { total: entries.length }),
        truncated: clipped || entries.length > shown.length,
      };
    } catch (error) {
      return stub(
        path,
        path,
        "missing",
        0,
        t("attachment.dirUnreadable", { error: errorText(error) }),
      );
    }
  }

  // 이미지는 본문이 아니라 **바이트**로 실린다 — 붙여넣기와 같은 길(`attachProjectImage`)을
  // 타고 `.agent_workspace/attachments/` 에 눕는다. 그래서 여기서 하는 일은 마커 하나를 얻는
  // 것뿐이고, **글자 예산(`budget`)은 건드리지 않는다** — 그건 본문을 재는 자다.
  const mediaType = imageMediaTypeOf(path);
  if (mediaType) {
    // 비전 없는 모델에 이미지를 실으면 전송 자체가 400 으로 끊긴다. 자리표로 물러나면
    // 대화는 이어지고, 무엇을 못 실었는지도 모델에게 남는다.
    if (options.acceptsImages === false) {
      return stub(
        path,
        path,
        "binary",
        info.size,
        t("attachment.imageNoVision", { size: formatBytes(info.size) }),
      );
    }
    if (imageSlots <= 0) {
      return stub(
        path,
        path,
        "binary",
        info.size,
        t("attachment.imageTooMany", { max: MAX_IMAGES_PER_MESSAGE }),
      );
    }
    try {
      const image = await attachProjectImage(path, { projectPath: options.projectPath });
      return {
        path,
        displayPath: image.name,
        kind: "image",
        size: image.size,
        body: "",
        truncated: false,
        image,
      };
    } catch (error) {
      return stub(path, path, "binary", info.size, t("attachment.imageFailed", { error: errorText(error) }));
    }
  }

  // 문서 형식은 열어 보지도 않는다 — 열어 봤자 바이너리라 실을 수 없다.
  const document = documentTypeOf(path);
  if (document) {
    const how = document.skill
      ? t("attachment.documentSkill", { skill: document.skill })
      : t("attachment.documentNoSkill");
    return stub(
      path,
      path,
      "document",
      info.size,
      `${t(document.labelKey)} · ${formatBytes(info.size)} — ${how}`,
    );
  }

  if (budget <= 0) {
    return stub(
      path,
      path,
      "text",
      info.size,
      t("attachment.budgetExhausted", { size: formatBytes(info.size) }),
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
        t("attachment.binary", { size: formatBytes(file.size) }),
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
    return stub(
      path,
      path,
      "missing",
      info.size,
      t("attachment.unreadable", { error: errorText(error) }),
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 참조된 경로들을 순서대로 첨부로 만든다. 전체 상한을 함께 관리한다.
 *
 * 상한은 **둘이고 자가 다르다** — 텍스트는 글자 수(`budget`), 이미지는 장수(`imageSlots`).
 * 이미지 한 장은 마커 한 줄이라 글자로 재면 공짜처럼 보이는데 실제로는 토큰 수천을 먹는다.
 */
export async function resolveMentions(
  paths: string[],
  options: MentionOptions = {},
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  let budget = MAX_TOTAL_ATTACHMENT_CHARS;
  let imageSlots = MAX_IMAGES_PER_MESSAGE;

  for (const path of paths) {
    const attachment = await resolveMention(path, { ...options, budget, imageSlots });
    budget -= attachment.body.length;
    if (attachment.kind === "image") imageSlots -= 1;
    out.push(attachment);
  }
  return out;
}

/** 첨부 하나의 제목 줄. 말풍선의 칩과 블록의 헤더가 같은 문구를 쓴다. */
export function attachmentTitle(attachment: Attachment): string {
  const suffix =
    attachment.kind === "text"
      ? t(attachment.truncated ? "attachment.charsTruncated" : "attachment.chars", {
          chars: attachment.body.length.toLocaleString(),
        })
      : attachment.kind === "image" && attachment.image
        ? // 이미지 꼬리표는 문장이 아니라 데이터다 — 사전을 태우지 않는다.
          // 한국어로 만든 대화를 영어로 열어도 이 줄은 그대로여야 한다(디스크에 남는 값이다).
          `${attachment.image.mediaType} · ${attachment.image.width}×${attachment.image.height} · ${formatBytes(attachment.image.size)}`
        : attachment.kind === "dir"
          ? t("attachment.dirLabel")
          : attachment.kind === "missing"
            ? t("attachment.none")
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
    // 이미지는 본문 대신 마커 한 줄. 전송 직전에 진짜 바이트로 바뀐다.
    if (attachment.kind === "image" && attachment.image) {
      return `${header}\n${imageMarker(attachment.image)}`;
    }
    return `${header}\n${attachment.note ?? ""}`;
  });

  return [
    ATTACH_OPEN,
    t("attachment.header"),
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

// ------------------------------------------------------------- 이미지 마커

/**
 * 페이로드에 실리는 이미지 참조. **base64 가 아니다.**
 *
 * `buildTurnContext()` 가 만든 컨텍스트는 assistant 노드의 `context_snapshot` 으로 통째로
 * 저장되는데, 여기에 진짜 바이트가 들어 있으면 스텝마다 이미지가 한 벌씩 복사된다
 * (5스텝 턴이면 다섯 벌). 그래서 스냅샷에는 참조만 두고, `runTurn()` 이 보내기 직전에
 * 바이트로 갈아 끼운다. 인스펙터는 이 참조를 보고 크기·형식을 적는다 —
 * base64 를 그대로 뿌리면 인스펙터는 읽을 수 없는 벽이 된다.
 */
export const IMAGE_REF_PREFIX = "dd-image:";

export function imageRef(sha: string): string {
  return `${IMAGE_REF_PREFIX}${sha}`;
}

export function isImageRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(IMAGE_REF_PREFIX);
}

/** 참조에서 sha 를 뽑는다. 참조가 아니면 `null`. */
export function shaOfRef(value: unknown): string | null {
  return isImageRef(value) ? value.slice(IMAGE_REF_PREFIX.length) : null;
}

/** SHA-256(소문자 hex 64자)인가. Rust 쪽 `is_sha256()` 과 같은 자를 쓴다. */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** 마커 안의 이름은 따옴표·꺾쇠를 품을 수 있다 — 그대로 적으면 마커가 그 자리에서 끊긴다. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** 사용자 노드의 `content` 에 남는 이미지 한 줄. */
export function imageMarker(image: ImageAttachment): string {
  const attributes = [
    `sha="${image.sha}"`,
    `type="${escapeAttribute(image.mediaType)}"`,
    `w="${image.width}"`,
    `h="${image.height}"`,
    `bytes="${image.size}"`,
    `name="${escapeAttribute(image.name)}"`,
  ];
  return `<image ${attributes.join(" ")} />`;
}

/** 마커를 찾는 자. 쓸 때마다 새로 만든다 — 전역 정규식은 `lastIndex` 를 들고 다녀 한 건씩 샌다. */
function markerPattern(): RegExp {
  return /<image\s+([^>]*?)\s*\/>/g;
}

function readAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+)="([^"]*)"/g)) {
    out[match[1]] = unescapeAttribute(match[2]);
  }
  return out;
}

/**
 * 마커 하나를 이미지로 되돌린다. 모양이 어긋나면 `null` —
 * 사람이 손으로 고친 대화 하나가 전송을 통째로 막으면 안 된다.
 */
export function parseImageMarker(raw: string): ImageAttachment | null {
  const attributes = readAttributes(raw);
  const sha = attributes.sha ?? "";
  if (!isSha256(sha)) return null;

  const width = Number(attributes.w);
  const height = Number(attributes.h);
  const size = Number(attributes.bytes);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

  return {
    sha,
    mediaType: attributes.type || "image/png",
    width,
    height,
    size: Number.isFinite(size) ? size : 0,
    name: attributes.name || sha.slice(0, 12),
  };
}

/** 본문에 실린 이미지들을 순서대로. 화면과 토큰 계산이 같은 목록을 쓴다. */
export function parseImageMarkers(content: string): ImageAttachment[] {
  const out: ImageAttachment[] = [];
  for (const match of content.matchAll(markerPattern())) {
    const image = parseImageMarker(match[1]);
    if (image) out.push(image);
  }
  return out;
}

/** 본문을 텍스트 조각과 이미지로 가른 결과. */
export type ContentPiece =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageAttachment };

/**
 * 본문을 텍스트와 이미지로 가른다. `toModelMessages()` 가 파트 배열을 만들 때 쓴다.
 *
 * 못 알아본 마커는 **텍스트로 남겨 둔다** — 조용히 지우면 그 자리에 무엇이 있었는지가 사라진다.
 */
export function splitImageMarkers(content: string): ContentPiece[] {
  const pieces: ContentPiece[] = [];
  let cursor = 0;

  for (const match of content.matchAll(markerPattern())) {
    const image = parseImageMarker(match[1]);
    if (!image) continue;

    const start = match.index ?? 0;
    const before = content.slice(cursor, start);
    if (before) pieces.push({ type: "text", text: before });
    pieces.push({ type: "image", image });
    cursor = start + match[0].length;
  }

  const rest = content.slice(cursor);
  if (rest) pieces.push({ type: "text", text: rest });
  return pieces;
}
