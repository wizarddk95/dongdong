/** 서브에이전트 실행 표시용 공통 값. 대시보드와 트리 노드가 같은 색·문구를 쓴다. */
import { estimateCost, readUsage, type Cost, type Usage } from "@/lib/ai/usage";
import { t, type MessageKey } from "@/lib/i18n";
import type { AgentRun } from "@/types/ipc";

export interface RunStatusStyle {
  /** 문구는 언어에 따라 갈리므로 사전 키만 들고 있는다 — 부르는 쪽이 `t()` 로 편다. */
  labelKey: MessageKey;
  /** 배지 배경/글자색 */
  className: string;
  /** 진행률 바 색 */
  barClassName: string;
}

/**
 * 상태별 색·문구. 뜻은 `label` 이 지고 색은 거들기만 한다 —
 * 크로마틱 액센트는 청록 하나뿐이라 "진행 중"은 액센트로 두고,
 * 끝난 상태만 시맨틱(초록·노랑·빨강)을 꺼내 쓴다.
 */
export const RUN_STATUS_STYLE: Record<string, RunStatusStyle> = {
  pending: {
    labelKey: "agentRun.status.pending",
    className: "bg-surface-2 text-ink-muted",
    barClassName: "bg-surface-3",
  },
  running: {
    labelKey: "agentRun.status.running",
    className: "bg-accent-subtle text-ink",
    barClassName: "bg-accent",
  },
  succeeded: {
    labelKey: "agentRun.status.succeeded",
    className: "bg-success-subtle text-ink",
    barClassName: "bg-success",
  },
  failed: {
    labelKey: "agentRun.status.failed",
    className: "bg-error-subtle text-ink",
    barClassName: "bg-error",
  },
  cancelled: {
    labelKey: "agentRun.status.cancelled",
    className: "bg-warning-subtle text-ink",
    barClassName: "bg-warning",
  },
};

export function runStatusStyle(status: string): RunStatusStyle {
  return RUN_STATUS_STYLE[status] ?? RUN_STATUS_STYLE.pending;
}

export function isRunActive(run: AgentRun): boolean {
  return run.status === "running" || run.status === "pending";
}

/** 시작 시각 기준 경과 시간. 아직 시작 전이면 null. */
export function runDuration(run: AgentRun): string | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return seconds < 60
    ? t("time.seconds", { seconds })
    : t("time.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/** 이 실행이 쓴 토큰과 추정 요금. 아직 토큰을 안 남겼으면 null. */
export function runUsage(run: AgentRun): { usage: Usage; cost: Cost; modelId: string | null } | null {
  const usage = readUsage(run.tokenUsage);
  if (!usage) return null;

  const stored = (run.tokenUsage as { modelId?: unknown } | null)?.modelId;
  const modelId = typeof stored === "string" ? stored : null;
  // 위임 실행 하나 = LLM 호출 여러 번의 합이라 롱컨텍스트 구간은 따지지 않는다.
  return { usage, cost: estimateCost(modelId, usage), modelId };
}
