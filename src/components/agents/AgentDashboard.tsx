import { useEffect, useState } from "react";

import { Button } from "@/components/Panel";
import { UsageTag } from "@/components/UsageMeter";
import { isRunActive, runDuration, runStatusStyle, runUsage } from "@/lib/agentRuns";
import { useAgents } from "@/store/agents";
import { useWorkspace } from "@/store/workspace";
import type { AgentRun } from "@/types/ipc";

/**
 * 칸반 열 정의 — 상태를 세 덩어리로 묶어 본다.
 * 열 머리의 2px 룰만 색을 갖는다. 카드 자체는 회색 계조로 남긴다.
 */
const COLUMNS: { id: string; label: string; statuses: string[]; accent: string }[] = [
  { id: "active", label: "실행 중", statuses: ["pending", "running"], accent: "border-accent" },
  { id: "done", label: "완료", statuses: ["succeeded"], accent: "border-success" },
  {
    id: "failed",
    label: "실패 · 취소",
    statuses: ["failed", "cancelled"],
    accent: "border-error",
  },
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
    return <p className="p-4 text-body-sm text-ink-muted">프로젝트 폴더를 먼저 여세요.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="text-caption text-ink-muted">
          서브에이전트 {runs.length}개{loading ? " · 불러오는 중…" : ""}
        </span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" onClick={() => void refresh()}>
            새로고침
          </Button>
          <Button onClick={() => void clearFinished()} disabled={runs.length === 0}>
            끝난 것 정리
          </Button>
        </span>
      </header>

      {error && (
        <p className="shrink-0 border-b border-hairline border-l-2 border-l-error bg-error-subtle px-3 py-2 font-mono text-caption break-all text-ink">
          {error}
        </p>
      )}

      {runs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-subhead text-ink">아직 위임된 작업이 없습니다</p>
          <p className="text-body-sm text-ink-muted">
            에이전트가 <code className="font-mono text-ink">delegate_task</code> 를 호출하면 여기에
            나타납니다.
          </p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-auto p-3">
          {COLUMNS.map((column) => {
            const items = runs.filter((run) => column.statuses.includes(run.status));
            return (
              <section key={column.id} className="flex min-w-0 flex-col gap-2">
                <h3
                  className={`shrink-0 border-b-2 pb-1.5 text-caption text-ink ${column.accent}`}
                >
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
  // 위임 실행은 대화 트리에 안 남으므로 쓴 토큰을 여기서만 볼 수 있다.
  const usage = runUsage(run);

  return (
    <div className="group rounded-md border border-hairline bg-canvas p-2.5 elevate">
      <div className="mb-1.5 flex items-center gap-1.5 text-caption">
        <span className={`shrink-0 rounded-full px-2 py-0.5 ${status.className}`}>{status.label}</span>
        <span className="min-w-0 flex-1 truncate text-ink">{run.name}</span>
        {elapsed && <span className="shrink-0 text-ink-subtle">{elapsed}</span>}
      </div>

      {/* 진행률은 스텝 예산 대비 비율이라 정확한 완성도가 아니다 */}
      <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-all ${status.barClassName}`}
          style={{ width: `${Math.round((run.progress ?? 0) * 100)}%` }}
        />
      </div>

      {active && (
        <p className="mb-1 truncate font-mono text-caption text-accent">
          {run.currentTool ? `▶ ${run.currentTool}` : "▶ 생각 중…"}
        </p>
      )}

      <p
        className={`text-caption text-ink-muted ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
      >
        {run.task}
      </p>

      {expanded && (run.result || run.error) && (
        <div
          className={`mt-2 rounded-md border-l-2 px-2.5 py-1.5 text-caption whitespace-pre-wrap ${
            run.error ? "border-error bg-error-subtle text-ink" : "border-hairline bg-surface-1 text-ink"
          }`}
        >
          {run.error ?? run.result}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2 text-caption">
        <button
          className="text-accent hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : run.result || run.error ? "결과 보기" : "전체 보기"}
        </button>
        {usage && (
          <UsageTag usage={usage.usage} cost={usage.cost} modelId={usage.modelId} variant="cost" />
        )}
        <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {active && (
            <button
              className="rounded-sm px-2 py-0.5 text-accent transition-colors hover:bg-hover"
              onClick={() => cancel(run.id)}
            >
              중단
            </button>
          )}
          <button
            className="rounded-sm px-2 py-0.5 text-ink-muted transition-colors hover:bg-hover hover:text-error"
            onClick={() => void remove(run.id)}
          >
            삭제
          </button>
        </span>
      </div>
    </div>
  );
}
