/**
 * 프로젝트 지침 파일(`AGENTS.md`) 로딩.
 *
 * 사용자가 연 프로젝트 루트에 `AGENTS.md` 가 있으면 그 원문을 매 턴 컨텍스트 **맨 앞**에
 * 실어 보낸다. 에이전트가 그 프로젝트의 규칙(빌드 명령, 금지 사항, 구조)을 모른 채
 * 움직이지 않게 하는 것이 목적이다.
 *
 * 파일은 대화 도중에도 바뀔 수 있으므로(에이전트가 직접 고치기도 한다) 턴마다 다시 읽는다.
 */
import { datetimeBlock } from "@/lib/ai/datetime";
import { t } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";

/** 위에서부터 먼저 찾히는 파일 하나만 쓴다. */
export const INSTRUCTION_FILES = ["AGENTS.md", "agents.md"];

/** 지침이 컨텍스트를 통째로 잡아먹지 않도록 상한을 둔다. */
export const MAX_INSTRUCTION_CHARS = 24_000;

export interface ProjectInstructions {
  /** 프로젝트 루트 기준 상대 경로 */
  path: string;
  content: string;
  truncated: boolean;
  loadedAt: string;
}

/**
 * 프로젝트 루트의 지침 파일을 읽는다. 없으면 `null`.
 * (지침이 없는 프로젝트가 정상이므로 에러로 취급하지 않는다)
 */
export async function loadProjectInstructions(
  projectPath?: string,
): Promise<ProjectInstructions | null> {
  for (const name of INSTRUCTION_FILES) {
    try {
      const file = await ipc.readFile(name, projectPath);
      if (file.isBinary) continue;

      const content = file.content.trim();
      if (!content) continue;

      const truncated = content.length > MAX_INSTRUCTION_CHARS;
      return {
        path: file.relativePath,
        content: truncated ? content.slice(0, MAX_INSTRUCTION_CHARS) : content,
        truncated: truncated || file.truncated,
        loadedAt: new Date().toISOString(),
      };
    } catch {
      // 파일이 없으면 Rust 가 NotFound 를 던진다. 다음 후보로 넘어간다.
    }
  }
  return null;
}

/**
 * 지침 블록. 원문을 그대로 싣고 출처를 밝혀서,
 * 인스펙터로 열었을 때 무엇이 왜 들어갔는지 보이게 한다.
 */
export function instructionBlock(instructions: ProjectInstructions): string {
  const notice = instructions.truncated
    ? `\n\n${t("instructions.truncated", {
        limit: MAX_INSTRUCTION_CHARS.toLocaleString(),
        path: instructions.path,
      })}`
    : "";

  const header = [
    t("instructions.heading", { path: instructions.path }),
    t("instructions.lead"),
    "",
  ].join("\n");

  return `${header}${instructions.content}${notice}`;
}

/**
 * 도구를 부르기 전에 먼저 말하게 하는 블록.
 *
 * 아무 말 없이 도구부터 부르면 사람은 **지시가 제대로 전달됐는지 알 방법이 없다** —
 * 화면에는 도구 이름만 뜨고, 그게 내가 부탁한 일인지 엉뚱한 일인지 결과가 나올 때까지
 * 모른다. 그래서 한두 문장을 먼저 뱉게 하고, 그 문장으로 사람이 방향을 확인하게 한다.
 *
 * **사용자 프롬프트가 아니라 앱이 싣는다.** 프롬프트를 직접 고쳐 쓴 사람도 이 동작은
 * 그대로 받아야 하기 때문이다(고쳐 쓴 글에 이 규칙을 대신 적어 줄 방법이 없다).
 * 무엇이 실렸는지는 인스펙터에 원문 그대로 보인다.
 */
export function preambleBlock(): string {
  return t("prompt.preamble");
}

/**
 * 시스템 프롬프트를 조립한다.
 *
 * 순서에 뜻이 있다: **프로젝트 지침이 맨 앞**(컨텍스트 최상단), 그다음 기본 프롬프트,
 * 앱이 고정으로 싣는 답변 규칙, **현재 시각은 맨 뒤** — 대화 바로 앞에 두어야 "지금" 이
 * 가장 가까이서 읽힌다.
 *
 * `now` 를 넘기면 시각 블록이 붙는다. 넘길지 말지는 부르는 쪽이 설정(`injectDateTime`)을
 * 보고 정한다. 채팅 게이지·인스펙터·실제 전송이 **같은 함수**를 쓰므로 세 화면이
 * 같은 값을 말한다 — 여기서 갈라지면 게이지가 거짓말을 한다.
 */
export function composeSystemPrompt(
  basePrompt: string,
  instructions: ProjectInstructions | null,
  now?: Date | null,
): string {
  const blocks = [
    instructions ? instructionBlock(instructions) : "",
    basePrompt,
    preambleBlock(),
    now ? datetimeBlock(now) : "",
  ].filter(Boolean);

  return blocks.join("\n\n---\n\n");
}
