/**
 * 렌더 중 예외를 잡아 화면을 지키는 마지막 방어선.
 *
 * React 19 는 렌더에서 예외가 나면 루트를 통째로 언마운트한다 —
 * 데스크톱 앱에서는 창이 새까매져서 "앱이 꺼진" 것처럼 보인다.
 * 여기서 잡아 두면 최소한 무엇이 터졌는지 보이고, 다시 그리기를 시도할 수 있다.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { t } from "@/lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 개발 중에는 콘솔에 컴포넌트 스택까지 남겨 둔다.
    console.error("[dongdong] render error", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    /*
     * 이 화면은 앱의 스타일 시트가 살아 있다는 보장이 없다 —
     * 그래도 토큰은 CSS 변수라 `index.css` 만 붙어 있으면 테마를 따라간다.
     */
    return (
      <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas p-8 text-ink">
        <h1 className="text-headline text-ink">{t("errorBoundary.title")}</h1>
        <p className="text-body-sm text-ink-muted">{t("errorBoundary.body")}</p>
        <pre className="max-h-40 overflow-auto rounded-md border-l-2 border-error bg-error-subtle p-3 font-mono text-caption whitespace-pre-wrap text-ink">
          {error.message}
        </pre>
        {stack && (
          <pre className="max-h-60 overflow-auto rounded-md border border-hairline bg-surface-1 p-3 font-mono text-caption whitespace-pre-wrap text-ink-muted">
            {stack}
          </pre>
        )}
        <div>
          <button
            className="rounded-sm bg-primary px-4 py-2.5 text-button font-medium text-on-primary transition-colors hover:bg-primary-hover"
            onClick={() => this.setState({ error: null, stack: null })}
          >
            {t("errorBoundary.retry")}
          </button>
        </div>
      </div>
    );
  }
}
