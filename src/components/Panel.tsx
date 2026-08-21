/**
 * 공통 부품 — 버튼 · 타일(패널) · 모달 · 입력 크롬 · 태그.
 *
 * 화면 전체가 같은 규칙을 쓰도록 여기 모아 둔다. 새 UI 를 붙일 때는
 * 색·모서리·패딩을 손으로 적지 말고 여기서 가져다 쓴다.
 * 모서리 규칙은 `index.css` 그대로 — 칩 xs · 버튼/입력 sm · 패널 md · 모달 lg.
 */
import type { ReactNode } from "react";

/* ─────────────────────────── 입력 크롬 ───────────────────────────
 * 사방을 두른 1px 테두리 + 둥근 모서리. 포커스는 전역 `:focus-visible` 링이 받고,
 * 여기서는 테두리만 액센트로 옮겨 두 겹이 겹쳐 보이지 않게 한다.
 */
const FIELD_BASE =
  "w-full border border-field-rule bg-field text-ink transition-colors placeholder:text-ink-subtle hover:border-ink-subtle focus:border-accent disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-1 disabled:text-ink-disabled";

/** 40px 높이. 폼 본문용. */
export const FIELD = `${FIELD_BASE} rounded-sm px-3.5 py-2.5 text-body-sm`;

/** 32px 높이. 툴바·인라인용. 밀도 높은 자리에 쓴다. */
export const FIELD_SM = `${FIELD_BASE} rounded-sm px-3 py-1.5 text-caption`;

/** 셀렉트는 네이티브 화살표 자리를 오른쪽에 비워 둔다. */
export const SELECT = `${FIELD} pr-8`;
export const SELECT_SM = `${FIELD_SM} pr-7`;

/* ─────────────────────────── 버튼 ─────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

/**
 * 버튼 다섯 종.
 *  - primary   청록 채움. 화면당 하나가 원칙이다.
 *  - secondary 잉크 채움. primary 옆에 서는 짝.
 *  - tertiary  옅은 면 + 1px 테두리. 기본 버튼으로 가장 많이 쓴다.
 *  - ghost     배경 없음. 툴바에 여러 개가 늘어설 때.
 *  - danger    파괴적 동작 전용.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active",
  secondary: "bg-ink text-canvas hover:bg-ink-muted",
  tertiary:
    "border border-hairline bg-surface-1 text-ink hover:border-field-rule hover:bg-hover active:bg-selected",
  ghost: "bg-transparent text-ink-muted hover:bg-hover hover:text-ink",
  danger: "bg-error text-canvas hover:bg-error-hover",
};

/** 높이 — sm 32px(툴바) · md 40px(폼). */
const SIZES: Record<ButtonSize, string> = {
  sm: "rounded-sm px-3 py-1.5 text-caption",
  md: "rounded-sm px-4 py-2.5 text-button",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "tertiary",
  size = "sm",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:border-transparent disabled:bg-surface-1 disabled:text-ink-disabled disabled:hover:bg-surface-1 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    />
  );
}

/* ─────────────────────────── 타일 · 태그 ─────────────────────────── */

interface PanelProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 모든 작업 영역이 공유하는 패널 껍데기 — 둥근 타일이 아주 옅게 떠 있다. */
export function Panel({ title, subtitle, actions, children, className = "" }: PanelProps) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-canvas elevate ${className}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-body-emphasis text-ink">{title}</h2>
          {subtitle && <p className="truncate text-caption text-ink-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export type TagTone = "neutral" | "accent" | "success" | "warning" | "error";

const TAG_TONES: Record<TagTone, string> = {
  neutral: "bg-surface-2 text-ink-muted",
  accent: "bg-accent-subtle text-ink",
  success: "bg-success-subtle text-ink",
  warning: "bg-warning-subtle text-ink",
  error: "bg-error-subtle text-ink",
};

/**
 * 상태 태그 — 알약 모양. 뜻은 색이 아니라 글자가 지고 색은 거들기만 한다
 * (색맹·흑백 출력에서도 읽혀야 한다). 옅은 면 위의 글자는 언제나 잉크색이다 —
 * 같은 계열의 색 글자를 얹으면 라이트/다크 어느 한쪽에서 반드시 대비가 무너진다.
 */
export function Tag({
  tone = "neutral",
  className = "",
  children,
  title,
}: {
  tone?: TagTone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption ${TAG_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ─────────────────────────── 설명 배지 ─────────────────────────── */

/**
 * `?` 배지 — 커서를 올리거나 키보드 포커스를 주면 설명이 뜬다.
 *
 * 라벨 옆에 붙여 **긴 설명을 접어 둔다**. 화면에 늘 펼쳐 두면 정작 조작할 컨트롤이
 * 문단에 파묻히고, 그렇다고 지우면 처음 보는 사람이 뭘 고르는지 모른다.
 *
 * 네이티브 `title` 을 안 쓰는 이유: 뜨는 데 1초쯤 걸리고 줄바꿈·색·위치가 전부 OS 몫이라
 * 화면과 따로 논다(다크 테마에서 특히). 대신 JS 없이 CSS 만으로 연다 — 상태도 리렌더도 없다.
 *
 * `align` 은 말풍선이 나갈 방향이다. 오른쪽 열에 있는 배지는 `right` 로 둬야
 * 말풍선이 모달 밖으로 삐져나가지 않는다.
 */
export function Hint({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    // 그룹에 이름을 붙인다 — 바깥에 `group` 이 또 있으면(카드 등) 그걸 스쳐도 열린다.
    <span className={`group/hint relative inline-flex align-middle ${className}`}>
      <span
        tabIndex={0}
        role="button"
        aria-label="설명 보기"
        // `<label>` 안에 있으면 클릭이 라벨의 컨트롤로 넘어간다(셀렉트가 열린다) → 막는다.
        onClick={(event) => event.preventDefault()}
        className="flex size-4 cursor-help items-center justify-center rounded-full border border-hairline bg-surface-1 text-caption leading-none text-ink-muted transition-colors group-hover/hint:border-accent group-hover/hint:text-accent"
      >
        ?
      </span>
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute top-full z-50 mt-1.5 w-60 rounded-md border border-hairline bg-canvas px-3 py-2 text-caption text-ink-muted opacity-0 transition-opacity elevate-lg group-hover/hint:visible group-hover/hint:opacity-100 group-focus-within/hint:visible group-focus-within/hint:opacity-100 ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/* ─────────────────────────── 모달 ─────────────────────────── */

interface ModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  /** 기본 max-w-lg. 인스펙터처럼 넓게 봐야 하는 모달은 늘린다. */
  widthClass?: string;
}

/** 인스펙터 계열 모달의 공통 껍데기. */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  footer,
  children,
  widthClass = "max-w-lg",
}: ModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-hairline bg-canvas elevate-lg ${widthClass}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-card-title text-ink">{title}</h2>
            {subtitle && <p className="truncate text-caption text-ink-muted">{subtitle}</p>}
          </div>
          <button
            className="-mt-1 -mr-1 shrink-0 rounded-sm px-2 py-1 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            title="닫기"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
