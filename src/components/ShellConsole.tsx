import { useState } from "react";

import { Button, Panel } from "@/components/Panel";
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
          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200"
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
        <div className="flex shrink-0 gap-2 border-b border-zinc-800 p-2">
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void run();
            }}
            placeholder={system?.os === "windows" ? "예: dir" : "예: ls -la"}
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600"
          />
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? "실행 중…" : "실행"}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">
          {history.map((result, index) => (
            <div key={index} className="mb-3 border-l-2 border-zinc-700 pl-2">
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                <span className={result.success ? "text-emerald-400" : "text-red-400"}>
                  {result.success ? "✓" : "✗"} exit {result.exitCode ?? "—"}
                </span>
                <span>{result.durationMs}ms</span>
                <span>{result.shell}</span>
                {result.timedOut && <span className="text-amber-400">timeout</span>}
                {result.truncated && <span className="text-amber-400">truncated</span>}
              </div>
              <div className="text-zinc-400">$ {result.command}</div>
              {result.stdout && (
                <pre className="whitespace-pre-wrap break-words text-zinc-200">{result.stdout}</pre>
              )}
              {result.stderr && (
                <pre className="whitespace-pre-wrap break-words text-red-300">{result.stderr}</pre>
              )}
            </div>
          ))}
          {history.length === 0 && (
            <p className="p-2 text-zinc-600">명령을 실행하면 결과가 여기에 쌓입니다.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
