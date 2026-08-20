import { useState } from "react";

import { Button, FIELD_SM, Panel, SELECT_SM } from "@/components/Panel";
import * as ipc from "@/lib/ipc";
import { useWorkspace } from "@/store/workspace";
import type { ShellKind, ShellResult } from "@/types/ipc";

const SHELLS: ShellKind[] = ["auto", "cmd", "powershell", "pwsh", "bash", "sh", "zsh"];

/** execute_shell_command IPC 콘솔. OS 분기와 타임아웃 동작을 여기서 확인한다. */
export function ShellConsole() {
  const system = useWorkspace((state) => state.system);
  const project = useWorkspace((state) => state.project);

  const [command, setCommand] = useState("");
  const [shell, setShell] = useState<ShellKind>("auto");
  const [history, setHistory] = useState<ShellResult[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    const trimmed = command.trim();
    if (!trimmed || running) return;

    setRunning(true);
    try {
      const result = await ipc.executeShellCommand(trimmed, { shell, timeoutMs: 120_000 });
      setHistory((previous) => [result, ...previous].slice(0, 50));
      setCommand("");
    } catch (error) {
      setHistory((previous) => [
        {
          command: trimmed,
          shell,
          cwd: "",
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: null,
          success: false,
          timedOut: false,
          cancelled: false,
          truncated: false,
          durationMs: 0,
        },
        ...previous,
      ]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Panel
      title="쉘 콘솔"
      subtitle={
        project
          ? `cwd: ${project.rootPath}`
          : `프로젝트 미선택 — 앱 실행 위치(${system?.cwd ?? "?"})에서 실행됩니다`
      }
      className="flex-1"
      actions={
        <select
          value={shell}
          onChange={(event) => setShell(event.target.value as ShellKind)}
          className={`${SELECT_SM} w-auto`}
        >
          {SHELLS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline p-2">
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run();
            }}
            placeholder={system?.os === "windows" ? "예: dir" : "예: ls -la"}
            className={`${FIELD_SM} flex-1 font-mono`}
          />
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? "실행 중…" : "실행"}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-caption">
          {history.map((result, index) => (
            <div
              key={index}
              // 왼쪽 2px 룰이 성공/실패를 말한다 — 글자에도 ✓/✗ 를 남겨 색 없이 읽히게 한다.
              className={`mb-4 border-l-2 pl-3 ${result.success ? "border-success" : "border-error"}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-ink-muted">
                <span className={result.success ? "text-success" : "text-error"}>
                  {result.success ? "✓" : "✗"} exit {result.exitCode ?? "—"}
                </span>
                <span>{result.durationMs}ms</span>
                <span>{result.shell}</span>
                {result.timedOut && <span className="text-warning">timeout</span>}
                {result.truncated && <span className="text-warning">truncated</span>}
              </div>
              <div className="text-ink-muted">$ {result.command}</div>
              {result.stdout && (
                <pre className="whitespace-pre-wrap break-words text-ink">{result.stdout}</pre>
              )}
              {result.stderr && (
                <pre className="whitespace-pre-wrap break-words text-error">{result.stderr}</pre>
              )}
            </div>
          ))}
          {history.length === 0 && (
            <p className="p-2 text-ink-subtle">명령을 실행하면 결과가 여기에 쌓입니다.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
