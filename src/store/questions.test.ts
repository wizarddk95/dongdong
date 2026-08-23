import { beforeEach, describe, expect, it } from "vitest";

import { emptyDraft } from "@/lib/ai/questions";
import { useQuestions } from "@/store/questions";

/** 카드가 화면에 뜰 때까지 (스토어 set 은 동기지만 request 는 async 다). */
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

const TOPICS = [
  { header: "라이브러리", question: "무엇으로 만들까요?", options: [{ label: "A" }, { label: "B" }] },
  { header: "범위", question: "어디까지 지울까요?", multiSelect: true, options: [{ label: "X" }] },
];

beforeEach(() => {
  useQuestions.setState({ queue: [] });
});

describe("useQuestions", () => {
  it("카드를 띄우고 사람이 보낼 때까지 기다린다", async () => {
    const pending = useQuestions.getState().request({ questions: TOPICS });
    await tick();

    const [ask] = useQuestions.getState().queue;
    expect(ask.questions).toHaveLength(2);
    expect(ask.questions[0].header).toBe("라이브러리");

    const draft = emptyDraft(ask.questions);
    draft[ask.questions[0].id] = { selected: ["A"], custom: "" };
    draft[ask.questions[1].id] = { selected: ["X"], custom: "그리고 이것도" };
    useQuestions.getState().submit(ask.id, draft);

    await expect(pending).resolves.toEqual({
      answered: true,
      answers: [
        {
          header: "라이브러리",
          question: "무엇으로 만들까요?",
          multiSelect: false,
          selected: ["A"],
          answered: true,
        },
        {
          header: "범위",
          question: "어디까지 지울까요?",
          multiSelect: true,
          selected: ["X"],
          custom: "그리고 이것도",
          answered: true,
        },
      ],
    });
    // 답을 보내고 나면 카드는 사라진다.
    expect(useQuestions.getState().queue).toHaveLength(0);
  });

  it("취소는 예외가 아니라 결과다 — 모델이 이유를 읽고 다음 수를 고른다", async () => {
    const pending = useQuestions.getState().request({ questions: TOPICS });
    await tick();

    const [ask] = useQuestions.getState().queue;
    useQuestions.getState().cancel(ask.id);

    const outcome = await pending;
    expect(outcome.answered).toBe(false);
    expect(outcome).toHaveProperty("reason");
    expect(useQuestions.getState().queue).toHaveLength(0);
  });

  it("물을 것이 하나도 없으면 카드를 띄우지 않고 곧바로 풀린다", async () => {
    // 질문 본문이 없는 주제만 왔다 → 접고 나면 남는 것이 없다.
    const outcome = await useQuestions.getState().request({ questions: [{ header: "이름만" }] });
    expect(outcome.answered).toBe(false);
    expect(useQuestions.getState().queue).toHaveLength(0);
  });

  it("이미 끊긴 턴이면 카드를 띄우지 않는다", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await useQuestions
      .getState()
      .request({ questions: TOPICS, signal: controller.signal });

    expect(outcome.answered).toBe(false);
    expect(useQuestions.getState().queue).toHaveLength(0);
  });

  it("기다리는 중에 [중지]를 누르면 카드가 풀린다 — 누를 곳 없는 버튼을 남기지 않는다", async () => {
    const controller = new AbortController();
    const pending = useQuestions
      .getState()
      .request({ questions: TOPICS, signal: controller.signal });
    await tick();
    expect(useQuestions.getState().queue).toHaveLength(1);

    controller.abort();

    const outcome = await pending;
    expect(outcome.answered).toBe(false);
    expect(useQuestions.getState().queue).toHaveLength(0);
  });

  it("턴이 끝나면 남은 카드를 전부 취소로 풀어 준다", async () => {
    const first = useQuestions.getState().request({ questions: TOPICS });
    const second = useQuestions.getState().request({ questions: TOPICS, origin: "탐색기" });
    await tick();
    expect(useQuestions.getState().queue).toHaveLength(2);

    useQuestions.getState().clear();

    expect((await first).answered).toBe(false);
    expect((await second).answered).toBe(false);
    expect(useQuestions.getState().queue).toHaveLength(0);
  });

  it("서브에이전트가 물으면 누가 묻는지 카드에 남는다", async () => {
    void useQuestions.getState().request({ questions: TOPICS, origin: "테스트 러너" });
    await tick();
    expect(useQuestions.getState().queue[0].origin).toBe("테스트 러너");
  });

  it("여러 요청이 겹쳐도 각자의 답으로 풀린다 — 화면은 맨 앞 하나만 띄운다", async () => {
    const first = useQuestions.getState().request({ questions: TOPICS });
    const second = useQuestions.getState().request({ questions: [TOPICS[0]] });
    await tick();

    const [askA, askB] = useQuestions.getState().queue;
    // 뒤엣것을 먼저 풀어도 앞엣것의 답이 섞이지 않는다.
    const draftB = emptyDraft(askB.questions);
    draftB[askB.questions[0].id] = { selected: ["B"], custom: "" };
    useQuestions.getState().submit(askB.id, draftB);

    const outcomeB = await second;
    expect(outcomeB).toMatchObject({ answered: true, answers: [{ selected: ["B"] }] });
    expect(useQuestions.getState().queue).toHaveLength(1);

    const draftA = emptyDraft(askA.questions);
    draftA[askA.questions[0].id] = { selected: ["A"], custom: "" };
    draftA[askA.questions[1].id] = { selected: [], custom: "직접" };
    useQuestions.getState().submit(askA.id, draftA);

    const outcomeA = await first;
    expect(outcomeA.answered).toBe(true);
    expect(outcomeA).toMatchObject({ answers: [{ selected: ["A"] }, { custom: "직접" }] });
  });

  it("없는 요청에 답해도 조용히 지나간다 (카드가 이미 풀린 뒤의 클릭)", () => {
    expect(() => useQuestions.getState().submit("없는id", {})).not.toThrow();
    expect(() => useQuestions.getState().cancel("없는id")).not.toThrow();
  });
});
