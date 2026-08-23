import { describe, expect, it } from "vitest";

import { entryNameProblem, joinRelative } from "@/lib/fileNames";

describe("entryNameProblem", () => {
  it("평범한 이름은 통과한다", () => {
    expect(entryNameProblem("index.ts")).toBeNull();
    expect(entryNameProblem("새 폴더")).toBeNull();
    expect(entryNameProblem(".env")).toBeNull();
    expect(entryNameProblem("a-b_c.d.ts")).toBeNull();
  });

  it("앞뒤 공백은 다듬어서 본다", () => {
    expect(entryNameProblem("  index.ts  ")).toBeNull();
    expect(entryNameProblem("   ")).toBe("empty");
    expect(entryNameProblem("")).toBe("empty");
  });

  it("경로 구분자는 따로 가른다 — 안내 문구가 다르다", () => {
    expect(entryNameProblem("src/index.ts")).toBe("separator");
    expect(entryNameProblem("src\\index.ts")).toBe("separator");
  });

  it("윈도우가 못 쓰는 글자를 막는다", () => {
    for (const name of ["a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b"]) {
      expect(entryNameProblem(name), name).toBe("chars");
    }
  });

  it("눈에 안 보이는 제어문자도 막는다", () => {
    expect(entryNameProblem(`a${String.fromCharCode(9)}b`)).toBe("chars");
    expect(entryNameProblem(`a${String.fromCharCode(0)}b`)).toBe("chars");
    expect(entryNameProblem(`a${String.fromCharCode(127)}b`)).toBe("chars");
  });

  it("현재/상위 폴더를 가리키는 이름을 막는다", () => {
    expect(entryNameProblem(".")).toBe("reserved");
    expect(entryNameProblem("..")).toBe("reserved");
  });

  it("끝에 점이 붙은 이름을 막는다 — 윈도우가 조용히 떼어 낸다", () => {
    // 만든 이름과 실제로 생긴 이름이 달라지면 목록에서 찾지 못한다.
    expect(entryNameProblem("note.")).toBe("reserved");
  });

  it("윈도우 예약 장치 이름은 확장자를 붙여도 막는다", () => {
    expect(entryNameProblem("con")).toBe("reserved");
    expect(entryNameProblem("NUL")).toBe("reserved");
    expect(entryNameProblem("com1.txt")).toBe("reserved");
    expect(entryNameProblem("lpt9")).toBe("reserved");
    // 비슷하기만 한 이름은 통과한다.
    expect(entryNameProblem("console.ts")).toBeNull();
    expect(entryNameProblem("com0")).toBeNull();
  });

  it("이미 있는 이름은 대소문자를 접어서 막는다", () => {
    const existing = ["README.md", "src"];
    expect(entryNameProblem("README.md", existing)).toBe("duplicate");
    // 윈도우에서 `readme.md` 는 같은 파일이다 — 다른 이름인 줄 알고 만들면 덮어쓴다.
    expect(entryNameProblem("readme.md", existing)).toBe("duplicate");
    expect(entryNameProblem("SRC", existing)).toBe("duplicate");
    expect(entryNameProblem("readme.txt", existing)).toBeNull();
  });

  it("검사 순서가 있다 — 빈 이름이 중복보다 먼저다", () => {
    expect(entryNameProblem("", [""])).toBe("empty");
  });
});

describe("joinRelative", () => {
  it("루트에서는 이름만 남는다", () => {
    expect(joinRelative(".", "index.ts")).toBe("index.ts");
    expect(joinRelative("", "index.ts")).toBe("index.ts");
  });

  it("하위 폴더는 슬래시로 잇는다", () => {
    expect(joinRelative("src", "index.ts")).toBe("src/index.ts");
    expect(joinRelative("src/lib", "ipc.ts")).toBe("src/lib/ipc.ts");
  });

  it("끝에 붙은 구분자를 겹치지 않게 접는다", () => {
    expect(joinRelative("src/", "index.ts")).toBe("src/index.ts");
    expect(joinRelative("src\\", "index.ts")).toBe("src/index.ts");
  });

  it("이름의 앞뒤 공백은 다듬는다 — 검사와 같은 이름으로 만든다", () => {
    expect(joinRelative("src", "  index.ts ")).toBe("src/index.ts");
  });
});
