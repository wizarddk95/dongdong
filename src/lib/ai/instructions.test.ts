import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ readFile: vi.fn() }));

import {
  composeSystemPrompt,
  instructionBlock,
  loadProjectInstructions,
  MAX_INSTRUCTION_CHARS,
  type ProjectInstructions,
} from "@/lib/ai/instructions";
import * as ipc from "@/lib/ipc";

const mocked = vi.mocked(ipc);

function file(partial: { content: string; relativePath?: string; isBinary?: boolean }) {
  return {
    path: `C:/p/${partial.relativePath ?? "AGENTS.md"}`,
    relativePath: partial.relativePath ?? "AGENTS.md",
    content: partial.content,
    size: partial.content.length,
    truncated: false,
    isBinary: partial.isBinary ?? false,
  };
}

const loaded: ProjectInstructions = {
  path: "AGENTS.md",
  content: "빌드는 pnpm build 로 한다.",
  truncated: false,
  loadedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadProjectInstructions", () => {
  it("프로젝트 루트의 AGENTS.md 를 읽는다", async () => {
    mocked.readFile.mockResolvedValue(file({ content: "  빌드는 pnpm build 로 한다.  " }));

    const instructions = await loadProjectInstructions();

    expect(mocked.readFile).toHaveBeenCalledWith("AGENTS.md", undefined);
    expect(instructions).toMatchObject({
      path: "AGENTS.md",
      content: "빌드는 pnpm build 로 한다.",
      truncated: false,
    });
  });

  it("파일이 없으면 에러가 아니라 null 이다", async () => {
    mocked.readFile.mockRejectedValue(new Error("찾을 수 없습니다: AGENTS.md"));
    await expect(loadProjectInstructions()).resolves.toBeNull();
  });

  it("대소문자가 다른 이름도 찾아본다", async () => {
    mocked.readFile
      .mockRejectedValueOnce(new Error("찾을 수 없습니다: AGENTS.md"))
      .mockResolvedValueOnce(file({ content: "규칙", relativePath: "agents.md" }));

    const instructions = await loadProjectInstructions();

    expect(instructions?.path).toBe("agents.md");
  });

  it("빈 파일이나 바이너리는 무시한다", async () => {
    mocked.readFile.mockResolvedValue(file({ content: "   " }));
    await expect(loadProjectInstructions()).resolves.toBeNull();

    mocked.readFile.mockResolvedValue(file({ content: "\u0000이진", isBinary: true }));
    await expect(loadProjectInstructions()).resolves.toBeNull();
  });

  it("너무 긴 지침은 잘라내고 표시를 남긴다", async () => {
    mocked.readFile.mockResolvedValue(file({ content: "가".repeat(MAX_INSTRUCTION_CHARS + 500) }));

    const instructions = await loadProjectInstructions();

    expect(instructions?.content.length).toBe(MAX_INSTRUCTION_CHARS);
    expect(instructions?.truncated).toBe(true);
  });
});

describe("composeSystemPrompt", () => {
  it("지침을 시스템 프롬프트 맨 앞에 붙인다", () => {
    const system = composeSystemPrompt("당신은 코딩 에이전트입니다.", loaded);

    expect(system.startsWith("# 프로젝트 지침 (AGENTS.md)")).toBe(true);
    expect(system).toContain("빌드는 pnpm build 로 한다.");
    expect(system.indexOf("빌드는")).toBeLessThan(system.indexOf("당신은 코딩 에이전트입니다."));
  });

  it("지침이 없으면 기본 프롬프트를 그대로 둔다", () => {
    expect(composeSystemPrompt("기본", null)).toBe("기본");
  });

  it("잘린 지침은 원본을 직접 읽으라고 알려 준다", () => {
    const block = instructionBlock({ ...loaded, truncated: true });
    expect(block).toContain("AGENTS.md 를 직접 읽으세요");
  });
});
