import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  saveAttachment: vi.fn(),
  readAttachment: vi.fn(),
  readFileBase64: vi.fn(),
}));

import {
  attachProjectImage,
  imageMediaTypeOf,
  isImagePath,
  isSupportedImageType,
  IMAGE_MEDIA_TYPES,
} from "@/lib/images";

describe("imageMediaTypeOf / isImagePath", () => {
  it("확장자로 형식을 정한다", () => {
    expect(imageMediaTypeOf("shot.png")).toBe("image/png");
    expect(imageMediaTypeOf("docs/a/b/logo.webp")).toBe("image/webp");
    expect(imageMediaTypeOf("C:\\p\\anim.GIF")).toBe("image/gif");
  });

  it("jpg 와 jpeg 는 같은 형식이다", () => {
    expect(imageMediaTypeOf("a.jpg")).toBe("image/jpeg");
    expect(imageMediaTypeOf("a.jpeg")).toBe("image/jpeg");
  });

  it("Rust 가 받는 형식만 나온다", () => {
    // 여기서 통과시킨 것을 `ATTACHMENT_TYPES` 가 거절하면 첨부가 조용히 실패한다.
    for (const path of ["a.png", "a.jpg", "a.jpeg", "a.webp", "a.gif"]) {
      expect(isSupportedImageType(imageMediaTypeOf(path)!)).toBe(true);
    }
    expect(IMAGE_MEDIA_TYPES).toContain("image/png");
  });

  it("SVG 는 이미지가 아니다 — 텍스트로 실려야 한다", () => {
    expect(imageMediaTypeOf("icon.svg")).toBeNull();
    expect(isImagePath("icon.svg")).toBe(false);
  });

  it("확장자가 없거나 이미지가 아니면 null", () => {
    expect(imageMediaTypeOf("README")).toBeNull();
    expect(imageMediaTypeOf(".gitignore")).toBeNull();
    expect(imageMediaTypeOf("a.ts")).toBeNull();
    expect(imageMediaTypeOf("보고서.xlsx")).toBeNull();
  });
});

describe("attachProjectImage", () => {
  it("이미지가 아닌 경로는 읽어 보지도 않는다", async () => {
    const ipc = await import("@/lib/ipc");
    await expect(attachProjectImage("src/main.tsx")).rejects.toThrow("이미지 형식이");
    expect(vi.mocked(ipc.readFileBase64)).not.toHaveBeenCalled();
  });
});
