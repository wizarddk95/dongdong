import { describe, expect, it } from "vitest";

import { matchPanelShortcut, type ShortcutEvent } from "@/lib/shortcuts";

function event(patch: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return {
    key: "b",
    shiftKey: false,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    ...patch,
  };
}

describe("matchPanelShortcut", () => {
  it("Ctrl+B 는 세션 목록", () => {
    expect(matchPanelShortcut(event({ key: "b" }))).toBe("sessions");
  });

  it("Ctrl+L 은 대화 트리", () => {
    expect(matchPanelShortcut(event({ key: "l" }))).toBe("tree");
  });

  it("맥의 Cmd 도 같은 자리다", () => {
    expect(matchPanelShortcut(event({ key: "l", ctrlKey: false, metaKey: true }))).toBe("tree");
  });

  it("수식 키 없이는 그냥 글자다", () => {
    expect(matchPanelShortcut(event({ ctrlKey: false }))).toBeNull();
  });

  it("Shift 나 Alt 가 섞이면 다른 조합이다", () => {
    expect(matchPanelShortcut(event({ shiftKey: true }))).toBeNull();
    expect(matchPanelShortcut(event({ altKey: true }))).toBeNull();
  });

  it("다른 글자는 지나간다", () => {
    expect(matchPanelShortcut(event({ key: "k" }))).toBeNull();
  });

  it("대문자로 와도 알아본다", () => {
    expect(matchPanelShortcut(event({ key: "B" }))).toBe("sessions");
  });

  it("한글 입력 중이라 글자를 못 알아보면 물리 키로 되짚는다", () => {
    expect(matchPanelShortcut(event({ key: "ㅠ", code: "KeyB" }))).toBe("sessions");
  });

  it("자판을 바꿔 글자가 먼저 맞으면 그쪽을 따른다", () => {
    // Dvorak 처럼 물리 위치와 글자가 어긋나는 자판. 사람이 본 글자가 이긴다.
    expect(matchPanelShortcut(event({ key: "l", code: "KeyP" }))).toBe("tree");
  });
});
