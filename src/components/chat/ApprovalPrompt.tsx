import { useEffect, useState } from "react";

import { Button, Hint, Tag } from "@/components/Panel";
import { describeRule } from "@/lib/ai/approval";
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
          {request.kind === "delete" ? "삭제 승인이 필요합니다" : "실행 승인이 필요합니다"}
        </span>
        <Tag tone="warning">{request.toolName}</Tag>
        {request.origin && <Tag tone="neutral">서브에이전트 · {request.origin}</Tag>}
        {request.destructive && (
          <Tag tone="error" title="되돌리기 어려운 명령으로 보입니다. [항상 허용] 은 내주지 않습니다.">
            되돌리기 어려움
          </Tag>
        )}
        {queue.length > 1 && <span>대기 {queue.length - 1}건</span>}
        <Hint align="right" className="ml-auto">
          {request.kind === "delete"
            ? "삭제는 되돌릴 수 없습니다. 휴지통을 거치지 않고 디스크에서 사라집니다. 버전 관리 밖의 파일이라면 특히 한 번 더 확인하세요."
            : "이 앱은 샌드박스가 없습니다. 아래 명령은 당신의 OS 권한으로 그대로 실행됩니다. 무엇을 하는 명령인지 읽고 판단하세요. 자동 실행은 설정 › 도구 에서 켤 수 있습니다."}
        </Hint>
      </div>

      <pre className="mb-1.5 max-h-40 overflow-auto rounded-sm border border-hairline bg-canvas px-3 py-2 font-mono text-caption whitespace-pre-wrap text-ink select-text">
        {request.command}
      </pre>

      {request.detail && <p className="mb-2 text-caption text-ink">{request.detail}</p>}

      {request.cwd && (
        <p className="mb-2 truncate text-caption text-ink-muted">
          작업 디렉터리 <code className="font-mono">{request.cwd}</code>
        </p>
      )}

      {/*
        [항상 허용]이 정확히 무엇을 여는지 버튼을 누르기 **전에** 적는다.
        "앞으로 계속" 처럼 읽히면 사용자는 자기가 연 문의 크기를 모른 채 누른다.
      */}
      <p className="mb-2 text-caption text-ink-muted">
        {!request.rule ? (
          request.kind === "delete" ? (
            <>
              삭제는 규칙으로 미리 열어 둘 수 없습니다 — 지운 파일은 되돌아오지 않으므로
              &quot;비슷한 것도 함께&quot; 라는 개념이 성립하지 않습니다. 매번 묻습니다.
            </>
          ) : (
            <>되돌리기 어려운 명령이라 [항상 허용] 은 제공하지 않습니다. 이번 한 번만 고르세요.</>
          )
        ) : (
          <>
            [항상 허용] 은 <b className="text-ink">이 세션에서</b>{" "}
            <code className="font-mono text-ink">{rule ? describeRule(rule) : ""}</code>{" "}
            {rule?.exact ? (
              <>와 완전히 같은 명령만 통과시킵니다.</>
            ) : (
              <>
                로 시작하는 <b className="text-ink">단일 명령</b>만 통과시킵니다 —{" "}
                <span className="font-mono">&amp;&amp;</span> · 파이프 · 리다이렉션이 붙으면 다시
                묻습니다.
              </>
            )}{" "}
            세션을 바꾸거나 앱을 다시 켜면 사라집니다.
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => approve(request.id)}>
          {request.kind === "delete" ? "삭제" : "실행"}
        </Button>
        {request.rule && (
          <Button
            variant="secondary"
            size="sm"
            title={`이 세션에서 "${rule ? describeRule(rule) : ""}" 에 해당하는 명령은 묻지 않고 실행합니다. 설정 › 도구 에서 지울 수 있고, 세션을 바꾸거나 앱을 다시 켜면 사라집니다.`}
            onClick={() => approve(request.id, { always: true })}
          >
            이 세션에서 항상 허용
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={() => deny(request.id, reason)}>
          거부
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
          placeholder="거부 사유 (선택) — 에이전트가 다음 수를 고를 때 읽습니다"
          className="min-w-40 flex-1 rounded-sm border border-field-rule bg-field px-3 py-1.5 text-caption text-ink transition-colors placeholder:text-ink-subtle hover:border-ink-subtle focus:border-accent"
        />
        {allowed.length > 0 && (
          <span
            className="shrink-0 text-caption text-ink-subtle"
            title="이 세션에서 [항상 허용]으로 통과시키고 있는 규칙 수입니다. 설정 › 도구 에서 볼 수 있습니다."
          >
            허용 규칙 {allowed.length}
          </span>
        )}
      </div>
    </div>
  );
}
