/**
 * OS 알림 한 줄 띄우기 (`tauri-plugin-notification`).
 *
 * 플러그인은 **부를 때 동적으로 불러온다** — 모듈을 정적으로 import 하면 Tauri 밖(테스트·브라우저
 * 미리보기)에서 파일을 읽는 것만으로 터진다. 알림은 없어도 되는 기능이라 조용히 넘어가는 쪽이 맞다.
 *
 * 권한은 처음 띄울 때 한 번 물어본다(macOS·Windows). 거절하면 그대로 포기한다 —
 * 매 턴 다시 묻지 않는다.
 */

/** 창을 보고 있으면 알림을 띄우지 않는다 — 이미 보고 있는 사람에게 알릴 것이 없다. */
export function windowIsFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

/**
 * 알림을 띄운다. 띄웠으면 `true`.
 * 창이 포커스돼 있거나, 권한이 없거나, Tauri 밖이면 `false` (에러를 던지지 않는다).
 */
export async function notify(title: string, body: string): Promise<boolean> {
  // 웹뷰가 아니면(테스트·노드) 띄울 창부터가 없다 — 플러그인을 건드리지 않는다.
  if (typeof window === "undefined") return false;
  if (windowIsFocused()) return false;

  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    const granted =
      (await plugin.isPermissionGranted()) ||
      (await plugin.requestPermission()) === "granted";
    if (!granted) return false;

    plugin.sendNotification({ title, body });
    return true;
  } catch (error) {
    // 알림 하나 못 띄운 것으로 턴이 흔들리면 안 된다.
    console.warn("알림을 띄우지 못했습니다:", error);
    return false;
  }
}
