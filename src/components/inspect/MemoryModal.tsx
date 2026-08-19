import { useEffect, useState } from "react";

import { Button, Modal } from "@/components/Panel";
import * as ipc from "@/lib/ipc";
import { useWorkspace } from "@/store/workspace";
import type { Memory, MemoryScope } from "@/types/ipc";

interface MemoryModalProps {
  open: boolean;
  onClose: () => void;
}

const SCOPE_LABEL: Record<string, string> = {
  project: "프로젝트",
  session: "이 세션",
};

/**
 * 에이전트 메모리 인스펙터.
 * `remember` / `recall` 스킬이 쓰는 것과 정확히 같은 테이블을 보여주고 직접 고칠 수 있게 한다.
 */
export function MemoryModal({ open, onClose }: MemoryModalProps) {
  const project = useWorkspace((state) => state.project);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);

  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scope, setScope] = useState<MemoryScope>("project");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  async function refresh() {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      setMemories(await ipc.listMemories(activeSessionId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open, activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!key.trim() || !value.trim()) return;
    setError(null);
    try {
      await ipc.upsertMemory({
        key: key.trim(),
        value: value.trim(),
        scope,
        sessionId: activeSessionId,
      });
      setKey("");
      setValue("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function remove(memory: Memory) {
    setError(null);
    try {
      await ipc.deleteMemory(memory.id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Modal
      open={open}
      title="현재 메모리"
      subtitle="에이전트의 remember / recall 이 읽고 쓰는 것과 같은 저장소"
      onClose={onClose}
      widthClass="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-[10px] text-zinc-600">
            {loading ? "불러오는 중…" : `${memories.length}개`}
          </span>
          <Button onClick={() => void refresh()}>새로고침</Button>
          <Button variant="primary" onClick={onClose}>
            닫기
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4 text-xs">
        {!project && <p className="text-zinc-500">프로젝트 폴더를 먼저 여세요.</p>}

        {error && (
          <p className="rounded border border-red-900 bg-red-950/50 px-2 py-1 font-mono text-[11px] break-all text-red-300">
            {error}
          </p>
        )}

        {project && (
          <>
            <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/60 p-2">
              <div className="flex gap-1.5">
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as MemoryScope)}
                  className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
                >
                  <option value="project">프로젝트 전역</option>
                  <option value="session" disabled={!activeSessionId}>
                    이 세션만
                  </option>
                </select>
                <input
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="키 (예: 빌드 명령)"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600"
                />
              </div>
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="기억할 내용"
                rows={2}
                className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600"
              />
              <div className="flex justify-end">
                <Button onClick={() => void save()} disabled={!key.trim() || !value.trim()}>
                  저장 (같은 키면 덮어쓰기)
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              {memories.length === 0 && !loading && (
                <p className="text-[11px] text-zinc-600">
                  아직 저장된 메모리가 없습니다. 에이전트가 `remember` 를 쓰거나 위에서 직접 추가할
                  수 있습니다.
                </p>
              )}

              {memories.map((memory) => (
                <div
                  key={memory.id}
                  className="group rounded border border-zinc-800 bg-zinc-950/60 p-2"
                >
                  <div className="mb-1 flex items-center gap-2 text-[10px]">
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        memory.scope === "session"
                          ? "bg-violet-950 text-violet-300"
                          : "bg-emerald-950 text-emerald-300"
                      }`}
                    >
                      {SCOPE_LABEL[memory.scope] ?? memory.scope}
                    </span>
                    <span className="font-mono text-zinc-200">{memory.key}</span>
                    <span className="text-zinc-600">{memory.updatedAt.slice(0, 19)}</span>
                    <button
                      className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-950 hover:text-red-300"
                      onClick={() => void remove(memory)}
                    >
                      삭제
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[11px] text-zinc-300">
                    {memory.value}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
