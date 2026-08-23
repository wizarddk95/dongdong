import { describe, expect, it } from "vitest";

import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  allAnswered,
  answerOf,
  answeredCount,
  describeAnswer,
  emptyDraft,
  finalizeAnswers,
  isAnswered,
  moveIndex,
  nextUnanswered,
  normalizeQuestions,
  setCustom,
  summarizeAsk,
  toggleChoice,
  wrapIndex,
  type ChoiceDraft,
  type ChoiceQuestion,
} from "@/lib/ai/questions";

/** 테스트용 주제 하나. id 는 화면 키일 뿐이라 여기서는 사람이 읽기 좋게 박는다. */
function question(partial: Partial<ChoiceQuestion> & { id: string }): ChoiceQuestion {
  return {
    header: partial.id,
    question: `${partial.id} 를 고르세요`,
    multiSelect: false,
    options: [{ label: "A" }, { label: "B" }],
    ...partial,
  };
}

const QUESTIONS = [question({ id: "q1" }), question({ id: "q2" }), question({ id: "q3" })];

function draftWith(entries: Record<string, { selected?: string[]; custom?: string }>): ChoiceDraft {
  const draft = emptyDraft(QUESTIONS);
  for (const [id, value] of Object.entries(entries)) {
    draft[id] = { selected: value.selected ?? [], custom: value.custom ?? "" };
  }
  return draft;
}

describe("normalizeQuestions", () => {
  it("모델이 보낸 목록을 화면에 걸 수 있는 모양으로 접는다", () => {
    const [topic] = normalizeQuestions([
      {
        header: "인증 방식",
        question: "  무엇으로 로그인하나요?  ",
        multiSelect: true,
        options: [{ label: " OAuth ", description: "구글·깃허브" }, { label: "이메일" }],
      },
    ]);

    expect(topic.header).toBe("인증 방식");
    expect(topic.question).toBe("무엇으로 로그인하나요?");
    expect(topic.multiSelect).toBe(true);
    expect(topic.options).toEqual([
      { label: "OAuth", description: "구글·깃허브" },
      { label: "이메일" },
    ]);
    expect(topic.id).toBeTruthy();
  });

  it("주제마다 서로 다른 id 를 매긴다 — 답을 담는 키가 겹치면 한 주제의 답이 다른 주제를 덮는다", () => {
    const topics = normalizeQuestions([{ question: "하나" }, { question: "둘" }]);
    expect(topics[0].id).not.toBe(topics[1].id);
  });

  it("질문 본문이 없는 주제는 버린다 — 빈 카드는 누를 것이 없다", () => {
    expect(normalizeQuestions([{ header: "이름만", options: [{ label: "A" }] }])).toEqual([]);
    expect(normalizeQuestions([{ question: "   " }])).toEqual([]);
  });

  it("칩 이름이 없으면 질문 앞머리를 잘라 쓴다", () => {
    const [topic] = normalizeQuestions([{ question: "아주 긴 질문을 여기에 적어 두었습니다" }]);
    expect(topic.header.length).toBeGreaterThan(0);
    expect(topic.question).toContain(topic.header.replace("…", ""));
  });

  it("주제 수와 선택지 수에 상한을 둔다 — 없으면 카드가 화면을 덮는다", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      question: `질문 ${index}`,
      options: Array.from({ length: 20 }, (_, option) => ({ label: `보기 ${option}` })),
    }));
    const topics = normalizeQuestions(many);

    expect(topics).toHaveLength(MAX_QUESTIONS);
    expect(topics[0].options).toHaveLength(MAX_OPTIONS);
  });

  it("빈 라벨과 중복 라벨을 걸러낸다 — 같은 라벨이 둘이면 답에서 구별되지 않는다", () => {
    const [topic] = normalizeQuestions([
      {
        question: "무엇을 고를까요",
        options: [{ label: "A" }, { label: " A " }, { label: "  " }, { label: "B" }],
      },
    ]);
    expect(topic.options.map((option) => option.label)).toEqual(["A", "B"]);
  });

  it("스키마를 어겨 문자열만 보낸 보기도 받는다", () => {
    const [topic] = normalizeQuestions([{ question: "고르세요", options: ["A", "B"] }]);
    expect(topic.options).toEqual([{ label: "A" }, { label: "B" }]);
  });

  it("긴 글은 잘라 받는다", () => {
    const [topic] = normalizeQuestions([
      { question: "x".repeat(2_000), options: [{ label: "y".repeat(500) }] },
    ]);
    expect(topic.question.length).toBeLessThanOrEqual(501);
    expect(topic.options[0].label.length).toBeLessThanOrEqual(121);
  });

  it("목록이 아닌 값은 빈 목록으로 떨어진다", () => {
    expect(normalizeQuestions(undefined)).toEqual([]);
    expect(normalizeQuestions("질문")).toEqual([]);
    expect(normalizeQuestions([null, 3])).toEqual([]);
  });

  it("multiSelect 는 true 일 때만 켠다", () => {
    const [on, off] = normalizeQuestions([
      { question: "a", multiSelect: true },
      { question: "b", multiSelect: "yes" },
    ]);
    expect(on.multiSelect).toBe(true);
    expect(off.multiSelect).toBe(false);
  });
});

describe("고르기", () => {
  it("단일 선택은 앞의 답을 밀어낸다", () => {
    const answer = toggleChoice({ selected: ["A"], custom: "" }, "B", false);
    expect(answer.selected).toEqual(["B"]);
  });

  it("단일 선택도 같은 것을 다시 누르면 풀린다 — 되돌릴 길이 있어야 한다", () => {
    const answer = toggleChoice({ selected: ["A"], custom: "" }, "A", false);
    expect(answer.selected).toEqual([]);
  });

  it("다중 선택은 쌓이고, 다시 누르면 그것만 빠진다", () => {
    const first = toggleChoice({ selected: [], custom: "" }, "A", true);
    const second = toggleChoice(first, "B", true);
    expect(second.selected).toEqual(["A", "B"]);
    expect(toggleChoice(second, "A", true).selected).toEqual(["B"]);
  });

  it("직접 입력은 다중 선택에서 고른 것들과 함께 선다", () => {
    const answer = setCustom({ selected: ["A"], custom: "" }, "그 외의 것", true);
    expect(answer).toEqual({ selected: ["A"], custom: "그 외의 것" });
  });

  it("단일 선택에서 직접 입력을 적으면 고른 항목이 빠진다 — '하나만' 이라는 약속을 지킨다", () => {
    const answer = setCustom({ selected: ["A"], custom: "" }, "직접 적은 답", false);
    expect(answer).toEqual({ selected: [], custom: "직접 적은 답" });
  });

  it("직접 입력을 지우면 고른 항목을 되살리지는 않는다 — 다만 답은 비어야 한다", () => {
    const answer = setCustom({ selected: [], custom: "적었던 글" }, "", false);
    expect(isAnswered(answer)).toBe(false);
  });

  it("직접 입력에도 상한이 있다", () => {
    const answer = setCustom({ selected: [], custom: "" }, "가".repeat(1_000), false);
    expect(answer.custom.length).toBe(500);
  });
});

describe("답했는가", () => {
  it("고른 것이 없어도 직접 입력이 있으면 답한 것이다", () => {
    expect(isAnswered({ selected: [], custom: "직접" })).toBe(true);
    expect(isAnswered({ selected: ["A"], custom: "" })).toBe(true);
    expect(isAnswered({ selected: [], custom: "   " })).toBe(false);
    expect(isAnswered({ selected: [], custom: "" })).toBe(false);
  });

  it("빈 초안에서도 답을 꺼낼 수 있다 — 화면이 매번 없는지 확인하지 않게", () => {
    expect(answerOf({}, "없는키")).toEqual({ selected: [], custom: "" });
  });

  it("모든 주제에 답해야 [보내기] 가 열린다", () => {
    const partial = draftWith({ q1: { selected: ["A"] }, q2: { custom: "직접" } });
    expect(allAnswered(QUESTIONS, partial)).toBe(false);
    expect(answeredCount(QUESTIONS, partial)).toBe(2);

    const full = draftWith({
      q1: { selected: ["A"] },
      q2: { custom: "직접" },
      q3: { selected: ["B"] },
    });
    expect(allAnswered(QUESTIONS, full)).toBe(true);
    expect(answeredCount(QUESTIONS, full)).toBe(3);
  });
});

describe("주제 이동", () => {
  it("다음으로 갈 곳은 '그 다음' 이 아니라 아직 비어 있는 주제다", () => {
    // 3번을 고치러 돌아왔다가 골랐다면 다음은 4번이 아니라 아직 안 고른 2번이어야 한다.
    const draft = draftWith({ q1: { selected: ["A"] }, q3: { selected: ["B"] } });
    expect(nextUnanswered(QUESTIONS, draft, 2)).toBe(1);
  });

  it("모두 답했으면 -1 — 화면은 그때 [보내기]로 넘어간다", () => {
    const draft = draftWith({
      q1: { selected: ["A"] },
      q2: { selected: ["A"] },
      q3: { selected: ["A"] },
    });
    expect(nextUnanswered(QUESTIONS, draft, 0)).toBe(-1);
  });

  it("주제 이동은 감기지 않는다 — 끝에서 한 번 더 눌러도 그 자리에 선다", () => {
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(1, -1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(0);
  });

  it("목록 안 커서는 감긴다 — 선택지는 짧아서 끝이 곧 처음이다", () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

describe("굳히기", () => {
  it("고른 것과 직접 입력을 함께 돌려준다", () => {
    const draft = draftWith({
      q1: { selected: ["A", "B"] },
      q2: { custom: "  직접 적은 답  " },
      q3: { selected: ["A"], custom: "덧붙임" },
    });
    const answers = finalizeAnswers(QUESTIONS, draft);

    expect(answers[0]).toEqual({
      header: "q1",
      question: "q1 를 고르세요",
      multiSelect: false,
      selected: ["A", "B"],
      answered: true,
    });
    // 앞뒤 공백은 걷어내고, 없으면 키 자체를 싣지 않는다.
    expect(answers[1].custom).toBe("직접 적은 답");
    expect(answers[1].selected).toEqual([]);
    expect(answers[2].custom).toBe("덧붙임");
    expect("custom" in answers[0]).toBe(false);
  });

  it("답하지 않은 주제는 answered: false 로 남는다", () => {
    const answers = finalizeAnswers(QUESTIONS, emptyDraft(QUESTIONS));
    expect(answers.every((answer) => answer.answered === false)).toBe(true);
  });
});

describe("사람이 읽는 한 줄", () => {
  it("고른 것과 직접 입력을 이어 붙인다", () => {
    expect(describeAnswer({ selected: ["A", "B"], custom: "" })).toBe("A, B");
    expect(describeAnswer({ selected: ["A"], custom: "그 외" })).toContain("A");
    expect(describeAnswer({ selected: ["A"], custom: "그 외" })).toContain("그 외");
    expect(describeAnswer({ selected: [], custom: "" })).toBe("");
  });

  it("요약은 접기 전(모델이 보낸 원본)도 받는다 — 칩은 그때 그려진다", () => {
    expect(summarizeAsk([{ header: "인증" }, { question: "배포 방식은?" }])).toBe(
      "인증, 배포 방식은?",
    );
    expect(summarizeAsk([])).toBe("");
  });

  it("긴 요약은 잘라서 칩 하나에 담는다", () => {
    const summary = summarizeAsk(
      Array.from({ length: 10 }, (_, index) => ({ header: `주제${index}번은길다` })),
    );
    expect(summary.length).toBeLessThanOrEqual(61);
    expect(summary.endsWith("…")).toBe(true);
  });
});
