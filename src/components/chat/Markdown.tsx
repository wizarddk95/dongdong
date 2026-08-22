import katex from "katex";
import { Fragment, memo, useMemo, useState } from "react";

import { t } from "@/lib/i18n";
import { parseMarkdown, type BlockNode, type InlineNode, type ListItem } from "@/lib/markdown";

interface MarkdownProps {
  text: string;
  /** 사고 과정처럼 흐리게 보여야 하는 본문 */
  dim?: boolean;
  className?: string;
}

/** 채팅 본문을 마크다운으로 그린다. 스트리밍 중에도 매 토큰 다시 파싱된다(본문이 짧아 부담 없음). */
export const Markdown = memo(function Markdown({ text, dim = false, className = "" }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const tone = dim ? "text-caption text-ink-muted" : "text-body-sm text-ink";

  return (
    <div className={`min-w-0 space-y-2 break-words ${tone} ${className}`}>
      {blocks.map((block, index) => (
        <Block key={index} node={block} dim={dim} />
      ))}
    </div>
  );
});

/**
 * 제목 계층은 크기로만 만든다 — 채팅 본문이라 디스플레이 크기까지 올리지 않고
 * card-title 아래 구간만 쓴다.
 */
const HEADING_CLASS: Record<number, string> = {
  1: "text-card-title text-ink",
  2: "text-subhead text-ink",
  3: "text-body-lg text-ink",
  4: "text-body-emphasis text-ink",
  5: "text-body-emphasis text-ink-muted",
  6: "text-caption font-semibold text-ink-muted",
};

function Block({ node, dim }: { node: BlockNode; dim: boolean }) {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="leading-relaxed">
          <Inline nodes={node.children} />
        </p>
      );

    case "heading": {
      const Tag = `h${node.level}` as "h1";
      return (
        <Tag className={`mt-3 first:mt-0 ${HEADING_CLASS[node.level]}`}>
          <Inline nodes={node.children} />
        </Tag>
      );
    }

    case "codeBlock":
      return <CodeBlock lang={node.lang} value={node.value} />;

    case "math":
      return <MathBlock value={node.value} closed={node.closed} />;

    case "list":
      return <List node={node} dim={dim} />;

    case "blockquote":
      return (
        <blockquote className="space-y-2 border-l-2 border-surface-3 pl-3 text-ink-muted">
          {node.children.map((child, index) => (
            <Block key={index} node={child} dim={dim} />
          ))}
        </blockquote>
      );

    case "table":
      return <Table node={node} />;

    case "hr":
      return <hr className="border-hairline" />;
  }
}

function List({ node, dim }: { node: Extract<BlockNode, { type: "list" }>; dim: boolean }) {
  const Tag = node.ordered ? "ol" : "ul";
  const marker = node.ordered ? "list-decimal" : "list-disc";
  return (
    <Tag
      className={`${marker} pl-5 marker:text-ink-subtle ${node.tight ? "space-y-1" : "space-y-2"}`}
      start={node.ordered ? node.start : undefined}
    >
      {node.items.map((item, index) => (
        <Item key={index} item={item} tight={node.tight} dim={dim} />
      ))}
    </Tag>
  );
}

function Item({ item, tight, dim }: { item: ListItem; tight: boolean; dim: boolean }) {
  // 촘촘한 목록의 단일 문단은 <p> 없이 펼쳐야 줄 간격이 뜨지 않는다.
  const inlineOnly = tight && item.children.length === 1 && item.children[0].type === "paragraph";

  return (
    <li className={item.checked == null ? "" : "list-none -ml-5 flex items-start gap-1.5"}>
      {item.checked != null && (
        <input
          type="checkbox"
          checked={item.checked}
          readOnly
          // 네이티브 체크박스의 채움색. 시스템의 유일한 액센트를 그대로 물려준다.
          className="mt-[3px] accent-accent"
        />
      )}
      <div className={`min-w-0 flex-1 ${inlineOnly ? "" : "space-y-2"}`}>
        {inlineOnly ? (
          <Inline nodes={(item.children[0] as Extract<BlockNode, { type: "paragraph" }>).children} />
        ) : (
          item.children.map((child, index) => <Block key={index} node={child} dim={dim} />)
        )}
      </div>
    </li>
  );
}

function Table({ node }: { node: Extract<BlockNode, { type: "table" }> }) {
  const alignClass = (index: number) => {
    const align = node.align[index];
    return align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
  };

  return (
    <div className="overflow-x-auto rounded-md border border-hairline">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {node.header.map((cell, index) => (
              <th
                key={index}
                className={`border-b border-hairline bg-surface-1 px-3 py-2 text-body-emphasis ${alignClass(index)}`}
              >
                <Inline nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`border-b border-hairline px-3 py-2 text-caption ${alignClass(index)}`}
                >
                  <Inline nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 수식을 KaTeX 로 그린다.
 *
 * `dangerouslySetInnerHTML` 을 쓰지만 원문을 그대로 붓는 게 아니라 KaTeX 가 만든 것만
 * 넣는다 — `trust` 기본값이 꺼져 있어 `\href` 같은 바깥으로 나가는 명령은 애초에 무시된다.
 * 실패는 예외로 받는다(`throwOnError`) — 켜 두면 KaTeX 가 제 빨간색을 박아 넣어
 * 테마를 안 따라간다. 대신 원문을 그대로 보여 주고 이유를 툴팁에 담는다.
 */
function renderMath(value: string, display: boolean): { html: string } | { error: string } {
  try {
    return {
      html: katex.renderToString(value, {
        displayMode: display,
        throwOnError: true,
        // LLM 출력엔 수식 안에 한글·유니코드가 섞이기 마련이라 경고까지 올리지 않는다.
        strict: false,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function MathBlock({ value, closed }: { value: string; closed: boolean }) {
  // 스트리밍 중(아직 안 닫힘)엔 반쪽 LaTeX 이라 그리려 들지 않는다 — 매 토큰 오류가 번쩍인다.
  const result = useMemo(() => (closed ? renderMath(value, true) : null), [value, closed]);

  if (!result || "error" in result) {
    return (
      <pre
        className="overflow-x-auto rounded-md border border-hairline bg-surface-1 px-3 py-2 font-mono text-caption text-ink-muted"
        title={result?.error}
      >
        {value}
      </pre>
    );
  }

  // KaTeX 가 `.katex-display` 에 1em 세로 여백을 박아 넣는다 — 블록 간격은 본문 쪽
  // `space-y-*` 하나로 잡아야 하므로 걷어낸다.
  return (
    <div
      className="overflow-x-auto py-1 [&_.katex-display]:my-0"
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  );
}

function MathInline({ value }: { value: string }) {
  const result = useMemo(() => renderMath(value, false), [value]);

  if ("error" in result) {
    return (
      <code
        className="rounded-xs bg-error-subtle px-1.5 py-[1px] font-mono text-caption text-error"
        title={result.error}
      >
        {value}
      </code>
    );
  }

  return <span dangerouslySetInnerHTML={{ __html: result.html }} />;
}

function CodeBlock({ lang, value }: { lang: string | null; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 클립보드 접근이 막혀도 본문 표시엔 영향이 없다.
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-surface-1">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-1">
        <span className="font-mono text-caption text-ink-muted">{lang ?? "code"}</span>
        <button
          className="ml-auto rounded-sm px-2 py-0.5 text-caption text-accent transition-colors hover:bg-hover"
          onClick={() => void copy()}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2">
        <code className="font-mono text-caption leading-relaxed text-ink">{value}</code>
      </pre>
    </div>
  );
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNodeView key={index} node={node} />
      ))}
    </>
  );
}

function InlineNodeView({ node }: { node: InlineNode }) {
  switch (node.type) {
    case "text":
      return <Fragment>{node.value}</Fragment>;

    case "break":
      return <br />;

    case "math":
      return <MathInline value={node.value} />;

    case "code":
      return (
        <code className="rounded-xs border border-code-rule bg-code-surface px-1.5 py-[1px] font-mono text-caption text-code">
          {node.value}
        </code>
      );

    case "strong":
      return (
        <strong className="font-semibold text-ink">
          <Inline nodes={node.children} />
        </strong>
      );

    case "em":
      return (
        <em className="italic">
          <Inline nodes={node.children} />
        </em>
      );

    case "del":
      return (
        <del className="text-ink-subtle line-through">
          <Inline nodes={node.children} />
        </del>
      );

    case "link":
      return (
        <a
          href={safeHref(node.href)}
          target="_blank"
          rel="noreferrer noopener"
          title={node.href}
          className="text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          <Inline nodes={node.children} />
        </a>
      );

    // 원격 이미지를 웹뷰에서 바로 불러오지 않고 링크로만 보여준다.
    case "image":
      return (
        <a
          href={safeHref(node.src)}
          target="_blank"
          rel="noreferrer noopener"
          title={node.src}
          className="text-accent underline underline-offset-2 hover:text-accent-hover"
        >
          🖼 {node.alt || node.src}
        </a>
      );
  }
}

/** `javascript:` 같은 스킴은 링크로 만들지 않는다. */
function safeHref(href: string): string | undefined {
  return /^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(href) ? href : undefined;
}
