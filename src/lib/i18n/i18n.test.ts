import { beforeEach, describe, expect, it } from "vitest";

import { en } from "@/lib/i18n/en";
import { ko } from "@/lib/i18n/ko";
import {
  getLocale,
  matchesAnyLocale,
  setLocale,
  subscribeLocale,
  t,
  translate,
  type MessageKey,
} from "@/lib/i18n";
import { detectLocale, normalizeLocale } from "@/lib/i18n/locale";
import { composeSystemPrompt } from "@/lib/ai/instructions";
import { appendSkillCatalog, mergeSkills } from "@/lib/ai/skills";

const KO_KEYS = Object.keys(ko) as MessageKey[];

/** `{name}` 자리표만 뽑는다. 두 사전이 같은 자리를 써야 값이 빠지지 않는다. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

beforeEach(() => {
  setLocale("ko");
});

describe("사전", () => {
  it("두 사전의 키 집합이 정확히 같다", () => {
    expect(Object.keys(en).sort()).toEqual(KO_KEYS.slice().sort());
  });

  it("빈 문장을 남겨 두지 않는다", () => {
    for (const key of KO_KEYS) {
      expect(ko[key].length, `ko: ${key}`).toBeGreaterThan(0);
      expect(en[key].length, `en: ${key}`).toBeGreaterThan(0);
    }
  });

  it("같은 키의 자리표가 두 언어에서 일치한다", () => {
    // 한쪽에만 있는 자리표는 그 언어에서만 값이 사라지는 조용한 버그가 된다.
    for (const key of KO_KEYS) {
      expect(placeholders(en[key]), `key: ${key}`).toEqual(placeholders(ko[key]));
    }
  });

  it("영어 사전에 한글이 남아 있지 않다", () => {
    for (const key of KO_KEYS) {
      expect(/[가-힣]/.test(en[key]), `key: ${key}`).toBe(false);
    }
  });
});

describe("translate", () => {
  it("자리표를 채운다", () => {
    expect(translate("ko", "time.seconds", { seconds: 12 })).toBe("12초");
    expect(translate("en", "time.seconds", { seconds: 12 })).toBe("12s");
  });

  it("값이 없는 자리표는 원문 그대로 남긴다 — 빈칸보다 눈에 띄어야 고친다", () => {
    expect(translate("ko", "time.seconds")).toBe("{seconds}초");
  });

  it("알 수 없는 로케일은 기본 사전으로 떨어진다", () => {
    expect(translate("de" as never, "theme.dark")).toBe(ko["theme.dark"]);
  });
});

describe("현재 언어", () => {
  it("setLocale 이 t() 를 바꾼다", () => {
    expect(t("theme.dark")).toBe("다크");
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("theme.dark")).toBe("Dark");
  });

  it("구독자에게 알린다 — 같은 값으로 다시 세우면 알리지 않는다", () => {
    let calls = 0;
    const stop = subscribeLocale(() => calls++);
    setLocale("en");
    setLocale("en");
    expect(calls).toBe(1);
    stop();
    setLocale("ko");
    expect(calls).toBe(1);
  });

  it("알 수 없는 값은 기본값으로 되돌린다", () => {
    expect(normalizeLocale("fr")).toBe("ko");
    expect(normalizeLocale(undefined)).toBe("ko");
    expect(normalizeLocale("en")).toBe("en");
  });
});

describe("detectLocale", () => {
  it("한국어권만 ko, 나머지는 en 으로 연다", () => {
    expect(detectLocale(["ko-KR", "en-US"])).toBe("ko");
    expect(detectLocale(["KO"])).toBe("ko");
    expect(detectLocale(["en-GB"])).toBe("en");
    expect(detectLocale(["ja-JP"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
});

describe("matchesAnyLocale", () => {
  it("어느 언어의 기본값이든 알아본다", () => {
    // 한국어로 만든 세션을 영어로 바꾼 뒤에도 "이름 없음" 으로 읽혀야 한다.
    setLocale("en");
    expect(matchesAnyLocale("session.untitled", "새 대화")).toBe(true);
    expect(matchesAnyLocale("session.untitled", "New chat")).toBe(true);
    expect(matchesAnyLocale("session.untitled", "직접 지은 제목")).toBe(false);
  });
});

describe("모델에게 가는 문장", () => {
  // 화면만 영어로 바뀌고 프롬프트가 한국어로 남으면 "영어를 골랐는데 왜 한국어로 답하지" 가 된다.
  // 컨텍스트에 실리는 블록을 통째로 조립해서 한글이 한 글자도 없는지 본다.
  it("영어를 고르면 시스템 프롬프트 · 스킬 목록 · 시각 블록에 한글이 없다", () => {
    setLocale("en");
    const skills = mergeSkills([]);
    const prompt = appendSkillCatalog(
      composeSystemPrompt(t("prompt.default"), null, new Date("2026-08-22T05:03:00Z")),
      skills,
    );

    expect(skills.length).toBeGreaterThan(0); // 내장 스킬이 실제로 실렸는지 먼저 확인
    expect(prompt).toContain("Available skills");
    expect(/[가-힣]/.test(prompt)).toBe(false);
  });

  it("한국어를 고르면 같은 블록이 한국어로 조립된다", () => {
    setLocale("ko");
    const prompt = appendSkillCatalog(
      composeSystemPrompt(t("prompt.default"), null, new Date("2026-08-22T05:03:00Z")),
      mergeSkills([]),
    );
    expect(prompt).toContain("사용할 수 있는 스킬");
    expect(prompt).toContain("현재 시각");
  });
});
