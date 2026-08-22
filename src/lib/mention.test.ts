import { describe, expect, it } from "vitest";

import { activeMention, applyMention, extractMentions, quotePath } from "@/lib/mention";

describe("activeMention", () => {
  it("커서 앞에서 열린 토큰을 찾는다", () => {
    const text = "이 파일 봐줘 @src/lib/ip";
    expect(activeMention(text, text.length)).toEqual({
      start: text.indexOf("@"),
      end: text.length,
      query: "src/lib/ip",
    });
  });

  it("`@` 바로 뒤(빈 검색어)도 토큰이다", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("공백을 지나면 토큰이 아니다", () => {
    expect(activeMention("@src/a.ts 다음 문장", 16)).toBeNull();
  });

  it("이메일 주소는 참조로 보지 않는다", () => {
    const text = "user@example.com";
    expect(activeMention(text, text.length)).toBeNull();
  });

  it("따옴표로 연 참조는 공백을 품는다", () => {
    const text = '@"내 문서/보고';
    expect(activeMention(text, text.length)).toEqual({
      start: 0,
      end: text.length,
      query: "내 문서/보고",
    });
  });

  it("이미 닫힌 따옴표 참조는 다시 열지 않는다", () => {
    const text = '@"내 문서.docx" ';
    expect(activeMention(text, text.length)).toBeNull();
  });

  it("커서가 토큰 중간이면 그 자리까지만 검색어다", () => {
    const text = "@src/lib/ipc.ts";
    expect(activeMention(text, 5)?.query).toBe("src/");
  });
});

describe("quotePath", () => {
  it("공백이 있을 때만 감싼다", () => {
    expect(quotePath("src/a.ts")).toBe("src/a.ts");
    expect(quotePath("내 문서/a.docx")).toBe('"내 문서/a.docx"');
  });
});

describe("applyMention", () => {
  it("토큰 자리를 경로로 갈아 끼우고 공백을 붙인다", () => {
    const text = "봐줘 @ip";
    const token = activeMention(text, text.length)!;
    const next = applyMention(text, token, "src/lib/ipc.ts");
    expect(next.text).toBe("봐줘 @src/lib/ipc.ts ");
    expect(next.caret).toBe(next.text.length);
  });

  it("디렉터리는 슬래시만 붙이고 공백은 넣지 않는다", () => {
    const text = "@src";
    const token = activeMention(text, text.length)!;
    const next = applyMention(text, token, "src/lib", { isDir: true });
    expect(next.text).toBe("@src/lib/");
    expect(next.caret).toBe(next.text.length);
  });

  it("뒤에 이미 공백이 있으면 두 칸이 되지 않는다", () => {
    const text = "@ip 뒤에 글자";
    const token = activeMention(text, 3)!;
    expect(applyMention(text, token, "src/ipc.ts").text).toBe("@src/ipc.ts 뒤에 글자");
  });

  it("공백이 든 경로는 따옴표로 감싼다", () => {
    const text = "@내";
    const token = activeMention(text, text.length)!;
    expect(applyMention(text, token, "내 문서/a.docx").text).toBe('@"내 문서/a.docx" ');
  });
});

describe("extractMentions", () => {
  it("순서대로 뽑고 중복은 한 번만", () => {
    expect(extractMentions("@a.ts 와 @b.ts, 다시 @a.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("따옴표 참조도 잡는다", () => {
    expect(extractMentions('@"내 문서/보고서.xlsx" 요약해줘')).toEqual(["내 문서/보고서.xlsx"]);
  });

  it("이메일 주소는 뽑지 않는다", () => {
    expect(extractMentions("메일은 user@example.com 로")).toEqual([]);
  });

  it("문장 부호는 떼고 확장자의 점은 남긴다", () => {
    expect(extractMentions("@src/a.ts, @src/b.ts)")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("괄호 안에서 시작한 참조도 잡는다", () => {
    expect(extractMentions("(@src/a.ts)")).toEqual(["src/a.ts"]);
  });

  it("참조가 없으면 빈 배열", () => {
    expect(extractMentions("평범한 문장입니다")).toEqual([]);
  });
});
