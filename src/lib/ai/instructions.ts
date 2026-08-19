/**
 * 프로젝트 지침 파일(`AGENTS.md`) 로딩.
 *
 * 사용자가 연 프로젝트 루트에 `AGENTS.md` 가 있으면 그 원문을 매 턴 컨텍스트 **맨 앞**에
 * 실어 보낸다. 에이전트가 그 프로젝트의 규칙(빌드 명령, 금지 사항, 구조)을 모른 채
 * 움직이지 않게 하는 것이 목적이다.
 *
 * 파일은 대화 도중에도 바뀔 수 있으므로(에이전트가 직접 고치기도 한다) 턴마다 다시 읽는다.
 */
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
    ? `\n\n(지침이 길어 앞부분 ${MAX_INSTRUCTION_CHARS.toLocaleString()}자만 실었습니다. 전체는 ${instructions.path} 를 직접 읽으세요.)`
    : "";

  const header = [
    `# 프로젝트 지침 (${instructions.path})`,
    "이 프로젝트의 규칙입니다. 아래 지침이 기본 동작보다 우선합니다.",
    "",
  ].join("\n");

  return `${header}${instructions.content}${notice}`;
}

/** 지침을 시스템 프롬프트 맨 앞에 붙인다 (컨텍스트 최상단). */
export function composeSystemPrompt(
  basePrompt: string,
  instructions: ProjectInstructions | null,
): string {
  if (!instructions) return basePrompt;
  return `${instructionBlock(instructions)}\n\n---\n\n${basePrompt}`;
}
