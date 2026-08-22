import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri dev host (모바일/원격 디버깅 시 사용)
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Tauri CLI 로그가 지워지지 않도록
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust 소스는 Tauri 가 감시하므로 Vite 는 무시
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    // 테스트는 개발자 PC 의 OS 언어를 따라가면 안 된다 — 화면 언어를 여기서 못 박는다.
    // (안 박으면 한국어 윈도우에서만 초록이고 CI 러너에서 깨진다)
    setupFiles: ["./src/test/setup.ts"],
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // 로컬 데스크톱 앱이라 번들을 네트워크로 받지 않는다. 코드 분할 경고는 불필요.
    chunkSizeWarningLimit: 2000,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
