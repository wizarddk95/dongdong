/**
 * 도구(tool) 레이어 — `lib/ipc.ts` 의 IPC 함수를 Vercel AI SDK 의 도구로 노출한다.
 *
 * **스킬(`lib/ai/skills.ts`)과는 다른 것이다**: 도구는 매 턴 스키마째 컨텍스트에 실려
 * 모델이 곧바로 부를 수 있는 실행 경로이고, 스킬은 절차를 적어 둔 문서라 이름과 설명만
 * 실렸다가 모델이 필요하다고 판단할 때 `load_skill` 로 본문을 끌어온다.
 *
 * 모든 실제 I/O 는 Rust 백엔드가 사용자 OS 권한으로 수행하고,
 * 경로 제한(프로젝트 루트 밖 금지)도 Rust `paths::resolve_within` 이 담당한다.
 * 여기서는 스키마 정의와 LLM 이 읽기 좋은 형태로의 결과 정리만 한다.
 *
 * 무엇을 켤지는 설정의 도구 토글(`ToolToggles`)로 사용자가 정한다.
 * 그 위에 **셸만은 실행 직전 승인**을 한 겹 더 받는다 — `requestApproval` 이 넘어오면
 * 게이트가 열릴 때까지 도구가 그 자리에서 기다린다(`store/approvals.ts`).
 */
import { tool, type ToolSet } from "@ai-sdk/provider-utils";
import { z } from "zod";

import { redact } from "@/lib/ai/redact";
import { t, type MessageKey } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";

/** 설정에서 켜고 끄는 도구 묶음. */
export interface ToolToggles {
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

export const DEFAULT_TOOLS: ToolToggles = {
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

/** 승인 게이트에 넘어가는 사실들. 화면의 카드가 이 값을 그대로 읽는다. */
export interface ApprovalAsk {
  /** 생략하면 셸 실행 */
  kind?: "shell" | "delete";
  toolName: string;
  /** 셸이면 명령 원문, 삭제면 지울 경로 */
  command: string;
  /** 명령만으로는 안 보이는 사실 한 줄 */
  detail?: string;
  cwd?: string;
  /** 서브에이전트가 부른 것이면 그 이름 */
  origin?: string;
  signal?: AbortSignal;
}

export interface ToolOptions {
  enabled?: Partial<ToolToggles>;
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
  /**
   * 실행 승인 게이트 — 셸 실행과 **삭제**가 지난다.
   * 넘기지 않으면 예전처럼 곧바로 실행한다(테스트와 승인이 필요 없는 호출 경로).
   */
  requestApproval?: (ask: ApprovalAsk) => Promise<{ approved: boolean; reason?: string }>;
  /** 승인 카드에 "누가 요청했는지" 를 적기 위한 이름. 서브에이전트가 채운다. */
  origin?: string;
}

/**
 * 진짜로 돌고 있는 작업(셸 프로세스 · MCP 서버)에 붙이는 중단 토큰.
 * `crypto.randomUUID` 가 없는 환경(구형 웹뷰)도 대비한다.
 */
export function newCancelToken(prefix = "call"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 도구 하나가 LLM 컨텍스트를 통째로 잡아먹지 않도록 출력에 상한을 둔다. MCP 도구도 같은 자를 쓴다. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_DIR_ENTRIES = 300;

/**
 * 셸 한 번이 붙잡을 수 있는 최대 시간 (10분).
 *
 * 모델이 `timeoutMs` 를 크게 잡으면 턴이 그만큼 멈춰 서고, 화면에서는 그게 "무한 로딩" 과
 * 구별되지 않는다. 상한을 여기서 한 번 접어 두면 어떤 입력이 와도 끝은 온다.
 * (Rust 도 같은 값으로 다시 조인다 — 한쪽만 믿지 않는다)
 */
export const MAX_SHELL_TIMEOUT_MS = 600_000;

/**
 * 도구 출력에 상한을 씌우고, **그 전에 비밀값을 지운다**.
 *
 * 자르기와 가리기를 한 함수에 묶은 이유는 하나다 — 도구 출력이 컨텍스트로 들어가는 목이
 * 여기 하나뿐이라(내장 도구·MCP·스킬 본문이 전부 이 함수를 지난다) 새 도구를 붙이는 사람이
 * 가리기를 따로 기억할 필요가 없다. 순서도 중요하다: 먼저 가리고 나서 잘라야
 * 경계에 걸친 키가 반쪽만 남는 일이 없다.
 */
export function clip(text: string, limit = MAX_TOOL_OUTPUT_CHARS) {
  const safe = redact(text);
  if (safe.length <= limit) return { text: safe, clipped: false };
  return {
    text: `${safe.slice(0, limit)}\n${t("tool.clipped", { chars: safe.length - limit })}`,
    clipped: true,
  };
}

/** 묶음별 도구 이름. 컨텍스트 인스펙터와 설정 UI 가 함께 쓴다. */
export const TOOL_GROUPS: { id: keyof ToolToggles; labelKey: MessageKey; tools: string[] }[] = [
  {
    id: "fsRead",
    labelKey: "tool.group.fsRead",
    tools: ["read_file", "list_directory", "path_info"],
  },
  {
    id: "fsWrite",
    labelKey: "tool.group.fsWrite",
    tools: ["write_file", "create_directory", "delete_path"],
  },
  { id: "shell", labelKey: "tool.group.shell", tools: ["execute_shell_command"] },
  { id: "memory", labelKey: "tool.group.memory", tools: ["remember", "recall"] },
  { id: "subagents", labelKey: "tool.group.subagents", tools: ["delegate_task"] },
  { id: "mcp", labelKey: "tool.group.mcp", tools: ["mcp__<server>__<tool>"] },
];

/**
 * 활성화된 도구만 담은 ToolSet 을 만든다.
 * `runner.ts` 의 `tools` 인자로 그대로 넘어간다.
 */
export function buildTools(options: ToolOptions = {}): ToolSet {
  const enabled = { ...DEFAULT_TOOLS, ...options.enabled };
  const projectPath = options.projectPath;
  const sessionId = options.sessionId ?? null;
  const tools: ToolSet = {};

  if (enabled.fsRead) {
    tools.read_file = tool({
      description: t("tool.readFile.description"),
      inputSchema: z.object({
        path: z.string().describe(t("tool.readFile.path")),
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
      description: t("tool.listDirectory.description"),
      inputSchema: z.object({
        path: z.string().optional().describe(t("tool.listDirectory.path")),
        includeHidden: z.boolean().optional().describe(t("tool.listDirectory.includeHidden")),
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
      description: t("tool.pathInfo.description"),
      inputSchema: z.object({ path: z.string().describe(t("tool.pathInfo.path")) }),
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
      description: t("tool.writeFile.description"),
      inputSchema: z.object({
        path: z.string().describe(t("tool.writeFile.path")),
        content: z.string().describe(t("tool.writeFile.content")),
        append: z.boolean().optional().describe(t("tool.writeFile.append")),
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
      description: t("tool.createDirectory.description"),
      inputSchema: z.object({ path: z.string().describe(t("tool.createDirectory.path")) }),
      execute: async ({ path }) => ({ path: await ipc.createDirectory(path, projectPath) }),
    });

    tools.delete_path = tool({
      description: t("tool.deletePath.description"),
      inputSchema: z.object({
        path: z.string().describe(t("tool.deletePath.path")),
        recursive: z.boolean().optional().describe(t("tool.deletePath.recursive")),
      }),
      execute: async ({ path, recursive }, { abortSignal }) => {
        // 삭제는 되돌릴 수 없다 → 셸과 같은 게이트를 지난다. 규칙으로 미리 열어 둘 수는 없다
        // ("비슷한 삭제도 함께 허용" 이라는 개념이 성립하지 않는다).
        if (options.requestApproval) {
          const outcome = await options.requestApproval({
            kind: "delete",
            toolName: "delete_path",
            command: path,
            detail: recursive
              ? t("tool.deletePath.detailRecursive")
              : t("tool.deletePath.detail"),
            origin: options.origin,
            signal: abortSignal,
          });
          if (!outcome.approved) {
            return {
              path,
              approved: false,
              denied: true,
              deleted: false,
              reason: clip(outcome.reason ?? t("tool.deletePath.denied"), 1_000).text,
              hint: t("tool.deletePath.deniedHint"),
            };
          }
        }

        return {
          path,
          approved: true,
          deleted: await ipc.deletePath(path, { projectPath, recursive }),
        };
      },
    });
  }

  if (enabled.shell) {
    tools.execute_shell_command = tool({
      description: t("tool.shell.description"),
      inputSchema: z.object({
        command: z.string().describe(t("tool.shell.command")),
        cwd: z.string().optional().describe(t("tool.shell.cwd")),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(t("tool.shell.timeout", { max: MAX_SHELL_TIMEOUT_MS })),
      }),
      execute: async ({ command, cwd, timeoutMs }, { abortSignal }) => {
        // 실행 전 승인. 거부는 예외가 아니라 **정상적인 결말**이다 — 던지면 턴이
        // 에러로 끊기지만, 결과로 돌려주면 모델이 다른 수를 고를 수 있다.
        if (options.requestApproval) {
          const outcome = await options.requestApproval({
            toolName: "execute_shell_command",
            command,
            cwd,
            origin: options.origin,
            signal: abortSignal,
          });
          if (!outcome.approved) {
            return {
              command,
              approved: false,
              denied: true,
              // 사용자가 적은 사유도 컨텍스트로 들어간다 → 가리기·상한을 함께 지난다.
              reason: clip(outcome.reason ?? t("tool.shell.denied"), 1_000).text,
              hint: t("tool.shell.deniedHint"),
            };
          }
        }

        // 중단을 누르면 프로세스를 실제로 죽여야 한다. 토큰으로 Rust 쪽 실행을 찾아 트리째 정리한다.
        const cancelToken = newCancelToken("shell");
        const onAbort = () => {
          void ipc.cancelShellCommand(cancelToken).catch(() => {});
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        const result = await ipc
          .executeShellCommand(command, {
            cwd,
            // 모델이 크게 잡아 온 값은 여기서 접는다. 안 접으면 턴이 그만큼 멈춰 선다.
            timeoutMs: timeoutMs ? Math.min(timeoutMs, MAX_SHELL_TIMEOUT_MS) : undefined,
            projectPath,
            cancelToken,
          })
          .finally(() => abortSignal?.removeEventListener("abort", onAbort));
        const stdout = clip(result.stdout);
        const stderr = clip(result.stderr, 4_000);
        return {
          command: result.command,
          approved: true,
          cwd: result.cwd,
          exitCode: result.exitCode,
          success: result.success,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
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
      description: t("tool.remember.description"),
      inputSchema: z.object({
        key: z.string().describe(t("tool.remember.key")),
        value: z.string().describe(t("tool.remember.value")),
        scope: z.enum(["project", "session"]).optional().describe(t("tool.remember.scope")),
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
      description: t("tool.recall.description"),
      inputSchema: z.object({
        key: z.string().optional().describe(t("tool.recall.key")),
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
      description: t("tool.delegate.description"),
      inputSchema: z.object({
        name: z.string().describe(t("tool.delegate.name")),
        task: z.string().describe(t("tool.delegate.task")),
      }),
      // 턴을 중지하면 띄워 둔 서브에이전트도 함께 멈춰야 한다.
      execute: async ({ name, task }, { abortSignal }) => delegate({ name, task, signal: abortSignal }),
    });
  }

  return tools;
}

/** 지금 켜져 있는 도구 이름 목록. 컨텍스트 스냅샷에 함께 남긴다. */
export function enabledToolNames(options: ToolOptions = {}): string[] {
  return Object.keys(buildTools(options));
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
