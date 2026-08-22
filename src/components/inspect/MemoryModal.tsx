import { useEffect, useState } from "react";

import { Button, FIELD_SM, Modal, SELECT_SM, Tag } from "@/components/Panel";
import * as ipc from "@/lib/ipc";
import { t, type MessageKey } from "@/lib/i18n";
import { useWorkspace } from "@/store/workspace";
import type { Memory, MemoryScope } from "@/types/ipc";

interface MemoryModalProps {
  open: boolean;
  onClose: () => void;
}

const SCOPE_LABEL_KEY: Record<string, MessageKey> = {
  project: "memory.scope.project",
  session: "memory.scope.session",
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
      title={t("memory.title")}
      subtitle={t("memory.subtitle")}
      onClose={onClose}
      widthClass="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-caption text-ink-muted">
            {loading ? t("common.loading") : t("memory.count", { count: memories.length })}
          </span>
          <Button onClick={() => void refresh()}>{t("common.refresh")}</Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-4">
        {!project && (
          <p className="text-body-sm text-ink-muted">{t("chat.error.noProject")}</p>
        )}

        {error && (
          <p className="rounded-md border-l-2 border-error bg-error-subtle px-3 py-2 font-mono text-caption break-all text-ink">
            {error}
          </p>
        )}

        {project && (
          <>
            <div className="space-y-2 rounded-md border border-hairline bg-surface-1 p-3">
              <div className="flex gap-2">
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as MemoryScope)}
                  className={`${SELECT_SM} w-auto`}
                >
                  <option value="project">{t("memory.scope.projectOption")}</option>
                  <option value="session" disabled={!activeSessionId}>
                    {t("memory.scope.sessionOption")}
                  </option>
                </select>
                <input
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={t("memory.keyPlaceholder")}
                  className={`${FIELD_SM} flex-1`}
                />
              </div>
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={t("memory.valuePlaceholder")}
                rows={2}
                className={`${FIELD_SM} resize-none`}
              />
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => void save()} disabled={!key.trim() || !value.trim()}>
                  {t("memory.save")}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {memories.length === 0 && !loading && (
                <p className="text-caption text-ink-subtle">{t("memory.empty")}</p>
              )}

              {memories.map((memory) => (
                <div
                  key={memory.id}
                  className="group rounded-md border border-hairline bg-canvas p-3 elevate"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-caption">
                    {/* 범위는 색이 아니라 라벨이 말한다 — 둘 다 중립 태그다. */}
                    <Tag>
                      {SCOPE_LABEL_KEY[memory.scope]
                        ? t(SCOPE_LABEL_KEY[memory.scope])
                        : memory.scope}
                    </Tag>
                    <span className="font-mono text-ink">{memory.key}</span>
                    <span className="text-ink-subtle">{memory.updatedAt.slice(0, 19)}</span>
                    <button
                      className="ml-auto rounded-sm px-2 py-0.5 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-hover hover:text-error"
                      onClick={() => void remove(memory)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-caption text-ink-muted">
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
