import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  pathInfo: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}));

import {
  ATTACH_CLOSE,
  ATTACH_OPEN,
  attachmentBlock,
  attachmentTitles,
  documentTypeOf,
  extensionOf,
  imageMarker,
  imageRef,
  isSha256,
  parseImageMarker,
  parseImageMarkers,
  shaOfRef,
  splitImageMarkers,
  formatBytes,
  MAX_ATTACHMENT_CHARS,
  resolveMention,
  resolveMentions,
  splitAttachments,
  withAttachments,
  type Attachment,
  type ImageAttachment,
} from "@/lib/ai/attachments";
import * as ipc from "@/lib/ipc";

const mocked = vi.mocked(ipc);

function info(partial: Partial<ReturnType<typeof baseInfo>> = {}) {
  return { ...baseInfo(), ...partial };
}
function baseInfo() {
  return { path: "C:/p/a.ts", exists: true, isDir: false, isFile: true, size: 12 };
}

function fileContent(content: string, extra: { isBinary?: boolean; relativePath?: string } = {}) {
  return {
    path: `C:/p/${extra.relativePath ?? "a.ts"}`,
    relativePath: extra.relativePath ?? "a.ts",
    content,
    size: content.length,
    truncated: false,
    isBinary: extra.isBinary ?? false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extensionOf / documentTypeOf", () => {
  it("확장자를 소문자로 뽑는다", () => {
    expect(extensionOf("보고서.XLSX")).toBe("xlsx");
    expect(extensionOf("src/lib/ipc.ts")).toBe("ts");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("본문을 실을 수 없는 문서는 여는 스킬을 짚어 준다", () => {
    expect(documentTypeOf("a.xlsx")?.skill).toBe("xlsx");
    expect(documentTypeOf("a.docx")?.skill).toBe("docx");
    expect(documentTypeOf("a.pdf")?.skill).toBe("pdf");
    // 내장 스킬이 없는 형식은 라벨만 있고 스킬은 비어 있다.
    expect(documentTypeOf("a.pptx")?.skill).toBeUndefined();
    expect(documentTypeOf("a.ts")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("사람이 읽는 크기", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0MB");
  });
});

describe("resolveMention", () => {
  it("텍스트 파일은 본문을 싣는다", async () => {
    mocked.pathInfo.mockResolvedValue(info());
    mocked.readFile.mockResolvedValue(fileContent("export const a = 1;"));

    const attachment = await resolveMention("src/a.ts");
    expect(attachment.kind).toBe("text");
    expect(attachment.body).toBe("export const a = 1;");
    expect(mocked.readFile).toHaveBeenCalledOnce();
  });

  it("엑셀·워드·PDF 는 열지 않고 자리표만 싣는다", async () => {
    mocked.pathInfo.mockResolvedValue(info({ size: 24_000 }));

    const attachment = await resolveMention("보고서.xlsx");
    expect(attachment.kind).toBe("document");
    expect(attachment.body).toBe("");
    expect(attachment.note).toContain('load_skill("xlsx")');
    // 바이너리를 읽어 컨텍스트에 붓는 일이 없어야 한다.
    expect(mocked.readFile).not.toHaveBeenCalled();
  });

  it("내장 스킬이 없는 문서는 일반 안내만 한다", async () => {
    mocked.pathInfo.mockResolvedValue(info({ size: 1000 }));
    const attachment = await resolveMention("발표.pptx");
    expect(attachment.kind).toBe("document");
    expect(attachment.note).not.toContain("load_skill");
  });

  it("그 밖의 바이너리는 읽어 보고 자리표로 떨어진다", async () => {
    mocked.pathInfo.mockResolvedValue(info());
    mocked.readFile.mockResolvedValue(fileContent("", { isBinary: true, relativePath: "a.png" }));

    const attachment = await resolveMention("a.png");
    expect(attachment.kind).toBe("binary");
    expect(attachment.note).toContain("실을 수 없습니다");
  });

  it("디렉터리는 목록만 싣는다", async () => {
    mocked.pathInfo.mockResolvedValue(info({ isDir: true, isFile: false }));
    mocked.listDirectory.mockResolvedValue([
      { name: "lib", path: "", relativePath: "src/lib", isDir: true, isSymlink: false, size: 0, modified: null },
      { name: "main.tsx", path: "", relativePath: "src/main.tsx", isDir: false, isSymlink: false, size: 10, modified: null },
    ]);

    const attachment = await resolveMention("src");
    expect(attachment.kind).toBe("dir");
    expect(attachment.body).toBe("lib/\nmain.tsx");
  });

  it("없는 경로도 던지지 않고 사실대로 싣는다", async () => {
    mocked.pathInfo.mockResolvedValue(info({ exists: false }));
    const attachment = await resolveMention("없는파일.ts");
    expect(attachment.kind).toBe("missing");
    expect(attachment.note).toContain("아무것도 없습니다");
  });

  it("읽기 실패도 결말이지 예외가 아니다", async () => {
    mocked.pathInfo.mockRejectedValue(new Error("경로 접근이 거부되었습니다"));
    const attachment = await resolveMention("../밖.txt");
    expect(attachment.kind).toBe("missing");
    expect(attachment.note).toContain("거부");
  });

  it("긴 파일은 상한에서 잘린다", async () => {
    mocked.pathInfo.mockResolvedValue(info());
    mocked.readFile.mockResolvedValue(fileContent("가".repeat(MAX_ATTACHMENT_CHARS + 500)));

    const attachment = await resolveMention("big.ts");
    expect(attachment.truncated).toBe(true);
    expect(attachment.body.length).toBeLessThan(MAX_ATTACHMENT_CHARS + 200);
  });

  it("남은 한도가 없으면 본문 대신 안내만 싣는다", async () => {
    mocked.pathInfo.mockResolvedValue(info());
    const attachment = await resolveMention("src/a.ts", { budget: 0 });
    expect(attachment.body).toBe("");
    expect(attachment.note).toContain("한도");
    expect(mocked.readFile).not.toHaveBeenCalled();
  });
});

describe("resolveMentions", () => {
  it("앞 파일이 한도를 쓰면 뒤 파일은 자리표가 된다", async () => {
    mocked.pathInfo.mockResolvedValue(info());
    mocked.readFile.mockResolvedValue(fileContent("가".repeat(MAX_ATTACHMENT_CHARS)));

    const [first, second, third] = await resolveMentions(["a.ts", "b.ts", "c.ts", "d.ts"]).then(
      (all) => all,
    );
    expect(first.body.length).toBeGreaterThan(0);
    expect(second.body.length).toBeGreaterThan(0);
    expect(third.body.length).toBeGreaterThan(0);
    // 20,000자 × 3 = 60,000자로 한도가 소진된다 → 네 번째는 본문이 없다.
    const all = await resolveMentions(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(all[3].body).toBe("");
  });
});

describe("attachmentBlock / splitAttachments", () => {
  const text: Attachment = {
    path: "src/a.ts",
    displayPath: "src/a.ts",
    kind: "text",
    size: 19,
    body: "export const a = 1;",
    truncated: false,
  };
  const document: Attachment = {
    path: "보고서.xlsx",
    displayPath: "보고서.xlsx",
    kind: "document",
    size: 2048,
    body: "",
    note: "엑셀 문서 · 2.0KB — 본문은 싣지 않았습니다.",
    truncated: false,
  };

  it("첨부가 없으면 본문 그대로", () => {
    expect(withAttachments("안녕", [])).toBe("안녕");
    expect(attachmentBlock([])).toBe("");
  });

  it("경계 표와 '다시 읽지 마세요' 안내가 들어간다", () => {
    const block = attachmentBlock([text]);
    expect(block.startsWith(ATTACH_OPEN)).toBe(true);
    expect(block.endsWith(ATTACH_CLOSE)).toBe(true);
    expect(block).toContain("다시 읽지 마세요");
    expect(block).toContain("export const a = 1;");
  });

  it("본문에 백틱 세 개가 있어도 펜스가 끊기지 않는다", () => {
    const tricky: Attachment = { ...text, body: "```\ncode\n```" };
    const block = attachmentBlock([tricky]);
    expect(block).toContain("````");
  });

  it("자리표는 본문 없이 설명만 남는다", () => {
    const block = attachmentBlock([document]);
    expect(block).toContain("엑셀 문서");
    expect(block).not.toContain("```");
  });

  it("본문과 블록을 다시 가른다", () => {
    const joined = withAttachments("이거 봐줘 @src/a.ts", [text]);
    const split = splitAttachments(joined);
    expect(split.body).toBe("이거 봐줘 @src/a.ts");
    expect(split.block).toContain("export const a = 1;");
  });

  it("첨부가 없는 메시지는 그대로 돌려준다", () => {
    expect(splitAttachments("평범한 메시지")).toEqual({ body: "평범한 메시지", block: null });
  });

  it("제목 줄만 뽑아 칩으로 쓴다", () => {
    const block = attachmentBlock([text, document]);
    expect(attachmentTitles(block)).toHaveLength(2);
    expect(attachmentTitles(block)[0]).toContain("src/a.ts");
  });
});

// ------------------------------------------------------------- 이미지 마커

const SHA = "a".repeat(64);

function image(partial: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    sha: SHA,
    mediaType: "image/png",
    width: 1024,
    height: 768,
    size: 319_488,
    name: "shot.png",
    ...partial,
  };
}

describe("이미지 마커 — content 에 남는 한 줄", () => {
  it("적었다가 그대로 되읽는다", () => {
    const source = image();
    const parsed = parseImageMarker(imageMarker(source).replace(/^<image\s+|\s*\/>$/g, ""));
    expect(parsed).toEqual(source);
  });

  it("본문에서 순서대로 뽑는다", () => {
    const content = `앞\n${imageMarker(image())}\n사이\n${imageMarker(image({ sha: "b".repeat(64), name: "두번째.webp" }))}\n뒤`;
    const found = parseImageMarkers(content);

    expect(found).toHaveLength(2);
    expect(found[0].name).toBe("shot.png");
    expect(found[1].sha).toBe("b".repeat(64));
  });

  it("따옴표·꺾쇠가 든 이름도 마커를 끊지 않는다", () => {
    const tricky = image({ name: 'a"b<c>&d.png' });
    const found = parseImageMarkers(imageMarker(tricky));

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('a"b<c>&d.png');
  });

  it("sha 모양이 어긋난 마커는 무시한다 (손으로 고친 대화가 전송을 막으면 안 된다)", () => {
    expect(parseImageMarkers('<image sha="../../etc/passwd" w="10" h="10" />')).toEqual([]);
    expect(parseImageMarkers('<image sha="ABC" w="10" h="10" />')).toEqual([]);
    expect(parseImageMarkers("이미지가 없는 평범한 본문")).toEqual([]);
  });

  it("sha 판정은 소문자 hex 64자만 통과시킨다", () => {
    expect(isSha256(SHA)).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isSha256("a".repeat(63))).toBe(false);
    expect(isSha256(`${"a".repeat(62)}/x`)).toBe(false);
  });

  it("참조는 접두사로 알아보고 sha 를 되돌려준다", () => {
    expect(shaOfRef(imageRef(SHA))).toBe(SHA);
    expect(shaOfRef("iVBORw0KGgo=")).toBeNull();
    expect(shaOfRef(undefined)).toBeNull();
  });
});

describe("splitImageMarkers — 본문을 텍스트와 이미지로 가른다", () => {
  it("앞뒤 텍스트를 살려 순서를 지킨다", () => {
    const pieces = splitImageMarkers(`앞${imageMarker(image())}뒤`);

    expect(pieces.map((piece) => piece.type)).toEqual(["text", "image", "text"]);
    expect(pieces[0]).toEqual({ type: "text", text: "앞" });
    expect(pieces[2]).toEqual({ type: "text", text: "뒤" });
  });

  it("이미지가 없으면 텍스트 한 조각뿐이다", () => {
    expect(splitImageMarkers("그냥 글")).toEqual([{ type: "text", text: "그냥 글" }]);
  });

  it("빈 본문은 아무 조각도 만들지 않는다", () => {
    expect(splitImageMarkers("")).toEqual([]);
  });

  it("못 알아본 마커는 텍스트로 남는다 (조용히 지우지 않는다)", () => {
    const broken = '<image sha="짧음" w="1" h="1" />';
    expect(splitImageMarkers(broken)).toEqual([{ type: "text", text: broken }]);
  });
});

describe("이미지 첨부 블록", () => {
  function attachment(): Attachment {
    return {
      path: "shot.png",
      displayPath: "shot.png",
      kind: "image",
      size: 319_488,
      body: "",
      truncated: false,
      image: image(),
    };
  }

  it("본문 대신 마커가 실리고 제목에 크기가 적힌다", () => {
    const block = attachmentBlock([attachment()]);

    expect(block).toContain("## shot.png (image/png · 1024×768 · 312.0KB)");
    expect(block).toContain(imageMarker(image()));
    // base64 는 어디에도 없다 — 그게 이 설계의 요점이다.
    expect(block).not.toContain("base64");
  });

  it("저장된 본문에서 다시 갈라 이미지를 찾아낼 수 있다", () => {
    const content = withAttachments("이거 봐 줘", [attachment()]);
    const { body, block } = splitAttachments(content);

    expect(body).toBe("이거 봐 줘");
    expect(parseImageMarkers(block ?? "")).toEqual([image()]);
  });
});
