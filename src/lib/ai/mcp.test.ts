import { asSchema } from "@ai-sdk/provider-utils";
import { describe, expect, it, vi } from "vitest";

import { buildMcpTools, mcpToolName, slugify } from "@/lib/ai/mcp";
import type { McpServerInfo } from "@/types/ipc";

function server(partial: Partial<McpServerInfo> & Pick<McpServerInfo, "id" | "name">): McpServerInfo {
  return {
    protocolVersion: "2025-06-18",
    serverName: null,
    serverVersion: null,
    tools: [],
    connectedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

const readTool = {
  name: "read_text_file",
  description: "파일을 읽는다",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

async function run(tool: unknown, input: unknown) {
  const executable = tool as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return executable.execute(input, { toolCallId: "c1", messages: [], context: undefined });
}

describe("이름 변환", () => {
  it("공급자가 받는 문자만 남긴다", () => {
    // 허용되지 않는 문자는 _ 로 바뀌고, 앞뒤의 _ 는 다듬는다.
    expect(slugify("파일 서버 v2")).toBe("v2");
    expect(slugify("파일 v2 서버")).toBe("v2");
    expect(slugify("file-system_1")).toBe("file-system_1");
    expect(slugify("   ")).toBe("server");
  });

  it("mcp__서버__도구 형태로 접두사를 붙인다", () => {
    expect(mcpToolName("filesystem", "read_text_file")).toBe("mcp__filesystem__read_text_file");
  });

  it("이름이 128자를 넘지 않는다", () => {
    expect(mcpToolName("s".repeat(200), "t".repeat(200)).length).toBe(128);
  });
});

describe("buildMcpTools", () => {
  it("연결된 서버의 도구를 ToolSet 으로 합치고 출처를 남긴다", () => {
    const { tools, origins } = buildMcpTools([
      server({ id: "s1", name: "filesystem", tools: [readTool] }),
      server({ id: "s2", name: "github", tools: [{ ...readTool, name: "search" }] }),
    ]);

    expect(Object.keys(tools)).toEqual([
      "mcp__filesystem__read_text_file",
      "mcp__github__search",
    ]);
    expect(origins["mcp__github__search"]).toEqual({
      serverId: "s2",
      serverName: "github",
      toolName: "search",
    });
  });

  it("서버가 준 JSON Schema 를 그대로 공급자에게 넘긴다", () => {
    const { tools } = buildMcpTools([server({ id: "s1", name: "filesystem", tools: [readTool] })]);
    const schema = asSchema(
      (tools["mcp__filesystem__read_text_file"] as { inputSchema: never }).inputSchema,
    );

    expect(schema.jsonSchema).toEqual(readTool.inputSchema);
  });

  it("스키마가 없는 도구도 빈 객체 스키마로 실어 보낸다", () => {
    const { tools } = buildMcpTools([
      server({ id: "s1", name: "x", tools: [{ name: "ping", description: null, inputSchema: null }] }),
    ]);
    const schema = asSchema((tools.mcp__x__ping as { inputSchema: never }).inputSchema);

    expect(schema.jsonSchema).toEqual({ type: "object" });
  });

  it("이름이 겹치면 번호를 붙여 떨어뜨린다", () => {
    const { tools, origins } = buildMcpTools([
      server({ id: "s1", name: "files", tools: [{ ...readTool, name: "read" }] }),
      // 이름이 같은 서버를 두 개 등록한 경우 (id 는 다르다)
      server({ id: "s2", name: "files", tools: [{ ...readTool, name: "read" }] }),
    ]);

    expect(Object.keys(tools)).toEqual(["mcp__files__read", "mcp__files__read_2"]);
    expect(origins["mcp__files__read_2"].serverId).toBe("s2");
  });

  it("실행하면 원래 서버 id 와 도구 이름으로 호출한다", async () => {
    const callTool = vi.fn().mockResolvedValue({ text: "파일 내용", isError: false, raw: {} });
    const { tools } = buildMcpTools(
      [server({ id: "s1", name: "filesystem", tools: [readTool] })],
      { callTool },
    );

    const result = await run(tools.mcp__filesystem__read_text_file, { path: "a.ts" });

    expect(callTool).toHaveBeenCalledWith("s1", "read_text_file", { path: "a.ts" });
    expect(result).toEqual({
      server: "filesystem",
      tool: "read_text_file",
      isError: false,
      text: "파일 내용",
    });
  });

  it("도구가 실패를 알리면 그대로 모델에게 전달한다", async () => {
    const callTool = vi.fn().mockResolvedValue({ text: "권한 없음", isError: true, raw: {} });
    const { tools } = buildMcpTools(
      [server({ id: "s1", name: "filesystem", tools: [readTool] })],
      { callTool },
    );

    // MCP 의 isError 는 프로토콜 실패가 아니라 "도구가 실패를 보고한 것"이다.
    const result = (await run(tools.mcp__filesystem__read_text_file, {})) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it("연결된 서버가 없으면 빈 ToolSet 이다", () => {
    expect(Object.keys(buildMcpTools([]).tools)).toEqual([]);
  });
});
