import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Button } from "@/components/Panel";
import { UsageTag } from "@/components/UsageMeter";
import { summarizeProjectUsage } from "@/lib/ai/usage";
import { SessionNode, SESSION_HEIGHT, SESSION_WIDTH } from "@/components/sessions/SessionNode";
import { tidyLayout } from "@/lib/layout";
import { buildSessionTree } from "@/lib/sessionTree";
import { useWorkspace } from "@/store/workspace";
import type { SessionFlowNode } from "@/components/sessions/SessionNode";

const NODE_TYPES = { session: SessionNode };

interface SessionMapProps {
  /** 세션을 골라 채팅 화면으로 들어갈 때 */
  onOpenSession: (sessionId: string) => void;
}

/**
 * 세션 맵 — 채팅에 들어가기 전 단계.
 *
 * 프로젝트의 세션들과 거기서 갈라져 나온 분기 세션을 왼→오른쪽 트리로 보여준다.
 * 카드를 더블클릭(또는 골라서 [열기])하면 그 세션의 채팅으로 들어간다.
 */
export function SessionMap({ onOpenSession }: SessionMapProps) {
  const project = useWorkspace((state) => state.project);
  const sessions = useWorkspace((state) => state.sessions);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const refreshSessions = useWorkspace((state) => state.refreshSessions);
  const newSession = useWorkspace((state) => state.newSession);
  const removeSession = useWorkspace((state) => state.removeSession);
  const renameSession = useWorkspace((state) => state.renameSession);

  const [selectedId, setSelectedId] = useState<string | null>(activeSessionId);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);

  // 맵에 들어올 때마다 집계(노드 수·마지막 활동)를 다시 읽는다.
  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions, project?.rootPath]);

  const { nodes, edges } = useMemo(() => {
    const index = buildSessionTree(sessions);
    const placements = tidyLayout({
      roots: index.roots,
      childrenOf: (session) => index.childrenOf.get(session.id) ?? [],
      idOf: (session) => session.id,
      nodeWidth: SESSION_WIDTH,
      nodeHeight: SESSION_HEIGHT,
      gapX: 90,
      gapY: 26,
    });

    const flowNodes: SessionFlowNode[] = [];
    const flowEdges: Edge[] = [];

    for (const session of sessions) {
      const place = placements.get(session.id);
      if (!place) continue;

      flowNodes.push({
        id: session.id,
        type: "session",
        position: { x: place.x, y: place.y },
        draggable: false,
        data: {
          session,
          isActive: session.id === activeSessionId,
          isSelected: session.id === selectedId,
        },
      });

      const parentId = session.parentSessionId;
      if (parentId && index.byId.has(parentId) && placements.has(parentId)) {
        flowEdges.push({
          id: `${parentId}->${session.id}`,
          source: parentId,
          target: session.id,
          label: session.branchedFromMessageId
            ? `⑂ ${session.branchedFromMessageId.slice(0, 8)} 노드에서`
            : "⑂ 분기",
          labelStyle: { fill: "#c4b5fd", fontSize: 9 },
          labelBgStyle: { fill: "#18181b" },
          style: { stroke: "#7c3aed", strokeWidth: 1.5 },
        });
      }
    }

    return { nodes: flowNodes, edges: flowEdges };
  }, [sessions, activeSessionId, selectedId]);

  const selected = sessions.find((session) => session.id === selectedId) ?? null;
  // 이 프로젝트가 지금까지 쓴 총량. 모델별로 요금을 매긴 뒤 더한 값이다.
  const total = useMemo(() => summarizeProjectUsage(sessions), [sessions]);

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    setSelectedId(node.id);
    setRenameDraft(null);
  };

  async function createSession() {
    const session = await newSession();
    if (session) onOpenSession(session.id);
  }

  function deleteSelected() {
    if (!selected) return;
    const childCount = sessions.filter((s) => s.parentSessionId === selected.id).length;
    const detail = childCount > 0 ? `\n분기된 세션 ${childCount}개는 남아 루트로 올라갑니다.` : "";
    if (!window.confirm(`세션 "${selected.title}" 을(를) 삭제합니다.${detail}`)) return;

    void removeSession(selected.id);
    setSelectedId(null);
  }

  function commitRename() {
    const title = renameDraft?.trim();
    if (selected && title) void renameSession(selected.id, title);
    setRenameDraft(null);
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-zinc-600">
        <p>먼저 프로젝트 폴더를 여세요.</p>
        <p className="text-[11px]">상단의 [폴더 열기] 로 시작합니다.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-[11px] text-zinc-500">
          세션 {sessions.length}개 · 카드를 더블클릭하면 그 대화로 들어갑니다
        </span>
        {total.calls > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="text-zinc-600">·</span>
            <span>LLM 호출 {total.calls}회</span>
            <UsageTag
              usage={total.usage}
              cost={total.cost}
              modelId={total.primaryModelId}
              className="text-[11px]"
            />
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {renameDraft !== null ? (
            <>
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setRenameDraft(null);
                }}
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-100 focus:border-zinc-500 focus:outline-none"
              />
              <Button variant="primary" onClick={commitRename}>
                확인
              </Button>
              <Button onClick={() => setRenameDraft(null)}>취소</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={() => void createSession()}>
                + 새 세션
              </Button>
              <Button onClick={() => selected && onOpenSession(selected.id)} disabled={!selected}>
                열기
              </Button>
              <Button
                onClick={() => selected && setRenameDraft(selected.title)}
                disabled={!selected}
              >
                이름 변경
              </Button>
              <Button variant="danger" onClick={deleteSelected} disabled={!selected}>
                삭제
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {sessions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-600">
            <p>아직 세션이 없습니다.</p>
            <Button variant="primary" onClick={() => void createSession()}>
              + 새 세션 만들기
            </Button>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={(_event, node) => onOpenSession(node.id)}
            /*
             * 더블클릭 확대를 끄지 않으면 카드 더블클릭이 먹지 않는다 —
             * d3-zoom 의 dblclick 핸들러가 stopImmediatePropagation() 을 불러
             * 이벤트가 React 루트까지 못 올라가고 onNodeDoubleClick 이 죽는다.
             * 확대/축소는 좌측 하단 컨트롤과 휠로 충분하다.
             */
            zoomOnDoubleClick={false}
            onPaneClick={() => {
              setSelectedId(null);
              setRenameDraft(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#3f3f46" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
