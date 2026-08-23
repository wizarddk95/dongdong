import { useCallback, useEffect, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Button, FIELD_SM, Panel } from "@/components/Panel";
import { entryNameProblem, joinRelative, type NameProblem } from "@/lib/fileNames";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/useT";
import * as ipc from "@/lib/ipc";
import { isMarkdownPath } from "@/lib/markdown";
import { useWorkspace } from "@/store/workspace";
import type { DirEntry, FileContent } from "@/types/ipc";

/** 만들 것 — 파일이냐 폴더냐. IPC 도 안내 문구도 갈린다. */
type NewKind = "file" | "dir";

/**
 * 이름이 걸린 이유 → 화면 문구.
 * 모듈 상수는 언어가 바뀌어도 다시 만들어지지 않으므로 **문장이 아니라 키**를 담는다.
 */
const NAME_PROBLEM: Record<NameProblem, MessageKey> = {
  empty: "files.nameEmpty",
  separator: "files.nameSeparator",
  chars: "files.nameChars",
  reserved: "files.nameReserved",
  duplicate: "files.nameDuplicate",
};

/** read_file / write_file / list_directory IPC 를 눈으로 확인하는 패널. */
export function FileExplorer() {
  const t = useT();
  const project = useWorkspace((state) => state.project);
  const setError = useWorkspace((state) => state.setError);

  const [cwd, setCwd] = useState(".");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [file, setFile] = useState<FileContent | null>(null);
  const [buffer, setBuffer] = useState("");
  const [dirty, setDirty] = useState(false);
  /**
   * 마크다운을 렌더링해서 볼지. 파일을 새로 열 때마다 원문으로 돌아온다 —
   * 다른 파일을 열었는데 미리보기가 켜져 있으면 편집기가 사라진 것처럼 보인다.
   */
  const [preview, setPreview] = useState(false);
  /** 만드는 중인 이름. `null` 이면 만들고 있지 않다 — 목록에 줄 하나가 열린다. */
  const [creating, setCreating] = useState<{ kind: NewKind; name: string } | null>(null);
  /**
   * 목록에는 안 보이지만 디스크에는 있는 이름과 부딪혔을 때.
   * 숨김 파일을 끄고 있으면 `entries` 만으로는 못 잡으므로 만들기 직전에 한 번 더 묻는다.
   */
  const [taken, setTaken] = useState(false);

  /** 지금 폴더에 이미 있는 이름 — 중복 판정이 본다(숨김을 끄면 여기 안 보이는 것도 있다). */
  const existingNames = entries.map((entry) => entry.name);

  /**
   * 숨김 표시 여부를 **인자로 받는다** — 상태를 그대로 읽으면 토글할 때마다 `refresh` 의
   * 정체가 바뀌어 아래 effect 가 다시 돌고, 보던 폴더가 루트로 튕긴다.
   */
  const refresh = useCallback(
    async (target: string, hidden: boolean) => {
      if (!project) return;
      try {
        setEntries(await ipc.listDirectory(target, { includeHidden: hidden }));
        setCwd(target);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [project, setError],
  );

  useEffect(() => {
    if (project) void refresh(".", showHidden);
    else {
      setEntries([]);
      setFile(null);
    }
    // 프로젝트가 바뀔 때만 루트부터 다시 읽는다 — 숨김 토글은 자기 자리에서
    // 보던 폴더를 그대로 다시 읽는다(여기서 처리하면 루트로 튕긴다).
  }, [project, refresh]);

  // 프로젝트를 닫으면 만들던 줄도 함께 접는다.
  useEffect(() => {
    if (!project) setCreating(null);
  }, [project]);

  function toggleHidden() {
    const next = !showHidden;
    setShowHidden(next);
    void refresh(cwd, next);
  }

  async function openEntry(entry: DirEntry) {
    if (entry.isDir) {
      setCreating(null);
      await refresh(entry.relativePath, showHidden);
      return;
    }
    await openFile(entry.relativePath);
  }

  async function openFile(relativePath: string) {
    try {
      const content = await ipc.readFile(relativePath);
      setFile(content);
      setBuffer(content.content);
      setDirty(false);
      setPreview(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function save() {
    if (!file) return;
    try {
      await ipc.writeFile(file.relativePath, buffer);
      setDirty(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  function startCreating(kind: NewKind) {
    setTaken(false);
    setCreating({ kind, name: "" });
  }

  /**
   * 만들기. 이름 판정은 순수 함수가 하고, **덮어쓰기 방지**는 디스크에 한 번 더 묻는다 —
   * `write_file` 은 이미 있는 파일을 말없이 덮어쓰기 때문에 여기서 막지 않으면
   * "새 파일" 한 번이 남의 파일을 비운다.
   */
  async function submitCreate() {
    if (!creating || !project) return;
    const name = creating.name.trim();
    if (entryNameProblem(name, existingNames)) return;

    const target = joinRelative(cwd, name);
    try {
      const info = await ipc.pathInfo(target);
      if (info.exists) {
        setTaken(true);
        return;
      }
      if (creating.kind === "dir") await ipc.createDirectory(target);
      else await ipc.writeFile(target, "");

      // 점으로 시작하는 이름은 숨김이 꺼져 있으면 목록에 안 나온다 →
      // 만든 것이 보이지 않으면 실패한 것과 구별되지 않으므로 숨김을 켜 준다.
      const hidden = showHidden || name.startsWith(".");
      setShowHidden(hidden);
      setCreating(null);
      setTaken(false);
      await refresh(cwd, hidden);
      // 파일은 곧바로 뷰어로 연다 — 만든 다음에 하려던 일이 대개 편집이다.
      if (creating.kind === "file") await openFile(target);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  const parent = cwd === "." ? null : cwd.split("/").slice(0, -1).join("/") || ".";
  // 미리보기는 **편집 중인 버퍼**를 그린다 — 저장 전에도 결과를 보면서 고칠 수 있어야 한다.
  const markdown = Boolean(file && !file.isBinary && isMarkdownPath(file.relativePath));

  const problem = creating ? entryNameProblem(creating.name, existingNames) : null;
  // 빈 이름은 아직 "틀린" 것이 아니다 — 커서를 놓자마자 빨간 줄이 뜨면 다그치는 화면이 된다.
  const problemKey =
    problem && problem !== "empty"
      ? NAME_PROBLEM[problem]
      : taken
        ? NAME_PROBLEM.duplicate
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel
        title={t("files.explorer")}
        subtitle={project ? `/${cwd === "." ? "" : cwd}` : t("files.openProjectFirst")}
        className="max-h-64 shrink-0"
        actions={
          <>
            {/* 만들기 버튼 둘. 뜻은 글자가 지고, 긴 설명은 `title` 이 받는다. */}
            <Button
              variant="ghost"
              onClick={() => startCreating("file")}
              disabled={!project}
              title={t("files.newFileHint")}
            >
              {t("files.newFileAction")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => startCreating("dir")}
              disabled={!project}
              title={t("files.newFolderHint")}
            >
              {t("files.newFolderAction")}
            </Button>
            <Button variant="ghost" onClick={toggleHidden} disabled={!project}>
              {showHidden ? t("files.hiddenOn") : t("files.hiddenOff")}
            </Button>
            <Button variant="ghost" onClick={() => void refresh(cwd, showHidden)} disabled={!project}>
              {t("common.refresh")}
            </Button>
          </>
        }
      >
        <ul className="p-1.5 font-mono text-caption">
          {creating && (
            // 만드는 줄은 목록 **맨 위**에 선다 — 스크롤을 내려가서 찾을 일이 없다.
            <li className="rounded-sm bg-surface-1 px-2 py-2">
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={creating.name}
                  spellCheck={false}
                  placeholder={t(
                    creating.kind === "dir"
                      ? "files.newFolderPlaceholder"
                      : "files.newFilePlaceholder",
                  )}
                  aria-label={t(creating.kind === "dir" ? "files.newFolder" : "files.newFile")}
                  onChange={(event) => {
                    setCreating({ kind: creating.kind, name: event.target.value });
                    // 이름이 바뀌었으면 디스크에 물어본 결과도 낡았다.
                    setTaken(false);
                  }}
                  onKeyDown={(event) => {
                    // Enter 로 만들고 Esc 로 접는다. 다른 키는 그대로 흘린다.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitCreate();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setCreating(null);
                    }
                  }}
                  className={`${FIELD_SM} font-mono`}
                />
                <Button
                  variant="primary"
                  onClick={() => void submitCreate()}
                  disabled={Boolean(problem) || taken}
                >
                  {t("files.create")}
                </Button>
                <Button variant="ghost" onClick={() => setCreating(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
              {/* 만들어질 자리와 걸린 이유는 **누르기 전에** 글자로 적어 둔다. */}
              <p
                className={`mt-1.5 text-caption ${problemKey ? "text-error" : "text-ink-subtle"}`}
              >
                {problemKey
                  ? t(problemKey)
                  : t("files.createIn", { path: `/${cwd === "." ? "" : cwd}` })}
              </p>
            </li>
          )}
          {parent !== null && (
            <li>
              <button
                className="w-full rounded-sm px-2.5 py-1.5 text-left text-ink-muted transition-colors hover:bg-hover"
                onClick={() => {
                  setCreating(null);
                  void refresh(parent, showHidden);
                }}
              >
                ../
              </button>
            </li>
          )}
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
                onClick={() => void openEntry(entry)}
              >
                {/* 폴더/파일은 색이 아니라 글자 굵기와 아이콘으로 가른다. */}
                <span className={entry.isDir ? "text-body-emphasis text-ink" : "text-ink-muted"}>
                  {entry.isDir ? "📁" : "📄"} {entry.name}
                </span>
                {!entry.isDir && (
                  <span className="ml-auto text-caption text-ink-subtle">{entry.size}B</span>
                )}
              </button>
            </li>
          ))}
          {project && entries.length === 0 && !creating && (
            <li className="px-4 py-6 text-center text-ink-subtle">{t("files.empty")}</li>
          )}
        </ul>
      </Panel>

      {/* 목록은 위쪽 일부만 쓰고, 남는 높이는 전부 뷰어가 가져간다 */}
      <Panel
        title={t("files.viewer")}
        subtitle={
          file
            ? `${file.relativePath}${file.truncated ? ` ${t("files.partial")}` : ""}`
            : t("files.noSelection")
        }
        className="min-h-0 flex-1"
        actions={
          <>
            {/* 마크다운일 때만 뜬다 — 다른 파일에는 렌더링할 것이 없다. */}
            {markdown && (
              <Button
                onClick={() => setPreview((value) => !value)}
                title={preview ? t("files.sourceHint") : t("files.previewHint")}
              >
                {preview ? t("files.source") : t("files.preview")}
              </Button>
            )}
            <Button variant="primary" onClick={() => void save()} disabled={!file || !dirty}>
              {dirty ? t("files.saveDirty") : t("common.save")}
            </Button>
          </>
        }
      >
        {file ? (
          file.isBinary ? (
            <p className="p-4 text-body-sm text-ink-muted">
              {t("files.binary", { size: file.size })}
            </p>
          ) : markdown && preview ? (
            // 채팅과 같은 파서·같은 부품을 쓴다 — 두 화면이 같은 마크다운을 다르게 그리면
            // 어느 쪽이 맞는지 사람이 알 수 없다.
            <div className="p-4">
              <Markdown text={buffer} />
            </div>
          ) : (
            <textarea
              value={buffer}
              onChange={(event) => {
                setBuffer(event.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="h-full min-h-64 w-full resize-none border-0 bg-transparent p-4 font-mono text-caption text-ink outline-none"
            />
          )
        ) : (
          <p className="p-4 text-body-sm text-ink-muted">{t("files.pickFile")}</p>
        )}
      </Panel>
    </div>
  );
}
