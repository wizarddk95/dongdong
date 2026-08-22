import { useMemo, useState } from "react";

import { JsonTree } from "@/components/inspect/JsonTree";
import { t, type MessageKey } from "@/lib/i18n";
import { Button, Modal, Tag, type TagTone } from "@/components/Panel";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { buildMcpTools } from "@/lib/ai/mcp";
import { resolveEffort } from "@/lib/ai/providers";
import {
  buildTurnContext,
  contextPayloadOf,
  payloadChars,
  type TurnContext,
} from "@/lib/ai/runner";
import { appendSkillCatalog, buildSkillTools } from "@/lib/ai/skills";
import { enabledToolNames } from "@/lib/ai/tools";
import { formatExact, lastCallUsage, projectTokens, readNodeUsage } from "@/lib/ai/usage";
import { pathTo } from "@/lib/tree";
import { useMcp } from "@/store/mcp";
import { useSettings } from "@/store/settings";
import { useSkills } from "@/store/skills";
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
const SOURCE_LABEL: Record<Source, { textKey: MessageKey; tone: TagTone }> = {
  snapshot: { textKey: "context.source.snapshot", tone: "success" },
  derived: { textKey: "context.source.derived", tone: "warning" },
  preview: { textKey: "context.source.preview", tone: "accent" },
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
  // 미리보기(아직 안 보낸 턴)에는 지금 켜져 있는 스킬 목록이 그대로 실린다.
  const skillFiles = useSkills((state) => state.files);
  const skills = useSkills.getState().enabled();

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
          appendSkillCatalog(settings.systemPrompt, skills),
          settings.useProjectInstructions ? instructions : null,
          // 미리보기도 실제 전송과 같은 함수·같은 조건을 쓴다(시각 블록 포함).
          settings.injectDateTime ? new Date() : null,
        ),
      chain: pathTo(messages, leafId),
      effort: snapshot?.effort ?? settings.effort,
      maxSteps: snapshot?.maxSteps ?? settings.maxSteps,
      toolNames:
        snapshot?.toolNames ??
        // 미리보기에는 지금 연결된 MCP 서버의 도구도 함께 나가야 한다.
        [
          ...enabledToolNames({ enabled: settings.tools, sessionId: activeSessionId }),
          ...(settings.tools.mcp
            ? Object.keys(buildMcpTools(mcpServers).tools)
            : []),
          ...Object.keys(buildSkillTools(skills)),
        ],
    });
    return { context, source: node ? "derived" : "preview" };
  }, [
    messageId,
    messages,
    activeParentId,
    activeSessionId,
    instructions,
    mcpServers,
    settings,
    skillFiles,
  ]);

  const json = useMemo(() => JSON.stringify(context, null, 2), [context]);

  // 설정에 적힌 강도가 아니라 이 모델에 실제로 나간 강도 (없으면 undefined).
  const sentEffort = resolveEffort(context.modelId, context.effort);

  /**
   * 이 페이로드의 크기 — **문자** 수다.
   *
   * 화면에 보여 주는 `json` 은 읽으라고 들여쓴 것이라 실제보다 한참 부푼다.
   * 여기서는 들여쓰기 없는 원문 길이를 센다(system 은 json 안에 이미 들어 있으므로
   * 따로 더하지 않는다 — 더하면 시스템 프롬프트가 두 번 세어진다).
   */
  const chars = useMemo(() => payloadChars(context), [context]);

  /**
   * 같은 페이로드가 실제로 몇 토큰이었는지 — 추정이 아니라 공급자가 세어 준 값이다.
   *
   * 노드를 보고 있으면 그 노드의 실측값이 곧 이 페이로드의 토큰 수다 — 스냅샷을 그대로
   * 띄웠든 트리에서 재구성했든, 노드 하나가 호출 하나이므로 잰 대상이 같다.
   *
   * 아직 보낸 적이 없는 미리보기만 환산한다: 마지막 호출의 실측값에 못을 박고 그 뒤로
   * 늘어난 만큼만 이 대화의 실측 자/토큰 비율로 더한다 — 채팅창 위 컨텍스트 링이 쓰는
   * 바로 그 계산이다(두 화면이 같은 수를 말해야 한다).
   */
  const measured = useMemo(() => {
    const node = messageId ? messages.find((message) => message.id === messageId) : null;
    const own = node ? readNodeUsage(node) : null;
    if (own) return { tokens: own.usage.inputTokens, exact: true };

    const chain = pathTo(messages, node ? node.parentId : activeParentId);
    const previous = lastCallUsage(chain);
    if (!previous) return null;

    const projection = projectTokens(
      previous.usage,
      contextPayloadOf(chain, messages, context.system),
    );
    return { tokens: projection.used, exact: projection.projected === 0 };
  }, [messageId, messages, activeParentId, context.system]);

  // 자 ↔ 토큰은 서로 다른 자다. 나란히 놓되 어긋나는 이유를 붙여 둔다.
  const countsTooltip = [
    t("context.counts.chars"),
    t("context.counts.ratio"),
    t("context.counts.schemas"),
    measured?.exact ? t("context.counts.measured") : t("context.counts.projected"),
  ].join("\n");

  const badge = SOURCE_LABEL[source];

  async function copyRaw() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal
      open={open}
      title={t("context.title")}
      subtitle={t("context.subtitle")}
      onClose={onClose}
      widthClass="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-caption tabular-nums text-ink-muted" title={countsTooltip}>
            {t("context.charCount", { chars: formatExact(chars) })} ·{" "}
            {t("usageUi.messages", { count: context.messages.length })}
            {measured &&
              ` · ${
                measured.exact
                  ? t("context.tokensExact", { tokens: formatExact(measured.tokens) })
                  : t("context.tokensApprox", { tokens: formatExact(measured.tokens) })
              }`}
          </span>
          <Button onClick={() => void copyRaw()}>{copied ? t("common.copied") : t("context.copyJson")}</Button>
          <Button onClick={() => setRaw((value) => !value)}>
            {raw ? t("context.viewTree") : t("context.viewRaw")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
          <Tag tone={badge.tone}>{t(badge.textKey)}</Tag>
          <span className="font-mono text-ink">{context.modelId}</span>
          {/* 안 보낸 값을 보낸 것처럼 적지 않는다 — 이 화면의 존재 이유가 그거다.
              설정값이 아니라 **그 모델에 실제로 나간 값**을 같은 함수로 다시 구한다. */}
          {sentEffort === undefined ? (
            <span title={t("context.noEffortHint")}>{t("context.noEffort")}</span>
          ) : sentEffort === context.effort ? (
            <span>effort {sentEffort}</span>
          ) : (
            <span title={t("context.effortAdjustedHint", { effort: context.effort })}>
              {t("context.effortAdjusted", { sent: sentEffort, configured: context.effort })}
            </span>
          )}
          <span>{t("context.maxSteps", { count: context.maxSteps })}</span>
          <span className="font-mono">{context.createdAt}</span>
        </div>

        {source === "derived" && (
          <p className="rounded-md border-l-2 border-warning bg-warning-subtle px-3 py-2 text-caption text-ink">
            {t("context.derivedNote")}
          </p>
        )}

        {raw ? (
          <pre className="overflow-auto rounded-md border border-hairline bg-surface-1 p-3 font-mono text-caption whitespace-pre-wrap text-ink">
            {json}
          </pre>
        ) : (
          <>
            <section>
              <h3 className="mb-1.5 text-body-emphasis text-ink">{t("context.systemPrompt")}</h3>
              <pre className="max-h-40 overflow-auto rounded-md border border-hairline bg-surface-1 p-3 font-mono text-caption whitespace-pre-wrap text-ink">
                {context.system || t("context.none")}
              </pre>
            </section>

            <section>
              <h3 className="mb-1.5 text-body-emphasis text-ink">
                {t("context.exposedTools", { count: context.toolNames.length })}
              </h3>
              <div className="flex flex-wrap gap-1">
                {context.toolNames.length === 0 && (
                  <span className="text-caption text-ink-subtle">{t("context.noTools")}</span>
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
                {t("usageUi.messages", { count: context.messages.length })}
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
                  <p className="text-caption text-ink-subtle">{t("context.noMessages")}</p>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
