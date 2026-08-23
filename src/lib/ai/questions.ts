/**
 * 사용자 선택(질문 카드) — **판정과 파생만** 담는 순수 층.
 *
 * 모델이 정책 판단이나 빠진 정보 앞에서 멈춰야 할 때 `ask_user_question` 으로 주제를 묶어
 * 물어보면, 사용자가 채팅 입력칸 위 카드에서 고른다. 승인 게이트(`lib/ai/approval.ts`)와
 * 같은 규율을 따른다 — **판정은 여기 순수 함수로 두고, 묻고 기다리는 일만
 * `store/questions.ts` 가 한다**. 화면(`components/chat/QuestionPrompt.tsx`)은 여기 있는
 * 함수를 쓰기만 하고 같은 규칙을 따로 적지 않는다. 두 곳에 적으면 반드시 어긋난다.
 *
 * 두 가지가 이 층의 존재 이유다.
 *
 * 1. **모델이 보낸 목록을 그대로 믿지 않는다.** 주제 수·선택지 수·글자 수에 상한이 없으면
 *    카드가 화면을 통째로 덮고, 빈 라벨·중복 라벨은 누를 수 없는 버튼이 된다.
 *    `normalizeQuestions()` 가 한 번 접어서 받는다.
 * 2. **마지막 칸은 언제나 직접 입력이다.** 모델이 내놓은 선택지가 셋 다 틀렸을 때
 *    사용자가 빠져나갈 길이 없으면 이 카드는 대화를 돕는 게 아니라 막는다.
 */
import { t } from "@/lib/i18n";

/** 한 번에 물을 수 있는 주제 수. 넘으면 잘라 받는다. */
export const MAX_QUESTIONS = 4;
/** 한 주제의 선택지 수 상한. 직접 입력 칸은 여기 포함되지 않는다(항상 하나 더 붙는다). */
export const MAX_OPTIONS = 6;
/** 모델에게 권하는 최소 선택지 수. 모자라도 거절하지 않고 직접 입력만 남긴다. */
export const MIN_OPTIONS = 2;
/** 칩에 들어가는 짧은 라벨(주제 이름)의 상한. */
export const MAX_HEADER_CHARS = 20;
/** 선택지 라벨의 상한. 버튼 한 줄에 들어가야 한다. */
export const MAX_LABEL_CHARS = 120;
/** 질문 본문·선택지 설명의 상한. */
export const MAX_TEXT_CHARS = 500;

/** 선택지 하나. */
export interface ChoiceOption {
  label: string;
  /** 무엇을 고르는 것인지 한 줄. 없으면 라벨만 보인다 */
  description?: string;
}

/** 주제 하나 = 카드 한 장. */
export interface ChoiceQuestion {
  /** 화면의 키이자 답을 담는 키. 모델이 주는 값이 아니라 여기서 매긴다 */
  id: string;
  /** 칩에 뜨는 짧은 이름 (예: "인증 방식") */
  header: string;
  /** 질문 전문 */
  question: string;
  /** 여러 개를 고를 수 있는가 */
  multiSelect: boolean;
  options: ChoiceOption[];
}

/** 대기열에 들어가는 요청 하나. 주제 여러 개를 한 묶음으로 묻는다. */
export interface ChoiceAsk {
  id: string;
  questions: ChoiceQuestion[];
  /** 서브에이전트가 물은 것이면 그 이름 — 누가 묻는지 화면에 밝힌다 */
  origin?: string;
}

/** 한 주제에 대한 답. 고른 항목들과 직접 입력은 **함께** 설 수 있다. */
export interface ChoiceAnswer {
  selected: string[];
  /** 마지막 칸에 사람이 직접 적은 글. 다중 선택이면 고른 것들과 함께 간다 */
  custom: string;
}

/** 주제 id → 답. 화면이 들고 있다가 [보내기] 때 한 번에 굳힌다. */
export type ChoiceDraft = Record<string, ChoiceAnswer>;

/** 모델에게 돌아가는 답 하나. */
export interface ChoiceResult {
  header: string;
  question: string;
  multiSelect: boolean;
  /** 고른 라벨들. 직접 입력만 했으면 빈 배열 */
  selected: string[];
  /** 직접 적은 글. 없으면 생략된다 */
  custom?: string;
  answered: boolean;
}

/** 카드가 풀리는 두 가지 결말. 취소도 예외가 아니라 **결과**다. */
export type ChoiceOutcome =
  | { answered: true; answers: ChoiceResult[] }
  | { answered: false; reason: string };

/** 요청 id. `crypto.randomUUID` 가 없는 환경(구형 웹뷰)도 대비한다. */
export function newAskId(prefix = "ask"): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function trimTo(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** 모델이 보낸 목록을 화면에 걸 수 있는 모양으로 접는다. */
export function normalizeQuestions(input: unknown): ChoiceQuestion[] {
  const raw = Array.isArray(input) ? input : [];
  const questions: ChoiceQuestion[] = [];

  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    const record = (item ?? {}) as Record<string, unknown>;
    const question = trimTo(record.question, MAX_TEXT_CHARS);
    // 질문 본문이 없으면 물을 것이 없다. 빈 카드를 띄우느니 그 주제를 버린다.
    if (!question) continue;

    const seen = new Set<string>();
    const options: ChoiceOption[] = [];
    for (const entry of Array.isArray(record.options) ? record.options : []) {
      const optionRecord = (entry ?? {}) as Record<string, unknown>;
      // 문자열만 준 경우도 받는다 — 스키마를 어기는 모델이 실제로 있다.
      const label = trimTo(
        typeof entry === "string" ? entry : optionRecord.label,
        MAX_LABEL_CHARS,
      );
      // 같은 라벨이 둘이면 어느 쪽을 눌렀는지 답에서 구별되지 않는다.
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const description =
        typeof entry === "string" ? "" : trimTo(optionRecord.description, MAX_TEXT_CHARS);
      options.push(description ? { label, description } : { label });
      if (options.length >= MAX_OPTIONS) break;
    }

    questions.push({
      id: newAskId("q"),
      // 칩 이름이 없으면 질문 앞머리를 잘라 쓴다. 빈 칩은 어느 주제인지 못 알아본다.
      header: trimTo(record.header, MAX_HEADER_CHARS) || trimTo(question, MAX_HEADER_CHARS),
      question,
      multiSelect: record.multiSelect === true,
      options,
    });
  }

  return questions;
}

/** 아직 아무것도 고르지 않은 초안. */
export function emptyDraft(questions: ChoiceQuestion[]): ChoiceDraft {
  const draft: ChoiceDraft = {};
  for (const question of questions) draft[question.id] = { selected: [], custom: "" };
  return draft;
}

/** 초안에서 한 주제의 답을 꺼낸다. 없으면 빈 답 — 화면이 매번 없는지 확인하지 않게. */
export function answerOf(draft: ChoiceDraft, questionId: string): ChoiceAnswer {
  return draft[questionId] ?? { selected: [], custom: "" };
}

/**
 * 선택지 하나를 누른 결과.
 *
 * 단일 선택은 **같은 것을 다시 누르면 풀린다** — 잘못 누른 것을 되돌리는 길이
 * "다른 걸 고르기" 밖에 없으면 사용자는 답을 지울 수 없다.
 */
export function toggleChoice(
  answer: ChoiceAnswer,
  label: string,
  multiSelect: boolean,
): ChoiceAnswer {
  const has = answer.selected.includes(label);
  if (!multiSelect) return { ...answer, selected: has ? [] : [label] };
  return {
    ...answer,
    selected: has
      ? answer.selected.filter((item) => item !== label)
      : [...answer.selected, label],
  };
}

/** 직접 입력 칸의 글을 갈아 끼운다. 단일 선택이면 고른 항목을 밀어낸다. */
export function setCustom(
  answer: ChoiceAnswer,
  text: string,
  multiSelect: boolean,
): ChoiceAnswer {
  const custom = text.slice(0, MAX_TEXT_CHARS);
  // 단일 선택에서 직접 입력과 고른 항목이 함께 서면 "하나만" 이라는 약속이 깨진다.
  if (!multiSelect && custom.trim()) return { selected: [], custom };
  return { ...answer, custom };
}

/** 이 주제에 답이 있는가. 고른 것이 없어도 직접 입력이 있으면 답한 것이다. */
export function isAnswered(answer: ChoiceAnswer): boolean {
  return answer.selected.length > 0 || answer.custom.trim().length > 0;
}

/** 모든 주제에 답했는가. [보내기] 는 이때만 열린다. */
export function allAnswered(questions: ChoiceQuestion[], draft: ChoiceDraft): boolean {
  return questions.every((question) => isAnswered(answerOf(draft, question.id)));
}

/** 답한 주제 수. 카드 머리의 진행 표시가 쓴다. */
export function answeredCount(questions: ChoiceQuestion[], draft: ChoiceDraft): number {
  return questions.filter((question) => isAnswered(answerOf(draft, question.id))).length;
}

/**
 * `from` 다음으로 아직 답하지 않은 주제. 없으면 `-1`.
 *
 * 뒤쪽부터 훑고 앞으로 감아 온다 — 사용자가 3번 주제를 고치러 돌아왔다가 고르면
 * 다음으로 갈 곳은 4번이 아니라 **아직 비어 있는** 주제여야 한다.
 */
export function nextUnanswered(
  questions: ChoiceQuestion[],
  draft: ChoiceDraft,
  from: number,
): number {
  for (let step = 1; step <= questions.length; step += 1) {
    const index = (from + step) % questions.length;
    if (!isAnswered(answerOf(draft, questions[index].id))) return index;
  }
  return -1;
}

/**
 * 주제 이동. **감기지 않는다** — 마지막에서 오른쪽을 누르면 그 자리에 선다.
 * 감아 돌면 방금 본 첫 주제로 튕겨 어디에 있는지 놓친다.
 */
export function moveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index + delta, 0), length - 1);
}

/** 목록 안에서의 세로 이동. 이쪽은 **감긴다** — 선택지는 짧아서 끝이 곧 처음이다. */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** 초안을 모델에게 돌려줄 모양으로 굳힌다. */
export function finalizeAnswers(
  questions: ChoiceQuestion[],
  draft: ChoiceDraft,
): ChoiceResult[] {
  return questions.map((question) => {
    const answer = answerOf(draft, question.id);
    const custom = answer.custom.trim();
    return {
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      selected: answer.selected,
      ...(custom ? { custom } : {}),
      answered: isAnswered(answer),
    };
  });
}

/** 한 주제의 답을 사람이 읽는 한 줄로. 카드의 주제 목록과 도구 요약이 같은 문구를 쓴다. */
export function describeAnswer(answer: ChoiceAnswer): string {
  const parts = [...answer.selected];
  const custom = answer.custom.trim();
  if (custom) parts.push(t("questions.customPrefix", { text: custom }));
  return parts.join(", ");
}

/**
 * 요청 한 줄 요약 — 도구 호출 칩과 진행 표시가 쓴다.
 *
 * 접기 전(모델이 보낸 원본)도 받는다. 칩은 도구 호출이 확정되는 순간 그려지는데
 * 그때는 아직 `normalizeQuestions()` 를 지나지 않은 입력뿐이다.
 */
export function summarizeAsk(
  questions: readonly { header?: string; question?: string }[],
): string {
  const headers = questions
    .map((question) => (question?.header || question?.question || "").trim())
    .filter(Boolean)
    .join(", ");
  return headers.length > 60 ? `${headers.slice(0, 60)}…` : headers;
}
