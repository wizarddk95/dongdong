/**
 * 스킬 — "무엇을 어떤 순서로 하는가" 를 적어 둔 절차서.
 *
 * **도구(`lib/ai/tools.ts`)와는 다른 층이다.** 도구는 실행 경로라 스키마째 매 턴 실리고
 * 모델이 곧바로 부른다. 스킬은 문서라서 **이름과 한 줄 설명만** 시스템 프롬프트에 실렸다가,
 * 모델이 "이건 그 절차가 필요하겠다" 고 판단할 때 `load_skill` 로 본문을 끌어온다.
 * 다 실어 두면 쓰지도 않을 절차서 수만 자가 매 턴 컨텍스트를 먹기 때문이다.
 *
 * 문서는 세 곳에서 온다 (뒤엣것이 같은 이름을 덮어쓴다):
 *   1. 내장 — `builtinSkills.ts` (코드에 박혀 있어 준비 없이 쓸 수 있다)
 *   2. 전역 — OS 앱 설정 디렉터리의 `skills/`
 *   3. 프로젝트 — 리포의 `.dongdong/skills/`
 * 디스크 두 곳을 읽어 오는 것은 Rust(`commands/skills.rs`)이고, 여기서는 파싱과 조립만 한다.
 */
import { tool, type ToolSet } from "@ai-sdk/provider-utils";
import { z } from "zod";

import { builtinSkillDocs } from "@/lib/ai/builtinSkills";
import { clip } from "@/lib/ai/tools";
import { entryNameProblem, type NameProblem } from "@/lib/fileNames";
import { t, type MessageKey } from "@/lib/i18n";
import type { SkillFile } from "@/types/ipc";

export type SkillSource = "builtin" | "user" | "project";

export interface SkillDoc {
  /** 모델이 `load_skill` 에 넘기는 이름. frontmatter 의 `name`, 없으면 폴더 이름. */
  name: string;
  /** 한 줄 설명 — **이것만 매 턴 컨텍스트에 실린다**. 언제 열어야 하는지를 적는다. */
  description: string;
  /** frontmatter 를 걷어낸 본문. `load_skill` 이 돌려주는 값. */
  body: string;
  /**
   * 파일 원문(frontmatter 포함). 설정 화면의 편집기가 고치는 것은 **이쪽**이다 —
   * 본문만 내주면 저장할 때 머리말을 다시 조립해야 하고, 그 조립이 파서와 어긋나는
   * 순간 사람이 적은 description 이 조용히 사라진다.
   */
  raw: string;
  source: SkillSource;
  /** 디스크 스킬만 갖는다. 설정 화면이 어디를 고치면 되는지 보여줄 때 쓴다. */
  path?: string;
  /** 문서가 너무 길어 Rust 가 잘랐다 */
  truncated?: boolean;
}

/** 설명이 없을 때 본문에서 주워 오는 길이 상한. */
const FALLBACK_DESCRIPTION_CHARS = 160;

/** 한 번에 실어 보내는 스킬 본문의 상한. 도구 출력과 같은 자를 쓴다. */
export const MAX_SKILL_BODY_CHARS = 20_000;

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/** `key: value` 만 읽는다. 스킬 frontmatter 는 이름과 설명 두 줄이면 충분해서 YAML 을 들이지 않는다. */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    // 따옴표는 벗긴다 — YAML 습관대로 감싸 적는 사람이 많다.
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && value) out[key] = value;
  }
  return out;
}

/** 설명이 비었을 때 본문 첫 문장으로 대신한다 — 목록에 이름만 덩그러니 남지 않게. */
function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (!text) continue;
    return text.length > FALLBACK_DESCRIPTION_CHARS
      ? `${text.slice(0, FALLBACK_DESCRIPTION_CHARS)}…`
      : text;
  }
  return "";
}

/** 문서 원문 → 스킬 하나. frontmatter 가 없어도 받아 준다(그냥 마크다운 메모여도 쓸 수 있게). */
export function parseSkillDoc(
  content: string,
  options: { folder: string; source: SkillSource; path?: string; truncated?: boolean },
): SkillDoc {
  const match = content.match(FRONTMATTER);
  const meta = match ? parseFrontmatter(match[1]) : {};
  const body = (match ? content.slice(match[0].length) : content).trim();

  return {
    name: meta.name || options.folder,
    description: meta.description || firstMeaningfulLine(body),
    body,
    raw: content,
    source: options.source,
    path: options.path,
    truncated: options.truncated,
  };
}

/** 내장 스킬. 매번 같은 결과라 호출부에서 캐시할 필요는 없다(문서 3개 파싱). */
export function builtinSkills(): SkillDoc[] {
  return builtinSkillDocs().map((doc) =>
    parseSkillDoc(doc.content, { folder: doc.folder, source: "builtin" }),
  );
}

/**
 * 내장 + 디스크 문서를 하나의 목록으로 합친다.
 * 같은 이름이면 **뒤엣것이 이긴다**: 프로젝트 > 전역 > 내장.
 * (Rust 가 전역을 먼저, 프로젝트를 뒤에 실어 보내므로 순서를 그대로 믿는다)
 */
export function mergeSkills(files: SkillFile[]): SkillDoc[] {
  const byName = new Map<string, SkillDoc>();
  for (const skill of builtinSkills()) byName.set(skill.name, skill);

  for (const file of files) {
    const parsed = parseSkillDoc(file.content, {
      folder: file.folder,
      source: file.source,
      path: file.path,
      truncated: file.truncated,
    });
    if (!parsed.body.trim()) continue; // 빈 파일은 스킬이 아니다
    byName.set(parsed.name, parsed);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 설정의 토글을 적용한다. **목록에 없으면 켜진 것으로 본다** —
 * 새 내장 스킬이 추가돼도 예전 settings.json 이 그걸 조용히 끄면 안 된다.
 */
export function enabledSkills(
  skills: SkillDoc[],
  toggles: Record<string, boolean> = {},
): SkillDoc[] {
  return skills.filter((skill) => toggles[skill.name] !== false);
}

/**
 * 시스템 프롬프트에 실리는 스킬 목록. **본문은 넣지 않는다** — 이게 스킬의 요점이다.
 * 스킬이 없으면 빈 문자열을 돌려주므로 호출부가 조건문을 따로 두지 않아도 된다.
 */
export function skillCatalogBlock(skills: SkillDoc[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map((skill) => {
    const description = skill.description || t("skill.noDescription");
    return `- ${skill.name}: ${description}`;
  });

  return [
    t("skill.block.heading"),
    t("skill.block.lead"),
    t("skill.block.rule"),
    t("skill.block.noGuess"),
    "",
    ...lines,
  ].join("\n");
}

/** 스킬 목록을 시스템 프롬프트 **뒤**에 붙인다. 앞은 프로젝트 지침 자리다. */
export function appendSkillCatalog(prompt: string, skills: SkillDoc[]): string {
  const block = skillCatalogBlock(skills);
  return block ? `${prompt}\n\n---\n\n${block}` : prompt;
}

/**
 * `load_skill` 도구. 스킬이 하나도 없으면 만들지 않는다 —
 * 부를 것이 없는 도구를 스키마로 실어 보내면 컨텍스트만 축낸다.
 */
export function buildSkillTools(skills: SkillDoc[]): ToolSet {
  if (skills.length === 0) return {};

  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = skills.map((skill) => skill.name);

  return {
    load_skill: tool({
      description: t("skill.load.description", { names: names.join(", ") }),
      inputSchema: z.object({
        name: z.string().describe(t("skill.load.nameParam", { names: names.join(" | ") })),
      }),
      execute: async ({ name }) => {
        const skill = byName.get(name) ?? byName.get(name.trim().toLowerCase());
        if (!skill) {
          // 없는 이름을 부르면 목록을 다시 알려 준다 — 모델이 스스로 고치게.
          return { found: false, name, available: names };
        }
        const { text, clipped } = clip(skill.body, MAX_SKILL_BODY_CHARS);
        return {
          found: true,
          name: skill.name,
          source: skill.source,
          path: skill.path,
          content: text,
          truncated: clipped || skill.truncated === true,
        };
      },
    }),
  };
}

/**
 * 새 스킬 이름 판정(순수). 파일 이름 규칙(`entryNameProblem`)을 그대로 쓰되
 * **중복은 같은 범위 안에서만** 본다 — 프로젝트 스킬로 내장 `xlsx` 를 덮어쓰는 것은
 * 막을 일이 아니라 스킬이 쌓이는 방식 그 자체다(프로젝트 > 전역 > 내장).
 */
export function skillNameProblem(
  raw: string,
  existing: readonly SkillDoc[],
  scope: "user" | "project",
): NameProblem | null {
  const sameScope = existing.filter((skill) => skill.source === scope).map((skill) => skill.name);
  return entryNameProblem(raw, sameScope);
}

/** 설정 화면에서 출처를 짧게 보여줄 때 쓰는 라벨 키. */
export const SKILL_SOURCE_LABEL_KEY: Record<SkillSource, MessageKey> = {
  builtin: "skill.source.builtin",
  user: "skill.source.global",
  project: "skill.source.project",
};
