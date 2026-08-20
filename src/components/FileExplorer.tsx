import { useCallback, useEffect, useState } from "react";

import { Button, Panel } from "@/components/Panel";
import * as ipc from "@/lib/ipc";
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel
        title="파일 탐색기"
        subtitle={project ? `/${cwd === "." ? "" : cwd}` : "프로젝트를 먼저 여세요"}
        className="max-h-64 shrink-0"
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowHidden((value) => !value)} disabled={!project}>
              {showHidden ? "숨김 ON" : "숨김 OFF"}
            </Button>
            <Button variant="ghost" onClick={() => void refresh(cwd)} disabled={!project}>
              새로고침
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
            <li className="px-4 py-6 text-center text-ink-subtle">비어 있습니다.</li>
          )}
        </ul>
      </Panel>

      {/* 목록은 위쪽 일부만 쓰고, 남는 높이는 전부 뷰어가 가져간다 */}
      <Panel
        title="파일 뷰어"
        subtitle={file ? `${file.relativePath}${file.truncated ? " (일부만 표시)" : ""}` : "파일 선택 안 됨"}
        className="min-h-0 flex-1"
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={!file || !dirty}>
            {dirty ? "저장 *" : "저장"}
          </Button>
        }
      >
        {file ? (
          file.isBinary ? (
            <p className="p-4 text-body-sm text-ink-muted">
              바이너리 파일입니다 ({file.size} bytes).
            </p>
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
          <p className="p-4 text-body-sm text-ink-muted">왼쪽 목록에서 파일을 선택하세요.</p>
        )}
      </Panel>
    </div>
  );
}
