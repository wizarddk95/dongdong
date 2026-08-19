/**
 * Skill 레이어 — `lib/ipc.ts` 의 IPC 함수를 Vercel AI SDK 의 도구(tool)로 노출한다.
 *
 * 모든 실제 I/O 는 Rust 백엔드가 사용자 OS 권한으로 수행하고,
 * 경로 제한(프로젝트 루트 밖 금지)도 Rust `paths::resolve_within` 이 담당한다.
 * 여기서는 스키마 정의와 LLM 이 읽기 좋은 형태로의 결과 정리만 한다.
 *
 * 도구 실행 자체는 승인 절차 없이 바로 이루어진다. 무엇을 켤지는
 * 설정의 스킬 토글(`SkillToggles`)로 사용자가 결정한다.
 */
import { tool, type ToolSet } from "@ai-sdk/provider-utils";
import { z } from "zod";

import * as ipc from "@/lib/ipc";

/** 설정에서 켜고 끄는 스킬 묶음. */
export interface SkillToggles {
  /** read_file / list_directory / path_info */
  fsRead: boolean;
  /** write_file / create_directory / delete_path */
  fsWrite: boolean;
  /** execute_shell_command */
  shell: boolean;
  /** remember / recall */
  memory: boolean;
  /** delegate_task (서브에이전트 위임) */
  subagents: boolean;
  /** 연결된 MCP 서버가 제공하는 도구 (`buildMcpTools` 로 따로 만들어 합친다) */
  mcp: boolean;
}

export const DEFAULT_SKILLS: SkillToggles = {
  fsRead: true,
  fsWrite: true,
  shell: true,
  memory: true,
  subagents: true,
  mcp: true,
};

/** `delegate_task` 가 돌려주는 값. 서브에이전트가 끝난 뒤의 요약이다. */
export interface DelegateResult {
  runId: string;
  name: string;
  status: string;
  result?: string;
  error?: string;
}

export interface SkillOptions {
  enabled?: Partial<SkillToggles>;
  /** `scope: "session"` 메모리의 기준 세션 */
  sessionId?: string | null;
  /** 생략하면 활성 프로젝트를 쓴다 */
  projectPath?: string;
  /**
   * 위임 실행기. 넘기지 않으면 `delegate_task` 자체가 노출되지 않는다.
   * 서브에이전트에게 도구를 만들어 줄 때는 일부러 생략해 재위임을 막는다.
   */
  onDelegate?: (input: {
    name: string;
    task: string;
    /** 메인 턴이 중단되면 함께 끊긴다 */
    signal?: AbortSignal;
  }) => Promise<DelegateResult>;
}

/** 도구 하나가 LLM 컨텍스트를 통째로 잡아먹지 않도록 출력에 상한을 둔다. */
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_DIR_ENTRIES = 300;

function clip(text: string, limit = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= limit) return { text, clipped: false };
  return { text: `${text.slice(0, limit)}\n…(이하 ${text.length - limit}자 생략)`, clipped: true };
}

/** 스킬 묶음별 도구 이름. 컨텍스트 인스펙터와 설정 UI 가 함께 쓴다. */
export const SKILL_GROUPS: { id: keyof SkillToggles; label: string; tools: string[] }[] = [
  { id: "fsRead", label: "파일 읽기", tools: ["read_file", "list_directory", "path_info"] },
  { id: "fsWrite", label: "파일 쓰기", tools: ["write_file", "create_directory", "delete_path"] },
  { id: "shell", label: "쉘 실행", tools: ["execute_shell_command"] },
  { id: "memory", label: "메모리", tools: ["remember", "recall"] },
  { id: "subagents", label: "서브에이전트", tools: ["delegate_task"] },
  { id: "mcp", label: "MCP 서버 도구", tools: ["mcp__<서버>__<도구>"] },
];

/**
 * 활성화된 스킬만 담은 ToolSet 을 만든다.
 * `runner.ts` 의 `tools` 인자로 그대로 넘어간다.
 */
export function buildSkills(options: SkillOptions = {}): ToolSet {
  const enabled = { ...DEFAULT_SKILLS, ...options.enabled };
  const projectPath = options.projectPath;
  const sessionId = options.sessionId ?? null;
  const tools: ToolSet = {};

  if (enabled.fsRead) {
    tools.read_file = tool({
      description:
        "파일 하나를 읽는다. 경로는 프로젝트 루트 기준 상대 경로를 권장한다. 바이너리는 내용 없이 메타데이터만 돌아온다.",
      inputSchema: z.object({
        path: z.string().describe("읽을 파일 경로 (프로젝트 루트 기준 상대 경로 권장)"),
      }),
      execute: async ({ path }) => {
        const file = await ipc.readFile(path, projectPath);
        const { text } = clip(file.content);
        return {
          path: file.relativePath,
          content: text,
          size: file.size,
          truncated: file.truncated,
          isBinary: file.isBinary,
        };
      },
    });

    tools.list_directory = tool({
      description: "디렉터리 목록을 본다. path 를 생략하면 프로젝트 루트를 본다.",
      inputSchema: z.object({
        path: z.string().optional().describe("조회할 디렉터리 (생략 시 프로젝트 루트)"),
        includeHidden: z.boolean().optional().describe("숨김 파일 포함 여부 (기본 false)"),
      }),
      execute: async ({ path, includeHidden }) => {
        const entries = await ipc.listDirectory(path, { projectPath, includeHidden });
        return {
          path: path ?? ".",
          total: entries.length,
          entries: entries.slice(0, MAX_DIR_ENTRIES).map((entry) => ({
            name: entry.name,
            path: entry.relativePath,
            isDir: entry.isDir,
            size: entry.size,
          })),
          truncated: entries.length > MAX_DIR_ENTRIES,
        };
      },
    });

    tools.path_info = tool({
      description: "경로의 존재 여부와 종류(파일/디렉터리), 크기를 확인한다.",
      inputSchema: z.object({ path: z.string().describe("확인할 경로") }),
      execute: async ({ path }) => {
        const info = await ipc.pathInfo(path, projectPath);
        return {
          path: info.path,
          exists: info.exists,
          isDir: info.isDir,
          isFile: info.isFile,
          size: info.size,
        };
      },
    });
  }

  if (enabled.fsWrite) {
    tools.write_file = tool({
      description:
        "파일을 쓴다. 기본은 전체 덮어쓰기이며 상위 디렉터리는 자동 생성된다. 수정 전에는 read_file 로 현재 내용을 먼저 확인할 것.",
      inputSchema: z.object({
        path: z.string().describe("쓸 파일 경로"),
        content: z.string().describe("파일에 쓸 전체 내용"),
        append: z.boolean().optional().describe("true 면 덮어쓰지 않고 끝에 이어 붙인다"),
      }),
      execute: async ({ path, content, append }) => {
        const result = await ipc.writeFile(path, content, { projectPath, append });
        return {
          path: result.relativePath,
          bytesWritten: result.bytesWritten,
          created: result.created,
          mode: append ? "append" : "overwrite",
        };
      },
    });

    tools.create_directory = tool({
      description: "디렉터리를 만든다 (중간 경로 포함).",
      inputSchema: z.object({ path: z.string().describe("만들 디렉터리 경로") }),
      execute: async ({ path }) => ({ path: await ipc.createDirectory(path, projectPath) }),
    });

    tools.delete_path = tool({
      description:
        "파일이나 디렉터리를 삭제한다. 디렉터리를 지우려면 recursive 를 true 로 줘야 한다. 되돌릴 수 없으니 신중히 쓸 것.",
      inputSchema: z.object({
        path: z.string().describe("삭제할 경로"),
        recursive: z.boolean().optional().describe("디렉터리를 하위까지 통째로 지울 때 true"),
      }),
      execute: async ({ path, recursive }) => ({
        path,
        deleted: await ipc.deletePath(path, { projectPath, recursive }),
      }),
    });
  }

  if (enabled.shell) {
    tools.execute_shell_command = tool({
      description:
        "로컬 쉘에서 명령을 실행한다 (Windows 는 cmd, macOS 는 zsh, Linux 는 sh). 샌드박스가 아니라 사용자 권한으로 그대로 실행되며, cwd 기본값은 프로젝트 루트다.",
      inputSchema: z.object({
        command: z.string().describe("실행할 명령 한 줄"),
        cwd: z.string().optional().describe("작업 디렉터리 (생략 시 프로젝트 루트)"),
        timeoutMs: z.number().int().positive().optional().describe("타임아웃 (기본 120000ms)"),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        const result = await ipc.executeShellCommand(command, {
          cwd,
          timeoutMs,
          projectPath,
        });
        const stdout = clip(result.stdout);
        const stderr = clip(result.stderr, 4_000);
        return {
          command: result.command,
          cwd: result.cwd,
          exitCode: result.exitCode,
          success: result.success,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: result.truncated || stdout.clipped || stderr.clipped,
        };
      },
    });
  }

  if (enabled.memory) {
    tools.remember = tool({
      description:
        "다음 대화에서도 기억해야 할 사실을 저장한다. 같은 key 로 다시 저장하면 값이 갱신된다. " +
        "프로젝트 전반에 통하는 사실은 scope=project, 지금 세션에서만 유효한 메모는 scope=session.",
      inputSchema: z.object({
        key: z.string().describe("짧은 식별 키 (예: '빌드 명령')"),
        value: z.string().describe("기억할 내용"),
        scope: z.enum(["project", "session"]).optional().describe("기본값 project"),
      }),
      execute: async ({ key, value, scope }) => {
        const saved = await ipc.upsertMemory(
          { key, value, scope: scope ?? "project", sessionId },
          projectPath,
        );
        return { key: saved.key, scope: saved.scope, updatedAt: saved.updatedAt };
      },
    });

    tools.recall = tool({
      description:
        "저장해 둔 메모리를 읽는다. key 를 주면 그 항목만, 생략하면 이 프로젝트/세션의 메모리를 모두 돌려준다.",
      inputSchema: z.object({
        key: z.string().optional().describe("특정 항목만 찾을 때의 키"),
      }),
      execute: async ({ key }) => {
        const memories = await ipc.listMemories(sessionId, projectPath);
        const filtered = key ? memories.filter((memory) => memory.key === key) : memories;
        return {
          total: filtered.length,
          memories: filtered.map((memory) => ({
            key: memory.key,
            value: memory.value,
            scope: memory.scope,
            updatedAt: memory.updatedAt,
          })),
        };
      },
    });
  }

  // 위임 실행기가 있을 때만 노출한다. 서브에이전트는 이 도구를 받지 못한다.
  if (enabled.subagents && options.onDelegate) {
    const delegate = options.onDelegate;
    tools.delegate_task = tool({
      description:
        "독립적으로 끝낼 수 있는 하위 작업을 서브에이전트에게 맡기고 결과 요약을 받는다. " +
        "서브에이전트는 같은 프로젝트에서 파일과 쉘을 쓸 수 있지만 이 대화의 맥락은 모른다. " +
        "한 스텝에서 여러 번 호출하면 병렬로 실행된다. " +
        "탐색·조사처럼 분량이 큰 일에 쓰고, 최종 판단과 사용자 응답은 직접 한다.",
      inputSchema: z.object({
        name: z.string().describe("대시보드에 표시할 짧은 이름 (예: '테스트 러너')"),
        task: z
          .string()
          .describe(
            "서브에이전트가 혼자 읽고 수행할 수 있는 작업 지시. 필요한 파일 경로와 완료 기준을 포함할 것.",
          ),
      }),
      // 턴을 중지하면 띄워 둔 서브에이전트도 함께 멈춰야 한다.
      execute: async ({ name, task }, { abortSignal }) => delegate({ name, task, signal: abortSignal }),
    });
  }

  return tools;
}

/** 지금 켜져 있는 도구 이름 목록. 컨텍스트 스냅샷에 함께 남긴다. */
export function skillNames(options: SkillOptions = {}): string[] {
  return Object.keys(buildSkills(options));
}

/** 도구 호출을 트리/버블에 한 줄로 보여줄 때 쓰는 요약. */
export function summarizeToolCall(toolName: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const hint =
    typeof record.command === "string"
      ? record.command
      : typeof record.path === "string"
        ? record.path
        : typeof record.key === "string"
          ? record.key
          : typeof record.name === "string"
            ? record.name
            : "";
  const trimmed = hint.length > 60 ? `${hint.slice(0, 60)}…` : hint;
  return trimmed ? `${toolName}(${trimmed})` : toolName;
}
