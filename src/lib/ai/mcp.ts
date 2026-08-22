/**
 * MCP 도구를 AI SDK 의 ToolSet 으로 감싼다.
 *
 * 내장 Skill 과 달리 도구 이름·스키마를 실행 시점에야 알 수 있으므로
 * zod 대신 서버가 준 JSON Schema 를 그대로 쓰고 `dynamicTool` 로 만든다.
 */
import { dynamicTool, jsonSchema, type ToolSet } from "@ai-sdk/provider-utils";

import { clip, newCancelToken } from "@/lib/ai/skills";
import * as ipc from "@/lib/ipc";
import type { McpServerInfo } from "@/types/ipc";

/** 공급자가 받는 도구 이름 제약(영숫자·_·-)에 맞춘다. */
const MAX_TOOL_NAME = 128;

export function slugify(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "server";
}

/** `mcp__<서버>__<도구>` — 내장 Skill 과 이름이 부딪히지 않게 접두사를 붙인다. */
export function mcpToolName(serverSlug: string, toolName: string): string {
  return `mcp__${serverSlug}__${slugify(toolName)}`.slice(0, MAX_TOOL_NAME);
}

export interface McpToolOrigin {
  serverId: string;
  serverName: string;
  toolName: string;
}

export interface BuildMcpToolsResult {
  tools: ToolSet;
  /** 노출된 도구 이름 → 원래 서버/도구. 인스펙터와 로그에서 쓴다. */
  origins: Record<string, McpToolOrigin>;
}

export interface BuildMcpToolsOptions {
  callTool?: typeof ipc.mcpCallTool;
  /**
   * 중단 처리. 기본값은 서버 프로세스를 죽이는 것까지만 한다.
   * 스토어는 여기에 재연결까지 얹는다 — 중단이 다음 턴의 도구까지 앗아가지 않게.
   */
  cancelTool?: (serverId: string, cancelToken: string) => Promise<unknown>;
}

/**
 * 연결된 MCP 서버들의 도구를 하나의 ToolSet 으로 합친다.
 * 이름이 겹치면 뒤에 번호를 붙여 떨어뜨린다.
 */
export function buildMcpTools(
  servers: McpServerInfo[],
  options: BuildMcpToolsOptions = {},
): BuildMcpToolsResult {
  const tools: ToolSet = {};
  const origins: Record<string, McpToolOrigin> = {};

  for (const server of servers) {
    const slug = slugify(server.name || server.id);

    for (const definition of server.tools) {
      let name = mcpToolName(slug, definition.name);
      // 서버 이름이 같아 슬러그가 겹치는 경우 대비.
      for (let index = 2; name in tools; index += 1) {
        name = `${mcpToolName(slug, definition.name)}_${index}`.slice(0, MAX_TOOL_NAME);
      }

      origins[name] = {
        serverId: server.id,
        serverName: server.name,
        toolName: definition.name,
      };

      tools[name] = dynamicTool({
        description:
          definition.description ?? `${server.name} MCP 서버의 ${definition.name} 도구`,
        // 서버가 준 JSON Schema 를 그대로 공급자에게 넘긴다.
        inputSchema: jsonSchema((definition.inputSchema ?? { type: "object" }) as never),
        execute: async (input, { abortSignal }) => {
          // IPC 는 실제 호출 시점에 붙인다 (도구를 만들기만 할 때는 Tauri 가 없어도 된다).
          const callTool = options.callTool ?? ipc.mcpCallTool;
          const cancelTool =
            options.cancelTool ?? ((_serverId: string, token: string) => ipc.mcpCancelTool(token));

          // 중단을 누르면 서버 쪽 작업도 멈춰야 한다. `abortableTools()` 는 도구 promise 만
          // 풀어 주므로, 진짜 돌고 있는 프로세스는 도구가 스스로 정리한다(셸과 같은 규칙).
          const cancelToken = newCancelToken("mcp");
          const onAbort = () => {
            void cancelTool(server.id, cancelToken).catch(() => {});
          };
          abortSignal?.addEventListener("abort", onAbort, { once: true });

          const result = await callTool(server.id, definition.name, input ?? {}, cancelToken)
            .finally(() => abortSignal?.removeEventListener("abort", onAbort));

          // 내장 스킬과 같은 자로 자른다 — 검색·크롤 결과는 한 번에 컨텍스트를 통째로 먹는다.
          const { text, clipped } = clip(result.text);
          // 도구가 스스로 실패를 알린 경우도 모델이 읽고 대응해야 하므로 그대로 돌려준다.
          return {
            server: server.name,
            tool: definition.name,
            isError: result.isError,
            text,
            truncated: clipped,
          };
        },
      });
    }
  }

  return { tools, origins };
}
