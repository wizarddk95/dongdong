import { describe, expect, it } from "vitest";

import {
  appendSkillCatalog,
  buildSkillTools,
  builtinSkills,
  enabledSkills,
  mergeSkills,
  parseSkillDoc,
  skillCatalogBlock,
  type SkillDoc,
} from "@/lib/ai/skills";
import type { SkillFile } from "@/types/ipc";

function file(partial: Partial<SkillFile> & Pick<SkillFile, "folder" | "content">): SkillFile {
  return {
    source: "user",
    path: `C:/skills/${partial.folder}/SKILL.md`,
    truncated: false,
    ...partial,
  };
}

/** 도구의 execute 를 부르기 좋게 감싼다 (AI SDK 는 두 번째 인자로 실행 맥락을 준다). */
async function run(tool: unknown, input: unknown) {
  const execute = (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> })
    .execute;
  return execute(input, { toolCallId: "t1", messages: [] });
}

describe("parseSkillDoc", () => {
  it("frontmatter 의 name·description 을 읽고 본문만 남긴다", () => {
    const skill = parseSkillDoc(
      "---\nname: xlsx\ndescription: 엑셀을 다룰 때\n---\n# 본문\n절차",
      { folder: "excel", source: "user" },
    );
    expect(skill.name).toBe("xlsx");
    expect(skill.description).toBe("엑셀을 다룰 때");
    expect(skill.body.startsWith("# 본문")).toBe(true);
  });

  it("따옴표로 감싼 값도 받는다", () => {
    const skill = parseSkillDoc('---\nname: "pdf"\ndescription: \'PDF 다루기\'\n---\n본문', {
      folder: "x",
      source: "user",
    });
    expect(skill.name).toBe("pdf");
    expect(skill.description).toBe("PDF 다루기");
  });

  it("frontmatter 가 없으면 폴더 이름과 첫 줄을 쓴다", () => {
    const skill = parseSkillDoc("# 사내 보고서 양식\n1. 표지를 만든다", {
      folder: "report",
      source: "project",
    });
    expect(skill.name).toBe("report");
    expect(skill.description).toBe("사내 보고서 양식");
    expect(skill.body).toContain("표지를 만든다");
  });
});

describe("mergeSkills", () => {
  it("내장 스킬이 기본으로 들어간다", () => {
    const names = mergeSkills([]).map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining(["xlsx", "docx", "pdf"]));
  });

  it("같은 이름이면 프로젝트가 전역을, 전역이 내장을 이긴다", () => {
    const merged = mergeSkills([
      file({ folder: "xlsx", source: "user", content: "---\nname: xlsx\n---\n전역판" }),
      file({ folder: "xlsx", source: "project", content: "---\nname: xlsx\n---\n프로젝트판" }),
    ]);
    const xlsx = merged.find((skill) => skill.name === "xlsx");
    expect(xlsx?.source).toBe("project");
    expect(xlsx?.body).toBe("프로젝트판");
    // 덮어썼을 뿐 개수가 늘지는 않는다.
    expect(merged.filter((skill) => skill.name === "xlsx")).toHaveLength(1);
  });

  it("본문이 빈 파일은 스킬로 세지 않는다", () => {
    const before = mergeSkills([]).length;
    const after = mergeSkills([file({ folder: "empty", content: "---\nname: empty\n---\n   " })]);
    expect(after).toHaveLength(before);
  });
});

describe("enabledSkills", () => {
  const skills: SkillDoc[] = [
    { name: "a", description: "", body: "본문", source: "builtin" },
    { name: "b", description: "", body: "본문", source: "user" },
  ];

  it("설정에 없는 스킬은 켜진 것으로 본다", () => {
    expect(enabledSkills(skills, {}).map((skill) => skill.name)).toEqual(["a", "b"]);
  });

  it("false 로 적힌 것만 뺀다", () => {
    expect(enabledSkills(skills, { a: false }).map((skill) => skill.name)).toEqual(["b"]);
  });
});

describe("skillCatalogBlock", () => {
  it("이름과 설명만 싣고 본문은 넣지 않는다", () => {
    const block = skillCatalogBlock(builtinSkills());
    expect(block).toContain("xlsx:");
    expect(block).toContain("load_skill");
    // 본문의 코드 예제가 새어 나오면 스킬의 존재 이유가 사라진다.
    // (설명 줄에 라이브러리 이름은 나올 수 있으므로 본문에만 있는 문장으로 본다)
    expect(block).not.toContain("data_only=True");
  });

  it("스킬이 없으면 빈 문자열이라 프롬프트가 그대로다", () => {
    expect(skillCatalogBlock([])).toBe("");
    expect(appendSkillCatalog("기본 프롬프트", [])).toBe("기본 프롬프트");
  });

  it("목록은 시스템 프롬프트 뒤에 붙는다", () => {
    const composed = appendSkillCatalog("기본 프롬프트", builtinSkills());
    expect(composed.startsWith("기본 프롬프트")).toBe(true);
  });
});

describe("buildSkillTools", () => {
  it("스킬이 없으면 도구를 만들지 않는다", () => {
    expect(Object.keys(buildSkillTools([]))).toEqual([]);
  });

  it("load_skill 이 본문을 돌려준다", async () => {
    const tools = buildSkillTools(builtinSkills());
    const result = (await run(tools.load_skill, { name: "docx" })) as {
      found: boolean;
      content: string;
      source: string;
    };
    expect(result.found).toBe(true);
    expect(result.source).toBe("builtin");
    expect(result.content).toContain("python-docx");
  });

  it("없는 이름을 부르면 목록을 되돌려준다", async () => {
    const tools = buildSkillTools(builtinSkills());
    const result = (await run(tools.load_skill, { name: "hwp" })) as {
      found: boolean;
      available: string[];
    };
    expect(result.found).toBe(false);
    expect(result.available).toContain("xlsx");
  });
});
