import { useEffect, useState } from "react";

import { Button } from "@/components/Panel";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import type { McpServerConfig } from "@/types/ipc";

/** 인자는 한 줄에 하나 — 공백이 든 경로를 쪼개지 않기 위해서다. */
function parseLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of parseLines(value)) {
    const separator = line.indexOf("=");
    if (separator > 0) env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return env;
}

const STATE_STYLE: Record<string, { label: string; className: string }> = {
  idle: { label: "미연결", className: "text-zinc-500" },
  connecting: { label: "연결 중…", className: "text-amber-300" },
  connected: { label: "연결됨", className: "text-emerald-400" },
  error: { label: "실패", className: "text-red-400" },
};

/**
 * MCP 서버 목록 관리.
 * 설정 목록은 즉시 settings.json 에 저장하고, 연결/해제는 바로 Rust 로 넘긴다.
 */
export function McpServers() {
  const mcpServers = useSettings((state) => state.mcpServers);
  const update = useSettings((state) => state.update);
  const { servers, status, connect, disconnect, refresh, logs } = useMcp();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", command: "", args: "", env: "" });
  const [logLines, setLogLines] = useState<{ id: string; lines: string[] } | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function persist(next: McpServerConfig[]) {
    await update({ mcpServers: next });
  }

  async function add() {
    const name = draft.name.trim() || draft.command.trim();
    if (!name || !draft.command.trim()) return;

    const config: McpServerConfig = {
      id: crypto.randomUUID(),
      name,
      command: draft.command.trim(),
      args: parseLines(draft.args),
      env: parseEnv(draft.env),
      enabled: true,
    };
    await persist([...mcpServers, config]);
    setDraft({ name: "", command: "", args: "", env: "" });
    setAdding(false);
    await connect(config);
  }

  async function remove(config: McpServerConfig) {
    await disconnect(config.id);
    await persist(mcpServers.filter((server) => server.id !== config.id));
  }

  async function toggleEnabled(config: McpServerConfig, enabled: boolean) {
    await persist(
      mcpServers.map((server) => (server.id === config.id ? { ...server, enabled } : server)),
    );
    if (!enabled) await disconnect(config.id);
  }

  async function showLogs(serverId: string) {
    setLogLines({ id: serverId, lines: await logs(serverId) });
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-zinc-300">MCP 서버</h3>
        <button
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? "취소" : "+ 서버 추가"}
        </button>
      </div>
      <p className="text-[10px] text-zinc-600">
        외부 MCP 서버를 stdio 로 띄워 그 도구를 에이전트에게 함께 넘깁니다. 도구 이름은{" "}
        <code className="text-zinc-500">mcp__서버__도구</code> 형태로 붙습니다.
      </p>

      {adding && (
        <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/60 p-2">
          <div className="grid grid-cols-2 gap-1.5">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="이름 (예: filesystem)"
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600"
            />
            <input
              value={draft.command}
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              placeholder="실행 명령 (예: npx)"
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600"
            />
          </div>
          <textarea
            value={draft.args}
            onChange={(event) => setDraft({ ...draft, args: event.target.value })}
            placeholder={"인자 — 한 줄에 하나\n-y\n@modelcontextprotocol/server-filesystem\nC:/projects"}
            rows={3}
            className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600"
          />
          <textarea
            value={draft.env}
            onChange={(event) => setDraft({ ...draft, env: event.target.value })}
            placeholder={"환경 변수 — KEY=VALUE, 한 줄에 하나 (선택)"}
            rows={2}
            className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600"
          />
          <div className="flex justify-end">
            <Button onClick={() => void add()} disabled={!draft.command.trim()}>
              추가하고 연결
            </Button>
          </div>
        </div>
      )}

      {mcpServers.length === 0 && !adding && (
        <p className="text-[11px] text-zinc-600">등록된 MCP 서버가 없습니다.</p>
      )}

      {mcpServers.map((config) => {
        const state = status[config.id]?.state ?? "idle";
        const style = STATE_STYLE[state];
        const info = servers.find((server) => server.id === config.id);

        return (
          <div key={config.id} className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
            <div className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={config.enabled !== false}
                onChange={(event) => void toggleEnabled(config, event.target.checked)}
                title="앱을 켤 때 자동으로 연결합니다"
              />
              <span className="min-w-0 flex-1 truncate text-zinc-200">{config.name}</span>
              <span className={`shrink-0 text-[10px] ${style.className}`}>{style.label}</span>
              {info && <span className="shrink-0 text-[10px] text-zinc-500">도구 {info.tools.length}개</span>}
            </div>

            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
              {config.command} {(config.args ?? []).join(" ")}
            </p>

            {info && info.tools.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {info.tools.map((tool) => (
                  <span
                    key={tool.name}
                    title={tool.description ?? undefined}
                    className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-400"
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            )}

            {status[config.id]?.error && (
              <p className="mt-1 rounded border border-red-900 bg-red-950/40 px-1.5 py-1 font-mono text-[10px] whitespace-pre-wrap text-red-300">
                {status[config.id].error}
              </p>
            )}

            {logLines?.id === config.id && (
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/40 p-1.5 font-mono text-[10px] whitespace-pre-wrap text-zinc-400">
                {logLines.lines.join("\n") || "(서버 로그 없음)"}
              </pre>
            )}

            <div className="mt-1 flex gap-1">
              {state === "connected" ? (
                <Button onClick={() => void disconnect(config.id)}>끊기</Button>
              ) : (
                <Button onClick={() => void connect(config)} disabled={state === "connecting"}>
                  연결
                </Button>
              )}
              <Button onClick={() => void showLogs(config.id)}>로그</Button>
              <Button variant="danger" className="ml-auto" onClick={() => void remove(config)}>
                삭제
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
