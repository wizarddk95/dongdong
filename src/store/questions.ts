/**
 * 사용자 선택(질문 카드) 대기열.
 *
 * 승인 게이트(`store/approvals.ts`)와 같은 모양이다 — 도구(`ask_user_question`)가 실행
 * 도중 여기에 물어보고, 사용자가 카드에서 [보내기]를 누를 때까지 **그 도구만** 멈춰 선다.
 * 턴 전체가 멈추는 게 아니라 도구 하나가 await 에 걸려 있는 것이므로, [중지]를 누르면
 * `abortableTools()` 의 중단 경주가 도구를 거절하고 여기 남은 요청도 함께 풀린다.
 *
 * **판정과 파생은 전부 `lib/ai/questions.ts` 의 순수 함수다.** 이 스토어는 "묻고 기다리는"
 * 일만 한다. 승인 규칙과 달리 여기에는 기억해 둘 것이 없다 — 판단은 매번 새 판단이고,
 * "이런 질문은 앞으로 자동으로 이렇게 답한다" 는 것은 사람에게 묻는 뜻을 없앤다.
 */
import { create } from "zustand";

import {
  finalizeAnswers,
  newAskId,
  normalizeQuestions,
  type ChoiceAsk,
  type ChoiceDraft,
  type ChoiceOutcome,
} from "@/lib/ai/questions";
import { t } from "@/lib/i18n";

export interface ChoiceRequestInput {
  /** 모델이 보낸 원본 목록. 여기서 한 번 접어 받는다 */
  questions: unknown;
  /** 서브에이전트가 물은 것이면 그 이름 */
  origin?: string;
  /** 턴의 중단 시그널. 끊기면 대기 중인 카드도 취소로 풀린다 */
  signal?: AbortSignal;
}

interface QuestionsState {
  /** 사용자의 답을 기다리는 요청들. 화면은 맨 앞 하나만 카드로 띄운다. */
  queue: ChoiceAsk[];

  /** 질문 게이트. 물을 것이 하나도 없으면 카드 없이 곧바로 풀린다. */
  request: (input: ChoiceRequestInput) => Promise<ChoiceOutcome>;
  /** 초안을 굳혀 모델에게 돌려준다. */
  submit: (id: string, draft: ChoiceDraft) => void;
  /** 사용자가 답하지 않기로 했다. 모델은 이유를 읽고 다른 수를 고른다. */
  cancel: (id: string, reason?: string) => void;
  /** 남은 요청을 전부 취소로 풀어 준다 (턴이 끝났을 때). */
  clear: (reason?: string) => void;
}

/** 대기 중인 요청의 resolver. 직렬화 대상이 아니므로 스토어 밖 모듈 스코프에 둔다. */
const resolvers = new Map<string, (outcome: ChoiceOutcome) => void>();
/** 요청마다 붙여 둔 중단 리스너 해제기. */
const detachers = new Map<string, () => void>();

function settle(id: string, outcome: ChoiceOutcome) {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  detachers.get(id)?.();
  detachers.delete(id);
  resolve?.(outcome);
}

export const useQuestions = create<QuestionsState>((set, get) => ({
  queue: [],

  request: async (input) => {
    const questions = normalizeQuestions(input.questions);
    // 접고 나니 물을 것이 없다 — 빈 카드를 띄우느니 모델에게 사실대로 돌려준다.
    if (questions.length === 0) {
      return { answered: false, reason: t("questions.empty") };
    }
    // 이미 끊긴 턴이면 카드를 띄우지 않는다.
    if (input.signal?.aborted) return { answered: false, reason: t("questions.aborted") };

    const ask: ChoiceAsk = { id: newAskId(), questions, origin: input.origin };

    return new Promise<ChoiceOutcome>((resolve) => {
      resolvers.set(ask.id, (outcome) => {
        set({ queue: get().queue.filter((item) => item.id !== ask.id) });
        resolve(outcome);
      });

      if (input.signal) {
        const onAbort = () => settle(ask.id, { answered: false, reason: t("questions.aborted") });
        input.signal.addEventListener("abort", onAbort, { once: true });
        detachers.set(ask.id, () => input.signal?.removeEventListener("abort", onAbort));
      }

      set({ queue: [...get().queue, ask] });
    });
  },

  submit: (id, draft) => {
    const ask = get().queue.find((item) => item.id === id);
    if (!ask) return;
    settle(id, { answered: true, answers: finalizeAnswers(ask.questions, draft) });
  },

  cancel: (id, reason) => {
    settle(id, { answered: false, reason: reason?.trim() || t("questions.cancelled") });
  },

  clear: (reason) => {
    for (const ask of get().queue) {
      settle(ask.id, { answered: false, reason: reason ?? t("questions.turnEnded") });
    }
    set({ queue: [] });
  },
}));
