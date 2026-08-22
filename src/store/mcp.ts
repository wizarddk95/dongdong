/**
 * MCP 서버 연결 상태.
 *
 * 서버 목록(실행 명령)은 사용자 단위 설정이라 `store/settings.ts` 가 settings.json 에
 * 저장하고, 여기서는 "지금 떠 있는 연결"만 관리한다.
 * 실제 프로세스는 Rust(`src-tauri/src/mcp.rs`)가 들고 있다.
 */
import type { ToolSet } from "@ai-sdk/provider-utils";
import { create } from "zustand";

import { buildMcpTools, type McpToolOrigin } from "@/lib/ai/mcp";
import * as ipc from "@/lib/ipc";
import { useSettings } from "@/store/settings";
import type { McpServerConfig, McpServerInfo } from "@/types/ipc";

export type McpConnectionState = "idle" | "connecting" | "connected" | "error";

export interface McpStatus {
  state: McpConnectionState;
  error?: string;
}

interface McpState {
  /** 연결에 성공한 서버들 (도구 목록 포함) */
  servers: McpServerInfo[];
  status: Record<string, McpStatus>;

  connect: (config: McpServerConfig) => Promise<boolean>;
  /** enabled 인 서버를 모두 연결한다 (이미 붙은 것은 건너뜀). */
  connectEnabled: () => Promise<void>;
  disconnect: (serverId: string) => Promise<void>;
  /** Rust 가 들고 있는 실제 연결 목록으로 상태를 맞춘다. */
  refresh: () => Promise<void>;
  logs: (serverId: string) => Promise<string[]>;

  /** 연결된 서버들의 도구를 하나의 ToolSet 으로 (에이전트에 그대로 넘긴다) */
  tools: () => ToolSet;
  origins: () => Record<string, McpToolOrigin>;
}

export const useMcp = create<McpState>((set, get) => ({
  servers: [],
  status: {},

  connect: async (config) => {
    set({ status: { ...get().status, [config.id]: { state: "connecting" } } });
    try {
      const info = await ipc.mcpConnect(config);
      set({
        servers: [...get().servers.filter((server) => server.id !== info.id), info],
        status: { ...get().status, [config.id]: { state: "connected" } },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        servers: get().servers.filter((server) => server.id !== config.id),
        status: { ...get().status, [config.id]: { state: "error", error: message } },
      });
      return false;
    }
  },

  connectEnabled: async () => {
    const configs = useSettings.getState().mcpServers.filter((server) => server.enabled !== false);
    const connected = new Set(get().servers.map((server) => server.id));
    // 서버 하나가 실패해도 나머지는 붙어야 한다.
    await Promise.all(
      configs
        .filter((config) => !connected.has(config.id))
        .map((config) => get().connect(config)),
    );
  },

  disconnect: async (serverId) => {
    await ipc.mcpDisconnect(serverId);
    set({
      servers: get().servers.filter((server) => server.id !== serverId),
      status: { ...get().status, [serverId]: { state: "idle" } },
    });
  },

  refresh: async () => {
    const servers = await ipc.mcpListServers();
    const status = { ...get().status };
    for (const server of servers) status[server.id] = { state: "connected" };
    // Rust 쪽에서 사라진 연결(프로세스 종료 등)은 상태를 되돌린다.
    const alive = new Set(servers.map((server) => server.id));
    for (const id of Object.keys(status)) {
      if (!alive.has(id) && status[id].state === "connected") status[id] = { state: "idle" };
    }
    set({ servers, status });
  },

  logs: (serverId) => ipc.mcpServerLogs(serverId),

  tools: () =>
    buildMcpTools(get().servers, {
      // 중단은 서버 프로세스를 죽여 연결까지 끊는다(파이프 읽기를 푸는 방법이 그것뿐이다).
      // 여기서 곧바로 다시 붙이지 않으면 다음 턴에 도구가 조용히 사라진다.
      cancelTool: async (serverId, cancelToken) => {
        await ipc.mcpCancelTool(cancelToken);
        const config = useSettings
          .getState()
          .mcpServers.find((server) => server.id === serverId);
        if (config && config.enabled !== false) await get().connect(config);
        else await get().refresh();
      },
    }).tools,

  origins: () => buildMcpTools(get().servers).origins,
}));
