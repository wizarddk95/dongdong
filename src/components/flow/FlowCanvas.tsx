import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AgentNode, AGENT_HEIGHT, AGENT_WIDTH } from "@/components/flow/AgentNode";
import { TurnNode, TURN_HEIGHT, TURN_WIDTH } from "@/components/flow/TurnNode";
import { Button } from "@/components/Panel";
import { isRunActive } from "@/lib/agentRuns";
import { tidyLayout } from "@/lib/layout";
import { pathTo } from "@/lib/tree";
import { buildTurns, siblingTurns, turnSubtree } from "@/lib/turns";
import { useAgents } from "@/store/agents";
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
 */
export function FlowCanvas({ onFocusAgents }: FlowCanvasProps) {
  const messages = useWorkspace((state) => state.messages);
  const activeParentId = useWorkspace((state) => state.activeParentId);
  const selectedMessageId = useWorkspace((state) => state.selectedMessageId);
  const setActiveParent = useWorkspace((state) => state.setActiveParent);
  const selectMessage = useWorkspace((state) => state.selectMessage);
  const branchFrom = useWorkspace((state) => state.branchFrom);
  const removeTurn = useWorkspace((state) => state.removeTurn);
  const runs = useAgents((state) => state.runs);
  const removeRunsForMessages = useAgents((state) => state.removeForMessages);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

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
          label: midway ? "중간 스텝에서 분기" : undefined,
          labelStyle: { fill: "#c4b5fd", fontSize: 9 },
          labelBgStyle: { fill: "#18181b" },
          style: {
            stroke: onActivePath ? "#34d399" : "#3f3f46",
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
          style: { stroke: "#a21caf", strokeWidth: 1.5, strokeDasharray: "5 4" },
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

  function deleteSelectedTurn() {
    if (!selectedTurn) return;
    const { turnIds, messageIds } = turnSubtree(index, selectedTurn.id);
    const doomed = new Set(messageIds);
    const runCount = runs.filter(
      (run) => run.parentMessageId && doomed.has(run.parentMessageId),
    ).length;

    const descendants = turnIds.length - 1;
    const detail = [
      `이 턴${descendants > 0 ? `과 하위 ${descendants}개 턴` : ""}`,
      `노드 ${messageIds.length}개`,
      runCount > 0 ? `서브에이전트 기록 ${runCount}건` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (!window.confirm(`${detail} 을(를) 삭제합니다. 되돌릴 수 없습니다.`)) return;

    // 실행 기록을 먼저 지운다 — 노드가 먼저 사라지면 parentMessageId 가 끊겨 고아로 남는다.
    void removeRunsForMessages(messageIds).then(() => removeTurn(selectedTurn.id));
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-[11px] text-zinc-500">
          {index.turns.length}개 턴 · {messages.length}노드
          {orphanCount > 0 && ` · 연결 끊긴 위임 ${orphanCount}건`}
        </span>

        {selectedRun ? (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[11px] text-fuchsia-300">🤝 {selectedRun.name}</span>
            <Button onClick={() => onFocusAgents?.()} disabled={!onFocusAgents}>
              서브에이전트 탭에서 보기
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <Button
              onClick={() => selectedTurn && setActiveParent(selectedTurn.branchPointId)}
              disabled={!selectedTurn}
              title="이 턴이 갈라져 나온 지점으로 돌아갑니다. 같은 질문을 다시 하면 형제 턴이 생깁니다."
            >
              ⑂ 이 턴 다시 질문
            </Button>
            <Button
              onClick={() => selectedTurn && void branchFrom(selectedTurn.leafId)}
              disabled={!selectedTurn}
              title="선택한 턴까지를 복제해 새 세션을 만듭니다"
            >
              ⑂ 새 세션으로 분기
            </Button>
            <Button
              variant="danger"
              onClick={deleteSelectedTurn}
              disabled={!selectedTurn}
              title="선택한 턴과 그 아래 모든 턴을 삭제합니다"
            >
              턴 삭제
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            메시지를 보내면 대화 턴이 여기에 그려집니다.
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
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#3f3f46" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-zinc-900" maskColor="rgba(0,0,0,0.6)" />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
