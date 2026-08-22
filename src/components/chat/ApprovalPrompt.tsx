import { useEffect, useState } from "react";

import { Button, Hint, Tag } from "@/components/Panel";
import { describeRule } from "@/lib/ai/approval";
import { useT } from "@/lib/i18n/useT";
import { useApprovals } from "@/store/approvals";

/**
 * 셸 실행 승인 카드 — 입력칸 바로 위에 뜬다.
 *
 * 대기열이 여럿이어도 **한 번에 하나만** 보여준다. 여러 장을 쌓아 두면 사용자는 읽지 않고
 * 누르게 되고, 그러면 이 화면이 있으나 마나다. 남은 건수만 옆에 적는다.
 *
 * 세 버튼은 **전부 채운 버튼**이다 — 하나만 옅은 면으로 두면 그것만 "덜 중요한 것" 으로
 * 읽혀 눈이 미끄러지는데, 여기서 미끄러지면 안 되는 판단이다. 그렇다고 두 번째 브랜드 색을
 * 만들지는 않는다(`docs/design.md`): 실행은 청록(primary), 항상 허용은 잉크(secondary),
 * 거부는 파괴적 동작의 붉은색(danger). 뜻은 색이 아니라 글자가 지고 색은 무게만 맞춘다.
 */
export function ApprovalPrompt() {
  const t = useT();
  const queue = useApprovals((state) => state.queue);
  const approve = useApprovals((state) => state.approve);
  const deny = useApprovals((state) => state.deny);
  const allowed = useApprovals((state) => state.allowed);

  const request = queue[0];
  const rule = request?.rule ?? null;
  const [reason, setReason] = useState("");

  // 다음 요청으로 넘어가면 앞 요청에 적던 사유가 따라가면 안 된다.
  useEffect(() => setReason(""), [request?.id]);

  if (!request) return null;

  return (
    <div className="shrink-0 border-t border-hairline border-l-2 border-l-warning bg-warning-subtle px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-caption text-ink-muted">
        <span className="text-body-emphasis text-ink">
          {request.kind === "delete" ? t("approve.titleDelete") : t("approve.titleRun")}
        </span>
        <Tag tone="warning">{request.toolName}</Tag>
        {request.origin && (
          <Tag tone="neutral">{t("approve.fromSubagent", { name: request.origin })}</Tag>
        )}
        {request.destructive && (
          <Tag tone="error" title={t("approve.destructiveHint")}>
            {t("approve.destructive")}
          </Tag>
        )}
        {queue.length > 1 && <span>{t("approve.queued", { count: queue.length - 1 })}</span>}
        <Hint align="right" className="ml-auto">
          {request.kind === "delete" ? t("approve.hintDelete") : t("approve.hintRun")}
        </Hint>
      </div>

      <pre className="mb-1.5 max-h-40 overflow-auto rounded-sm border border-hairline bg-canvas px-3 py-2 font-mono text-caption whitespace-pre-wrap text-ink select-text">
        {request.command}
      </pre>

      {request.detail && <p className="mb-2 text-caption text-ink">{request.detail}</p>}

      {request.cwd && (
        <p className="mb-2 truncate text-caption text-ink-muted">
          {t("approve.cwd")} <code className="font-mono">{request.cwd}</code>
        </p>
      )}

      {/*
        [항상 허용]이 정확히 무엇을 여는지 버튼을 누르기 **전에** 적는다.
        "앞으로 계속" 처럼 읽히면 사용자는 자기가 연 문의 크기를 모른 채 누른다.
      */}
      <p className="mb-2 text-caption text-ink-muted">
        {!request.rule ? (
          request.kind === "delete" ? (
            <>{t("approve.noRuleDelete")}</>
          ) : (
            <>{t("approve.noRuleDestructive")}</>
          )
        ) : (
          <>
            {t("approve.ruleLead")}{" "}
            <code className="font-mono text-ink">{rule ? describeRule(rule) : ""}</code>{" "}
            {rule?.exact ? <>{t("approve.ruleExact")}</> : <>{t("approve.rulePrefix")}</>}{" "}
            {t("approve.ruleLifetime")}
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => approve(request.id)}>
          {request.kind === "delete" ? t("common.delete") : t("shell.run")}
        </Button>
        {request.rule && (
          <Button
            variant="secondary"
            size="sm"
            title={t("approve.alwaysHint", { rule: rule ? describeRule(rule) : "" })}
            onClick={() => approve(request.id, { always: true })}
          >
            {t("approve.always")}
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={() => deny(request.id, reason)}>
          {t("approve.deny")}
        </Button>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              deny(request.id, reason);
            }
          }}
          placeholder={t("approve.reasonPlaceholder")}
          className="min-w-40 flex-1 rounded-sm border border-field-rule bg-field px-3 py-1.5 text-caption text-ink transition-colors placeholder:text-ink-subtle hover:border-ink-subtle focus:border-accent"
        />
        {allowed.length > 0 && (
          <span
            className="shrink-0 text-caption text-ink-subtle"
            title={t("approve.allowedHint")}
          >
            {t("approve.allowedCount", { count: allowed.length })}
          </span>
        )}
      </div>
    </div>
  );
}
