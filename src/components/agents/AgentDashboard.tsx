import { useEffect, useState } from "react";

import { AgentResultModal } from "@/components/agents/AgentResultModal";
import { Button } from "@/components/Panel";
import { UsageTag } from "@/components/UsageMeter";
import { isRunActive, runDuration, runStatusStyle, runUsage } from "@/lib/agentRuns";
import { useAgents } from "@/store/agents";
import { t, type MessageKey } from "@/lib/i18n";
import { useWorkspace } from "@/store/workspace";
import type { AgentRun } from "@/types/ipc";

/**
 * 칸반 열 정의 — 상태를 세 덩어리로 묶어 본다.
 * 열 머리의 2px 룰만 색을 갖는다. 카드 자체는 회색 계조로 남긴다.
 */
const COLUMNS: { id: string; labelKey: MessageKey; statuses: string[]; accent: string }[] = [
  {
    id: "active",
    labelKey: "agents.column.active",
    statuses: ["pending", "running"],
    accent: "border-accent",
  },
  {
    id: "done",
    labelKey: "agents.column.done",
    statuses: ["succeeded"],
    accent: "border-success",
  },
  {
    id: "failed",
    labelKey: "agents.column.failed",
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
    return <p className="p-4 text-body-sm text-ink-muted">{t("chat.error.noProject")}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="min-w-0 truncate text-caption text-ink-muted">
          {t("agents.count", { count: runs.length })}
          {loading ? t("agents.loading") : ""}
        </span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" onClick={() => void refresh()}>
            {t("common.refresh")}
          </Button>
          <Button onClick={() => void clearFinished()} disabled={runs.length === 0}>
            {t("agents.clearFinished")}
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
          <p className="text-subhead text-ink">{t("agents.emptyTitle")}</p>
          <p className="text-body-sm text-ink-muted">{t("agents.emptyBody")}</p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-auto p-3">
          {COLUMNS.map((column) => {
            const items = runs.filter((run) => column.statuses.includes(run.status));
            return (
              <section key={column.id} className="flex min-w-0 flex-col gap-2">
                {/* 열 머리도 가로로 못 박는다 — 패널을 좁히면 "실패 · 취소" 가 세로로 선다. */}
                <h3
                  className={`shrink-0 truncate border-b-2 pb-1.5 text-caption whitespace-nowrap text-ink ${column.accent}`}
                >
                  {t(column.labelKey)} · {items.length}
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
  // 카드는 한 줄 요약만 진다. 지시문 전문도 결과도 전부 팝업에서 본다 —
  // 열 폭이 화면의 1/3 이라 카드 안에서 펼치면 무엇이든 칸을 뚫고 나간다.
  const [resultOpen, setResultOpen] = useState(false);

  const status = runStatusStyle(run.status);
  const active = isRunActive(run);
  const elapsed = runDuration(run);
  // 위임 실행은 대화 트리에 안 남으므로 쓴 토큰을 여기서만 볼 수 있다.
  const usage = runUsage(run);

  return (
    <div className="group rounded-md border border-hairline bg-canvas p-2.5 elevate">
      <div className="mb-1.5 flex items-center gap-1.5 text-caption">
        {/* 칸이 좁아져도 글자는 가로로 — 배지가 눌리면 한 글자씩 세로로 선다. */}
        <span
          className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 ${status.className}`}
        >
          {t(status.labelKey)}
        </span>
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
          {run.currentTool ? `▶ ${run.currentTool}` : t("agents.thinking")}
        </p>
      )}

      {/* 지시문은 언제나 두 줄까지. 전문은 [결과 열기] 팝업이 원문 그대로 보여준다. */}
      <p className="line-clamp-2 text-caption text-ink-muted" title={run.task}>
        {run.task}
      </p>

      {/*
        우측 패널을 좁히면 이 줄이 가장 먼저 눌린다 — flex 항목은 기본이 `shrink` 라
        버튼 폭이 글자 하나만큼 줄고, 그러면 한글이 **한 글자씩 세로로** 선다.
        여기 있는 것은 전부 짧은 라벨이라 줄일 이유가 없다 → `shrink-0` + `nowrap` 으로
        가로를 못 박고, 넘치면 줄을 바꾼다(`flex-wrap`).
      */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
        <button
          className="shrink-0 whitespace-nowrap text-accent hover:underline"
          title={t("agents.openResultHint")}
          onClick={() => setResultOpen(true)}
        >
          {t("agents.openResult")}
        </button>
        {usage && (
          <UsageTag
            usage={usage.usage}
            cost={usage.cost}
            modelId={usage.modelId}
            variant="cost"
            className="shrink-0"
          />
        )}
        <span className="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {active && (
            <button
              className="rounded-sm px-2 py-0.5 whitespace-nowrap text-accent transition-colors hover:bg-hover"
              onClick={() => cancel(run.id)}
            >
              {t("agents.stop")}
            </button>
          )}
          <button
            className="rounded-sm px-2 py-0.5 whitespace-nowrap text-ink-muted transition-colors hover:bg-hover hover:text-error"
            onClick={() => void remove(run.id)}
          >
            {t("common.delete")}
          </button>
        </span>
      </div>

      <AgentResultModal run={resultOpen ? run : null} onClose={() => setResultOpen(false)} />
    </div>
  );
}
