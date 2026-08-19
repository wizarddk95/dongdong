import { useEffect, useState } from "react";

import { AgentDashboard } from "@/components/agents/AgentDashboard";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { FileExplorer } from "@/components/FileExplorer";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsModal } from "@/components/SettingsModal";
import { ShellConsole } from "@/components/ShellConsole";
import { TopBar } from "@/components/TopBar";
import { useAgents } from "@/store/agents";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

type RightTab = "tree" | "agents" | "files" | "shell";

const TABS: { id: RightTab; label: string }[] = [
  { id: "tree", label: "대화 트리" },
  { id: "agents", label: "서브에이전트" },
  { id: "files", label: "파일" },
  { id: "shell", label: "쉘" },
];

export default function App() {
  const bootstrap = useWorkspace((state) => state.bootstrap);
  const error = useWorkspace((state) => state.error);
  const setError = useWorkspace((state) => state.setError);
  const loadSettings = useSettings((state) => state.load);
  // 실행 중인 서브에이전트 수는 탭에 배지로 띄운다 (다른 탭을 보고 있어도 보이게).
  const activeAgents = useAgents((state) =>
    state.runs.filter((run) => run.status === "running" || run.status === "pending").length,
  );

  const project = useWorkspace((state) => state.project);
  const settingsLoaded = useSettings((state) => state.loaded);
  const connectMcp = useMcp((state) => state.connectEnabled);

  const [tab, setTab] = useState<RightTab>("tree");
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
    void loadSettings();
  }, [bootstrap, loadSettings]);

  // MCP 서버는 설정을 읽은 뒤에 띄운다. cwd 기본값이 프로젝트 루트라 폴더를 열면 다시 시도한다.
  useEffect(() => {
    if (!settingsLoaded) return;
    void connectMcp();
  }, [settingsLoaded, project?.rootPath, connectMcp]);

  return (
    <div className="flex h-full flex-col">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-900 bg-red-950/60 px-4 py-2 text-xs text-red-200">
          <span className="flex-1 font-mono break-all">{error}</span>
          <button className="shrink-0 text-red-300 hover:text-red-100" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        <SessionSidebar />

        {/* 좌: 챗봇 UI */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-zinc-800">
          <ChatPanel />
        </section>

        {/* 우: 노드 트리 시각화 (+ Phase 1 도구들) */}
        <section className="flex min-h-0 w-[46%] min-w-[380px] flex-col">
          <nav className="flex shrink-0 gap-1 border-b border-zinc-800 px-2 py-1.5">
            {TABS.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`rounded px-2 py-1 text-[11px] transition-colors ${
                  tab === item.id
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                }`}
              >
                {item.label}
                {item.id === "agents" && activeAgents > 0 && (
                  <span className="ml-1 rounded bg-emerald-900 px-1 text-[10px] text-emerald-200">
                    {activeAgents}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1">
            {tab === "tree" && <FlowCanvas />}
            {tab === "agents" && <AgentDashboard />}
            {tab === "files" && (
              <div className="h-full overflow-auto p-2">
                <FileExplorer />
              </div>
            )}
            {tab === "shell" && (
              <div className="flex h-full flex-col p-2">
                <ShellConsole />
              </div>
            )}
          </div>
        </section>
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
