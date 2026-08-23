/**
 * 이미지 첨부의 웹뷰 쪽 절반 — 바이트를 받아 줄이고, 지문을 뜨고, 워크스페이스에 눕힌다.
 *
 * **왜 웹뷰가 하는가.** 붙여넣기·파일 선택은 `File` 객체로 **바이트를 바로** 준다.
 * 경로를 받아 Rust 로 읽으면 프로젝트 루트 밖(바탕화면 스크린샷)을 여는 길을 새로 뚫어야 하고,
 * 그건 `resolve_within()` 이 지키던 담장에 구멍을 내는 일이다. 바이트가 이미 여기 있으니
 * 담장을 건드릴 이유가 없다.
 *
 * 픽셀을 만지는 일(디코드·축소·재인코딩)도 여기 있다 — Rust 에 이미지 크레이트를 들이지 않는다.
 * **얼마로 줄일지는 `lib/ai/imageTokens.ts` 가 정한다**(축소한 크기와 토큰을 세는 크기가
 * 어긋나면 게이지가 조용히 틀린다).
 */
import type { ImageAttachment } from "@/lib/ai/attachments";
import { fitWithinMaxEdge, MAX_IMAGE_EDGE } from "@/lib/ai/imageTokens";
import * as ipc from "@/lib/ipc";
import type { AttachmentBytes } from "@/types/ipc";

/**
 * 받아 줄 형식. **Rust 의 `ATTACHMENT_TYPES` 와 같아야 한다** —
 * 여기서 통과시킨 것을 저쪽이 거절하면 붙여넣기가 조용히 실패한다.
 */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** 줄인 뒤 다시 인코딩할 때 쓰는 형식. 세 공급자가 모두 받고, PNG 보다 훨씬 작다. */
const REENCODE_MEDIA_TYPE = "image/webp";
const REENCODE_QUALITY = 0.9;

/** 한 메시지에 실을 수 있는 장수. 넘으면 나머지는 붙이지 않는다. */
export const MAX_IMAGES_PER_MESSAGE = 5;

/** 원본 바이트 상한. 이보다 크면 줄이기 전에 거절한다(디코딩 자체가 창을 멈춘다). */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export function isSupportedImageType(mediaType: string): boolean {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** 클립보드·드롭·파일 선택에서 온 것이 이미지인가. */
export function isImageFile(file: File): boolean {
  return isSupportedImageType(file.type);
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 큰 배열을 한 번에 `String.fromCharCode` 에 넣으면 스택이 넘친다 — 조각내서 넘긴다. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/**
 * 내용주소 키. 파일 이름이 되므로 Rust 쪽 `is_sha256()` 이 다시 한 번 모양을 본다.
 *
 * `crypto.subtle` 은 **보안 컨텍스트에서만** 산다. Tauri 는 `http://tauri.localhost`(개발은
 * `http://localhost:1420`)로 서빙하고 크로미움은 `*.localhost` 를 신뢰하므로 여기서는 있다 —
 * 그래도 없을 때 "undefined 의 digest 를 읽을 수 없음" 같은 말이 뜨면 원인을 못 찾는다.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("이 창에서는 SHA-256 을 계산할 수 없습니다 (보안 컨텍스트가 아닙니다)");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 축소·재인코딩을 거친 바이트. 원본이 이미 작으면 원본 그대로다. */
export interface PreparedImage {
  bytes: Uint8Array;
  mediaType: string;
  width: number;
  height: number;
  /** 원본을 줄였는가 (화면에 "줄여서 보냅니다" 를 적을 수 있게) */
  resized: boolean;
  /** 줄이기 전 크기 */
  sourceWidth: number;
  sourceHeight: number;
}

function canvasFor(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encode(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mediaType: string,
  quality: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: mediaType, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("이미지를 인코딩하지 못했습니다"))),
      mediaType,
      quality,
    );
  });
}

/**
 * 보낼 수 있는 모양으로 다듬는다.
 *
 * 긴 변이 `MAX_IMAGE_EDGE` 안이면 **원본 바이트를 그대로 쓴다** — 다시 인코딩해 봐야
 * 화질만 잃고 크기는 줄지 않는 경우가 많다. 넘을 때만 줄이고 webp 로 다시 굽는다.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isImageFile(file)) {
    throw new Error(`첨부할 수 없는 형식입니다: ${file.type || "알 수 없음"}`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("이미지가 너무 큽니다");
  }

  const bitmap = await createImageBitmap(file);
  const source = { width: bitmap.width, height: bitmap.height };
  const target = fitWithinMaxEdge(source, MAX_IMAGE_EDGE);

  if (target.width === source.width && target.height === source.height) {
    bitmap.close();
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: file.type,
      ...source,
      resized: false,
      sourceWidth: source.width,
      sourceHeight: source.height,
    };
  }

  const canvas = canvasFor(target.width, target.height);
  const context = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) throw new Error("이미지를 줄이지 못했습니다");

  context.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();

  const blob = await encode(canvas, REENCODE_MEDIA_TYPE, REENCODE_QUALITY);
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mediaType: REENCODE_MEDIA_TYPE,
    ...target,
    resized: true,
    sourceWidth: source.width,
    sourceHeight: source.height,
  };
}

/**
 * 화면이 들고 다니는 첨부. `resized` 는 **마커에 적히지 않는다** —
 * 대화에 남는 것은 실제로 보낸 크기이고, "줄였다" 는 지금 이 입력칸에만 쓸모 있는 사실이다.
 */
export interface AttachedImage extends ImageAttachment {
  resized: boolean;
}

/**
 * 다듬은 바이트를 워크스페이스에 눕히고 첨부 하나를 돌려준다.
 * 같은 이미지를 다시 붙여도 파일은 하나뿐이다(내용주소).
 */
export async function attachImage(
  file: File,
  options: { projectPath?: string } = {},
): Promise<AttachedImage> {
  const prepared = await prepareImage(file);
  const sha = await sha256Hex(prepared.bytes);

  const saved = await ipc.saveAttachment(
    { sha, data: toBase64(prepared.bytes), mediaType: prepared.mediaType },
    options.projectPath,
  );

  const extension = EXTENSIONS[prepared.mediaType] ?? "png";
  return {
    sha: saved.sha,
    mediaType: saved.mediaType,
    width: prepared.width,
    height: prepared.height,
    size: saved.size,
    name: file.name || `image-${sha.slice(0, 8)}.${extension}`,
    resized: prepared.resized,
  };
}

// ------------------------------------------------------------- 되읽기

/**
 * 되읽은 바이트를 들고 있는 곳. 한 턴에 같은 이미지를 여러 번 읽지 않게(전송 · 썸네일 ·
 * 인스펙터가 전부 같은 sha 를 찾는다) 모듈 수명으로 붙잡는다.
 * 내용주소라 **무효화가 필요 없다** — 같은 sha 는 영원히 같은 바이트다.
 */
const cache = new Map<string, AttachmentBytes>();

export async function loadAttachment(
  sha: string,
  projectPath?: string,
): Promise<AttachmentBytes | null> {
  const cached = cache.get(sha);
  if (cached) return cached;

  try {
    const bytes = await ipc.readAttachment(sha, projectPath);
    cache.set(sha, bytes);
    return bytes;
  } catch {
    // 워크스페이스를 지웠거나 다른 프로젝트에서 연 대화다. 전송도 화면도 이걸 견뎌야 한다.
    return null;
  }
}

/** 여러 장을 한 번에. 못 찾은 것은 빠진다. */
export async function loadAttachments(
  shas: string[],
  projectPath?: string,
): Promise<Map<string, AttachmentBytes>> {
  const unique = [...new Set(shas)];
  const loaded = await Promise.all(unique.map((sha) => loadAttachment(sha, projectPath)));

  const out = new Map<string, AttachmentBytes>();
  unique.forEach((sha, index) => {
    const bytes = loaded[index];
    if (bytes) out.set(sha, bytes);
  });
  return out;
}

/** `<img src>` 에 그대로 넣는 값. CSP 가 `img-src ... data:` 를 이미 열어 두었다. */
export function toDataUrl(bytes: Pick<AttachmentBytes, "mediaType" | "base64">): string {
  return `data:${bytes.mediaType};base64,${bytes.base64}`;
}
