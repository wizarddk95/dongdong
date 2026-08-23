import { useCallback, useEffect, useRef, useState } from "react";

import { Button, FIELD_SM, Hint, Tag } from "@/components/Panel";
import {
  allAnswered,
  answerOf,
  answeredCount,
  emptyDraft,
  isAnswered,
  moveIndex,
  nextUnanswered,
  setCustom,
  toggleChoice,
  wrapIndex,
  type ChoiceDraft,
} from "@/lib/ai/questions";
import { useT } from "@/lib/i18n/useT";
import { useQuestions } from "@/store/questions";

/**
 * 사용자 선택 카드 — 승인 카드와 같은 자리(입력칸 바로 위)에 뜬다.
 *
 * 모델이 정책 판단이나 빠진 정보 앞에서 멈춰 물어볼 때 여기서 고른다. 규율은 승인 카드와
 * 같다 — 대기열이 여럿이어도 **한 번에 한 장**, 그 안에서도 **한 번에 한 주제**만 보여준다.
 * 주제 넷을 한꺼번에 펼치면 카드가 화면을 덮고, 그러면 사람은 읽지 않고 누른다.
 *
 * 세 가지가 이 화면의 뼈대다.
 *
 * 1. **마지막 칸은 언제나 직접 입력이다.** 모델이 낸 선택지가 전부 틀렸을 때 빠져나갈 길이
 *    없으면 이 카드는 대화를 돕는 게 아니라 막는다.
 * 2. **되돌아갈 수 있다.** 고르면 다음 주제로 넘어가지만, 방향키(←/→)나 위쪽 주제 칩으로
 *    언제든 앞 주제로 돌아가 고친 답이 그대로 살아 있다. [보내기] 전까지는 아무것도
 *    확정되지 않는다 — 잘못 누른 한 번이 되돌릴 수 없는 답이 되면 사람은 카드를 무서워한다.
 * 3. **판정은 여기 적지 않는다.** 답했는지 · 다음이 어디인지 · 무엇을 모델에게 돌려줄지는
 *    전부 `lib/ai/questions.ts` 의 순수 함수다(테스트가 거기 붙는다).
 *
 * 키보드: ←/→ 주제 이동 · ↑/↓ 선택지 이동 · Enter 선택 · 숫자 키로 바로 선택 ·
 * Ctrl+Enter 보내기. 카드가 뜨면 포커스를 가져온다 — 방향키로 움직이려면 그래야 하고,
 * 어차피 지금은 사람이 답할 차례다.
 */
export function QuestionPrompt() {
  const t = useT();
  const queue = useQuestions((state) => state.queue);
  const submit = useQuestions((state) => state.submit);
  const cancel = useQuestions((state) => state.cancel);

  const ask = queue[0];
  const questions = ask?.questions ?? [];

  const [draft, setDraft] = useState<ChoiceDraft>({});
  /** 지금 보고 있는 주제 */
  const [index, setIndex] = useState(0);
  /** 목록 안에서의 커서. `options.length` 면 직접 입력 칸이다 */
  const [cursor, setCursor] = useState(0);

  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  // 다음 요청으로 넘어가면 앞 요청에 고르던 답이 따라가면 안 된다.
  useEffect(() => {
    setDraft(emptyDraft(ask?.questions ?? []));
    setIndex(0);
    setCursor(0);
  }, [ask?.id]);

  const question = questions[index];
  const optionCount = question?.options.length ?? 0;

  // 커서를 실제 DOM 포커스로 옮긴다 — 그래야 Enter/Space 가 버튼의 기본 동작으로 먹고,
  // 스크린 리더도 지금 어디에 있는지 읽는다(roving tabindex).
  useEffect(() => {
    if (!question) return;
    if (cursor >= optionCount) inputRef.current?.focus();
    else optionRefs.current[cursor]?.focus();
  }, [ask?.id, index, cursor, optionCount, question]);

  const answer = question ? answerOf(draft, question.id) : { selected: [], custom: "" };
  const ready = questions.length > 0 && allAnswered(questions, draft);
  const done = answeredCount(questions, draft);

  /** 답을 갈아 끼우고, 그 주제가 끝났으면 아직 비어 있는 주제로 넘어간다. */
  const applyAnswer = useCallback(
    (next: ChoiceDraft, advance: boolean) => {
      setDraft(next);
      if (!advance || !question) return;
      if (!isAnswered(answerOf(next, question.id))) return;

      const target = nextUnanswered(questions, next, index);
      if (target >= 0) {
        setIndex(target);
        setCursor(0);
      } else {
        // 마지막 답이었다 → 포커스를 [보내기]로 옮겨 Enter 한 번으로 끝나게 한다.
        submitRef.current?.focus();
      }
    },
    [index, question, questions],
  );

  const choose = useCallback(
    (label: string) => {
      if (!question) return;
      const updated = toggleChoice(answerOf(draft, question.id), label, question.multiSelect);
      // 다중 선택은 한 번 누른 것이 끝이 아니다 — 넘어가면 나머지를 고를 수 없다.
      applyAnswer({ ...draft, [question.id]: updated }, !question.multiSelect);
    },
    [applyAnswer, draft, question],
  );

  const writeCustom = useCallback(
    (text: string) => {
      if (!question) return;
      const updated = setCustom(answerOf(draft, question.id), text, question.multiSelect);
      setDraft({ ...draft, [question.id]: updated });
    },
    [draft, question],
  );

  const goto = useCallback((target: number) => {
    setIndex(target);
    setCursor(0);
  }, []);

  const send = useCallback(() => {
    if (!ask || !ready) return;
    submit(ask.id, draft);
  }, [ask, draft, ready, submit]);

  if (!ask || !question) return null;

  /** 커서가 도는 칸 수 = 선택지 + 직접 입력 한 칸. */
  const slots = optionCount + 1;

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    const typing = target?.tagName === "INPUT";

    // ←/→ 는 글자 사이를 오가는 키다 — 직접 입력 칸에서는 캐럿에 양보한다.
    if (!typing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      goto(moveIndex(index, event.key === "ArrowLeft" ? -1 : 1, questions.length));
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => wrapIndex(current, event.key === "ArrowUp" ? -1 : 1, slots));
      return;
    }

    if (event.key === "Enter") {
      // Ctrl(⌘)+Enter 는 어디서 눌러도 보내기다.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        send();
        return;
      }
      if (typing) {
        event.preventDefault();
        // 적은 글이 곧 답이다 — 여기서도 다음 주제로 넘어간다.
        applyAnswer(draft, true);
      }
      // 선택지 버튼 위에서의 Enter 는 버튼의 기본 동작(onClick)에 맡긴다.
      return;
    }

    // 숫자 키로 바로 고르기. 버튼에 적힌 번호와 같은 번호다.
    if (!typing && /^[1-9]$/.test(event.key)) {
      const slot = Number(event.key) - 1;
      if (slot < optionCount) {
        event.preventDefault();
        setCursor(slot);
        choose(question.options[slot].label);
      } else if (slot === optionCount) {
        event.preventDefault();
        setCursor(optionCount);
      }
    }
  }

  /*
   * 카드가 아무리 길어도 대화를 통째로 밀어내지는 못하게 상한을 둔다 — 카드가 화면을
   * 다 먹으면 방금 온 답을 보면서 판단할 수가 없다. 넘치면 카드 안쪽이 스크롤한다.
   * (카드가 뜨느라 줄어든 만큼 대화를 다시 바닥으로 데려가는 일은 `ChatPanel` 이 맡는다)
   */
  return (
    <div
      onKeyDown={onKeyDown}
      role="group"
      aria-label={t("questions.title")}
      className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-hairline border-l-2 border-l-accent bg-accent-subtle px-3 py-2.5"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-caption text-ink-muted">
        <span className="text-body-emphasis text-ink">{t("questions.title")}</span>
        {ask.origin && <Tag tone="neutral">{t("questions.fromSubagent", { name: ask.origin })}</Tag>}
        <Tag tone={question.multiSelect ? "accent" : "neutral"}>
          {question.multiSelect ? t("questions.multiSelect") : t("questions.singleSelect")}
        </Tag>
        <span className="tabular-nums">
          {t("questions.progress", { index: index + 1, total: questions.length })}
        </span>
        <span className="tabular-nums">
          {t("questions.answeredCount", { count: done, total: questions.length })}
        </span>
        {queue.length > 1 && <span>{t("questions.queued", { count: queue.length - 1 })}</span>}
        <Hint align="right" className="ml-auto">
          {t("questions.hint")}
        </Hint>
      </div>

      {/*
        주제 칩 — 어디까지 답했는지 한눈에 보이고, 눌러서 되돌아갈 수 있다.
        방향키만으로도 되지만 마우스만 쓰는 사람에게도 같은 길이 있어야 한다.
      */}
      {questions.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          {questions.map((item, itemIndex) => {
            const answered = isAnswered(answerOf(draft, item.id));
            const current = itemIndex === index;
            return (
              <button
                key={item.id}
                onClick={() => goto(itemIndex)}
                title={item.question}
                aria-current={current}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption transition-colors ${
                  current
                    ? "border-accent bg-canvas text-ink"
                    : "border-hairline bg-surface-1 text-ink-muted hover:bg-hover hover:text-ink"
                }`}
              >
                <span className={answered ? "text-accent" : "text-ink-subtle"}>
                  {answered ? "●" : "○"}
                </span>
                <span className="max-w-40 truncate">{item.header}</span>
              </button>
            );
          })}
        </div>
      )}

      <p className="mb-2 text-body-sm text-ink select-text">{question.question}</p>

      <div
        role={question.multiSelect ? "group" : "radiogroup"}
        aria-label={question.header}
        className="mb-2 max-h-56 space-y-1 overflow-auto"
      >
        {question.options.map((option, optionIndex) => {
          const selected = answer.selected.includes(option.label);
          return (
            <button
              key={option.label}
              ref={(node) => {
                optionRefs.current[optionIndex] = node;
              }}
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={selected}
              tabIndex={cursor === optionIndex ? 0 : -1}
              onClick={() => choose(option.label)}
              onFocus={() => setCursor(optionIndex)}
              className={`flex w-full items-start gap-2 rounded-sm border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-accent bg-canvas"
                  : "border-hairline bg-surface-1 hover:border-field-rule hover:bg-hover"
              }`}
            >
              {/* 뜻은 색이 아니라 글자·표식이 진다 — 흑백으로 봐도 무엇을 골랐는지 보여야 한다. */}
              <span
                aria-hidden
                className={`mt-px shrink-0 text-caption ${selected ? "text-accent" : "text-ink-subtle"}`}
              >
                {question.multiSelect ? (selected ? "☑" : "☐") : selected ? "◉" : "○"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm text-ink">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-caption text-ink-muted">
                    {option.description}
                  </span>
                )}
              </span>
              <span aria-hidden className="shrink-0 text-caption text-ink-subtle tabular-nums">
                {optionIndex + 1}
              </span>
            </button>
          );
        })}

        {optionCount === 0 && <p className="text-caption text-ink-muted">{t("questions.noOptions")}</p>}

        {/*
          마지막 칸은 언제나 직접 입력이다. 모델이 낸 보기가 전부 어긋났을 때
          "그중 하나" 를 억지로 고르게 하면 그 답이 그대로 컨텍스트에 남는다.
        */}
        <div
          className={`rounded-sm border px-3 py-2 transition-colors ${
            answer.custom.trim() ? "border-accent bg-canvas" : "border-hairline bg-surface-1"
          }`}
        >
          <div className="mb-1 flex items-center gap-2 text-caption text-ink-muted">
            <span aria-hidden className={answer.custom.trim() ? "text-accent" : "text-ink-subtle"}>
              ✎
            </span>
            <span>{t("questions.customLabel")}</span>
            <span aria-hidden className="ml-auto tabular-nums text-ink-subtle">
              {optionCount + 1}
            </span>
          </div>
          <input
            ref={inputRef}
            value={answer.custom}
            tabIndex={cursor >= optionCount ? 0 : -1}
            onChange={(event) => writeCustom(event.target.value)}
            onFocus={() => setCursor(optionCount)}
            placeholder={t("questions.customPlaceholder")}
            aria-label={t("questions.customLabel")}
            className={FIELD_SM}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={index === 0}
          onClick={() => goto(moveIndex(index, -1, questions.length))}
        >
          ← {t("questions.prev")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={index >= questions.length - 1}
          onClick={() => goto(moveIndex(index, 1, questions.length))}
        >
          {t("questions.next")} →
        </Button>

        <span className="text-caption text-ink-muted">
          {ready
            ? t("questions.readyHint")
            : t("questions.remaining", { count: questions.length - done })}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Button
            ref={submitRef}
            variant="primary"
            size="sm"
            disabled={!ready}
            title={t("questions.submitHint")}
            onClick={send}
          >
            {t("questions.submit")}
          </Button>
          <Button
            variant="tertiary"
            size="sm"
            title={t("questions.cancelHint")}
            onClick={() => cancel(ask.id)}
          >
            {t("questions.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
