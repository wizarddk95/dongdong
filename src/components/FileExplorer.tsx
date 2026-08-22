import { useCallback, useEffect, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Button, Panel } from "@/components/Panel";
import * as ipc from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { isMarkdownPath } from "@/lib/markdown";
import { useWorkspace } from "@/store/workspace";
import type { DirEntry, FileContent } from "@/types/ipc";

/** read_file / write_file / list_directory IPC 를 눈으로 확인하는 패널. */
export function FileExplorer() {
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

  const refresh = useCallback(
    async (target: string) => {
      if (!project) return;
      try {
        setEntries(await ipc.listDirectory(target, { includeHidden: showHidden }));
        setCwd(target);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [project, showHidden, setError],
  );

  useEffect(() => {
    if (project) void refresh(".");
    else {
      setEntries([]);
      setFile(null);
    }
  }, [project, refresh]);

  async function openEntry(entry: DirEntry) {
    if (entry.isDir) {
      await refresh(entry.relativePath);
      return;
    }
    try {
      const content = await ipc.readFile(entry.relativePath);
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

  const parent = cwd === "." ? null : cwd.split("/").slice(0, -1).join("/") || ".";
  // 미리보기는 **편집 중인 버퍼**를 그린다 — 저장 전에도 결과를 보면서 고칠 수 있어야 한다.
  const markdown = Boolean(file && !file.isBinary && isMarkdownPath(file.relativePath));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel
        title={t("files.explorer")}
        subtitle={project ? `/${cwd === "." ? "" : cwd}` : t("files.openProjectFirst")}
        className="max-h-64 shrink-0"
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowHidden((value) => !value)} disabled={!project}>
              {showHidden ? t("files.hiddenOn") : t("files.hiddenOff")}
            </Button>
            <Button variant="ghost" onClick={() => void refresh(cwd)} disabled={!project}>
              {t("common.refresh")}
            </Button>
          </>
        }
      >
        <ul className="p-1.5 font-mono text-caption">
          {parent !== null && (
            <li>
              <button
                className="w-full rounded-sm px-2.5 py-1.5 text-left text-ink-muted transition-colors hover:bg-hover"
                onClick={() => void refresh(parent)}
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
          {project && entries.length === 0 && (
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
