import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown, type BlockNode, type InlineNode } from "@/lib/markdown";

/** 인라인 트리를 눈으로 비교하기 쉬운 문자열로 눌러 담는다. */
function flatten(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.value;
        case "code":
          return `code(${node.value})`;
        case "strong":
          return `b(${flatten(node.children)})`;
        case "em":
          return `i(${flatten(node.children)})`;
        case "del":
          return `s(${flatten(node.children)})`;
        case "link":
          return `a(${node.href}|${flatten(node.children)})`;
        case "image":
          return `img(${node.src}|${node.alt})`;
        case "break":
          return "\\n";
      }
    })
    .join("");
}

function text(block: BlockNode): string {
  if (block.type === "paragraph" || block.type === "heading") return flatten(block.children);
  throw new Error(`inline 블록이 아님: ${block.type}`);
}

describe("parseInline", () => {
  it("강조 · 취소선 · 인라인 코드를 구분한다", () => {
    expect(flatten(parseInline("**굵게** 와 *기울임* 과 ~~취소~~"))).toBe(
      "b(굵게) 와 i(기울임) 과 s(취소)",
    );
    expect(flatten(parseInline("***둘 다***"))).toBe("b(i(둘 다))");
    expect(flatten(parseInline("`const a = 1`"))).toBe("code(const a = 1)");
  });

  it("인라인 코드 안의 마크다운 기호는 해석하지 않는다", () => {
    expect(flatten(parseInline("`**not bold**`"))).toBe("code(**not bold**)");
    expect(flatten(parseInline("``a ` b``"))).toBe("code(a ` b)");
  });

  it("식별자 안의 밑줄은 강조가 아니다", () => {
    expect(flatten(parseInline("snake_case_name"))).toBe("snake_case_name");
    expect(flatten(parseInline("_강조_ 됨"))).toBe("i(강조) 됨");
  });

  it("짝이 없는 기호는 글자 그대로 둔다", () => {
    expect(flatten(parseInline("**아직 스트리밍 중"))).toBe("**아직 스트리밍 중");
    expect(flatten(parseInline("2 * 3 * 4 는 곱셈"))).toBe("2 * 3 * 4 는 곱셈");
  });

  it("역슬래시 이스케이프를 푼다", () => {
    expect(flatten(parseInline("\\*별표\\*"))).toBe("*별표*");
  });

  it("링크 · 이미지 · 맨몸 URL 을 인식한다", () => {
    expect(flatten(parseInline("[문서](https://a.dev/x)"))).toBe("a(https://a.dev/x|문서)");
    expect(flatten(parseInline('[t](https://a.dev "제목")'))).toBe("a(https://a.dev|t)");
    expect(flatten(parseInline("![로고](https://a.dev/i.png)"))).toBe("img(https://a.dev/i.png|로고)");
    expect(flatten(parseInline("여기 https://a.dev/x 참고."))).toBe(
      "여기 a(https://a.dev/x|https://a.dev/x) 참고.",
    );
  });

  it("줄바꿈은 break 노드가 된다", () => {
    expect(flatten(parseInline("첫 줄\n둘째 줄"))).toBe("첫 줄\\n둘째 줄");
  });
});

describe("parseMarkdown", () => {
  it("### 제목을 heading 으로 만든다", () => {
    const blocks = parseMarkdown("# 하나\n### 셋\n#해시태그");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", level: 3 });
    expect(text(blocks[1])).toBe("셋");
    // 공백 없는 `#` 는 제목이 아니다.
    expect(blocks[2].type).toBe("paragraph");
  });

  it("코드 펜스에서 언어와 본문을 뽑는다", () => {
    const blocks = parseMarkdown("```ts\nconst a = 1;\n\nconst b = 2;\n```\n뒤 문단");
    expect(blocks[0]).toEqual({
      type: "codeBlock",
      lang: "ts",
      value: "const a = 1;\n\nconst b = 2;",
      closed: true,
    });
    expect(blocks[1].type).toBe("paragraph");
  });

  it("스트리밍 중 닫히지 않은 펜스도 코드블록으로 본다", () => {
    const blocks = parseMarkdown("```python\nprint(1)");
    expect(blocks[0]).toEqual({
      type: "codeBlock",
      lang: "python",
      value: "print(1)",
      closed: false,
    });
  });

  it("중첩 목록과 순서 목록을 만든다", () => {
    const blocks = parseMarkdown("- 하나\n  - 안쪽\n- 둘\n\n1. 첫째\n2. 둘째");
    const list = blocks[0];
    if (list.type !== "list") throw new Error("list 아님");
    expect(list.ordered).toBe(false);
    expect(list.tight).toBe(true);
    expect(list.items).toHaveLength(2);
    expect(text(list.items[0].children[0])).toBe("하나");
    expect(list.items[0].children[1]).toMatchObject({ type: "list", ordered: false });

    const ordered = blocks[1];
    if (ordered.type !== "list") throw new Error("list 아님");
    expect(ordered.ordered).toBe(true);
    expect(ordered.start).toBe(1);
    expect(ordered.items).toHaveLength(2);
  });

  it("빈 줄로 벌어진 목록은 loose 로 표시한다", () => {
    const blocks = parseMarkdown("- 하나\n\n- 둘");
    expect(blocks[0]).toMatchObject({ type: "list", tight: false });
  });

  it("체크박스 목록을 인식한다", () => {
    const blocks = parseMarkdown("- [x] 완료\n- [ ] 남음");
    if (blocks[0].type !== "list") throw new Error("list 아님");
    expect(blocks[0].items.map((item) => item.checked)).toEqual([true, false]);
    expect(text(blocks[0].items[0].children[0])).toBe("완료");
  });

  it("인용과 구분선을 만든다", () => {
    const blocks = parseMarkdown("> 인용 **굵게**\n> 이어짐\n\n---");
    if (blocks[0].type !== "blockquote") throw new Error("blockquote 아님");
    expect(text(blocks[0].children[0])).toBe("인용 b(굵게)\\n이어짐");
    expect(blocks[1]).toEqual({ type: "hr" });
  });

  it("표를 정렬 정보와 함께 만든다", () => {
    const blocks = parseMarkdown("| 이름 | 값 |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |");
    const table = blocks[0];
    if (table.type !== "table") throw new Error("table 아님");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header.map(flatten)).toEqual(["이름", "값"]);
    expect(table.rows.map((row) => row.map(flatten))).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("문단은 빈 줄로 나뉘고 줄바꿈은 유지된다", () => {
    const blocks = parseMarkdown("첫 문단 1\n첫 문단 2\n\n둘째 문단");
    expect(blocks).toHaveLength(2);
    expect(text(blocks[0])).toBe("첫 문단 1\\n첫 문단 2");
    expect(text(blocks[1])).toBe("둘째 문단");
  });

  it("빈 입력과 공백만 있는 입력은 블록이 없다", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n  \n")).toEqual([]);
  });

  it("HTML 은 해석하지 않고 글자로 남긴다", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    expect(text(blocks[0])).toBe("<script>alert(1)</script>");
  });
});
