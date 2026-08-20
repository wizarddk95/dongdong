/**
 * 토큰 · 비용 · 컨텍스트 잔량 표시 부품.
 *
 * 채팅 하단, 턴 카드, 세션 카드가 같은 색·같은 문구를 쓰도록 여기 모아 둔다.
 * 계산은 전부 `lib/ai/usage.ts` — 여기서는 그리기만 한다.
 */
import {
  CONTEXT_DANGER_RATIO,
  CONTEXT_WARN_RATIO,
  formatCost,
  formatExact,
  formatTokens,
  formatUsageLine,
  formatUsd,
  hasTokens,
  isLocalModel,
  uncachedInputTokens,
  usageTooltip,
  type ContextLevel,
  type ContextStatus,
  type Cost,
  type Usage,
} from "@/lib/ai/usage";

/**
 * 컨텍스트가 얼마나 찼는지에 따라 바 색이 바뀐다.
 * 여유 구간은 액센트(청록) — 경고·위험만 시맨틱 색을 꺼내 쓴다.
 * 색을 못 읽어도 알 수 있도록 `label` 을 툴팁·수치 옆에 함께 내보낸다.
 */
const LEVEL_STYLE: Record<ContextLevel, { bar: string; text: string; label: string }> = {
  ok: { bar: "bg-accent", text: "text-accent", label: "여유" },
  warn: { bar: "bg-warning", text: "text-ink", label: "주의" },
  danger: { bar: "bg-error", text: "text-error", label: "위험" },
  unknown: { bar: "bg-surface-3", text: "text-ink-muted", label: "미상" },
};

function percent(ratio: number): string {
  // 0.05% 같은 값이 "0%" 로 뭉개지지 않게 작은 값만 소수점을 남긴다.
  return ratio < 0.01 ? `${(ratio * 100).toFixed(1)}%` : `${Math.round(ratio * 100)}%`;
}

function gaugeTooltip(status: ContextStatus, modelId: string | null): string {
  const lines = [
    modelId ? `모델 ${modelId}` : "모델 미상",
    `다음 턴에 다시 실릴 토큰 ${formatExact(status.used)}`,
    `그중 캐시에서 읽히는 몫 ${formatExact(status.cached)}`,
  ];
  if (status.window) {
    lines.push(`컨텍스트 창 ${formatExact(status.window)} · 남은 자리 ${formatExact(status.remaining ?? 0)}`);
    if (status.level === "danger") lines.push("거의 가득 찼습니다 — 새 세션으로 분기하는 게 안전합니다.");
    else if (status.level === "warn") lines.push("여유가 줄고 있습니다.");
  } else {
    lines.push("이 모델의 컨텍스트 창 크기를 몰라 남은 양을 계산할 수 없습니다.");
  }
  lines.push("대화는 매 턴 전체가 다시 올라가므로 누적 합이 아니라 마지막 호출이 기준입니다.");
  return lines.join("\n");
}

interface ContextGaugeProps {
  status: ContextStatus;
  /** 툴팁에 적을 모델 */
  modelId?: string | null;
  /** `bar` 는 막대만, `full` 은 수치까지 (채팅 하단용) */
  variant?: "bar" | "full";
  className?: string;
}

/**
 * 컨텍스트 게이지.
 *
 * 막대는 두 겹이다 — 옅은 칸이 캐시에서 읽히는 몫, 진한 칸이 새로 청구되는 몫.
 * 창 크기를 모르는 모델(로컬 등)은 비율을 그릴 수 없어 수치만 보여준다.
 * 막대는 얇고 양 끝이 둥글다.
 */
export function ContextGauge({
  status,
  modelId = null,
  variant = "bar",
  className = "",
}: ContextGaugeProps) {
  const style = LEVEL_STYLE[status.level];
  const ratio = status.ratio ?? 0;
  // 캐시 몫은 전체 대비 비율로 잘라 같은 막대 안에 겹쳐 그린다.
  const cachedRatio = status.used > 0 ? (status.cached / status.used) * ratio : 0;
  const tooltip = gaugeTooltip(status, modelId);

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`} title={tooltip}>
      {variant === "full" && (
        <div className="flex items-baseline gap-1.5 text-caption">
          <span className="text-ink-muted">컨텍스트</span>
          <span className={style.text}>
            {status.window ? `${percent(ratio)} · ${style.label}` : "창 크기 미상"}
          </span>
          <span className="text-ink-muted">
            {formatExact(status.used)}
            {status.window ? ` / ${formatExact(status.window)}` : " 사용"}
          </span>
          {status.remaining !== null && (
            <span className="ml-auto text-ink-muted">남음 {formatExact(status.remaining)}</span>
          )}
        </div>
      )}

      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        {status.window ? (
          <>
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${style.bar}`}
              style={{ width: `${ratio * 100}%` }}
            />
            {/* 캐시에서 읽히는 몫은 같은 자리에 흐리게 덧칠해 "싼 부분"을 구분한다. */}
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${style.bar} opacity-40`}
              style={{ width: `${cachedRatio * 100}%` }}
            />
            {/* 경고선 — 눈금이 있어야 "얼마나 남았나"가 감으로 읽힌다. */}
            <span
              className="absolute inset-y-0 w-px bg-canvas"
              style={{ left: `${CONTEXT_WARN_RATIO * 100}%` }}
            />
            <span
              className="absolute inset-y-0 w-px bg-canvas"
              style={{ left: `${CONTEXT_DANGER_RATIO * 100}%` }}
            />
          </>
        ) : (
          // 창 크기를 모를 때의 사선 해치 — 비율이 없다는 걸 형태로 말한다.
          <div className="absolute inset-y-0 left-0 w-full [background-image:repeating-linear-gradient(45deg,var(--color-surface-3)_0,var(--color-surface-3)_4px,transparent_4px,transparent_8px)]" />
        )}
      </div>
    </div>
  );
}

interface UsageTagProps {
  usage: Usage;
  cost: Cost;
  modelId: string | null;
  /** `full` 은 토큰 내역까지, `cost` 는 금액만 */
  variant?: "full" | "cost";
  className?: string;
}

/** 토큰·요금 한 줄. 마우스를 올리면 항목별 내역이 뜬다. */
export function UsageTag({
  usage,
  cost,
  modelId,
  variant = "full",
  className = "",
}: UsageTagProps) {
  if (!hasTokens(usage)) return null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-caption tabular-nums ${className}`}
      title={usageTooltip(usage, cost, modelId)}
    >
      {variant === "full" && <span className="text-ink-subtle">{formatUsageLine(usage)}</span>}
      <span className="text-ink-muted">{formatCost(cost, modelId)}</span>
    </span>
  );
}

interface UsageBreakdownProps {
  usage: Usage;
  cost: Cost;
  modelId: string | null;
  /** LLM 호출 수 (세션 합계에만 있다) */
  calls?: number;
}

/** 항목별 토큰 내역 표 — 채팅 하단 펼침에 쓴다. */
export function UsageBreakdown({ usage, cost, modelId, calls }: UsageBreakdownProps) {
  const rows: { label: string; tokens: number; cost: number }[] = [
    { label: "입력 (신규)", tokens: uncachedInputTokens(usage), cost: cost.input },
    { label: "입력 (캐시 읽기)", tokens: usage.cacheReadTokens, cost: cost.cacheRead },
    { label: "입력 (캐시 쓰기)", tokens: usage.cacheWriteTokens, cost: cost.cacheWrite },
    { label: "출력", tokens: usage.outputTokens, cost: cost.output },
  ];

  return (
    <div className="rounded-md border border-hairline bg-surface-1 px-3 py-2.5 text-caption">
      <div className="mb-1.5 flex items-center gap-2 text-ink-muted">
        <span>{modelId ?? "모델 미상"}</span>
        {calls !== undefined && <span>· LLM 호출 {calls}회</span>}
        <span className="ml-auto text-ink">{formatCost(cost, modelId)}</span>
      </div>

      <table className="w-full tabular-nums">
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className={`border-t border-hairline ${row.tokens === 0 ? "text-ink-subtle" : "text-ink-muted"}`}
            >
              <td className="py-1">{row.label}</td>
              <td className="py-1 text-right">{formatExact(row.tokens)}</td>
              <td className="w-16 py-1 text-right">
                {cost.unpriced || isLocalModel(modelId) ? "—" : formatUsd(row.cost)}
              </td>
            </tr>
          ))}
          {usage.reasoningTokens > 0 && (
            <tr className="border-t border-hairline text-ink-subtle">
              <td className="py-1">└ 그중 사고</td>
              <td className="py-1 text-right">{formatExact(usage.reasoningTokens)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>

      {cost.longContext && (
        <p className="mt-1.5 border-l-2 border-warning pl-2 text-ink">
          롱컨텍스트 구간 요율이 적용된 호출이 있습니다.
        </p>
      )}
      {cost.underestimated && (
        <p className="mt-1.5 border-l-2 border-warning pl-2 text-ink">
          요율을 모르는 항목이 있어 실제보다 적게 잡혔습니다.
        </p>
      )}
    </div>
  );
}

/** 카드 구석에 넣는 아주 짧은 토큰 표시 (`↑12K ↓1.2K`). */
export function CompactTokens({ usage, className = "" }: { usage: Usage; className?: string }) {
  if (!hasTokens(usage)) return null;
  return (
    <span className={`whitespace-nowrap tabular-nums ${className}`}>
      ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)}
    </span>
  );
}
