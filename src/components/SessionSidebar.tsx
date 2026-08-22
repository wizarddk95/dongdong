import { useState } from "react";

import { Button, FIELD_SM, Tag } from "@/components/Panel";
import { ContextRing } from "@/components/UsageMeter";
import { formatCost, sessionContextStatus, summarizeProjectUsage, summarizeSessionUsage } from "@/lib/ai/usage";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

/**
 * 세션 목록 — 이 프로젝트의 대화를 고르고, 만들고, 이름을 바꾸고, 지우는 유일한 자리.
 *
 * 예전에는 채팅 앞단에 세션 맵(분기 트리)이 따로 있었지만, 세션 분기를 만드는 길이
 * 사라지면서 그릴 나무도 사라졌다 → 목록 하나로 합쳤다.
 *
 * 폭은 App 이 들고 있다 — 분할선을 끄는 주체가 App 이라 여기서 상태를 또 두면 어긋난다.
 */
export function SessionSidebar({ width }: { width: number }) {
  const project = useWorkspace((state) => state.project);
  const sessions = useWorkspace((state) => state.sessions);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const newSession = useWorkspace((state) => state.newSession);
  const selectSession = useWorkspace((state) => state.selectSession);
  const removeSession = useWorkspace((state) => state.removeSession);
  const renameSession = useWorkspace((state) => state.renameSession);
  // 컨텍스트 링의 분모는 **지금 선택한 모델**의 창이다 — "이 대화를 지금 이어서 쓰면 얼마나 차 있나".
  const modelId = useSettings((state) => state.modelId);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // 이 프로젝트가 지금까지 쓴 총량. 모델별로 요금을 매긴 뒤 더한 값이다.
  const total = summarizeProjectUsage(sessions);

  function startRename(sessionId: string, title: string) {
    setEditingId(sessionId);
    setDraft(title);
  }

  function commitRename() {
    const title = draft.trim();
    if (editingId && title) void renameSession(editingId, title);
    setEditingId(null);
  }

  return (
    <aside
      style={{ width }}
      className="flex h-full min-h-0 shrink-0 flex-col bg-surface-1"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <span className="text-body-emphasis text-ink">
          세션 {sessions.length > 0 && `(${sessions.length})`}
        </span>
        <Button onClick={() => void newSession()} disabled={!project} title="새 세션 만들기">
          +
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-auto py-1">
        {sessions.map((session) => {
          const summary = summarizeSessionUsage(session);
          const active = session.id === activeSessionId;

          if (session.id === editingId) {
            return (
              <li key={session.id} className="mx-2 px-1 py-1.5">
                <input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") setEditingId(null);
                  }}
                  className={FIELD_SM}
                />
              </li>
            );
          }

          return (
            <li
              key={session.id}
              /*
               * 구분선을 긋지 않고 항목 자체를 둥근 덩어리로 띄운다 —
               * 줄이 그어진 목록보다 훨씬 부드럽게 읽힌다.
               */
              className={`group mx-2 flex items-center gap-1 rounded-md px-3 py-2 transition-colors ${
                active ? "bg-selected" : "hover:bg-hover"
              }`}
            >
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => void selectSession(session.id)}
              >
                <span className={`block truncate ${active ? "text-body-emphasis" : ""} text-ink`}>
                  {session.title}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
                  {session.branchedFromMessageId && <Tag>⑂ 분기</Tag>}
                  <span>노드 {session.messageCount}</span>
                  {summary.calls > 0 && (
                    <span>{formatCost(summary.cost, summary.primaryModelId)}</span>
                  )}
                  <span>
                    {new Date(session.updatedAt).toLocaleString("ko-KR", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
              </button>

              <ContextRing status={sessionContextStatus(session, modelId)} size={18} />

              <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <button
                  className="rounded-sm px-1.5 py-0.5 text-ink-subtle transition-colors hover:bg-hover hover:text-ink"
                  title="이름 변경"
                  onClick={() => startRename(session.id, session.title)}
                >
                  ✎
                </button>
                <button
                  className="rounded-sm px-1.5 py-0.5 text-ink-subtle transition-colors hover:bg-hover hover:text-error"
                  title="세션 삭제"
                  onClick={() => {
                    if (window.confirm(`세션 "${session.title}" 을(를) 삭제합니다.`)) {
                      void removeSession(session.id);
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            </li>
          );
        })}

        {sessions.length === 0 && (
          <li className="px-3 py-6 text-center text-caption text-ink-muted">
            {project ? "세션이 없습니다." : "프로젝트를 여세요."}
          </li>
        )}
      </ul>

      {total.calls > 0 && (
        <div
          className="shrink-0 border-t border-hairline px-3 py-2 text-caption text-ink-muted"
          title="이 프로젝트의 모든 세션(버려진 분기와 서브에이전트 포함)이 쓴 합계입니다."
        >
          프로젝트 합계{" "}
          <span className="text-ink">{formatCost(total.cost, total.primaryModelId)}</span> · LLM
          호출 {total.calls}회
        </div>
      )}
    </aside>
  );
}
