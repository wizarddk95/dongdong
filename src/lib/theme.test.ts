import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, normalizeTheme, resolveTheme } from "@/lib/theme";

describe("테마 결정 규칙", () => {
  it("고정 선택은 OS 취향과 무관하게 그대로 간다", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("system 은 OS 취향을 따라간다", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("저장된 값 정규화", () => {
  it("아는 값은 그대로 둔다", () => {
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("system")).toBe("system");
  });

  it("모르는 값·빈 값은 기본값으로 되돌린다 (옛 settings.json 이 앱을 깨지 않게)", () => {
    expect(normalizeTheme("solarized")).toBe(DEFAULT_THEME);
    expect(normalizeTheme(undefined)).toBe(DEFAULT_THEME);
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
    expect(normalizeTheme(3)).toBe(DEFAULT_THEME);
  });
});
