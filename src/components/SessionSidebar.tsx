import { Button } from "@/components/Panel";
import { useWorkspace } from "@/store/workspace";

export function SessionSidebar() {
  const project = useWorkspace((state) => state.project);
  const sessions = useWorkspace((state) => state.sessions);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const newSession = useWorkspace((state) => state.newSession);
  const selectSession = useWorkspace((state) => state.selectSession);
  const removeSession = useWorkspace((state) => state.removeSession);

  return (
    <aside className="flex h-full min-h-0 w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/30">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2.5 py-2">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
          세션 {sessions.length > 0 && `(${sessions.length})`}
        </span>
        <Button onClick={() => void newSession()} disabled={!project} className="!px-1.5 !py-0.5">
          +
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-auto">
        {sessions.map((session) => (
          <li
            key={session.id}
            className={`group flex items-center gap-1 border-b border-zinc-800/50 px-2.5 py-2 text-xs ${
              session.id === activeSessionId ? "bg-zinc-800/70" : "hover:bg-zinc-800/30"
            }`}
          >
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => void selectSession(session.id)}
            >
              <span className="block truncate text-zinc-200">{session.title}</span>
              <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                {session.branchedFromMessageId && (
                  <span className="rounded bg-violet-950 px-1 text-violet-300">⑂ 분기</span>
                )}
                {new Date(session.updatedAt).toLocaleString("ko-KR", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </button>
            <button
              className="shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
              title="세션 삭제"
              onClick={() => void removeSession(session.id)}
            >
              ✕
            </button>
          </li>
        ))}

        {sessions.length === 0 && (
          <li className="px-3 py-6 text-center text-[11px] text-zinc-600">
            {project ? "세션이 없습니다." : "프로젝트를 여세요."}
          </li>
        )}
      </ul>
    </aside>
  );
}
