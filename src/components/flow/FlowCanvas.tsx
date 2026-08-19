import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { MessageNode, type MessageFlowNode } from "@/components/flow/MessageNode";
import { Button } from "@/components/Panel";
import { buildIndex, layoutTree, pathTo, siblingsOf } from "@/lib/tree";
import { useWorkspace } from "@/store/workspace";

const NODE_TYPES = { message: MessageNode };

/**
 * 대화 트리 시각화.
 *
 * 노드를 클릭하면 그 노드가 "다음 메시지의 부모"가 된다 →
 * 이미 답변이 달린 노드를 골라 다시 질문하면 세션 안에서 분기가 생긴다.
 * 세션 자체를 복제하는 타임머신은 상단의 [새 세션으로 분기] 버튼.
 */
export function FlowCanvas() {
  const messages = useWorkspace((state) => state.messages);
  const activeParentId = useWorkspace((state) => state.activeParentId);
  const selectedMessageId = useWorkspace((state) => state.selectedMessageId);
  const setActiveParent = useWorkspace((state) => state.setActiveParent);
  const selectMessage = useWorkspace((state) => state.selectMessage);
  const branchFrom = useWorkspace((state) => state.branchFrom);
  const removeMessage = useWorkspace((state) => state.removeMessage);

  const { nodes, edges } = useMemo(() => {
    const index = buildIndex(messages);
    const activePath = new Set(pathTo(messages, activeParentId).map((m) => m.id));
    const positioned = layoutTree(messages);

    const flowNodes: MessageFlowNode[] = positioned.map((item) => ({
      id: item.message.id,
      type: "message",
      position: { x: item.x, y: item.y },
      data: {
        message: item.message,
        isOnActivePath: activePath.size === 0 || activePath.has(item.message.id),
        isActiveParent: item.message.id === activeParentId,
        isSelected: item.message.id === selectedMessageId,
        branchCount: siblingsOf(index, item.message).length,
      },
      draggable: false,
    }));

    const flowEdges: Edge[] = messages
      .filter((message) => message.parentId && index.byId.has(message.parentId))
      .map((message) => ({
        id: `${message.parentId}->${message.id}`,
        source: message.parentId as string,
        target: message.id,
        animated: message.status === "streaming",
        style: {
          stroke: activePath.has(message.id) ? "#34d399" : "#3f3f46",
          strokeWidth: activePath.has(message.id) ? 2 : 1,
        },
      }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [messages, activeParentId, selectedMessageId]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      selectMessage(node.id);
      setActiveParent(node.id);
    },
    [selectMessage, setActiveParent],
  );

  const selected = messages.find((m) => m.id === selectedMessageId) ?? null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-[11px] text-zinc-500">
          {messages.length}개 노드 · 노드를 클릭하면 그 지점에서 대화가 이어집니다
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            onClick={() => selected && void branchFrom(selected.id)}
            disabled={!selected}
            title="선택한 노드까지를 복제해 새 세션을 만듭니다"
          >
            ⑂ 새 세션으로 분기
          </Button>
          <Button
            variant="danger"
            onClick={() => selected && void removeMessage(selected.id)}
            disabled={!selected}
            title="선택한 노드와 그 아래 하위 트리를 삭제합니다"
          >
            하위 트리 삭제
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            메시지를 보내면 대화 트리가 여기에 그려집니다.
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            onPaneClick={() => selectMessage(null)}
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
