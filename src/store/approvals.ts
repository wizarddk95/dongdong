/**
 * 셸 실행 승인 대기열 + **이 세션에서만 사는** 허용 규칙.
 *
 * 도구(`tools.ts` 의 `execute_shell_command`)가 실행 직전에 여기에 물어보고,
 * 사용자가 카드에서 버튼을 누를 때까지 **그 도구만** 멈춰 선다.
 * 턴 전체가 멈추는 게 아니라 도구 하나가 await 에 걸려 있는 것이므로,
 * [중지]를 누르면 `abortableTools()` 의 중단 경주가 그대로 도구를 거절한다
 * (그때 여기 남은 요청도 함께 정리한다).
 *
 * **[항상 허용]의 수명은 지금 세션이다.** 디스크(`settings.json`)에 남기지 않고 메모리에만
 * 둔다 — 어제 어떤 대화에서 한 번 누른 것이 오늘 다른 프로젝트의 명령을 조용히 통과시키면
 * 그건 승인 화면을 둔 뜻이 사라지는 것이다. 세션을 바꾸거나 앱을 다시 켜면 백지에서 시작한다.
 *
 * 판정 규칙은 전부 `lib/ai/approval.ts` 의 순수 함수다. 이 스토어는 "묻고 기다리는" 일과
 * "규칙을 세션 동안 들고 있는" 일만 한다.
 */
import { create } from "zustand";

import {
  commandRule,
  decideApproval,
  isDestructive,
  makeAllowRule,
  newRuleId,
  type AllowRule,
  type ApprovalKind,
  type ApprovalOutcome,
  type ApprovalRequest,
} from "@/lib/ai/approval";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

export interface ApprovalAsk {
  /** 생략하면 셸 실행으로 본다 */
  kind?: ApprovalKind;
  toolName: string;
  /** 셸이면 명령 원문, 삭제면 지울 경로 */
  command: string;
  /** 명령만으로는 안 보이는 사실 한 줄 */
  detail?: string;
  cwd?: string;
  /** 서브에이전트가 부른 것이면 그 이름 */
  origin?: string;
  /** 턴의 중단 시그널. 끊기면 대기 중인 요청도 거부로 풀린다 */
  signal?: AbortSignal;
}

interface ApprovalsState {
  /** 사용자의 판단을 기다리는 요청들. 화면은 맨 앞 하나만 카드로 띄운다. */
  queue: ApprovalRequest[];
  /**
   * [항상 허용]으로 쌓인 규칙. **이 세션에서만** 유효하다.
   * 저장하지 않으므로 앱을 다시 켜면 비어 있다.
   */
  allowed: AllowRule[];
  /** `allowed` 가 속한 세션. 여기서 벗어나면 규칙을 버린다. */
  ruleSessionId: string | null;

  /** 승인 게이트. `allow` 로 판정되면 카드 없이 곧바로 통과한다. */
  request: (ask: ApprovalAsk) => Promise<ApprovalOutcome>;
  /** `always` 면 이 명령을 덮는 규칙을 **이 세션에** 기억한다. */
  approve: (id: string, options?: { always?: boolean }) => void;
  deny: (id: string, reason?: string) => void;
  /** 남은 요청을 전부 거부로 풀어 준다 (턴이 끝났을 때). */
  clear: (reason?: string) => void;
  /** 허용 규칙 하나를 지운다. 다음부터 그 명령은 다시 묻는다. */
  forget: (ruleId: string) => void;
  /** 허용 규칙을 전부 지운다. */
  forgetAll: () => void;
}

/** 대기 중인 요청의 resolver. 스토어 상태가 아니라 모듈 스코프에 둔다(직렬화 대상이 아니다). */
const resolvers = new Map<string, (outcome: ApprovalOutcome) => void>();
/** 요청마다 붙여 둔 중단 리스너 해제기. */
const detachers = new Map<string, () => void>();

function settle(id: string, outcome: ApprovalOutcome) {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  detachers.get(id)?.();
  detachers.delete(id);
  resolve?.(outcome);
}

export const useApprovals = create<ApprovalsState>((set, get) => ({
  queue: [],
  allowed: [],
  ruleSessionId: null,

  request: async (ask) => {
    const state = get();
    const kind = ask.kind ?? "shell";
    const settings = useSettings.getState();
    const decision = decideApproval(kind, ask.command, settings.shellApproval, state.allowed);
    if (decision === "allow") return { approved: true };

    // 이미 끊긴 턴이면 카드를 띄우지 않는다.
    if (ask.signal?.aborted) return { approved: false, reason: "중단되었습니다." };

    // 삭제는 규칙으로 미리 열 수 없다(지운 파일은 되돌아오지 않는다).
    // 되돌리기 어려운 셸 명령도 마찬가지로 [항상 허용] 을 내주지 않는다.
    const destructive = kind === "delete" || isDestructive(ask.command);
    const request: ApprovalRequest = {
      id: newRuleId(),
      kind,
      toolName: ask.toolName,
      command: ask.command,
      detail: ask.detail,
      cwd: ask.cwd,
      origin: ask.origin,
      rule: destructive ? null : commandRule(ask.command),
      destructive,
    };

    return new Promise<ApprovalOutcome>((resolve) => {
      resolvers.set(request.id, (outcome) => {
        set({ queue: get().queue.filter((item) => item.id !== request.id) });
        resolve(outcome);
      });

      if (ask.signal) {
        const onAbort = () => settle(request.id, { approved: false, reason: "중단되었습니다." });
        ask.signal.addEventListener("abort", onAbort, { once: true });
        detachers.set(request.id, () => ask.signal?.removeEventListener("abort", onAbort));
      }

      set({ queue: [...get().queue, request] });
    });
  },

  approve: (id, options) => {
    const request = get().queue.find((item) => item.id === id);
    if (!request) return;

    let remembered;
    // 규칙을 내주지 않기로 한 요청은 화면에서도 버튼을 감추지만, 판정은 여기서도 지킨다 —
    // 두 곳이 어긋나면 눌리지 않아야 할 것이 눌린다.
    if (options?.always && request.rule) {
      const rule = makeAllowRule(request.command, get().allowed);
      if (rule) {
        remembered = rule;
        set({
          allowed: [...get().allowed, rule],
          ruleSessionId: useWorkspace.getState().activeSessionId,
        });
      }
    }

    settle(id, { approved: true, remembered });
  },

  deny: (id, reason) => {
    settle(id, {
      approved: false,
      reason: reason?.trim() || "사용자가 이 명령의 실행을 거부했습니다.",
    });
  },

  clear: (reason) => {
    for (const request of get().queue) {
      settle(request.id, { approved: false, reason: reason ?? "턴이 끝나 요청이 취소되었습니다." });
    }
    set({ queue: [] });
  },

  forget: (ruleId) => set({ allowed: get().allowed.filter((rule) => rule.id !== ruleId) }),

  forgetAll: () => set({ allowed: [] }),
}));

/**
 * 세션이 바뀌면 허용 규칙을 버린다.
 *
 * "이 세션에서만" 이 말 그대로가 되려면 세션 전환이 곧 만료여야 한다. 스토어 안에서
 * 세션 id 를 매번 비교하지 않고 밖에서 구독하는 이유는 규칙을 읽는 곳이 게이트만이
 * 아니기 때문이다 — 설정 화면의 목록도 같은 순간에 비어야 한다.
 */
useWorkspace.subscribe((state, previous) => {
  if (state.activeSessionId === previous.activeSessionId) return;
  useApprovals.setState({ allowed: [], ruleSessionId: state.activeSessionId });
});
