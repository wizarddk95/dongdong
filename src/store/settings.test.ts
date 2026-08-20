import { beforeEach, describe, expect, it, vi } from "vitest";

// 설정 저장은 디스크(Rust)로 나가므로 갈아 끼운다. 여기서 보는 건 스토어의 파생 규칙뿐.
vi.mock("@/lib/ipc", () => ({
  readAppSettings: vi.fn(),
  appSettingsPath: vi.fn(),
  writeAppSettings: vi.fn(async () => undefined),
}));

import { useSettings } from "@/store/settings";

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

  it("모델이 그대로면 effort 를 건드리지 않는다", async () => {
    await useSettings.getState().update({ modelId: "anthropic:claude-opus-5" });
    expect(useSettings.getState().effort).toBe("max");
  });
});
