import { beforeEach, describe, expect, it, vi } from "vitest";

// 디스크(Rust)로 나가는 길만 갈아 끼운다. 여기서 보는 건 스토어가 무엇을 언제 부르는가다.
vi.mock("@/lib/ipc", () => ({
  listSkillFiles: vi.fn(async () => []),
  skillDirs: vi.fn(async () => ({ user: "C:/cfg/skills", project: null })),
  createSkillFile: vi.fn(async () => "C:/cfg/skills/report/SKILL.md"),
  writeSkillFile: vi.fn(async () => undefined),
  deleteSkillFile: vi.fn(async () => true),
}));

import * as ipc from "@/lib/ipc";
import { useSkills } from "@/store/skills";
import type { SkillFile } from "@/types/ipc";

const FILE: SkillFile = {
  source: "user",
  folder: "report",
  path: "C:/cfg/skills/report/SKILL.md",
  content: "---\nname: report\ndescription: 보고서\n---\n\n본문",
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useSkills.setState({ files: [], dirs: null, loading: false, error: null });
});

describe("스킬 문서 고쳐 쓰기", () => {
  it("원문을 그대로 쓰고 곧바로 디스크를 다시 읽는다", async () => {
    vi.mocked(ipc.listSkillFiles).mockResolvedValue([FILE]);

    const next = "---\nname: report\ndescription: 고친 설명\n---\n\n새 본문";
    await useSkills.getState().save(FILE.path, next);

    expect(ipc.writeSkillFile).toHaveBeenCalledWith(FILE.path, next);
    // 다시 읽지 않으면 화면이 방금 저장한 내용을 모르는 채로 남는다.
    expect(ipc.listSkillFiles).toHaveBeenCalled();
    expect(useSkills.getState().files).toEqual([FILE]);
  });

  it("쓰기가 실패하면 그대로 던진다 — 편집기가 오류를 보여줘야 한다", async () => {
    vi.mocked(ipc.writeSkillFile).mockRejectedValue(new Error("스킬 디렉터리 밖입니다"));
    await expect(useSkills.getState().save(FILE.path, "x")).rejects.toThrow(
      "스킬 디렉터리 밖입니다",
    );
  });
});

describe("파싱된 스킬은 원문을 함께 들고 있다", () => {
  it("all() 이 내주는 문서에 frontmatter 까지 그대로 남는다", async () => {
    vi.mocked(ipc.listSkillFiles).mockResolvedValue([FILE]);
    await useSkills.getState().refresh();

    const doc = useSkills
      .getState()
      .all()
      .find((skill) => skill.name === "report");
    expect(doc?.raw).toBe(FILE.content);
    expect(doc?.body).toBe("본문");
  });
});

describe("읽기 실패는 던지지 않는다", () => {
  it("턴마다 도는 경로라 오류를 상태로만 남긴다", async () => {
    vi.mocked(ipc.listSkillFiles).mockRejectedValue(new Error("못 읽었다"));
    await expect(useSkills.getState().refresh()).resolves.toBeUndefined();
    expect(useSkills.getState().error).toContain("못 읽었다");
    expect(useSkills.getState().loading).toBe(false);
  });
});
