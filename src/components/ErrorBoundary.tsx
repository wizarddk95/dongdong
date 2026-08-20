/**
 * 렌더 중 예외를 잡아 화면을 지키는 마지막 방어선.
 *
 * React 19 는 렌더에서 예외가 나면 루트를 통째로 언마운트한다 —
 * 데스크톱 앱에서는 창이 새까매져서 "앱이 꺼진" 것처럼 보인다.
 * 여기서 잡아 두면 최소한 무엇이 터졌는지 보이고, 다시 그리기를 시도할 수 있다.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

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
    console.error("[dongdong] 렌더 오류", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col gap-3 overflow-auto bg-zinc-950 p-6 text-zinc-200">
        <h1 className="text-sm font-semibold text-red-300">화면을 그리다가 오류가 났습니다</h1>
        <p className="text-xs text-zinc-400">
          작업 내용은 DB 에 그대로 있습니다. 아래 내용을 남겨 두고 다시 시도하세요.
        </p>
        <pre className="max-h-40 overflow-auto rounded border border-red-900 bg-red-950/30 p-2 text-[11px] whitespace-pre-wrap text-red-200">
          {error.message}
        </pre>
        {stack && (
          <pre className="max-h-60 overflow-auto rounded border border-zinc-800 bg-black/40 p-2 text-[10px] whitespace-pre-wrap text-zinc-500">
            {stack}
          </pre>
        )}
        <div>
          <button
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
            onClick={() => this.setState({ error: null, stack: null })}
          >
            다시 그리기
          </button>
        </div>
      </div>
    );
  }
}
