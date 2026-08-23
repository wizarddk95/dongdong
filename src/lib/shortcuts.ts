/**
 * 패널 여닫기 단축키 판정(순수).
 *
 * 세션 목록은 `Ctrl+B`, 대화 트리(우측 패널)는 `Ctrl+L` 이다(맥은 `Cmd`).
 * 수식 키가 있는 조합이라 **입력칸에 커서가 있어도 그대로 동작한다** — 글자로는
 * 나올 수 없는 조합이라 타이핑과 헷갈릴 일이 없다. 이 앱에서 커서 자리는 거의
 * 언제나 입력칸이므로, 거기서 되는 것이 이 단축키의 전부라고 봐도 된다.
 *
 * 판정을 여기 모아 두는 이유는 화면(툴팁·버튼)이 같은 규칙을 말해야 하기 때문이다.
 */

/** 여닫을 수 있는 패널. */
export type PanelId = "sessions" | "tree";

/** 단축키 판정에 필요한 것만 추린 키 이벤트. DOM 없이 테스트하려고 떼어 냈다. */
export interface ShortcutEvent {
  key: string;
  /**
   * 물리 키 코드(`KeyB`). 한글 입력 상태에서는 `key` 가 `ㅠ`(또는 `Process`)로 와서
   * 글자로는 못 알아보므로 여기로 되짚는다. 자판 배열을 바꾼 사람에게는 `key` 가
   * 맞으므로 **글자를 먼저 보고** 코드는 물러날 자리로만 쓴다.
   */
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** 눌린 키가 어느 패널을 여닫는가. 아무것도 아니면 null. */
export function matchPanelShortcut(event: ShortcutEvent): PanelId | null {
  // Ctrl(맥은 Cmd)만. Shift·Alt 가 섞이면 다른 조합이므로 넘긴다 —
  // 여기서 관대해지면 남이 쓰려고 잡아 둔 조합까지 먹는다.
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return null;

  const key = event.key.toLowerCase();
  if (key === "b") return "sessions";
  if (key === "l") return "tree";

  // 글자로 못 알아본 경우에만 물리 키로 되짚는다(한글 입력 중).
  if (event.code === "KeyB") return "sessions";
  if (event.code === "KeyL") return "tree";
  return null;
}
