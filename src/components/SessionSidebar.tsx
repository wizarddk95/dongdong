import { Button, Tag } from "@/components/Panel";
import { formatCost, summarizeSessionUsage } from "@/lib/ai/usage";
import { useWorkspace } from "@/store/workspace";

interface SessionSidebarProps {
  /** 채팅 앞단의 세션 맵으로 돌아가기 */
  onBackToMap: () => void;
}

export function SessionSidebar({ onBackToMap }: SessionSidebarProps) {
  const project = useWorkspace((state) => state.project);
  const sessions = useWorkspace((state) => state.sessions);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const newSession = useWorkspace((state) => state.newSession);
  const selectSession = useWorkspace((state) => state.selectSession);
  const removeSession = useWorkspace((state) => state.removeSession);

  return (
    <aside className="flex h-full min-h-0 w-60 shrink-0 flex-col border-r border-hairline bg-surface-1">
      <button
        className="shrink-0 border-b border-hairline px-3 py-2 text-left text-caption text-accent hover:bg-hover"
        onClick={onBackToMap}
      >
        ← 세션 맵
      </button>

      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <span className="text-body-emphasis text-ink">
          세션 {sessions.length > 0 && `(${sessions.length})`}
        </span>
        <Button onClick={() => void newSession()} disabled={!project} title="새 세션 만들기">
          +
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-auto">
        {sessions.map((session) => {
          const summary = summarizeSessionUsage(session);
          const active = session.id === activeSessionId;
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
              <button
                className="shrink-0 rounded-sm px-1.5 py-0.5 text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-hover hover:text-error"
                title="세션 삭제"
                onClick={() => void removeSession(session.id)}
              >
                ✕
              </button>
            </li>
          );
        })}

        {sessions.length === 0 && (
          <li className="px-3 py-6 text-center text-caption text-ink-muted">
            {project ? "세션이 없습니다." : "프로젝트를 여세요."}
          </li>
        )}
      </ul>
    </aside>
  );
}
