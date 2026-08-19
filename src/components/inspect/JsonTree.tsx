import { useState } from "react";

/**
 * 컨텍스트/도구 페이로드를 접었다 펼 수 있는 트리로 보여준다.
 * 이 툴의 핵심은 '무엇이 LLM 에 갔는지'를 숨기지 않는 것이라 값은 가공하지 않고 그대로 렌더링한다.
 */
interface JsonTreeProps {
  value: unknown;
  /** 이 깊이까지는 펼친 채로 시작한다 */
  defaultOpenDepth?: number;
}

const LONG_TEXT = 400;

export function JsonTree({ value, defaultOpenDepth = 2 }: JsonTreeProps) {
  return (
    <div className="font-mono text-[11px] leading-relaxed text-zinc-300">
      <Node value={value} depth={0} defaultOpenDepth={defaultOpenDepth} />
    </div>
  );
}

function Node({
  name,
  value,
  depth,
  defaultOpenDepth,
}: {
  name?: string;
  value: unknown;
  depth: number;
  defaultOpenDepth: number;
}) {
  const [open, setOpen] = useState(depth < defaultOpenDepth);

  const label = name != null ? <span className="text-sky-300">{name}</span> : null;

  if (value === null || value === undefined) {
    return (
      <Row>
        {label}
        <span className="text-zinc-600">{value === null ? "null" : "undefined"}</span>
      </Row>
    );
  }

  if (typeof value === "string") {
    return (
      <Row>
        {label}
        <LongString text={value} />
      </Row>
    );
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return (
      <Row>
        {label}
        <span className="text-amber-300">{String(value)}</span>
      </Row>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);

  const summary = isArray ? `배열 ${entries.length}개` : `객체 ${entries.length}개`;

  return (
    <div>
      <button
        className="flex items-baseline gap-1 text-left hover:text-zinc-100"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="w-3 shrink-0 text-zinc-600">{open ? "▾" : "▸"}</span>
        {label}
        <span className="text-zinc-600">{summary}</span>
      </button>

      {open && (
        <div className="ml-3 border-l border-zinc-800 pl-2">
          {entries.map(([key, item]) => (
            <Node
              key={key}
              name={key}
              value={item}
              depth={depth + 1}
              defaultOpenDepth={defaultOpenDepth}
            />
          ))}
          {entries.length === 0 && <Row>(비어 있음)</Row>}
        </div>
      )}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-baseline gap-1 pl-3">{children}</div>;
}

/** 긴 문자열은 접어 두되, 원문 확인은 항상 가능해야 한다. */
function LongString({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_TEXT;
  const shown = long && !expanded ? `${text.slice(0, LONG_TEXT)}…` : text;

  return (
    <span className="min-w-0 flex-1">
      <span className="whitespace-pre-wrap break-words text-emerald-200">{shown}</span>
      {long && (
        <button
          className="ml-1 text-[10px] text-zinc-500 hover:text-zinc-300"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : `더 보기 (${text.length}자)`}
        </button>
      )}
    </span>
  );
}
