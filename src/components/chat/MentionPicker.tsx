import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { documentTypeOf } from "@/lib/ai/attachments";
import { t } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { activeMention, applyMention, type MentionToken } from "@/lib/mention";
import type { ProjectFile } from "@/types/ipc";

/** 목록에 한 번에 띄우는 개수. 더 늘리면 스크롤만 길어지고 고르기 어려워진다. */
const LIMIT = 30;
/** 입력이 멈춘 뒤 검색까지의 유예. 키를 칠 때마다 디스크를 훑지 않기 위해. */
const DEBOUNCE_MS = 110;

interface PickerOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (next: string) => void;
  /** 프로젝트가 안 열려 있으면 목록을 띄우지 않는다 */
  enabled: boolean;
  projectPath?: string;
}

export interface MentionPickerState {
  open: boolean;
  items: ProjectFile[];
  activeIndex: number;
  loading: boolean;
  token: MentionToken | null;
  setActiveIndex: (index: number) => void;
  pick: (file: ProjectFile) => void;
  /** 텍스트 영역의 keydown 앞에 세운다. 목록이 열려 있으면 방향키·엔터를 가로챈다. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 커서가 움직였을 수 있는 모든 순간(입력·클릭·키업)에 부른다. */
  sync: () => void;
}

/**
 * `@` 자동완성의 상태 기계.
 *
 * 텍스트 규칙은 전부 `lib/mention.ts` 의 순수 함수가 지고, 여기서는 **커서를 읽고 · 검색을
 * 미루고 · 방향키를 가로채는** 일만 한다. 목록이 닫혀 있을 때는 `onKeyDown` 이 `false` 를
 * 돌려주므로 엔터가 평소대로 전송으로 간다 — 가로채는 조건을 두 곳에 적지 않기 위해서다.
 */
export function useMentionPicker({
  textareaRef,
  text,
  setText,
  enabled,
  projectPath,
}: PickerOptions): MentionPickerState {
  const [token, setToken] = useState<MentionToken | null>(null);
  const [items, setItems] = useState<ProjectFile[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  // Esc 로 닫은 뒤에는 같은 토큰에서 다시 열리지 않게 한다.
  const [dismissed, setDismissed] = useState(false);
  /** 고른 뒤 커서를 옮길 자리. 렌더가 끝난 뒤에야 적용할 수 있다. */
  const caretAfterPick = useRef<number | null>(null);

  const sync = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    const next = activeMention(element.value, element.selectionStart ?? 0);
    setToken(next);
    if (!next) setDismissed(false);
  }, [textareaRef]);

  // 바깥에서 텍스트가 갈아 끼워지는 경우(전송 후 비우기 등)도 따라간다.
  useEffect(() => {
    if (!text) setToken(null);
  }, [text]);

  const open = enabled && !dismissed && token !== null;

  useEffect(() => {
    if (!open || !token) {
      setItems([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      ipc
        .searchProjectFiles(token.query, { projectPath, limit: LIMIT })
        .then((found) => {
          if (cancelled) return;
          setItems(found);
          setActiveIndex(0);
        })
        // 프로젝트가 없거나 검색이 실패하면 조용히 목록만 비운다 — 입력은 계속돼야 한다.
        .catch(() => {
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, token?.query, projectPath]);

  // 고른 직후 커서를 삽입된 경로 뒤로 옮긴다.
  useEffect(() => {
    const caret = caretAfterPick.current;
    if (caret == null) return;
    caretAfterPick.current = null;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(caret, caret);
    setToken(activeMention(element.value, caret));
  }, [text, textareaRef]);

  const pick = useCallback(
    (file: ProjectFile) => {
      const element = textareaRef.current;
      const current = token ?? (element ? activeMention(element.value, element.selectionStart ?? 0) : null);
      if (!current) return;

      const next = applyMention(element?.value ?? text, current, file.relativePath, {
        isDir: file.isDir,
      });
      caretAfterPick.current = next.caret;
      setText(next.text);
      // 디렉터리를 고르면 그 안을 이어서 고르게 두고, 파일이면 목록을 닫는다.
      if (!file.isDir) setToken(null);
    },
    [setText, text, token, textareaRef],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || items.length === 0) {
        // 목록이 없어도 Esc 는 열린 토큰을 닫아 준다.
        if (open && event.key === "Escape") {
          event.preventDefault();
          setDismissed(true);
          return true;
        }
        return false;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % items.length);
          return true;
        case "ArrowUp":
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab":
          event.preventDefault();
          pick(items[activeIndex] ?? items[0]);
          return true;
        case "Escape":
          event.preventDefault();
          setDismissed(true);
          return true;
        default:
          return false;
      }
    },
    [activeIndex, items, open, pick],
  );

  return {
    open: open && (items.length > 0 || loading),
    items,
    activeIndex,
    loading,
    token,
    setActiveIndex,
    pick,
    onKeyDown,
    sync,
  };
}

/** 항목 하나가 어떤 종류인지 한 단어로. 첨부됐을 때 무슨 일이 일어날지를 미리 말해 준다. */
function kindLabel(file: ProjectFile): string {
  if (file.isDir) return t("mention.kind.listOnly");
  const document = documentTypeOf(file.relativePath);
  if (document) {
    return document.skill
      ? t("mention.kind.needsSkill", { kind: t(document.labelKey) })
      : t(document.labelKey);
  }
  return t("mention.kind.body");
}

/**
 * `@` 자동완성 목록. 입력칸 위에 떠서 방향키로 오르내린다.
 * 상태는 전부 `useMentionPicker` 가 들고, 여기서는 그리기만 한다.
 */
export function MentionPicker({
  state,
  className = "",
}: {
  state: MentionPickerState;
  className?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // 방향키로 목록 밖까지 내려가면 따라 스크롤한다.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.children[state.activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [state.activeIndex]);

  if (!state.open) return null;

  return (
    <div
      className={`absolute bottom-full left-0 z-40 mb-1.5 w-full max-w-xl overflow-hidden rounded-md border border-hairline bg-canvas elevate-lg ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5 text-caption text-ink-muted">
        <span className="text-ink">{t("mention.title")}</span>
        <code className="font-mono text-accent">@{state.token?.query ?? ""}</code>
        <span className="ml-auto">{t("mention.keys")}</span>
      </div>

      <ul ref={listRef} className="max-h-64 overflow-auto py-1">
        {state.items.length === 0 && (
          <li className="px-3 py-2 text-caption text-ink-muted">
            {state.loading ? t("mention.searching") : t("mention.noMatch")}
          </li>
        )}
        {state.items.map((file, index) => {
          const selected = index === state.activeIndex;
          return (
            <li key={file.relativePath}>
              <button
                type="button"
                // 입력칸이 포커스를 잃으면 커서 위치가 흔들린다 → 마우스 다운을 막고 클릭만 받는다.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => state.setActiveIndex(index)}
                onClick={() => state.pick(file)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption transition-colors ${
                  selected ? "bg-selected text-ink" : "text-ink-muted hover:bg-hover"
                }`}
              >
                <span className="w-4 shrink-0 text-center text-ink-subtle">
                  {file.isDir ? "▸" : "·"}
                </span>
                <span className="truncate font-mono text-ink">
                  {file.relativePath}
                  {file.isDir ? "/" : ""}
                </span>
                <span className="ml-auto shrink-0 text-ink-subtle">{kindLabel(file)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
