import { useCallback, useEffect, useRef, useState } from "react";

import { AgentDashboard } from "@/components/agents/AgentDashboard";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { FileExplorer } from "@/components/FileExplorer";
import { FlowCanvas } from "@/components/flow/FlowCanvas";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsModal } from "@/components/SettingsModal";
import { ShellConsole } from "@/components/ShellConsole";
import { TopBar } from "@/components/TopBar";
import {
  SIDEBAR_DEFAULT,
  clampRightWidth,
  clampSidebarWidth,
  defaultRightWidth,
} from "@/lib/panelSize";
import { applyTheme, watchSystemTheme } from "@/lib/theme";
import { useAgents } from "@/store/agents";
import { useChat } from "@/store/chat";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/useT";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useSkills } from "@/store/skills";
import { useWorkspace } from "@/store/workspace";

type RightTab = "tree" | "agents" | "files" | "shell";

const TABS: { id: RightTab; labelKey: MessageKey }[] = [
  { id: "tree", labelKey: "app.tab.tree" },
  { id: "agents", labelKey: "app.tab.agents" },
  { id: "files", labelKey: "app.tab.files" },
  { id: "shell", labelKey: "app.tab.shell" },
];

export default function App() {
  const t = useT();
  const bootstrap = useWorkspace((state) => state.bootstrap);
  const error = useWorkspace((state) => state.error);
  const setError = useWorkspace((state) => state.setError);
  const loadSettings = useSettings((state) => state.load);
  // 실행 중인 서브에이전트 수는 탭에 배지로 띄운다 (다른 탭을 보고 있어도 보이게).
  const activeAgents = useAgents((state) =>
    state.runs.filter((run) => run.status === "running" || run.status === "pending").length,
  );

  const project = useWorkspace((state) => state.project);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const refreshSessions = useWorkspace((state) => state.refreshSessions);
  const refreshAgents = useAgents((state) => state.refresh);
  // 턴이 끝나면 사이드바의 집계(노드 수·비용)를 다시 읽는다.
  const running = useChat((state) => state.running);
  const settingsLoaded = useSettings((state) => state.loaded);
  const theme = useSettings((state) => state.theme);
  const connectMcp = useMcp((state) => state.connectEnabled);
  // 스킬 문서는 프로젝트마다 다르다(.dongdong/skills) → 폴더를 열 때 다시 읽는다.
  const refreshSkills = useSkills((state) => state.refresh);

  const [tab, setTab] = useState<RightTab>("tree");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 채팅 ↔ 우측 패널 분할. null 이면 아직 폭을 모른다는 뜻이라 기본 비율로 잡는다.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  // 세션 목록도 같은 방식으로 늘린다. 이쪽은 창 기준이라 기본값을 바로 안다.
  const mainRef = useRef<HTMLElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  /** 지금 끌고 있는 분할선. 둘이 동시에 끌리는 일은 없다. */
  const [dragging, setDragging] = useState<"sidebar" | "right" | null>(null);

  // 컨테이너가 생기거나 창 크기가 바뀌면 폭을 다시 범위 안으로 넣는다.
  const fitToContainer = useCallback(() => {
    setSidebarWidth((current) => clampSidebarWidth(current, window.innerWidth));
    const box = splitRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setRightWidth((current) =>
      current === null ? defaultRightWidth(box.width) : clampRightWidth(current, box.width),
    );
  }, []);

  useEffect(() => {
    fitToContainer();
    window.addEventListener("resize", fitToContainer);
    return () => window.removeEventListener("resize", fitToContainer);
  }, [fitToContainer]);

  // 드래그 중에는 커서가 패널 밖으로 나가도 따라오도록 window 에 건다.
  useEffect(() => {
    if (!dragging) return;

    function onMove(event: PointerEvent) {
      if (dragging === "sidebar") {
        const left = mainRef.current?.getBoundingClientRect().left ?? 0;
        setSidebarWidth(clampSidebarWidth(event.clientX - left, window.innerWidth));
        return;
      }
      const box = splitRef.current?.getBoundingClientRect();
      if (!box) return;
      setRightWidth(clampRightWidth(box.right - event.clientX, box.width));
    }
    function onUp() {
      setDragging(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    void bootstrap();
    void loadSettings();
  }, [bootstrap, loadSettings]);

  // "시스템 설정" 을 고른 사용자는 OS 가 밤낮을 바꿀 때 앱도 같이 따라가야 한다.
  useEffect(() => watchSystemTheme(() => applyTheme(theme)), [theme]);

  // 집계는 DB 를 다시 읽어야 갱신된다 — 프로젝트를 열 때와 턴이 끝날 때 맞춘다.
  useEffect(() => {
    if (!running) void refreshSessions();
  }, [running, refreshSessions, project?.rootPath]);

  // 서브에이전트 기록은 트리 노드에도 그려지므로 탭과 무관하게 세션마다 읽어 둔다.
  useEffect(() => {
    void refreshAgents();
  }, [activeSessionId, refreshAgents]);

  // MCP 서버는 설정을 읽은 뒤에 띄운다. cwd 기본값이 프로젝트 루트라 폴더를 열면 다시 시도한다.
  useEffect(() => {
    if (!settingsLoaded) return;
    void connectMcp();
  }, [settingsLoaded, project?.rootPath, connectMcp]);

  // 턴을 시작할 때도 다시 읽지만(파일이 바뀔 수 있다), 설정 화면과 인스펙터가
  // 첫 턴 전에도 목록을 보여줘야 하므로 여기서 한 번 미리 읽어 둔다.
  useEffect(() => {
    void refreshSkills();
  }, [project?.rootPath, refreshSkills]);

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-hairline bg-error-subtle px-4 py-2 text-caption text-ink">
          {/* 색 없이도 읽히도록 앞에 라벨을 세운다. */}
          <span className="shrink-0 text-body-emphasis text-error">{t("app.error")}</span>
          <span className="flex-1 font-mono break-all">{error}</span>
          <button
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            title={t("common.close")}
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      <main ref={mainRef} className="flex min-h-0 flex-1">
        <SessionSidebar width={sidebarWidth} />

        {/* 세션 목록 분할선 — 우측 것과 같은 부품이다(잡히는 영역만 좌우로 넓힌 1px 선). */}
        <div
          role="separator"
          aria-orientation="vertical"
          title={t("app.resizeSidebar")}
          onPointerDown={(event) => {
            event.preventDefault();
            setDragging("sidebar");
          }}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          className={`group relative w-px shrink-0 cursor-col-resize transition-colors ${
            dragging === "sidebar" ? "bg-accent" : "bg-hairline hover:bg-accent"
          }`}
        >
          <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>

        <div
          ref={splitRef}
          className={`flex min-w-0 flex-1 ${dragging ? "cursor-col-resize select-none" : ""}`}
        >
          {/* 좌: 챗봇 UI — 남는 폭을 모두 가져간다 */}
          <section className="flex min-w-0 flex-1 flex-col">
            <ChatPanel />
          </section>

          {/* 분할선 — 끌어서 채팅 폭을 넓힌다 */}
          <div
            role="separator"
            aria-orientation="vertical"
            title={t("app.resizeChat")}
            onPointerDown={(event) => {
              event.preventDefault();
              setDragging("right");
            }}
            onDoubleClick={() => {
              const box = splitRef.current?.getBoundingClientRect();
              if (box) setRightWidth(defaultRightWidth(box.width));
            }}
            className={`group relative w-px shrink-0 cursor-col-resize transition-colors ${
              dragging === "right" ? "bg-accent" : "bg-hairline hover:bg-accent"
            }`}
          >
            {/* 1px 선은 집기 어려워 잡히는 영역만 좌우로 넓힌다 */}
            <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
          </div>

          {/* 우: 노드 트리 시각화 (+ Phase 1 도구들) */}
          <section
            className="flex min-h-0 shrink-0 flex-col"
            style={{ width: rightWidth ?? "40%" }}
          >
            {/*
             * 탭은 배경으로 고르지 않는다. 선택된 것만 잉크색 글자에 2px 청록 밑줄이
             * 붙고, 나머지는 1px 헤어라인 위에 흐리게 남는다.
             */}
            <nav
              role="tablist"
              className="flex shrink-0 border-b border-hairline bg-canvas px-2"
            >
              {TABS.map((item) => {
                const selected = tab === item.id;
                return (
                  <button
                    key={item.id}
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setTab(item.id)}
                    /*
                     * 크기는 고정하고 **웨이트와 밑줄만** 바꾼다 — 선택에 따라 글자
                     * 크기가 달라지면 탭 폭이 흔들려서 누를 때마다 줄이 출렁인다.
                     */
                    className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-body-sm transition-colors ${
                      selected
                        ? "border-accent font-semibold text-ink"
                        : "border-transparent text-ink-muted hover:bg-hover hover:text-ink"
                    }`}
                  >
                    {t(item.labelKey)}
                    {item.id === "agents" && activeAgents > 0 && (
                      // 채움색은 accent 가 아니라 primary — 다크에서 흰 글자와의 대비가 여기서만 충분하다.
                      <span className="rounded-full bg-primary px-1.5 text-caption text-on-primary">
                        {activeAgents}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="min-h-0 flex-1">
              {tab === "tree" && <FlowCanvas onFocusAgents={() => setTab("agents")} />}
              {tab === "agents" && <AgentDashboard />}
              {tab === "files" && (
                <div className="h-full min-h-0 overflow-hidden p-3">
                  <FileExplorer />
                </div>
              )}
              {tab === "shell" && (
                <div className="flex h-full flex-col p-3">
                  <ShellConsole />
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
