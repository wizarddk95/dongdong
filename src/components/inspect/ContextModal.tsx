import { useMemo, useState } from "react";

import { JsonTree } from "@/components/inspect/JsonTree";
import { Button, Modal } from "@/components/Panel";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { buildMcpTools } from "@/lib/ai/mcp";
import { buildTurnContext, type TurnContext } from "@/lib/ai/runner";
import { skillNames } from "@/lib/ai/skills";
import { pathTo } from "@/lib/tree";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

interface ContextModalProps {
  open: boolean;
  onClose: () => void;
  /** 특정 assistant 노드의 스냅샷을 볼 때. null 이면 "다음 턴에 나갈 컨텍스트"를 미리 만든다. */
  messageId?: string | null;
}

type Source = "snapshot" | "derived" | "preview";

const SOURCE_LABEL: Record<Source, { text: string; className: string }> = {
  snapshot: { text: "저장된 스냅샷", className: "bg-emerald-950 text-emerald-300" },
  derived: { text: "트리에서 재구성", className: "bg-amber-950 text-amber-300" },
  preview: { text: "다음 턴 미리보기", className: "bg-sky-950 text-sky-300" },
};

/** 스냅샷에 messages 가 들어 있는지 (도구 스텝 노드는 설정값만 저장한다) */
function hasMessages(snapshot: unknown): snapshot is TurnContext {
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    Array.isArray((snapshot as TurnContext).messages)
  );
}

export function ContextModal({ open, onClose, messageId }: ContextModalProps) {
  const messages = useWorkspace((state) => state.messages);
  const activeParentId = useWorkspace((state) => state.activeParentId);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const instructions = useWorkspace((state) => state.instructions);
  const mcpServers = useMcp((state) => state.servers);
  const settings = useSettings();

  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const { context, source } = useMemo((): { context: TurnContext; source: Source } => {
    const node = messageId ? messages.find((message) => message.id === messageId) : null;
    const snapshot = node?.contextSnapshot as Partial<TurnContext> | null | undefined;

    // 스냅샷에 메시지 원문이 있으면 그게 곧 그 시점에 실제로 보낸 것이다.
    if (node && hasMessages(snapshot)) return { context: snapshot, source: "snapshot" };

    // 도구 스텝 노드 등 메시지를 안 남긴 경우엔 조상 체인으로 그대로 복원한다.
    const leafId = node ? node.parentId : activeParentId;
    const context = buildTurnContext({
      modelId: snapshot?.modelId ?? settings.modelId,
      system:
        snapshot?.system ??
        composeSystemPrompt(
          settings.systemPrompt,
          settings.useProjectInstructions ? instructions : null,
        ),
      chain: pathTo(messages, leafId),
      effort: snapshot?.effort ?? settings.effort,
      maxSteps: snapshot?.maxSteps ?? settings.maxSteps,
      toolNames:
        snapshot?.toolNames ??
        // 미리보기에는 지금 연결된 MCP 서버의 도구도 함께 나가야 한다.
        [
          ...skillNames({ enabled: settings.skills, sessionId: activeSessionId }),
          ...(settings.skills.mcp
            ? Object.keys(buildMcpTools(mcpServers).tools)
            : []),
        ],
    });
    return { context, source: node ? "derived" : "preview" };
  }, [messageId, messages, activeParentId, activeSessionId, instructions, mcpServers, settings]);

  const json = useMemo(() => JSON.stringify(context, null, 2), [context]);

  // 토큰 수는 공급자마다 달라 정확히 알 수 없으므로 문자 수만 정직하게 보여준다.
  const totalChars = useMemo(
    () => context.system.length + json.length,
    [context.system.length, json.length],
  );

  const badge = SOURCE_LABEL[source];

  async function copyRaw() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal
      open={open}
      title="현재 컨텍스트"
      subtitle="LLM 요청 직전에 전달되는 원문 그대로"
      onClose={onClose}
      widthClass="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[10px] text-zinc-600">
            총 {totalChars.toLocaleString()}자 (토큰 아님) · 메시지 {context.messages.length}개
          </span>
          <Button onClick={() => void copyRaw()}>{copied ? "복사됨" : "JSON 복사"}</Button>
          <Button onClick={() => setRaw((value) => !value)}>
            {raw ? "트리로 보기" : "원문 보기"}
          </Button>
          <Button variant="primary" onClick={onClose}>
            닫기
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>{badge.text}</span>
          <span className="font-mono text-[11px] text-zinc-300">{context.modelId}</span>
          <span className="text-zinc-500">effort {context.effort}</span>
          <span className="text-zinc-500">최대 {context.maxSteps} 스텝</span>
          <span className="font-mono text-[10px] text-zinc-600">{context.createdAt}</span>
        </div>

        {source === "derived" && (
          <p className="rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200">
            이 노드는 도구 실행 뒤 이어진 스텝이라 메시지 원문을 따로 저장하지 않습니다. 부모까지의
            대화 체인으로 동일하게 재구성했습니다.
          </p>
        )}

        {raw ? (
          <pre className="overflow-auto rounded bg-black/40 p-3 font-mono text-[11px] whitespace-pre-wrap text-zinc-300">
            {json}
          </pre>
        ) : (
          <>
            <section>
              <h3 className="mb-1 text-[11px] font-semibold text-zinc-400">시스템 프롬프트</h3>
              <pre className="max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-300">
                {context.system || "(없음)"}
              </pre>
            </section>

            <section>
              <h3 className="mb-1 text-[11px] font-semibold text-zinc-400">
                노출된 도구 {context.toolNames.length}개
              </h3>
              <div className="flex flex-wrap gap-1">
                {context.toolNames.length === 0 && (
                  <span className="text-[11px] text-zinc-600">(도구 없음)</span>
                )}
                {context.toolNames.map((name) => (
                  <span
                    key={name}
                    className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-[11px] font-semibold text-zinc-400">
                메시지 {context.messages.length}개
              </h3>
              <div className="space-y-1.5">
                {context.messages.map((message, index) => (
                  <div key={index} className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
                    <div className="mb-1 flex items-center gap-2 text-[10px]">
                      <span className="font-semibold text-zinc-300">{message.role}</span>
                      <span className="text-zinc-600">#{index + 1}</span>
                    </div>
                    <JsonTree value={message.content} defaultOpenDepth={2} />
                  </div>
                ))}
                {context.messages.length === 0 && (
                  <p className="text-[11px] text-zinc-600">
                    아직 보낼 대화가 없습니다. 메시지를 입력하면 여기에 나타납니다.
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
