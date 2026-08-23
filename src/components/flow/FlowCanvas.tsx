import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AgentResultModal } from "@/components/agents/AgentResultModal";
import { AgentNode, AGENT_HEIGHT, AGENT_WIDTH } from "@/components/flow/AgentNode";
import { TurnNode, TURN_HEIGHT, TURN_WIDTH } from "@/components/flow/TurnNode";
import { Button } from "@/components/Panel";
import { useResolvedTheme } from "@/lib/useResolvedTheme";
import { isRunActive } from "@/lib/agentRuns";
import { t } from "@/lib/i18n";
import { tidyLayout } from "@/lib/layout";
import { pathTo } from "@/lib/tree";
import {
  buildTurns,
  siblingTurns,
  soloDeleteBlocker,
  turnLabel,
  turnSubtree,
} from "@/lib/turns";
import { useAgents } from "@/store/agents";
import { useChat } from "@/store/chat";
import { useWorkspace } from "@/store/workspace";
import type { AgentRun } from "@/types/ipc";

const NODE_TYPES = { turn: TurnNode, agent: AgentNode };

const GAP_X = 76;
const GAP_Y = 40;
const STEP_Y = TURN_HEIGHT + GAP_Y;

interface FlowCanvasProps {
  /** 서브에이전트 노드에서 대시보드 탭으로 넘어갈 때 */
  onFocusAgents?: () => void;
}

/**
 * 대화 턴 그래프.
 *
 * 한 턴(질문 + 응답 + 도구 스텝)이 카드 하나이고, 왼→오른쪽으로 이어진다.
 * 위임된 서브에이전트는 발화한 턴에서 위/아래로 갈라져 나온다.
 * 카드를 클릭하면 그 턴 뒤에서 대화가 이어진다 — 앞 턴을 고르면 분기가 생긴다.
 * (분기는 여기서만 만든다. "이 턴에서 다시 질문" 같은 버튼을 따로 두면
 *  같은 일을 두 갈래로 하게 되고, 그중 한쪽이 뿌리를 여러 개 만들었다.)
 */
export function FlowCanvas({ onFocusAgents }: FlowCanvasProps) {
  const messages = useWorkspace((state) => state.messages);
  const activeParentId = useWorkspace((state) => state.activeParentId);
  const selectedMessageId = useWorkspace((state) => state.selectedMessageId);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const setActiveParent = useWorkspace((state) => state.setActiveParent);
  const selectMessage = useWorkspace((state) => state.selectMessage);
  const removeNodes = useWorkspace((state) => state.removeNodes);
  const undoDelete = useWorkspace((state) => state.undoDelete);
  const deletions = useWorkspace((state) => state.deletions);
  const clipboard = useWorkspace((state) => state.clipboard);
  const copyNodes = useWorkspace((state) => state.copyNodes);
  const clearClipboard = useWorkspace((state) => state.clearClipboard);
  const pasteNodes = useWorkspace((state) => state.pasteNodes);
  const runs = useAgents((state) => state.runs);
  const cancelRunsForMessages = useAgents((state) => state.cancelForMessages);
  const refreshRuns = useAgents((state) => state.refresh);
  // 턴이 흐르는 중에 트리를 건드리면 스트리밍이 쓰고 있는 노드가 사라진다.
  const running = useChat((state) => state.running);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // 그래프에서 고른 서브에이전트의 요약을 그 자리에서 연다 — 탭을 옮겨 다시 찾지 않게.
  const [runResultOpen, setRunResultOpen] = useState(false);
  // React Flow 는 자체 클래스로 명암을 잡으므로 해석된 테마를 직접 알려 줘야 한다.
  const theme = useResolvedTheme();

  const { nodes, edges, index, orphanCount } = useMemo(() => {
    const index = buildTurns(messages);
    const activeNodeIds = new Set(pathTo(messages, activeParentId).map((m) => m.id));
    const selectedTurnId = selectedMessageId
      ? (index.turnOfMessage.get(selectedMessageId) ?? null)
      : null;

    // 서브에이전트를 발화한 턴에 매단다. 어느 턴에도 못 붙는 실행은 대시보드에만 남는다.
    const agentsByTurn = new Map<string, AgentRun[]>();
    let orphanCount = 0;
    for (const run of [...runs].reverse()) {
      const turnId = run.parentMessageId ? index.turnOfMessage.get(run.parentMessageId) : undefined;
      if (!turnId) {
        orphanCount += 1;
        continue;
      }
      const bucket = agentsByTurn.get(turnId) ?? [];
      bucket.push(run);
      agentsByTurn.set(turnId, bucket);
    }

    const placements = tidyLayout({
      roots: index.roots,
      childrenOf: (turn) => index.childrenOf.get(turn.id) ?? [],
      idOf: (turn) => turn.id,
      nodeWidth: TURN_WIDTH,
      nodeHeight: TURN_HEIGHT,
      gapX: GAP_X,
      gapY: GAP_Y,
      lanesOf: (turn) => {
        const count = agentsByTurn.get(turn.id)?.length ?? 0;
        return { above: Math.floor(count / 2), below: Math.ceil(count / 2) };
      },
    });

    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];

    for (const turn of index.turns) {
      const place = placements.get(turn.id);
      if (!place) continue;

      const onActivePath =
        activeNodeIds.size === 0 || turn.nodes.some((node) => activeNodeIds.has(node.id));
      const agents = agentsByTurn.get(turn.id) ?? [];

      flowNodes.push({
        id: turn.id,
        type: "turn",
        position: { x: place.x, y: place.y },
        draggable: false,
        data: {
          turn,
          isOnActivePath: onActivePath,
          isActiveParent: turn.leafId === activeParentId,
          isSelected: turn.id === selectedTurnId,
          branchCount: siblingTurns(index, turn).length,
          agentCount: agents.length,
        },
      });

      if (turn.parentTurnId) {
        const parent = index.byId.get(turn.parentTurnId);
        // 부모 턴의 끝이 아닌 중간 스텝에서 갈라졌으면 눈에 띄게 표시한다.
        const midway = parent != null && parent.leafId !== turn.branchPointId;
        flowEdges.push({
          id: `${turn.parentTurnId}->${turn.id}`,
          source: turn.parentTurnId,
          target: turn.id,
          animated: turn.status === "streaming",
          label: midway ? t("flow.midwayBranch") : undefined,
          // 색값을 박아 두면 테마를 바꿔도 선만 옛 색으로 남는다 → 토큰 변수를 그대로 넘긴다.
          labelStyle: { fill: "var(--color-ink-muted)", fontSize: 11 },
          labelBgStyle: { fill: "var(--color-canvas)" },
          style: {
            stroke: onActivePath ? "var(--color-accent)" : "var(--color-surface-3)",
            strokeWidth: onActivePath ? 2 : 1,
            strokeDasharray: midway ? "4 3" : undefined,
          },
        });
      }

      // 0번은 아래, 1번은 위, 2번은 아래 두 칸… 으로 번갈아 배치한다.
      agents.forEach((run, position) => {
        const lane = Math.floor(position / 2) + 1;
        const direction = position % 2 === 0 ? 1 : -1;
        const nodeId = `agent:${run.id}`;

        flowNodes.push({
          id: nodeId,
          type: "agent",
          position: {
            x: place.x + (TURN_WIDTH - AGENT_WIDTH) / 2,
            y: place.y + direction * lane * STEP_Y + (TURN_HEIGHT - AGENT_HEIGHT) / 2,
          },
          draggable: false,
          data: { run, isSelected: run.id === selectedRunId, dimmed: !onActivePath },
        });

        flowEdges.push({
          id: `agent-edge:${run.id}`,
          source: turn.id,
          sourceHandle: direction === 1 ? "agents-bottom" : "agents-top",
          target: nodeId,
          targetHandle: direction === 1 ? "top" : "bottom",
          animated: isRunActive(run),
          // 서브에이전트 연결은 색이 아니라 점선으로 구분한다.
          style: { stroke: "var(--color-ink-subtle)", strokeWidth: 1.5, strokeDasharray: "5 4" },
        });
      });
    }

    return { nodes: flowNodes, edges: flowEdges, index, orphanCount };
  }, [messages, activeParentId, selectedMessageId, runs, selectedRunId]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (node.type === "agent") {
        setSelectedRunId(node.id.slice("agent:".length));
        return;
      }
      const turn = index.byId.get(node.id);
      if (!turn) return;
      setSelectedRunId(null);
      selectMessage(turn.leafId);
      setActiveParent(turn.leafId);
    },
    [index, selectMessage, setActiveParent],
  );

  const selectedTurn = selectedMessageId
    ? (index.byId.get(index.turnOfMessage.get(selectedMessageId) ?? "") ?? null)
    : null;
  const selectedRun = selectedRunId ? (runs.find((run) => run.id === selectedRunId) ?? null) : null;

  // 지금 되돌릴 수 있는 삭제 (이 세션에서 마지막으로 지운 것).
  const undoable = useMemo(() => {
    for (let at = deletions.length - 1; at >= 0; at -= 1) {
      if (deletions[at].sessionId === activeSessionId) return deletions[at];
    }
    return null;
  }, [deletions, activeSessionId]);

  // 뿌리가 둘로 갈라지는 삭제는 막는다. 이유는 버튼 툴팁으로 그대로 보여준다.
  const busy = running ? t("flow.busy") : null;
  const soloBlocker = busy ?? (selectedTurn ? soloDeleteBlocker(index, selectedTurn) : null);

  /** 노드 목록을 지우고 딸린 실행·그래프를 정리한다. */
  function remove(messageIds: string[], cascade: boolean, label: string) {
    // 돌고 있는 서브에이전트는 먼저 멈춘다 — 노드가 사라져도 실행은 계속 돌기 때문이다.
    cancelRunsForMessages(messageIds);
    void removeNodes(messageIds, { cascade, label }).then(() => refreshRuns());
  }

  /** 선택한 턴 하나만 도려낸다. 뒤에 이어지던 대화는 부모 턴에 그대로 붙는다. */
  function deleteSelectedTurn() {
    if (!selectedTurn || soloBlocker) return;
    remove(
      selectedTurn.nodes.map((node) => node.id),
      false,
      t("flow.turnLabel", { label: turnLabel(selectedTurn) }),
    );
  }

  /** 선택한 턴부터 그 아래 전부. 갈래째 걷어낼 때 쓴다. */
  function deleteSelectedSubtree() {
    if (!selectedTurn || busy) return;
    const { turnIds, messageIds } = turnSubtree(index, selectedTurn.id);
    const descendants = turnIds.length - 1;

    // 한 턴짜리면 위 버튼과 결과가 같으니 묻지 않는다. 갈래를 통째로 걷어낼 때만 확인한다.
    if (descendants > 0) {
      const detail = t("flow.subtreeDetail", {
        turns: descendants,
        nodes: messageIds.length,
      });
      if (!window.confirm(t("flow.confirmDelete", { detail }))) {
        return;
      }
    }

    remove(
      messageIds,
      true,
      t("flow.subtreeLabel", { label: turnLabel(selectedTurn), count: turnIds.length }),
    );
  }

  const copySelectedTurn = useCallback(() => {
    if (!selectedTurn) return;
    const preview = selectedTurn.userText.replace(/\s+/g, " ").trim().slice(0, 20);
    copyNodes(
      selectedTurn.nodes.map((node) => node.id),
      `${t("flow.turnLabel", { label: turnLabel(selectedTurn) })}${preview ? ` · ${preview}` : ""}`,
    );
  }, [selectedTurn, copyNodes]);

  /** 클립보드의 턴을 선택한 턴 뒤에 복제해 붙인다. 세션이 달라도 된다. */
  const pasteIntoSelection = useCallback(() => {
    if (!clipboard) return;
    void pasteNodes(selectedTurn ? selectedTurn.leafId : null).then(() => refreshRuns());
  }, [clipboard, selectedTurn, pasteNodes, refreshRuns]);

  // 붙일 자리가 필요하다 — 빈 세션일 때만 자리 없이(=새 뿌리로) 붙일 수 있다.
  const canPaste =
    !running && Boolean(clipboard) && (selectedTurn != null || messages.length === 0);

  /**
   * Ctrl+C · Ctrl+V.
   *
   * 그래프 탭이 떠 있는 동안에만 듣는다 — 다른 탭을 보고 있으면 이 컴포넌트가 없다.
   * 글자를 다루는 중이면(입력칸에 커서가 있거나 본문을 긁어 놓았으면) 그건 글자 복사다.
   * 가로채면 채팅 내용을 복사하려던 손이 노드를 복사하게 된다 → 그대로 흘려보낸다.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "v") return;

      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      if (key === "c" && (window.getSelection()?.toString() ?? "") !== "") return;

      if (key === "c") {
        if (!selectedTurn) return;
        event.preventDefault();
        copySelectedTurn();
      } else {
        if (!canPaste) return;
        event.preventDefault();
        pasteIntoSelection();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedTurn, canPaste, copySelectedTurn, pasteIntoSelection]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="text-caption text-ink-muted">
          {t("flow.counts", { turns: index.turns.length, nodes: messages.length })}
          {orphanCount > 0 && ` · ${t("flow.orphans", { count: orphanCount })}`}
        </span>

        {clipboard && (
          <span className="flex min-w-0 items-center gap-1 text-caption text-ink-subtle">
            <span
              className="max-w-56 truncate"
              title={t("flow.clipboardHint", { nodes: clipboard.messageIds.length })}
            >
              {t("flow.clipboard", { label: clipboard.label })}
            </span>
            <button
              className="rounded-sm px-1 transition-colors hover:bg-hover hover:text-ink"
              title={t("flow.clearClipboard")}
              onClick={clearClipboard}
            >
              ✕
            </button>
          </span>
        )}

        {undoable && (
          <Button
            disabled={running}
            onClick={() => void undoDelete().then(() => refreshRuns())}
            title={t("flow.undoHint")}
          >
            {t("flow.undo")} · {undoable.label}
          </Button>
        )}

        {selectedRun ? (
          <div className="ml-auto flex items-center gap-1">
            <span className="truncate text-caption text-ink-muted">
              {t("app.tab.agents")} <span className="text-ink">{selectedRun.name}</span>
            </span>
            <Button
              onClick={() => setRunResultOpen(true)}
              disabled={!selectedRun.result && !selectedRun.error}
              title={t("agents.openResultHint")}
            >
              {t("flow.openAgentResult")}
            </Button>
            <Button onClick={() => onFocusAgents?.()} disabled={!onFocusAgents}>
              {t("flow.openAgentsTab")}
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <Button
              onClick={copySelectedTurn}
              disabled={!selectedTurn}
              title={t("flow.copyHint")}
            >
              {t("common.copy")}
            </Button>
            {/* 비활성 버튼에는 툴팁이 뜨지 않는 웹뷰가 있어 이유는 껍데기에 건다. */}
            <span
              title={
                busy ??
                (clipboard
                  ? t("flow.pasteHint")
                  : t("flow.pasteEmpty"))
              }
            >
              <Button onClick={pasteIntoSelection} disabled={!canPaste}>
                {t("flow.paste")}
              </Button>
            </span>
            <span
              title={
                soloBlocker ?? t("flow.deleteTurnHint")
              }
            >
              <Button
                variant="danger"
                onClick={deleteSelectedTurn}
                disabled={!selectedTurn || Boolean(soloBlocker)}
              >
                {t("flow.deleteTurn")}
              </Button>
            </span>
            <span title={busy ?? t("flow.deleteSubtreeHint")}>
              <Button
                variant="danger"
                onClick={deleteSelectedSubtree}
                disabled={!selectedTurn || Boolean(busy)}
              >
                {t("flow.deleteSubtree")}
              </Button>
            </span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-body-sm text-ink-muted">
            {t("flow.empty")}
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            onPaneClick={() => {
              selectMessage(null);
              setSelectedRunId(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.15}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
            colorMode={theme}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="var(--color-surface-2)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      <AgentResultModal
        run={runResultOpen ? selectedRun : null}
        onClose={() => setRunResultOpen(false)}
      />
    </div>
  );
}
