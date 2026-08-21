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
  formatModelLabel,
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
 * 컨텍스트가 얼마나 찼는지에 따라 링 색이 바뀐다.
 * 여유 구간은 액센트(청록) — 경고·위험만 시맨틱 색을 꺼내 쓴다.
 * 색을 못 읽어도 알 수 있도록 `label` 을 툴팁·수치 옆에 함께 내보낸다.
 */
const LEVEL_STYLE: Record<ContextLevel, { ring: string; text: string; label: string }> = {
  ok: { ring: "stroke-accent", text: "text-accent", label: "여유" },
  warn: { ring: "stroke-warning", text: "text-ink", label: "주의" },
  danger: { ring: "stroke-error", text: "text-error", label: "위험" },
  unknown: { ring: "stroke-surface-3", text: "text-ink-muted", label: "미상" },
};

function percent(ratio: number): string {
  // 0.05% 같은 값이 "0%" 로 뭉개지지 않게 작은 값만 소수점을 남긴다.
  return ratio < 0.01 ? `${(ratio * 100).toFixed(1)}%` : `${Math.round(ratio * 100)}%`;
}

/** `+1,230` / `-820` — 부호를 붙여야 늘었는지 줄었는지가 한눈에 보인다. */
function signed(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatExact(Math.abs(value))}`;
}

function gaugeTooltip(status: ContextStatus): string {
  const lines = [
    `다음 턴에 쓸 모델 ${status.modelId ?? "미상"}`,
    // "이 노드 하나" 로 오해되기 쉬운 자리다. 무엇을 센 수인지 먼저 못 박는다.
    `지금 [전송]을 누르면 나갈 양 ${status.estimated || status.approximate ? "약 " : ""}${formatExact(status.used)} 토큰`,
    "(대화 전체가 매 턴 다시 올라간다 — 노드 하나의 몫이 아니다)",
  ];

  if (status.chars !== null) {
    lines.push(
      `그 페이로드: 메시지 ${status.messageCount}개 · ${formatExact(status.chars)}자`,
      "[현재 컨텍스트 보기] 가 보여 주는 바로 그 페이로드다 — 두 화면의 수가 같다.",
    );
  }

  if (status.estimated) {
    lines.push(
      `실측 ${formatExact(status.measuredTokens)} ${signed(status.projectedTokens)} 환산`,
      `= 마지막 호출은 공급자가 정확히 셌고, 그 뒤 늘거나 준 만큼만 이 대화의 실측 비율(${status.charsPerToken?.toFixed(2)}자/토큰)로 환산했습니다.`,
    );
  } else if (status.charsPerToken !== null) {
    lines.push("마지막 호출 이후 달라진 것이 없어 실측값 그대로입니다.");
  }

  lines.push(`그중 캐시에서 읽히는 몫 ${formatExact(status.cached)}`);
  if (status.window) {
    lines.push(
      `컨텍스트 창 ${formatExact(status.window)} · 남은 자리 ${formatExact(status.remaining ?? 0)}`,
    );
    if (status.level === "danger") lines.push("거의 가득 찼습니다 — 새 세션으로 분기하는 게 안전합니다.");
    else if (status.level === "warn") lines.push("여유가 줄고 있습니다.");
  } else {
    lines.push("이 모델의 컨텍스트 창 크기를 몰라 남은 양을 계산할 수 없습니다.");
  }
  lines.push("입력창에 쓰는 중인 글은 아직 안 셉니다 — 보내는 순간 더해집니다.");
  // 모델을 막 바꿨을 때. 값을 보정하지 않고 "다른 자로 잰 값" 이라고만 말한다.
  if (status.approximate) {
    lines.push(
      `이 수는 ${status.measuredModelId} 가 센 값입니다 — 토크나이저가 달라 실제로는 조금 어긋납니다.`,
      "선택한 모델로 한 턴만 돌리면 실측값으로 바뀝니다.",
    );
  }
  return lines.join("\n");
}

/**
 * 링 위 `ratio` 지점을 가로지르는 눈금 선분.
 *
 * 각도는 SVG 기본 방향(3시에서 시계 방향)으로 잰다 — 호도 `strokeDashoffset` 로
 * 같은 자리에서 시작하고, 12시로 돌리는 일은 svg 에 건 `-rotate-90` 이 한꺼번에 한다.
 * 여기서 또 90도를 빼면 눈금만 어긋난다.
 */
function tick(ratio: number, radius: number, center: number, length: number) {
  const angle = ratio * 360 * (Math.PI / 180);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x1: center + cos * (radius - length / 2),
    y1: center + sin * (radius - length / 2),
    x2: center + cos * (radius + length / 2),
    y2: center + sin * (radius + length / 2),
  };
}

interface ContextRingProps {
  status: ContextStatus;
  /** 링 지름(px) */
  size?: number;
  /** `ring` 은 링만, `full` 은 옆에 수치까지 (채팅 입력칸 위) */
  variant?: "ring" | "full";
  className?: string;
}

/**
 * 컨텍스트 게이지 — 원형.
 *
 * 막대와 달리 자리를 가로로 먹지 않아 카드 구석과 입력칸 위에 같은 모양으로 놓을 수 있다.
 * 12시에서 시계 방향으로 채우고, 호는 두 도막이다 — 옅은 쪽이 캐시에서 읽히는 몫,
 * 진한 쪽이 새로 청구되는 몫. 겹쳐 그리면 같은 색이라 구분이 사라지므로 이어 붙인다.
 * 주의·위험 문턱 자리에는 눈금을 새겨 "얼마나 남았나" 를 각도만으로 읽게 한다.
 * 창 크기를 모르는 모델(로컬 등)은 비율이 없어 점선 링으로만 둔다.
 */
export function ContextRing({
  status,
  size = 28,
  variant = "ring",
  className = "",
}: ContextRingProps) {
  const style = LEVEL_STYLE[status.level];
  const ratio = status.ratio ?? 0;
  const cachedRatio = status.used > 0 ? (status.cached / status.used) * ratio : 0;
  const tooltip = gaugeTooltip(status);

  // 좌표계는 100 짜리 정사각형으로 고정하고 화면 크기만 바꾼다 — 굵기가 같이 커진다.
  const stroke = 12;
  const center = 50;
  const radius = center - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const arc = (from: number, to: number) => ({
    strokeDasharray: `${Math.max(0, to - from) * circumference} ${circumference}`,
    strokeDashoffset: -from * circumference,
  });

  const ring = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="shrink-0 -rotate-90"
      role="img"
      aria-label={`컨텍스트 ${status.window ? percent(ratio) : "미상"}`}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className={status.window ? "stroke-surface-2" : "stroke-surface-3"}
        {...(status.window ? {} : { strokeDasharray: "6 8", strokeLinecap: "round" as const })}
      />
      {status.window && (
        <>
          {/* 캐시에서 읽히는 몫 — 같은 색을 옅게. 진한 쪽과 이어 붙여 그린다. */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className={`${style.ring} opacity-40`}
            {...arc(0, cachedRatio)}
          />
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className={style.ring}
            {...arc(cachedRatio, ratio)}
          />
          {[CONTEXT_WARN_RATIO, CONTEXT_DANGER_RATIO].map((mark) => (
            <line
              key={mark}
              {...tick(mark, radius, center, stroke)}
              strokeWidth={2}
              className="stroke-canvas"
            />
          ))}
        </>
      )}
    </svg>
  );

  if (variant === "ring") {
    return (
      <span className={`inline-flex ${className}`} title={tooltip}>
        {ring}
      </span>
    );
  }

  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${className}`} title={tooltip}>
      {ring}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5 text-caption">
          {/* "다음 턴에 나갈 양" 을 적어 두지 않으면 마지막 노드 하나의 몫으로 읽힌다.
              자 수는 토큰과 자가 달라 나란히 두면 오히려 헷갈려서 툴팁으로만 남긴다
              (인스펙터와 대조할 값은 툴팁에 그대로 있다). */}
          <span className="text-ink-muted">다음 턴에 나갈 양</span>
          {status.chars !== null && (
            <span className="tabular-nums text-ink-subtle">메시지 {status.messageCount}개</span>
          )}
          <span className={`ml-auto ${style.text}`}>
            {status.window ? `${percent(ratio)} · ${style.label}` : "창 크기 미상"}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 text-caption tabular-nums text-ink-muted">
          <span>
            {/* 환산분이 섞였거나 다른 모델이 센 값이면 같다고 말하지 않는다. */}
            {(status.estimated || status.approximate) && "≈"}
            {formatExact(status.used)}
            {status.window ? ` / ${formatExact(status.window)}` : " 사용"}
            <span className="text-ink-subtle"> 토큰</span>
          </span>
        </div>
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
  /** 모델 이름을 앞에 적는다 — 한 세션에 여러 모델이 섞이는 자리(말풍선)용 */
  showModel?: boolean;
  className?: string;
}

/** 토큰·요금 한 줄. 마우스를 올리면 항목별 내역이 뜬다. */
export function UsageTag({
  usage,
  cost,
  modelId,
  variant = "full",
  showModel = false,
  className = "",
}: UsageTagProps) {
  if (!hasTokens(usage)) return null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-caption tabular-nums ${className}`}
      title={usageTooltip(usage, cost, modelId)}
    >
      {/* 어느 모델이 낸 값인지 — 요금은 이 모델의 요율로 계산된다. */}
      {showModel && <span className="text-ink-subtle">{formatModelLabel(modelId)}</span>}
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
