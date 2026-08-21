import { useMemo, useState } from "react";

import { JsonTree } from "@/components/inspect/JsonTree";
import { Button, Modal, Tag, type TagTone } from "@/components/Panel";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { buildMcpTools } from "@/lib/ai/mcp";
import { resolveEffort } from "@/lib/ai/providers";
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

/**
 * 이 컨텍스트가 어디서 왔는지 — 이 툴의 투명성이 걸린 표시라 글자로 못 박고,
 * 색은 "그대로 저장된 것(중립)" 과 "재구성한 것(주의)" 만 구분한다.
 */
const SOURCE_LABEL: Record<Source, { text: string; tone: TagTone }> = {
  snapshot: { text: "저장된 스냅샷", tone: "success" },
  derived: { text: "트리에서 재구성", tone: "warning" },
  preview: { text: "다음 턴 미리보기", tone: "accent" },
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
  // 설정에 적힌 강도가 아니라 이 모델에 실제로 나간 강도 (없으면 undefined).
  const sentEffort = resolveEffort(context.modelId, context.effort);

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
          <span className="mr-auto text-caption text-ink-muted">
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
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
          <Tag tone={badge.tone}>{badge.text}</Tag>
          <span className="font-mono text-ink">{context.modelId}</span>
          {/* 안 보낸 값을 보낸 것처럼 적지 않는다 — 이 화면의 존재 이유가 그거다.
              설정값이 아니라 **그 모델에 실제로 나간 값**을 같은 함수로 다시 구한다. */}
          {sentEffort === undefined ? (
            <span title="이 모델에는 사고 강도가 나가지 않습니다">effort 미전송</span>
          ) : sentEffort === context.effort ? (
            <span>effort {sentEffort}</span>
          ) : (
            <span title={`설정은 ${context.effort} 지만 이 모델이 받는 값이 아니라 가장 가까운 값으로 나갔습니다`}>
              effort {sentEffort} (설정 {context.effort})
            </span>
          )}
          <span>최대 {context.maxSteps} 스텝</span>
          <span className="font-mono">{context.createdAt}</span>
        </div>

        {source === "derived" && (
          <p className="rounded-md border-l-2 border-warning bg-warning-subtle px-3 py-2 text-caption text-ink">
            이 노드는 도구 실행 뒤 이어진 스텝이라 메시지 원문을 따로 저장하지 않습니다. 부모까지의
            대화 체인으로 동일하게 재구성했습니다.
          </p>
        )}

        {raw ? (
          <pre className="overflow-auto rounded-md border border-hairline bg-surface-1 p-3 font-mono text-caption whitespace-pre-wrap text-ink">
            {json}
          </pre>
        ) : (
          <>
            <section>
              <h3 className="mb-1.5 text-body-emphasis text-ink">시스템 프롬프트</h3>
              <pre className="max-h-40 overflow-auto rounded-md border border-hairline bg-surface-1 p-3 font-mono text-caption whitespace-pre-wrap text-ink">
                {context.system || "(없음)"}
              </pre>
            </section>

            <section>
              <h3 className="mb-1.5 text-body-emphasis text-ink">
                노출된 도구 {context.toolNames.length}개
              </h3>
              <div className="flex flex-wrap gap-1">
                {context.toolNames.length === 0 && (
                  <span className="text-caption text-ink-subtle">(도구 없음)</span>
                )}
                {context.toolNames.map((name) => (
                  <span
                    key={name}
                    className="rounded-full bg-surface-1 px-2 py-0.5 font-mono text-caption text-ink-muted"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1.5 text-body-emphasis text-ink">
                메시지 {context.messages.length}개
              </h3>
              <div className="space-y-1.5">
                {context.messages.map((message, index) => (
                  <div key={index} className="rounded-md border border-hairline bg-surface-1 p-2.5">
                    <div className="mb-1 flex items-center gap-2 text-caption">
                      <span className="text-body-emphasis text-ink">{message.role}</span>
                      <span className="text-ink-subtle">#{index + 1}</span>
                    </div>
                    <JsonTree value={message.content} defaultOpenDepth={2} />
                  </div>
                ))}
                {context.messages.length === 0 && (
                  <p className="text-caption text-ink-subtle">
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
