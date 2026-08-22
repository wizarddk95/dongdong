import { describe, expect, it } from "vitest";

import {
  isMarkdownPath,
  parseInline,
  parseMarkdown,
  type BlockNode,
  type InlineNode,
} from "@/lib/markdown";

/** 인라인 트리를 눈으로 비교하기 쉬운 문자열로 눌러 담는다. */
function flatten(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.value;
        case "code":
          return `code(${node.value})`;
        case "math":
          return `math(${node.value})`;
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

describe("수식", () => {
  it("인라인 수식은 `$…$` 와 `\\(…\\)` 를 모두 받는다", () => {
    expect(flatten(parseInline("답은 $E = mc^2$ 이다"))).toBe("답은 math(E = mc^2) 이다");
    expect(flatten(parseInline("답은 \\(E = mc^2\\) 이다"))).toBe("답은 math(E = mc^2) 이다");
  });

  it("수식 안의 문법은 마크다운으로 해석하지 않는다", () => {
    expect(flatten(parseInline("$a_1 + a_2$"))).toBe("math(a_1 + a_2)");
    expect(flatten(parseInline("$\\frac{1}{2}$"))).toBe("math(\\frac{1}{2})");
    // 별표가 짝을 이뤄도 강조로 끌려가면 안 된다.
    expect(flatten(parseInline("$a * b * c$"))).toBe("math(a * b * c)");
  });

  it("통화 표기는 수식이 아니다", () => {
    expect(flatten(parseInline("$5 와 $10 을 더하면"))).toBe("$5 와 $10 을 더하면");
    expect(flatten(parseInline("가격 $ 5 $ 원"))).toBe("가격 $ 5 $ 원");
  });

  it("통화가 뒤따르는 수식과 짝지어지지 않는다", () => {
    expect(flatten(parseInline("가격은 $5 와 $10 이다. 합은 $x + y$ 이다"))).toBe(
      "가격은 $5 와 $10 이다. 합은 math(x + y) 이다",
    );
  });

  it("`\\$` 는 달러 기호 그대로다", () => {
    expect(flatten(parseInline("\\$100 과 \\$200"))).toBe("$100 과 $200");
  });

  it("인라인 코드가 수식보다 세다", () => {
    expect(flatten(parseInline("`$x$`"))).toBe("code($x$)");
  });

  it("짝이 없으면 글자로 남는다", () => {
    expect(flatten(parseInline("여는 $ 만 있다"))).toBe("여는 $ 만 있다");
    expect(flatten(parseInline("\\(닫히지 않음"))).toBe("(닫히지 않음");
  });

  it("한 줄짜리 디스플레이 수식", () => {
    expect(parseMarkdown("$$x^2 + y^2 = z^2$$")).toEqual([
      { type: "math", value: "x^2 + y^2 = z^2", closed: true },
    ]);
  });

  it("여러 줄 디스플레이 수식은 구분 기호만 걷어 낸다", () => {
    const blocks = parseMarkdown("$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$");
    expect(blocks).toEqual([
      {
        type: "math",
        value: "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}",
        closed: true,
      },
    ]);
  });

  it("`\\[ … \\]` 도 디스플레이 수식이다", () => {
    expect(parseMarkdown("\\[\n\\int_0^1 x\\,dx = \\frac12\n\\]")).toEqual([
      { type: "math", value: "\\int_0^1 x\\,dx = \\frac12", closed: true },
    ]);
  });

  it("닫히지 않은 디스플레이 수식은 스트리밍 중으로 본다", () => {
    expect(parseMarkdown("$$\n\\frac{1}{")).toEqual([
      { type: "math", value: "\\frac{1}{", closed: false },
    ]);
  });

  it("여는 줄 뒤에 글자가 남으면 블록이 아니라 문단이다", () => {
    const blocks = parseMarkdown("$$x$$ 가 답이다");
    expect(blocks).toHaveLength(1);
    expect(text(blocks[0])).toBe("math(x) 가 답이다");
  });

  it("닫는 줄 뒤에 남은 글자는 문단으로 잇는다", () => {
    const blocks = parseMarkdown("$$\nx\n$$ 이 답이다");
    expect(blocks[0]).toEqual({ type: "math", value: "x", closed: true });
    expect(text(blocks[1])).toBe("이 답이다");
  });

  it("문단 중간의 디스플레이 수식은 문단을 끊는다", () => {
    const blocks = parseMarkdown("앞 문장\n$$\nx = 1\n$$\n뒤 문장");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
  });

  it("목록 항목 안의 디스플레이 수식도 들여쓰기를 벗는다", () => {
    const blocks = parseMarkdown("- 항목\n\n  $$\n  x = 1\n  $$");
    expect(blocks[0].type).toBe("list");
    const item = (blocks[0] as Extract<BlockNode, { type: "list" }>).items[0];
    expect(item.children.at(-1)).toEqual({ type: "math", value: "x = 1", closed: true });
  });

  it("코드블록 안의 `$$` 는 글자다", () => {
    const blocks = parseMarkdown("```\n$$x$$\n```");
    expect(blocks).toEqual([{ type: "codeBlock", lang: null, value: "$$x$$", closed: true }]);
  });
});

describe("isMarkdownPath", () => {
  it("마크다운 확장자를 알아본다 (대소문자 무관)", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/design.MD")).toBe(true);
    expect(isMarkdownPath("notes.markdown")).toBe(true);
    expect(isMarkdownPath("page.mdx")).toBe(true);
  });

  it("윈도우 경로 구분자도 본다", () => {
    expect(isMarkdownPath("C:\\projects\\dongdong\\README.md")).toBe(true);
  });

  it("그 밖의 파일은 원문 편집기로 둔다", () => {
    expect(isMarkdownPath("src/App.tsx")).toBe(false);
    expect(isMarkdownPath("Makefile")).toBe(false);
    // 확장자 없이 점으로 시작하는 이름(.md)은 확장자가 아니라 이름이다.
    expect(isMarkdownPath(".md")).toBe(false);
  });
});
