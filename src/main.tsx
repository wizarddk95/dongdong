import React from "react";
import ReactDOM from "react-dom/client";

import App from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "@/index.css";
// 수식 스타일(KaTeX) — `scripts/gen-katex-css.mjs` 가 woff2 만 남겨 뽑아 둔 사본이다.
// index.css 안에서 `@import` 하면 Tailwind 가 폰트 경로를 다시 써 버려서 여기서 따로 싣는다.
import "@/styles/katex.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
