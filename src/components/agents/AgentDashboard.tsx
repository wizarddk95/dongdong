import { useEffect, useState } from "react";

import { Button } from "@/components/Panel";
import { isRunActive, runDuration, runStatusStyle } from "@/lib/agentRuns";
import { useAgents } from "@/store/agents";
import { useWorkspace } from "@/store/workspace";
import type { AgentRun } from "@/types/ipc";

/** 칸반 열 정의 — 상태를 세 덩어리로 묶어 본다. */
const COLUMNS: { id: string; label: string; statuses: string[]; accent: string }[] = [
  {
    id: "active",
    label: "실행 중",
    statuses: ["pending", "running"],
    accent: "border-emerald-800",
  },
  { id: "done", label: "완료", statuses: ["succeeded"], accent: "border-sky-900" },
  { id: "failed", label: "실패 · 취소", statuses: ["failed", "cancelled"], accent: "border-red-900" },
];

/**
 * 서브에이전트 대시보드.
 * 메인 에이전트가 `delegate_task` 로 띄운 실행들을 상태별로 보여준다.
 */
export function AgentDashboard() {
  const project = useWorkspace((state) => state.project);
  const { runs, loading, error, refresh, clearFinished } = useAgents();

  // 실행 중인 게 있으면 경과 시간이 흐르도록 주기적으로 다시 그린다.
  const hasActive = runs.some((run) => run.status === "running" || run.status === "pending");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  if (!project) {
    return <p className="p-3 text-xs text-zinc-600">프로젝트 폴더를 먼저 여세요.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[11px]">
        <span className="text-zinc-400">
          서브에이전트 {runs.length}개{loading ? " · 불러오는 중…" : ""}
        </span>
        <span className="ml-auto flex gap-1">
          <Button onClick={() => void refresh()}>새로고침</Button>
          <Button onClick={() => void clearFinished()} disabled={runs.length === 0}>
            끝난 것 정리
          </Button>
        </span>
      </header>

      {error && (
        <p className="shrink-0 border-b border-red-900 bg-red-950/50 px-3 py-1.5 font-mono text-[11px] break-all text-red-300">
          {error}
        </p>
      )}

      {runs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-xs text-zinc-600">
          <p>아직 위임된 작업이 없습니다.</p>
          <p className="text-[11px]">
            에이전트가 <code className="text-zinc-500">delegate_task</code> 를 호출하면 여기에
            나타납니다.
          </p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-auto p-2">
          {COLUMNS.map((column) => {
            const items = runs.filter((run) => column.statuses.includes(run.status));
            return (
              <section key={column.id} className="flex min-w-0 flex-col gap-1.5">
                <h3 className={`shrink-0 border-b pb-1 text-[10px] text-zinc-400 ${column.accent}`}>
                  {column.label} · {items.length}
                </h3>
                {items.map((run) => (
                  <RunCard key={run.id} run={run} />
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: AgentRun }) {
  const cancel = useAgents((state) => state.cancel);
  const remove = useAgents((state) => state.remove);
  const [expanded, setExpanded] = useState(false);

  const status = runStatusStyle(run.status);
  const active = isRunActive(run);
  const elapsed = runDuration(run);

  return (
    <div className="group rounded border border-zinc-800 bg-zinc-900/60 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px]">
        <span className={`rounded px-1 py-0.5 ${status.className}`}>{status.label}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-200">{run.name}</span>
        {elapsed && <span className="shrink-0 text-zinc-600">{elapsed}</span>}
      </div>

      {/* 진행률은 스텝 예산 대비 비율이라 정확한 완성도가 아니다 */}
      <div className="mb-1 h-1 overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full transition-all ${status.barClassName}`}
          style={{ width: `${Math.round((run.progress ?? 0) * 100)}%` }}
        />
      </div>

      {active && (
        <p className="mb-1 truncate font-mono text-[10px] text-amber-300">
          {run.currentSkill ? `▶ ${run.currentSkill}` : "▶ 생각 중…"}
        </p>
      )}

      <p
        className={`text-[11px] text-zinc-400 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
      >
        {run.task}
      </p>

      {expanded && (run.result || run.error) && (
        <div
          className={`mt-1.5 rounded border px-1.5 py-1 text-[11px] whitespace-pre-wrap ${
            run.error
              ? "border-red-900 bg-red-950/40 text-red-200"
              : "border-zinc-800 bg-black/30 text-zinc-300"
          }`}
        >
          {run.error ?? run.result}
        </div>
      )}

      <div className="mt-1 flex items-center gap-1 text-[10px]">
        <button
          className="text-zinc-500 hover:text-zinc-300"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : run.result || run.error ? "결과 보기" : "전체 보기"}
        </button>
        <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {active && (
            <button
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-amber-300 hover:bg-zinc-700"
              onClick={() => cancel(run.id)}
            >
              중단
            </button>
          )}
          <button
            className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400 hover:bg-red-950 hover:text-red-300"
            onClick={() => void remove(run.id)}
          >
            삭제
          </button>
        </span>
      </div>
    </div>
  );
}
