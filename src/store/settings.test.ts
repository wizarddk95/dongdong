import { beforeEach, describe, expect, it, vi } from "vitest";

// 설정 저장은 디스크(Rust)로 나가므로 갈아 끼운다. 여기서 보는 건 스토어의 파생 규칙뿐.
vi.mock("@/lib/ipc", () => ({
  readAppSettings: vi.fn(),
  appSettingsPath: vi.fn(),
  writeAppSettings: vi.fn(async () => undefined),
}));

// 로컬 서버 탐색도 Rust(HTTP 플러그인)를 타므로 막아 둔다.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import * as ipc from "@/lib/ipc";
import { DEFAULT_TOOLS, buildTools } from "@/lib/ai/tools";
import { en } from "@/lib/i18n/en";
import { getLocale, setLocale } from "@/lib/i18n";
import { defaultSystemPrompt, useSettings } from "@/store/settings";

describe("모델을 바꾸면 권장 사고 강도를 따라간다", () => {
  beforeEach(() => {
    useSettings.setState({ modelId: "anthropic:claude-opus-5", effort: "max" });
  });

  it("권장값이 있는 모델로 바꾸면 effort 도 함께 옮겨간다", async () => {
    await useSettings.getState().update({ modelId: "anthropic:claude-sonnet-5" });
    expect(useSettings.getState().effort).toBe("high");
  });

  it("같은 patch 에 effort 가 있으면 사용자가 고른 값이 이긴다", async () => {
    await useSettings.getState().update({ modelId: "anthropic:claude-sonnet-5", effort: "low" });
    expect(useSettings.getState().effort).toBe("low");
  });

  it("권장값이 없는 모델은 현재 강도를 유지한다", async () => {
    await useSettings.getState().update({ modelId: "anthropic:claude-haiku-4-5-20251001" });
    expect(useSettings.getState().effort).toBe("max");
  });

  it("권장값이 없고 그 모델이 안 받는 값이면 가장 가까운 값으로 당긴다", async () => {
    // Gemini 3.7 Flash 는 low~high 만 받는다. "max" 가 그대로 남으면
    // 드롭다운에 없는 값이 저장돼 셀렉트가 빈칸처럼 보인다.
    await useSettings.getState().update({ modelId: "google:gemini-3.7-flash" });
    expect(useSettings.getState().effort).toBe("high");
  });

  it("모델이 그대로면 effort 를 건드리지 않는다", async () => {
    await useSettings.getState().update({ modelId: "anthropic:claude-opus-5" });
    expect(useSettings.getState().effort).toBe("max");
  });
});

describe("Gemini 자격 증명", () => {
  beforeEach(() => {
    vi.mocked(ipc.writeAppSettings).mockClear();
    useSettings.setState({ googleApiKey: "", googleBaseUrl: "" });
  });

  it("키가 디스크에 함께 저장되고 credentials() 로도 나간다", async () => {
    await useSettings.getState().update({ googleApiKey: "AIza-test" });
    const saved = vi.mocked(ipc.writeAppSettings).mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({ googleApiKey: "AIza-test" });
    expect(useSettings.getState().credentials().googleApiKey).toBe("AIza-test");
  });

  it("베이스 주소가 비어 있으면 undefined 로 넘겨 공급자 기본값을 쓰게 한다", () => {
    expect(useSettings.getState().credentials().googleBaseUrl).toBeUndefined();
  });
});

describe("테마", () => {
  const readSettings = vi.mocked(ipc.readAppSettings);

  beforeEach(() => {
    vi.mocked(ipc.writeAppSettings).mockClear();
    vi.mocked(ipc.appSettingsPath).mockResolvedValue("C:/settings.json" as never);
  });

  it("고른 테마가 디스크에 함께 저장된다", async () => {
    await useSettings.getState().update({ theme: "dark" });
    expect(useSettings.getState().theme).toBe("dark");
    const written = vi.mocked(ipc.writeAppSettings).mock.calls.at(-1)?.[0];
    expect(written).toMatchObject({ theme: "dark" });
  });

  it("저장된 테마를 읽어 온다", async () => {
    readSettings.mockResolvedValue({ theme: "dark" } as never);
    await useSettings.getState().load();
    expect(useSettings.getState().theme).toBe("dark");
  });

  it("모르는 값이 들어 있어도 기본값으로 떨어질 뿐 앱은 뜬다", async () => {
    readSettings.mockResolvedValue({ theme: "solarized" } as never);
    await useSettings.getState().load();
    expect(useSettings.getState().theme).toBe("light");
  });

  it("테마를 안 쓰던 옛 settings.json 도 기본값으로 채워진다", async () => {
    readSettings.mockResolvedValue({ modelId: "anthropic:claude-opus-5" } as never);
    await useSettings.getState().load();
    expect(useSettings.getState().theme).toBe("light");
  });
});

describe("대화 확대 배율", () => {
  const readSettings = vi.mocked(ipc.readAppSettings);

  beforeEach(() => {
    vi.mocked(ipc.writeAppSettings).mockClear();
    vi.mocked(ipc.appSettingsPath).mockResolvedValue("C:/settings.json" as never);
  });

  it("고른 배율이 디스크에 함께 저장된다 — 눈이 편한 크기는 앱을 다시 켜도 그대로여야 한다", async () => {
    await useSettings.getState().update({ chatZoom: 1.3 });
    expect(useSettings.getState().chatZoom).toBe(1.3);
    expect(vi.mocked(ipc.writeAppSettings).mock.calls.at(-1)?.[0]).toMatchObject({ chatZoom: 1.3 });
  });

  it("배율을 안 쓰던 옛 settings.json 은 100% 로 뜬다", async () => {
    readSettings.mockResolvedValue({ modelId: "anthropic:claude-opus-5" } as never);
    await useSettings.getState().load();
    expect(useSettings.getState().chatZoom).toBe(1);
  });

  it("손으로 고쳐 넣은 값도 범위 안으로 자른다", async () => {
    readSettings.mockResolvedValue({ chatZoom: 12 } as never);
    await useSettings.getState().load();
    expect(useSettings.getState().chatZoom).toBe(2);
  });
});

describe("로컬 모델 목록 새로고침", () => {
  const http = vi.mocked(tauriFetch);

  function serverHas(models: string[]) {
    http.mockReset();
    http.mockResolvedValue(
      new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as never,
    );
  }

  beforeEach(() => {
    vi.mocked(ipc.writeAppSettings).mockClear();
    useSettings.setState({
      localBaseUrl: "http://localhost:11434/v1",
      localModels: [],
    });
  });

  it("서버가 알려준 목록으로 갈아 끼운다", async () => {
    serverHas(["gpt-oss:20b"]);
    await expect(useSettings.getState().refreshLocalModels()).resolves.toEqual(["gpt-oss:20b"]);
    expect(useSettings.getState().localModels).toEqual(["gpt-oss:20b"]);
  });

  it("서버에서 사라진 모델은 목록에서도 빠진다", async () => {
    useSettings.setState({ localModels: ["gpt-oss:20b", "qwen3:14b"] });
    serverHas(["gpt-oss:20b"]);
    await useSettings.getState().refreshLocalModels();
    expect(useSettings.getState().localModels).toEqual(["gpt-oss:20b"]);
  });

  it("달라진 게 없으면 디스크를 건드리지 않는다 (앱 뜰 때마다 도는 경로다)", async () => {
    useSettings.setState({ localModels: ["gpt-oss:20b"] });
    serverHas(["gpt-oss:20b"]);
    await useSettings.getState().refreshLocalModels();
    expect(ipc.writeAppSettings).not.toHaveBeenCalled();
  });

  it("주소를 함께 넘기면 그 주소를 저장한다", async () => {
    serverHas(["gpt-oss:20b"]);
    await useSettings.getState().refreshLocalModels("  http://127.0.0.1:1234/v1  ");
    expect(useSettings.getState().localBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(http.mock.calls[0][0]).toBe("http://127.0.0.1:1234/v1/models");
  });

  it("서버가 꺼져 있으면 던지고 직전 목록은 그대로 둔다", async () => {
    useSettings.setState({ localModels: ["gpt-oss:20b"] });
    http.mockReset();
    http.mockRejectedValue(new Error("connection refused"));
    await expect(useSettings.getState().refreshLocalModels()).rejects.toThrow();
    expect(useSettings.getState().localModels).toEqual(["gpt-oss:20b"]);
  });
});

describe("화면 언어", () => {
  beforeEach(() => {
    setLocale("ko");
    useSettings.setState({ language: "ko", systemPrompt: defaultSystemPrompt() });
  });

  it("언어를 바꾸면 t() 도 함께 옮겨간다", async () => {
    await useSettings.getState().update({ language: "en" });
    expect(getLocale()).toBe("en");
  });

  it("손대지 않은 기본 프롬프트는 새 언어의 기본값으로 갈아 끼운다", async () => {
    await useSettings.getState().update({ language: "en" });
    expect(useSettings.getState().systemPrompt).toBe(en["prompt.default"]);
  });

  it("사용자가 고쳐 쓴 프롬프트는 언어를 바꿔도 그대로 둔다", async () => {
    // 언어 하나 바꿨다고 사용자가 쓴 글이 사라지면 안 된다.
    useSettings.setState({ systemPrompt: "내가 직접 쓴 프롬프트" });
    await useSettings.getState().update({ language: "en" });
    expect(useSettings.getState().systemPrompt).toBe("내가 직접 쓴 프롬프트");
  });

  it("같은 patch 에 프롬프트가 있으면 그것이 이긴다", async () => {
    await useSettings.getState().update({ language: "en", systemPrompt: "직접 지정" });
    expect(useSettings.getState().systemPrompt).toBe("직접 지정");
  });

  it("영어를 고르면 도구 설명도 영어로 나간다 — 프롬프트만 바뀌면 반쪽이다", async () => {
    await useSettings.getState().update({ language: "en" });
    const tools = buildTools({ enabled: { ...DEFAULT_TOOLS, shell: false } });
    expect(String(tools.read_file?.description)).toBe(en["tool.readFile.description"]);
  });
});
