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
    <div className="flex min-h-0 flex-col gap-3">
      <Panel
        title="파일 탐색기"
        subtitle={project ? `/${cwd === "." ? "" : cwd}` : "프로젝트를 먼저 여세요"}
        className="max-h-72"
        actions={
          <>
            <Button onClick={() => setShowHidden((value) => !value)} disabled={!project}>
              {showHidden ? "숨김 ON" : "숨김 OFF"}
            </Button>
            <Button onClick={() => void refresh(cwd)} disabled={!project}>
              새로고침
            </Button>
          </>
        }
      >
        <ul className="divide-y divide-zinc-800/60 font-mono text-xs">
          {parent !== null && (
            <li>
              <button
                className="w-full px-3 py-1 text-left text-zinc-400 hover:bg-zinc-800/40"
                onClick={() => void refresh(parent)}
              >
                ../
              </button>
            </li>
          )}
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-zinc-800/40"
                onClick={() => void openEntry(entry)}
              >
                <span className={entry.isDir ? "text-sky-300" : "text-zinc-300"}>
                  {entry.isDir ? "📁" : "📄"} {entry.name}
                </span>
                {!entry.isDir && (
                  <span className="ml-auto text-[10px] text-zinc-600">{entry.size}B</span>
                )}
              </button>
            </li>
          ))}
          {project && entries.length === 0 && (
            <li className="px-3 py-4 text-center text-zinc-600">비어 있습니다.</li>
          )}
        </ul>
      </Panel>

      <Panel
        title="파일 뷰어"
        subtitle={file ? `${file.relativePath}${file.truncated ? " (일부만 표시)" : ""}` : "파일 선택 안 됨"}
        className="flex-1"
        actions={
          <Button variant="primary" onClick={() => void save()} disabled={!file || !dirty}>
            {dirty ? "저장 *" : "저장"}
          </Button>
        }
      >
        {file ? (
          file.isBinary ? (
            <p className="p-3 text-xs text-zinc-500">바이너리 파일입니다 ({file.size} bytes).</p>
          ) : (
            <textarea
              value={buffer}
              onChange={(event) => {
                setBuffer(event.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="h-full min-h-40 w-full resize-none bg-transparent p-3 font-mono text-xs text-zinc-200 outline-none"
            />
          )
        ) : (
          <p className="p-3 text-xs text-zinc-600">왼쪽 목록에서 파일을 선택하세요.</p>
        )}
      </Panel>
    </div>
  );
}
