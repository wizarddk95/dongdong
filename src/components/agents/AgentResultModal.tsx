import { useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Button, Modal, Tag } from "@/components/Panel";
import { UsageTag } from "@/components/UsageMeter";
import { runDuration, runStatusStyle, runUsage } from "@/lib/agentRuns";
import { t } from "@/lib/i18n";
import type { AgentRun } from "@/types/ipc";

/**
 * 서브에이전트가 돌려준 요약을 **팝업**에서 본다.
 *
 * 카드 안에서 펼치던 시절에는 표와 코드 블록이 칸반 열(폭 1/3)을 그대로 뚫고 나갔다 —
 * 요약이 길수록, 그러니까 정작 읽어야 할 때일수록 더 깨졌다. 서브에이전트의 답은
 * 메인 에이전트의 답과 같은 마크다운이므로 **같은 부품으로, 넓은 자리에서** 그린다.
 *
 * 대시보드와 턴 그래프가 같은 팝업을 쓴다 — 두 화면이 같은 결과를 다르게 보여 주면
 * 어느 쪽이 원문인지 알 수 없다.
 */
export function AgentResultModal({ run, onClose }: { run: AgentRun | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  if (!run) return null;

  const status = runStatusStyle(run.status);
  const usage = runUsage(run);
  const elapsed = runDuration(run);
  const body = run.error ?? run.result;

  async function copy() {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 클립보드가 막혀도 본문 표시엔 영향이 없다.
    }
  }

  return (
    <Modal
      open
      title={run.name}
      subtitle={t("agents.resultTitle")}
      onClose={onClose}
      widthClass="max-w-3xl"
      footer={
        <>
          <Button onClick={() => void copy()} disabled={!body}>
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-caption">
          <span className={`shrink-0 rounded-full px-2 py-0.5 ${status.className}`}>
            {t(status.labelKey)}
          </span>
          {elapsed && <Tag>{elapsed}</Tag>}
          {usage && (
            <UsageTag
              usage={usage.usage}
              cost={usage.cost}
              modelId={usage.modelId}
              variant="cost"
            />
          )}
        </div>

        <section>
          <h3 className="mb-1 text-caption text-ink-muted">{t("agents.taskHeading")}</h3>
          {/* 지시문은 사람이 쓴 글이 아니라 모델이 넘긴 문자열이다 — 원문 그대로 둔다. */}
          <p className="rounded-md border border-hairline bg-surface-1 px-3 py-2 text-caption whitespace-pre-wrap text-ink">
            {run.task}
          </p>
        </section>

        <section>
          <h3 className="mb-1 text-caption text-ink-muted">
            {run.error ? t("agents.errorHeading") : t("agents.resultHeading")}
          </h3>
          {run.error ? (
            <p className="rounded-md border-l-2 border-error bg-error-subtle px-3 py-2 font-mono text-caption break-all text-ink">
              {run.error}
            </p>
          ) : run.result ? (
            <Markdown text={run.result} />
          ) : (
            <p className="text-body-sm text-ink-muted">{t("agents.noResult")}</p>
          )}
        </section>
      </div>
    </Modal>
  );
}
