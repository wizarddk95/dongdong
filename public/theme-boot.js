// 첫 페인트 전에 테마와 화면 언어를 새긴다.
//
// 진짜 설정은 Rust 의 settings.json 이지만 그건 비동기라, 다크를 쓰는 사람에게 흰 화면이
// 한 번 번쩍인다. `lib/theme.ts` 가 선택할 때마다 localStorage 에 복사해 두므로
// 여기서 그 캐시만 먼저 읽어 깔아 둔다 (설정을 읽으면 다시 맞춘다).
//
// index.html 의 인라인 <script> 가 아니라 별도 파일인 이유는 CSP 다 —
// `script-src 'self'` 아래에서 인라인 스크립트는 실행되지 않는다. Tauri 가 nonce 를 넣어 주는
// 대상은 `src` 가 http 로 시작하는 스크립트뿐이라 인라인은 예외가 없다.
// module 이 아닌 평범한 스크립트여야 한다 — module 은 defer 라 페인트 뒤로 밀릴 수 있다.
(function () {
  try {
    var saved = localStorage.getItem("dongdong.theme") || "light";
    var dark =
      saved === "dark" ||
      (saved === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }

  // `<html lang>` 도 같은 이유로 먼저 맞춘다 — 맞춤법 검사·스크린 리더·`:lang()` 이 이걸 본다.
  // 캐시가 없으면 OS 언어로 짐작한다(`lib/i18n/locale.ts` 의 detectLocale 과 같은 규칙).
  try {
    var locale = localStorage.getItem("dongdong.locale");
    if (locale !== "ko" && locale !== "en") {
      var first = (navigator.languages && navigator.languages[0]) || navigator.language || "";
      locale = first.toLowerCase().indexOf("ko") === 0 ? "ko" : "en";
    }
    document.documentElement.lang = locale;
  } catch (e) {
    document.documentElement.lang = "ko";
  }
})();
