/** 서브에이전트 실행 표시용 공통 값. 대시보드와 트리 노드가 같은 색·문구를 쓴다. */
import { estimateCost, readUsage, type Cost, type Usage } from "@/lib/ai/usage";
import type { AgentRun } from "@/types/ipc";

export interface RunStatusStyle {
  label: string;
  /** 배지 배경/글자색 */
  className: string;
  /** 진행률 바 색 */
  barClassName: string;
}

export const RUN_STATUS_STYLE: Record<string, RunStatusStyle> = {
  pending: {
    label: "대기",
    className: "bg-zinc-800 text-zinc-300",
    barClassName: "bg-emerald-600",
  },
  running: {
    label: "실행 중",
    className: "bg-emerald-950 text-emerald-300",
    barClassName: "bg-emerald-600",
  },
  succeeded: {
    label: "성공",
    className: "bg-sky-950 text-sky-300",
    barClassName: "bg-sky-600",
  },
  failed: { label: "실패", className: "bg-red-950 text-red-300", barClassName: "bg-red-700" },
  cancelled: {
    label: "취소",
    className: "bg-amber-950 text-amber-300",
    barClassName: "bg-red-700",
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
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
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
