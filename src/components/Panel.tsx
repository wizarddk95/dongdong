import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 모든 작업 영역이 공유하는 패널 껍데기. */
export function Panel({ title, subtitle, actions, children, className = "" }: PanelProps) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 ${className}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold tracking-wide text-zinc-300 uppercase">
            {title}
          </h2>
          {subtitle && <p className="truncate text-[11px] text-zinc-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger";
}

export function Button({ variant = "default", className = "", ...props }: ButtonProps) {
  const variants = {
    default: "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
    primary: "border-emerald-700 bg-emerald-800 text-emerald-50 hover:bg-emerald-700",
    danger: "border-red-900 bg-red-950 text-red-200 hover:bg-red-900",
  } as const;

  return (
    <button
      {...props}
      className={`rounded border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    />
  );
}

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 ${widthClass}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
            {subtitle && <p className="truncate text-[11px] text-zinc-500">{subtitle}</p>}
          </div>
          <button className="shrink-0 text-zinc-500 hover:text-zinc-200" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
