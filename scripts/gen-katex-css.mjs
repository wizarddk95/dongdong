// KaTeX 스타일시트에서 woff2 만 남긴 사본을 만든다 (`src/styles/katex.css`).
//
// 패키지의 `katex.min.css` 를 그대로 `@import` 하면 @font-face 가 자족마다
// woff2 · woff · ttf 세 벌을 걸고 있어서, 브라우저는 woff2 하나만 쓰는데도
// 번들러는 60개 파일(1.2MB)을 전부 실행 파일에 싣는다. 20개(≈420KB)면 된다.
// JetBrains Mono 를 라틴만 싣는 것과 같은 이유다(`src/index.css`).
//
// katex 를 올린 뒤에는 `node scripts/gen-katex-css.mjs` 로 다시 만든다.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const version = require("katex/package.json").version;
const source = readFileSync(require.resolve("katex/dist/katex.min.css"), "utf8");

// `url(fonts/X.woff2) format("woff2"),url(…woff),url(…ttf)` → woff2 한 줄.
// 경로도 패키지 지정자로 바꿔 둔다 — 사본이 node_modules 밖에 놓이기 때문.
let dropped = 0;
const trimmed = source.replace(
  /url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\(fonts\/[\w-]+\.woff\) format\("woff"\))?(?:,url\(fonts\/[\w-]+\.ttf\) format\("truetype"\))?/g,
  (whole, face) => {
    dropped += (whole.match(/url\(/g) ?? []).length - 1;
    return `url("katex/dist/fonts/${face}.woff2") format("woff2")`;
  },
);

if (!trimmed.includes('url("katex/dist/fonts/')) {
  throw new Error("@font-face 를 못 찾았다 — katex 의 CSS 형식이 바뀐 듯하다.");
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "katex.css"),
  `/*
 * KaTeX ${version} 의 스타일시트 — **생성 파일이니 직접 고치지 말 것.**
 * \`node scripts/gen-katex-css.mjs\` 가 패키지의 katex.min.css 에서 만든다.
 * 원본과 다른 점은 @font-face 가 woff2 만 걸고 경로가 패키지 지정자라는 것뿐이다.
 */
${trimmed.trim()}\n`,
);
console.log(`src/styles/katex.css 생성 — 폰트 참조 ${dropped}개 제거 (katex ${version})`);
