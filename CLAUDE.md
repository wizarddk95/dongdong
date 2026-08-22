# CLAUDE.md

`dongdong` — 노드 기반 대화 시각화를 갖춘 **로컬 코딩 에이전트** (Tauri 2 + React 19).
도커/샌드박스 없이 사용자 OS 권한으로 직접 실행하고, 프로젝트 루트의 `.agent_workspace/local.db`(SQLite)에 저장한다.
Phase 1~4 완료: 워크스페이스·대화 트리 → LLM 스트리밍 → 도구/Inspector → 서브에이전트 + MCP 브리지.
그 위에 스킬(절차서) · 훅(비차단 자동 동작) · 셸 실행 승인 · `@` 파일 참조 · **한국어/영어 UI** 가 올라가 있다.

## 작업 후 반드시 통과시킬 것

```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test --lib
```

현재 기준 vitest 495 / cargo 63. 기능을 추가하면 테스트도 함께 붙인다.
실제 구동 확인은 `pnpm tauri dev`.

## 기술 스택 (변경 금지)

React 19 · Vite 6 · TypeScript · Tailwind v4 · Zustand 5 · React Flow 12 · zod 4 ·
**Vercel AI SDK Core v7** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) · Tauri 2 (Rust, rusqlite bundled) ·
KaTeX(채팅 본문의 수식 렌더링에만 쓴다 — 마크다운 파서 자체는 여전히 의존성이 없다).
LangChain 같은 상위 추상화를 넣지 않는다. LLM 호출은 `streamText` 직접 호출.

## 절대 규칙

- **IPC**: 앱 코드는 `invoke()` 를 직접 부르지 않는다. 항상 `src/lib/ipc.ts` 경유.
- **새 command 는 4곳을 함께 고친다**: `src-tauri/src/commands/*.rs` → `lib.rs` 의 `invoke_handler` 등록 → `src/types/ipc.ts` → `src/lib/ipc.ts`. 하나라도 빠지면 런타임에야 터진다.
- **타입 동기화**: Rust 모델(serde `camelCase`)을 고치면 `src/types/ipc.ts` 도 같이 고친다.
- **DB**: 모든 SQL 은 `db/queries.rs` 에만. 커넥션 접근은 `state.rs` 의 `with_conn()` 이 유일한 통로.
- **마이그레이션**: `db/schema.rs` 의 `MIGRATIONS` 배열 **끝에만 추가**. 기존 항목 수정 금지(이미 만들어진 DB 와 어긋난다).
- **경로**: 파일 경로는 `paths.rs` 경유. `resolve_within()` 이 프로젝트 루트 밖 접근을 막는다 —
  **아직 없는 경로도 존재하는 조상까지 먼저 canonicalize 해서** 심볼릭 링크·정션으로 걸어 나가는 길을 닫는다
  (`resolve_through_links()`). 문자열 비교만 하면 `<root>/link/새파일` 이 통과한다.
  다만 셸이 켜져 있으면 이 담장은 실수를 막는 장치일 뿐이다 — `cd ..` 한 줄이면 그만이다.
- **오래 걸리는 command 는 `async` + `spawn_blocking`**. 동기 command 는 메인 스레드를 막아 UI 가 언다.
- **셸 실행과 삭제는 사람이 승인한다**: `execute_shell_command` · `delete_path` 는 실행 직전 `requestApproval` 게이트를
  지난다(기본 모드가 **승인 필요**). 판정은 전부 `lib/ai/approval.ts` 의 순수 함수이고
  묻고 기다리는 일만 `store/approvals.ts` 가 한다 — **판정을 UI 에 따로 적지 말 것**
  (설정 화면·승인 카드·게이트가 같은 함수를 쓴다). [항상 허용] 규칙은 연산자(`&&`·파이프·
  리다이렉션)가 붙은 명령을 절대 덮지 않고, **실행기**(`uv run`·`npx`·`python`·`node` …)는
  뒤에 오는 것이 곧 명령이라 전체 일치로만 덮는다. 이게 뚫리면 클릭 한 번이 임의 실행
  백지수표가 된다 — 실제로 `uv run` 규칙 하나가 `uv run <아무 스크립트>` 를 조용히 통과시켰다.
  **삭제는 규칙으로 열 수 없다**(지운 파일은 되돌아오지 않으므로 "비슷한 것도 함께" 가 성립하지 않는다).
  허용 규칙은 **세션 수명**이다 — 설정에 저장하지 않는다. 거부는 예외가 아니라 **결과**다 — 던지면 턴이 에러로 끊기고, 결과로 돌려주면 모델이 다른 수를 고른다.
  서브에이전트가 부른 셸도 같은 게이트를 지난다(위임 한 줄로 승인이 면제되면 안 된다).
- **중단 경로를 끊지 말 것**: 새 도구를 붙이면 `abortSignal` 을 반드시 존중한다. `runner.ts` 가 `abortableTools()` 로 한 번 감싸 주지만, 백그라운드에서 진짜 돌고 있는 작업(프로세스·자식 프로세스)은 도구가 스스로 정리해야 한다(`execute_shell_command` → `cancel_shell_command`, `mcp_call_tool` → `mcp_cancel_tool`).
- **도구와 스킬은 다른 층이다**: 도구(`lib/ai/tools.ts`)는 스키마째 매 턴 실리는 **실행 경로**,
  스킬(`lib/ai/skills.ts`)은 이름·설명만 실렸다가 `load_skill` 로 본문을 끌어오는 **절차서**다.
  새 기능을 붙일 때 어느 쪽인지부터 정한다 — 절차를 도구 description 에 적으면 매 턴 그 비용을 낸다.
  (설정의 옛 키 `skills` 는 이제 도구 토글이다. `store/settings.ts` 가 `tools` 로 옮겨 읽는다)
- **훅은 비차단이다**: 턴을 막거나 되돌리지 못하고, 실패해도 대화에 영향이 없다(`lib/hooks.ts`).
  도구 실행을 거부하는 훅을 붙이려면 `abort.ts` 의 중단 경주까지 손봐야 하므로 지금은 열지 않았다.
- **도구 출력에는 상한을 둔다**: `tools.ts` 의 `clip()`(20,000자)을 지난다. MCP 도구도 예외가 아니다 — 검색·크롤 결과 하나가 컨텍스트를 통째로 먹는다.
- **LLM 컨텍스트로 들어가는 텍스트는 전부 `clip()` 을 지난다**. 상한만이 아니라 **비밀값 가리기**
  (`lib/ai/redact.ts`)가 거기 붙어 있기 때문이다 — `cat settings.json` 한 줄이면 API 키가 도구
  출력으로 돌아오고, 그건 DB 에 남아 다음 턴에 공급자 서버로 나간다. 새 도구를 붙이면서 `clip()`
  을 건너뛰면 그 구멍이 다시 열린다. 가릴 값은 `store/settings.ts` 의 구독이 갈아 끼운다
  (API 키 + MCP 서버 env 값). 완벽하지 않다 — 모델이 키를 잘라 붙이면 못 잡는다. 그물이지 방벽이 아니다.
- **웹뷰는 CSP 아래 있다**(`tauri.conf.json` 의 `csp` / `devCsp`). 인라인 `<script>` 는 실행되지
  않는다 — Tauri 가 nonce 를 넣어 주는 대상은 `src` 가 http 로 시작하는 스크립트뿐이라 예외가 없다.
  그래서 첫 페인트 전 테마 스크립트도 `public/theme-boot.js` 로 빼 두었다. 원격 자원(CDN·폰트·이미지)을
  새로 들이려면 CSP 와 `capabilities/default.json` 을 함께 고쳐야 한다. 새 LLM 도메인도 마찬가지.
  (`style-src` 의 `'unsafe-inline'` 은 React Flow 가 인라인 style 로 뷰포트를 옮기기 때문에 뺄 수 없다)
- **스트리밍 중 DB 쓰기 금지**. 토큰은 Zustand 에만 쌓고 **스텝 경계**(도구 호출 확정 / 턴 종료)에서만 저장한다.
- **`MODEL_CATALOG`(`lib/ai/providers.ts`) 는 사용자 소유** — 임의로 고치지 않는다.
- **색·활자는 토큰만 쓴다**: 컴포넌트에 `zinc-800` 같은 팔레트 값이나 `#hex` 를 직접 적지 않는다.
  전부 `index.css` 의 의미 토큰(`bg-canvas` · `text-ink-muted` · `border-hairline` · `text-caption` …)
  경유. 하드코딩하면 다크 테마에서 그 자리만 깨진다. 규율은 `docs/design.md`.
- **모서리는 둥글게 · 그림자는 아주 옅게 · 크로마틱 액센트는 청록 하나** — 두 번째 브랜드 색을
  만들지 않는다. 뜻이 더 필요하면 라벨·아이콘·자리·테두리 굵기로 가른다.
  **예외는 인라인 코드(`code` 토큰) 하나뿐**이다 — 링크·버튼·활성 표시가 전부 청록이라
  코드 칩까지 같은 계열로 두면 구분은 안 되면서 채도만 쌓인다. 그래서 보색인 테라코타로
  뗐다(경고의 호박색과 헷갈리지 않게 붉은 쪽으로 민 색). 의도된 예외이니 "토큰 규율 위반"
  으로 되돌리지 말 것. 배경은 `docs/design.md`.
- **README 는 두 벌이다 — 언제나 함께 고친다**: `README.md`(영문) 과 `README.ko.md`(한국어).
  기능·동작·구조가 바뀌면 **두 파일 모두**에 반영한다. 한쪽만 고치면 다른 언어 사용자에게는
  없는 기능이 되거나, 더 나쁘게는 **안전 관련 서술이 서로 어긋난다**(실제로 승인 게이트가
  들어온 뒤 두 README 가 한동안 "확인 없이 바로 실행" 이라고 적고 있었다).
  같은 사실을 각 언어로 쓰되 번역투로 옮기지 말고 그 언어의 글로 쓴다.
- **화면 문구는 사전만 쓴다**: 컴포넌트·스토어에 문장을 직접 적지 않고 전부
  `lib/i18n/{ko,en}.ts` 를 지난다(색 토큰과 같은 규율이다). `en.ts` 가 `ko` 의 키로 타입을
  받으므로 한쪽에만 있는 키는 타입체크가 잡고, 자리표(`{name}`)가 어긋나는 것은 테스트가 잡는다.
  라벨을 상수 배열에 담을 때는 **문장이 아니라 `MessageKey` 를 담는다**(`TOOL_GROUPS` ·
  `HOOK_EVENTS` · `RUN_STATUS_STYLE` …) — 모듈 상수는 언어가 바뀌어도 다시 만들어지지 않는다.
  리액트에서는 `useT()`(언어 변경 시 다시 그린다), 그 밖에서는 `t()`.
- **언어는 껍데기가 아니다**: 시스템 프롬프트 · 도구 설명 · 스킬 본문 · 첨부 안내 · 현재 시각
  블록까지 **모델에게 가는 문장이 함께** 바뀐다. 화면만 영어로 바꾸면 "영어를 골랐는데 왜
  한국어로 답하지" 가 된다. 새 도구·스킬을 붙일 때 설명을 한국어로 박아 두면 그 구멍이 다시 열린다.
  다만 **사용자가 고쳐 쓴 시스템 프롬프트는 건드리지 않는다** — 손대지 않은 기본값일 때만
  갈아 끼운다(`isDefaultSystemPrompt()`).
- 주석과 UI 문구는 **한국어**. 주변 코드의 주석 밀도·네이밍을 따른다.
  (UI 문구는 사전의 **`ko.ts` 쪽**을 한국어로 쓴다는 뜻이다 — 컴포넌트에 직접 적으라는 뜻이 아니다.)

## 함정 (겪은 것들)

- **CORS**: 웹뷰 기본 `fetch` 로는 Anthropic 이 막힌다. `@tauri-apps/plugin-http` 의 `fetch` 를 provider 에 주입해 Rust(reqwest)를 경유한다. **새 LLM 도메인을 쓰면 `src-tauri/capabilities/default.json` 의 `http:default` 스코프에 URL 추가** 필수.
- Tauri HTTP 플러그인은 그래도 요청마다 웹뷰 주소로 **`Origin` 헤더를 강제로 붙인다**(플러그인 Rust 쪽 `commands.rs`). Anthropic 은 `Origin` 이 있으면 브라우저 직접 호출로 보고 `CORS requests must set 'anthropic-dangerous-direct-browser-access' header` 로 거부한다 → `createAnthropic({ headers: { "anthropic-dangerous-direct-browser-access": "true" } })` 로 켜 준다. 키가 로컬 밖으로 안 나가므로 안전하다.
- **AI SDK 의 중단은 "청크가 흐를 때만" 관측된다**. `streamText` 는 스트림에서 청크를 하나 읽은 뒤에 `abortSignal.aborted` 를 확인한다. 도구가 실행 중이면 청크가 없으므로 [중단]을 눌러도 아무 일도 일어나지 않는다 → 도구 자체를 중단 시그널과 경주시킨다(`lib/ai/abort.ts`). 도구가 거절되면 tool-error 청크가 흐르고 그때 스트림이 닫힌다.
- **Windows 에서 자식만 kill 하면 파이프가 안 닫힌다**. `cmd /C pnpm dev` 처럼 손자가 생기는 명령은 cmd 를 죽여도 손자가 stdout 을 물고 있어 리더 스레드의 `read` 가 EOF 를 못 본다 → `join()` 이 영구 대기하고 도구 호출이 영영 안 끝난다. `taskkill /T /F` 로 트리째 죽이고, 리더 조인에도 유예 시간을 둔다(`commands/shell.rs`).
  **셸만의 문제가 아니다** — MCP 서버도 `npx`·`node` 가 `cmd /C` 를 거쳐 뜨므로 자식은 cmd 이고 서버는 손자다. cmd 만 죽이면 타임아웃도 중단도 읽기를 못 풀고 그대로 매달린다(테스트가 60초를 기다리다 잡았다). 그래서 죽이는 곳은 전부 `process.rs` 의 `kill_tree()` 를 지난다.
- **사고 강도는 공급자마다 키가 다르고, 모델마다 받는 값이 다르다**. Anthropic 은
  `anthropic.effort`, OpenAI·Gemini 는 `openai.reasoningEffort` 다 — Gemini 도 OpenAI 호환
  계층을 타는데 `@ai-sdk/openai` 의 chat 모델이 providerOptions 를 **`"openai"` 고정 키**로
  읽기 때문이다(`createOpenAI({ name })` 를 따라가지 않는다). 설정의 강도는 하나뿐인데
  GPT-5.6 은 `max` 까지, Gemini 3.7 은 `low~high` 만 받는다 → `resolveEffort()` 가 목록 밖
  값을 가장 가까운 값으로 당겨서 보낸다(400 으로 턴을 날리지 않게). 무엇이 실제로 나갔는지는
  인스펙터가 같은 함수로 다시 계산해 보여 준다. **화면(잠금·목록)도 `sendsEffort()` /
  `effortOptionsFor()` 로 같은 판정을 쓴다** — 판정을 UI 에 따로 적으면 반드시 어긋난다.
- Anthropic 4.6+ 는 `temperature` 를 거부한다 → adaptive thinking + `effort`(`providerOptionsFor()`).
  **단 이건 모델마다 다르다** — Haiku 4.5 같은 구형은 adaptive 를 모르고 `effort` 도 안 받아서 그대로 보내면 400 이다.
  `providerOptionsFor()` 가 `MODEL_CATALOG` 의 `supportsAdaptiveThinking` 을 보고 붙일지 말지 정한다.
- **카탈로그의 모델 id 를 바꾸면 이미 저장된 `settings.json` 이 고아가 된다** → 드롭다운이 "직접 입력" 으로 떨어지고
  모델 능력 조회도 빗나간다. `providers.ts` 의 `MODEL_ID_ALIASES` 에 옛 id 를 등록하고, 설정 로드에서 `canonicalModelId()` 로 되돌린다.
- `ModelMessage` / `ToolSet` / `tool` / `dynamicTool` / `jsonSchema` 는 `ai` 가 아니라 **`@ai-sdk/provider-utils`** 에서 import.
- **Windows 셸 출력은 `chcp 65001` 로 안 고쳐진다**. 출력이 파이프로 리다이렉트되면 `dir` 같은 cmd 내장 명령과
  PowerShell 5 는 코드 페이지와 무관하게 OEM 코드 페이지(한국어면 CP949)로 쓴다 → 받는 쪽에서 되돌린다.
  `commands/shell.rs` 의 `decode_text()` 가 **줄 단위로** UTF-8 을 시도하고 실패한 줄만 `MultiByteToWideChar(GetOEMCP())`
  로 디코딩한다(한 스트림에 UTF-8 도구 출력과 CP949 가 섞여 나오기 때문). `chcp 65001` 선행은 그대로 두되 보조 수단일 뿐이다.
- **Gemini(`google:` 공급자)도 `@ai-sdk/openai` 로 부른다**. `@ai-sdk/google` 을 새로 들이지 않고
  구글의 **OpenAI 호환 엔드포인트**(`GEMINI_BASE_URL`)를 쓴다. 로컬 서버와 같은 이유로 `.chat()` 이어야
  한다 — 호환 계층에 Responses API 가 없다. 캐시 과금 구조도 다르다: **캐시 생성 요금이 따로 없고**
  (생성 토큰은 입력 단가로 과금) 대신 **시간당 저장 비용**이 붙는데 이건 토큰 기반 집계로는 안 잡힌다.
  그래서 카탈로그의 `cacheWrite` 는 `null`(무료)이 아니라 입력가와 같은 값이다. 3.1 Pro 는
  프롬프트 200K 초과 시 요청 전체가 상위 구간 요율 — OpenAI 272K 와 같은 규칙이라
  `longContextThresholdTokens` 를 그대로 쓴다.
- **Gemini 의 호환 계층은 도구 호출 청크에 `index` 를 안 넣는다**. OpenAI 본가는 스트리밍
  `tool_calls[].index` 를 항상 보내고(같은 번호의 조각을 이어 붙여 인자 문자열을 만드는 구조라
  그게 스트림의 키다) `@ai-sdk/openai` 의 청크 스키마도 **필수 number** 로 본다. 구글은 도구 호출을
  한 청크에 통째로 실으면서 이 필드를 빼먹는다 → 도구를 부르는 순간 `Type validation failed …
  expected number, received undefined` 로 턴이 통째로 날아간다(본문만 스트리밍하는 대화는 멀쩡해서
  "Gemini 는 되는데 도구만 안 된다" 로 보인다). `lib/ai/sseRepair.ts` 가 응답 SSE 를 지나가며 빠진
  번호만 채운다 — **호출 id 기준 등장 순서**로 매기는 게 핵심이다(전부 0 으로 채우면 한 턴에 도구를
  둘 이상 부를 때 SDK 가 서로 다른 호출을 한 호출의 조각으로 이어 붙인다). 같은 이유로 청크 경계가
  줄 한복판에 떨어질 수 있으니 줄 단위 버퍼링이 필요하고, 손대지 않는 줄은 원문 바이트 그대로 흘린다.
- **Gemini 3.x 는 도구 호출의 `thought_signature` 를 되돌려받아야 한다**. 바로 위 index 문제와
  같은 계층에서 나오는 **두 번째** 구멍이다. 구글은 호출 청크에
  `extra_content.google.thought_signature` 를 실어 보내고 그 호출을 다시 올릴 때 같은 값을
  요구하는데, `@ai-sdk/openai` 는 모르는 필드라 재조립하면서 떨어뜨린다 → 도구를 부른
  **다음** 요청이 `Function call is missing a thought_signature in functionCall parts` 로
  400 이 된다. 도구 실행은 성공하고 결과 노드까지 남은 **뒤에** 죽으므로 "방금 붙인 도구가
  깨졌다"(MCP 를 막 등록했을 때 특히) 처럼 보이지만 도구와 무관하다 — 내장 스킬도 똑같이
  죽는다. `lib/ai/thoughtSignature.ts` 가 응답 SSE 에서 서명을 주워 두고 나가는 요청의
  `tool_calls[]` 에 되붙인다. **메모리에만 두면 앱을 다시 켠 뒤 그 대화를 이어갈 때 다시
  400 이 나므로** `StoredToolCall.extraContent` 로 노드에 함께 저장하고
  `buildTurnContext()` 가 창고를 다시 채운다.
- **공급자 400 의 원인은 `APICallError.message` 에 없다**. 거기 담기는 건 상태 문구
  ("Bad Request") 뿐이고 진짜 이유는 `responseBody` 에 있다 → `error.message` 만 배너에
  띄우면 원인을 좁힐 방법이 사라진다(실제로 위 400 을 한참 못 찾았다). 스토어는
  `lib/ai/errors.ts` 의 `errorMessage()` 를 쓴다 — 재시도 래퍼를 벗기고 공급자마다 다른
  본문 모양도 여기서 접는다.
- **로컬 모델(`local:` 공급자)은 `createOpenAI(...).chat()` 로 부른다**. 기본 팩토리(`createOpenAI(...)(id)`)는
  Responses API 로 가는데 Ollama/LM Studio 는 `/v1/chat/completions` 만 구현했다. 키가 비면 SDK 가 예외를 내므로
  자리채움 키를 넣는다. 자세한 운용은 `docs/local-llm.md`.
- **Ollama 는 VRAM 24GB 미만이면 기본 컨텍스트가 4K** 다. 에이전트는 도구 스키마만으로도 그걸 넘겨서
  응답이 잘리거나 빈 문자열이 온다. `/v1` 경로는 본문의 `num_ctx` 를 무시하므로 **서버 쪽**에서
  `OLLAMA_CONTEXT_LENGTH` 로 잡고 재시작해야 한다.
- `npx` 같은 `.cmd` 는 직접 spawn 되지 않아 `cmd /C` 경유.
- React Flow 노드의 `onNodeDoubleClick` 은 `zoomOnDoubleClick`(기본 `true`)과 함께 쓰면 **죽는다**. d3-zoom 의 dblclick 핸들러가 `stopImmediatePropagation()` 을 불러 이벤트가 React 루트(위임 지점)까지 못 올라간다 → 노드 더블클릭을 쓰려면 `zoomOnDoubleClick={false}`.
- API 키·MCP 서버 목록은 프로젝트 DB 가 아니라 **OS 앱 설정 디렉터리의 `settings.json`**.
- Bash 툴에서 cargo 를 쓰려면 `export PATH="$USERPROFILE/.cargo/bin:$PATH"`.
- `pnpm tauri dev` 실행 중에 Rust 를 고치면 exe 교체 실패(os error 5)로 워처가 죽는다 → 앱 프로세스를 종료하고 다시 띄운다. 종료 후 포트 1420 을 문 vite 프로세스가 남기도 한다.
- **CSS 의 `@import` 를 거치면 `url()` 이 되쓰인다**. Tailwind(v4)가 `@import` 를 인라인하면서
  경로를 **그 파일 기준 상대 경로로** 바꾸는데, 패키지 지정자(`katex/dist/fonts/…`)까지 상대 경로로
  보고 `./styles/katex/dist/fonts/…` 로 만들어 버린다 → 빌드는 "didn't resolve" 경고만 흘리고 성공하고,
  실행하면 수식 서체만 조용히 빠진다. 그래서 KaTeX 사본은 `index.css` 가 아니라 **`main.tsx` 에서
  직접 import** 한다(진입점 CSS 는 이 되쓰기를 안 거친다).
- **KaTeX 의 CSS 를 그대로 쓰면 폰트가 세 벌 실린다**. @font-face 마다 woff2·woff·ttf 를 걸어 두어
  브라우저는 woff2 만 쓰는데 번들러는 60개(1.2MB)를 전부 싣는다 → `scripts/gen-katex-css.mjs` 가
  woff2 만 남긴 사본을 만든다(292KB). katex 를 올리면 이 스크립트를 다시 돌린다.
- **Tailwind v4 의 important 는 접미사**(`bg-x!`)다. v3 문법인 `!bg-x` 는 클래스를 아예 안 만든다 —
  오타와 똑같이 **조용히 죽어서** 타입체크도 테스트도 못 잡는다. 색이 안 먹으면 빌드된 CSS 에
  그 클래스가 있는지부터 본다(`grep -o 'bg-hairline[^{]*{[^}]*}' dist/assets/index-*.css`).
- **투명도 수식(`bg-error/10`)은 테마를 안 따라간다**. Tailwind 가 `color-mix()` 로 뽑으면서
  **라이트 값이 박힌 정적 폴백**을 같이 깔기 때문이다 → 옅은 면은 `--color-*-subtle` 토큰으로 만든다.
- **그림자를 `@theme` 에 넣으면 테마를 안 따라간다**. Tailwind 가 `shadow-*` 유틸리티를 만들면서
  값을 그대로 인라인하기 때문이다 → 평범한 `:root` 변수로 두고 `@utility`(`elevate`)로 선언한다.
- 폰트는 필요한 자족만 골라 `index.css` 가 `@font-face` 를 직접 적기도 한다. 패키지의 CSS 를
  통째로 `@import` 하면 쓰지도 않는 자족·폴백까지 실행 파일에 딸려 온다.
- **인스펙터의 "자" 와 게이지의 "토큰" 은 다른 자다**. 컨텍스트 모달은 문자 수를 세는데,
  들여쓴 JSON(`JSON.stringify(…, null, 2)`)을 재면 실제 페이로드보다 30% 가까이 부풀고
  도구 스키마는 아예 안 잡힌다 → 게이지의 토큰 수와 나란히 놓으면 "게이지가 노드 하나만
  센다" 는 오해가 생긴다(실제로 그렇게 읽혔다). 문자 수는 **들여쓰기 없는** 원문으로 세고,
  같은 자리에 그 호출의 **실측 토큰 수**를 함께 적어 둔다.
- `tsconfig.node.json` 은 composite 라 `noEmit` 대신 `emitDeclarationOnly`.

## 구조

```
src/
  index.css             디자인 토큰 (색·활자·모서리·그림자) — 라이트/다크 두 벌. 화면의 유일한 색 출처
  types/ipc.ts          Rust ↔ TS 타입 (serde camelCase 와 1:1)
  lib/ipc.ts            invoke 얇은 래퍼 — 유일한 IPC 통로
  lib/tree.ts           parent_id → 트리 복원, pathTo(), siblingsOf()
  lib/turns.ts          노드 체인 → 턴 묶음 + 채팅 말풍선 접기(toBubbles). 순수 파생, 스키마 무관
  lib/layout.ts         왼→오른쪽 tidy tree 좌표 (턴 그래프·서브에이전트 레인)
  lib/agentRuns.ts      서브에이전트 상태 색·경과 시간 (트리 노드와 대시보드 공용)
  lib/markdown.ts       채팅 본문용 경량 마크다운 파서 (의존성 없음). 수식은 구분 기호만 걷어 원문을 넘긴다
  styles/katex.css      KaTeX 스타일시트 사본 — 생성 파일(`scripts/gen-katex-css.mjs`), 직접 고치지 않는다
  lib/hooks.ts          훅 판정(순수) + 실행. 내장(알림) · 사용자(셸 명령)
  lib/notify.ts         OS 알림 한 줄 (tauri-plugin-notification 을 부를 때만 동적 로드)
  lib/panelSize.ts      세션 목록 ↔ 채팅 ↔ 우측 패널 분할 폭(순수). App 의 분할선이 쓴다
  lib/theme.ts          테마 결정(순수) + <html data-theme> 적용. 색값은 안 갖는다
  lib/i18n/             화면 문구 사전. `ko.ts` 가 원본이고 `en.ts` 가 같은 키를 채운다(타입으로 강제).
                        `locale.ts` 는 순수 판정(짐작·정규화), `index.ts` 가 현재 언어와 `t()`,
                        `useT.ts` 가 리액트 구독. 모델에게 가는 문장도 여기 산다
  lib/ai/builtinSkills.en.ts  내장 스킬 영어판. 한국어판과 **절차가 같아야** 한다 — 한쪽만 고치지 말 것
  lib/useResolvedTheme.ts  지금 적용된 테마를 React 로 (React Flow 처럼 JS 로 명암을 넘겨야 하는 곳만)
  lib/ai/abort.ts       도구 실행에 중단 붙이기 (ToolSet 래퍼)
  lib/ai/sseRepair.ts   OpenAI 호환 SSE 보정 (Gemini 가 빠뜨리는 tool_calls index 채우기)
  lib/ai/thoughtSignature.ts  Gemini 3.x thought_signature 왕복 (응답에서 줍고 다음 요청에 되붙이기)
  lib/ai/errors.ts      공급자 에러 → 읽을 수 있는 한 줄 (APICallError.responseBody 를 편다)
  lib/ai/approval.ts    셸 실행 승인 판정(순수) — 규칙 뽑기·매칭·위험 명령 판별
  lib/ai/attachments.ts `@` 참조 파일을 읽어 메시지에 싣는 블록으로 (바이너리는 자리표만)
  lib/ai/datetime.ts    지금 시각 블록 — 모델이 학습 시점을 "지금" 으로 착각하지 않게
  lib/mention.ts        `@` 토큰 찾기·끼워 넣기·뽑기 (순수). 입력칸과 전송 경로가 같은 규칙을 쓴다
  lib/ai/redact.ts      비밀값 가리기 — 도구 출력·에러 문구에서 API 키를 지운다 (`clip()` 이 부른다)
  lib/ai/providers.ts   "provider:modelId" 라우팅 + Tauri fetch 주입 + 로컬 서버(OpenAI 호환) 탐색
  lib/ai/usage.ts       토큰 사용량 정규화 + 요금 추정 + 컨텍스트 잔량 (순수 파생)
  lib/ai/runner.ts      streamText 한 턴 (DB 안 건드림) + tool 파트 변환
  lib/ai/tools.ts       IPC → AI SDK 도구 (zod 스키마 · 토글 · delegate_task). 매 턴 실린다
  lib/ai/skills.ts      스킬(절차서) 파싱·병합·목록 블록 + `load_skill`. 본문은 부를 때만 실린다
  lib/ai/builtinSkills.ts  내장 스킬 원문 (xlsx · docx · pdf — Python 절차). 코드에 박아 둔다
  lib/ai/subagent.ts    서브에이전트 한 명의 격리된 실행
  lib/ai/mcp.ts         MCP 도구 → dynamicTool (서버의 JSON Schema 그대로)
  lib/ai/instructions.ts 프로젝트 AGENTS.md 로딩 + 시스템 프롬프트 조합
  store/                workspace(트리) · chat(턴) · agents(서브) · mcp · skills · settings
                        approvals — 승인 대기열 + 세션 수명 허용 규칙 (디스크에 남기지 않는다)
  components/           chat · flow(턴 그래프) · agents · mcp · inspect · skills · hooks
                        SettingsModal.tsx — 좌측 섹션 목록 + 한 번에 한 섹션 (일반·모델·공급자·도구·스킬·훅·MCP)
                        ErrorBoundary.tsx — 렌더 예외로 창이 새까매지는 것을 막는다
                        UsageMeter.tsx — 토큰·요금·컨텍스트 게이지 (채팅/턴/세션 공용)
                        chat/ApprovalPrompt.tsx — 셸 실행 승인 카드 (입력칸 바로 위, 한 번에 하나)
                        chat/MentionPicker.tsx — `@` 자동완성 (방향키 이동 · Enter 선택)
                        Panel.tsx — 공통 부품(Button·Panel·Modal·Tag·Hint·입력 크롬). 새 UI 는 여기서 가져다 쓴다
src-tauri/src/
  lib.rs                command 등록 지점
  state.rs              프로젝트별 SQLite 커넥션 (with_conn)
  paths.rs              경로 정규화 + 루트 밖 차단
  process.rs            프로세스 트리 kill (셸·MCP 공용 — 손자까지 죽여야 파이프가 닫힌다)
  db/{schema,models,queries}.rs
  commands/{workspace,shell,fs,session,settings,skills,memory,agent,mcp}.rs
                        fs.rs 의 `search_project_files` 가 `@` 자동완성 목록을 만든다
                        (빌드 산출물 디렉터리는 애초에 훑지 않는다)
                        skills.rs 만 프로젝트 루트 밖(앱 설정 디렉터리)을 연다 — 전역 스킬이 거기 산다
  mcp.rs                MCP stdio 클라이언트 (JSON-RPC 피어 + 프로세스 레지스트리)
```

## 도메인 개념

- **대화 트리**: `messages.parent_id` 가 간선. 분기는 2층 — (a) 세션 내: `activeParentId` 변경 → 형제 노드, (b) 새 세션: `branch_session` 이 조상 체인을 복제.
- **턴**: 화면에 보이는 노드 하나 = 턴 하나(user 앵커 + 그 아래 assistant/tool 체인). `lib/turns.ts` 가 매번 다시 계산하며 DB 에는 저장하지 않는다. 삭제도 턴 단위 — 반쪽 노드를 만들지 않는다.
- **삭제·되돌리기·복사**: 삭제는 두 가지다. **이 턴만**(`cascade: false`)은 그 턴의 노드만 지우고
  자식들을 살아남은 조상에 다시 매단다(`delete_messages` 가 `reattached` 로 알려 준다).
  **아래까지**(`cascade: true`)는 후손까지 지운다. 어느 쪽이든 `DeleteOutcome` 이 되돌리기 표이고,
  프론트가 그걸 그대로 `restore_messages` 로 돌려보내면 **원래 id·seq** 로 되살아난다
  (id 가 바뀌면 서브에이전트 링크도 자식의 부모도 다시 못 잇는다). 되돌리기 스택은 **메모리에만** 산다.
  서브에이전트 기록은 삭제하지 않는다 — 실제 지출이라 지우면 세션 비용이 줄어든다(링크만 끊고 되돌리면 붙는다).
  복사(`copy_messages`)는 **토큰 사용량·컨텍스트 스냅샷을 비운다**(이중 집계·거짓 원문 방지).
- **세션의 뿌리는 하나**: 분기는 그래프에서 턴을 골라 만드는 길 하나뿐이다. 버튼으로 같은 일을
  또 하게 두었더니 루트 턴에서 뿌리가 여러 개 생겼다 → 버튼을 없앴고, 뿌리를 늘리는
  삭제·붙여넣기는 `queries.rs` 가 거절한다. 화면 쪽 같은 판정은 `soloDeleteBlocker()`
  (`lib/turns.ts`) — **두 곳이 어긋나면 눌리는 버튼이 DB 에서 거절당한다**.
- **세션 목록**: 좌측 사이드바 하나가 세션의 선택·생성·이름 변경·삭제를 모두 맡는다. 집계는 `list_sessions` 가 `SessionOverview` 로 한 번에 내려준다(세션마다 메시지를 읽지 않는다). 세션 맵(분기 세션 트리)은 세션 분기를 만드는 길이 사라지면서 함께 걷어냈다.
- **도구 실행**: 한 턴이 여러 스텝. 스텝마다 `assistant`(호출) → `tool`(결과) → `assistant` 노드가 쌓인다. 짝 없는 tool-call/result 는 `toModelMessages()` 가 걸러낸다(공급자가 400 을 낸다).
  저장은 이렇게 둘로 나뉘지만 **채팅 화면에서는 한 말풍선**이다 — `toBubbles()`(`lib/turns.ts`)가 tool 노드를 자기를 부른 assistant 말풍선으로 흡수하고, 도구 묶음은 기본 접힘이다.
- **토큰·비용**: **노드 하나 = LLM 호출 하나**다. 스텝이 끝날 때마다 그 호출 하나의 사용량이
  그 스텝의 assistant 노드 `token_usage` 에 남는다
  (`{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens, modelId }`).
  **비용은 저장하지 않는다** — 언제나 `MODEL_CATALOG` 요율표로 다시 계산한다(저장하면 노드별 합과
  세션 집계가 어긋난다). 서브에이전트는 노드를 안 남기므로 `agent_runs.token_usage` 에 따로 적는다.
  세션 카드용 누적은 `list_sessions` 가 **모델별로 나눠서**(`usageByModel`) 내려준다 — 같은 토큰도
  모델마다 단가가 다르므로 먼저 합치면 값이 틀어진다.
- **컨텍스트 잔량**: 답은 "지금 [전송]을 누르면 얼마가 나가는가" 여야 한다. 대화는 매 턴 전체가
  다시 올라가므로 누적 합이 아니고, 그렇다고 **마지막 호출의 실측값**도 아니다 — 그 뒤에 붙은
  것(그 답변, 새 질문)은 아직 아무도 센 적이 없기 때문이다. `projectTokens()` 가
  **실측에 못을 박고 늘어난 만큼만** 환산한다: 비율은 일반론이 아니라 이 대화가 방금 만든 값
  (마지막 호출이 받은 페이로드의 문자 수 ÷ 그 호출의 입력 토큰)이라 매 턴 다시 보정된다.
  앞쪽 노드로 분기하면 환산분이 음수가 된다. 페이로드를 못 만드는 세션 카드만 옛 어림
  (입력+출력)으로 물러난다.
  분모는 **지금 선택한 모델**의 `contextWindow` 다 — 창 크기가 모델마다 200K~1M 로 다섯 배씩
  차이 나서 모델을 바꾸면 같은 대화라도 여유가 완전히 달라진다. 분자를 잰 모델이 그와 다르면
  토크나이저가 어긋나므로 `approximate` 로 표시만 하고 값을 보정하지 않는다.
  **페이로드는 `contextPayloadOf()` 한 군데서만 만든다** — 채팅 게이지와 인스펙터가 다른 수를
  말하면 그 자체가 버그로 읽힌다(실제로 그렇게 읽혔다).
  표시는 원형 링(`ContextRing`)이고 채팅 입력칸 위와 세션 카드가 같은 부품을 쓴다.
- **투명성이 이 툴의 경쟁력**: assistant 노드의 `context_snapshot` 에 그 시점 LLM 입력 원문을 남기고 인스펙터로 보여준다. 새 기능도 "무엇이 LLM 에 갔는지" 숨기지 않게 만든다.
- **프로젝트 지침**: 연 프로젝트 루트의 `AGENTS.md` 를 매 턴 다시 읽어 시스템 프롬프트 맨 앞에 원문 그대로 싣는다(서브에이전트에도 전달).
- **서브에이전트**: `delegate_task` → 컨텍스트가 격리된 별도 실행, 요약만 상위로. `parent_message_id` 가 가리키는 노드의 턴에서 위/아래로 분기해 그려진다(대시보드 탭과 병행). `onDelegate` 없이 ToolSet 을 만들면 도구가 노출되지 않아 재위임이 구조적으로 불가능하다. 상태는 `agent_runs`.
- **스킬**: 절차서(`SKILL.md`)다. 시스템 프롬프트에는 `이름: 설명` 한 줄씩만 실리고, 모델이
  필요하다고 판단하면 `load_skill` 로 본문을 끌어온다 — 절차를 길게 적어도 평소 컨텍스트가 안 는다.
  세 곳에서 오고 **뒤엣것이 같은 이름을 덮어쓴다**: 내장(코드) → 전역(앱 설정 디렉터리의 `skills/`)
  → 프로젝트(`.dongdong/skills/`). 프로젝트 쪽을 `.agent_workspace` 에 두지 않은 이유는 그 폴더의
  `.gitignore` 가 `*` 라 리포와 함께 공유될 수 없기 때문이다. 파싱(frontmatter)은 **TS 가 한다** —
  Rust 는 파일만 읽어 온다(규칙을 두 언어로 나눠 적으면 반드시 어긋난다).
- **실행 승인**: 셸 명령과 **파일 삭제**는 기본적으로 사람이 눌러야 돈다. 파일 읽기·생성·수정은
  묻지 않는다 — 묻는 창이 많아지면 사람이 읽지 않고 누르고, 그러면 정작 물어야 할 것도 함께
  흘러간다(가르는 손잡이는 설정의 도구 토글이다). 모드는 둘 — `자동 실행` / `승인 필요`.
  카드는 **한 번에 하나만** 뜬다(여러 장을 쌓으면 읽지 않고 누르게 된다). 버튼 셋은 전부 채운
  버튼이다 — 하나만 옅으면 그것만 덜 중요한 것으로 읽혀 눈이 미끄러지는데, 여기서 미끄러지면
  안 되는 판단이다(실행=primary 청록 · 항상 허용=secondary 잉크 · 거부=danger).
  [항상 허용] 을 누르면 그 명령을 덮는 규칙이 생긴다: 단일 명령은 프로그램(+하위 명령)
  앞부분으로, 연산자가 섞인 명령은 **전체가 같을 때만**. 되돌리기 어려운 명령
  (`rm`·`git push`·`curl` …)에는 [항상 허용] 버튼 자체가 뜨지 않는다.
  **규칙의 수명은 지금 세션이다** — `settings.json` 이 아니라 `store/approvals.ts` 의 메모리에
  살고, 세션을 바꾸거나 앱을 다시 켜면 사라진다(어제 한 번 누른 것이 오늘 다른 프로젝트의
  명령을 조용히 통과시키면 승인 화면을 둔 뜻이 사라진다). 스코프는 **누르기 전에** 카드에
  글자로 적어 둔다. 삭제는 [항상 허용]을 아예 내주지 않는다.
  승인을 기다리는 동안 [중지]를 누르면 중단 경주가 도구를 거절하고 대기열도 함께 풀린다.
  **진행 표시는 두 상태를 갈라 말해야 한다** — "도구 실행 중" 만 떠 있으면 승인을 기다리는
  중인지 진짜로 도는 중인지 구별할 수 없어 멀쩡한 명령이 "무한 로딩" 으로 읽힌다.
  채팅 하단 바가 `승인 대기 중` / `도구 실행 중` 과 **경과 초**를 함께 적는다.
- **셸은 반드시 끝난다**: 타임아웃은 기본 2분·최대 10분이고 **양쪽에서 접는다**
  (`tools.ts` 의 `MAX_SHELL_TIMEOUT_MS` · `shell.rs` 의 `effective_timeout`).
  상한이 없으면 모델이 크게 잡아 온 `timeoutMs` 하나로 턴이 몇 시간이고 멈춰 선다.
- **`@` 파일 참조**: 입력칸에서 `@` 를 치면 프로젝트 파일 목록이 뜨고, 고른 파일은 **보내기
  직전에 읽혀** 사용자 노드의 `content` 뒤에 `<attached_files>` 블록으로 함께 저장된다
  (모델은 통째로 받고, 말풍선·그래프 카드는 접는다 — 같은 `splitAttachments()` 를 쓴다).
  텍스트가 아닌 파일은 **본문을 싣지 않는다**: 엑셀·워드·PDF 는 경로·종류·크기만 남기고
  `load_skill("xlsx"|"docx"|"pdf")` 로 절차를 열어 Python 으로 직접 읽으라고 짚어 준다.
  실린 내용은 `clip()` 을 지나므로 상한(파일당 20,000자·합계 60,000자)과 비밀값 가리기가 함께 걸린다.
- **화면 언어**: 한국어 · 영어 두 벌이고 설정의 [일반]에서 고른다. 바뀌는 것은 화면 문구만이
  아니다 — 기본 시스템 프롬프트, 도구 설명(`tools.ts`), 스킬 목록 블록과 내장 스킬 본문,
  `@` 첨부 안내, 현재 시각 블록이 함께 간다. 처음 켤 때는 OS 언어로 짐작하고(`detectLocale`),
  선택값은 `settings.json` 에 저장하며 테마와 같은 이유로 `localStorage` 에도 복사한다
  (`public/theme-boot.js` 가 첫 페인트 전에 `<html lang>` 을 맞춘다).
  **세션 제목처럼 문장이 디스크에 저장되는 값**은 지금 언어로만 비교하면 안 된다 —
  `matchesAnyLocale()` 로 어느 언어의 기본값이든 알아본다(안 그러면 한국어로 만든 세션이
  영어로 바꾼 뒤 "사용자가 지은 제목" 으로 보여 자동 제목이 안 붙는다).
- **현재 시각**: 모델은 학습이 끝난 시점을 "지금" 으로 안다 → 최신 자료를 지난 연도로 찾는다.
  `composeSystemPrompt()` 가 시각 블록을 **맨 뒤**(대화 바로 앞)에 붙인다. 대화 노드에는 남기지
  않는다 — 남기면 옛 턴의 시각이 화석으로 남는다. 채팅 게이지·인스펙터·실제 전송이 같은 함수를
  써야 세 화면이 같은 수를 말한다.
- **훅**: 턴 시작·완료·오류 시점에 도는 부수 동작. 내장(OS 알림)은 켜고 끄기만 하고, 사용자 훅은
  셸 명령 한 줄이다. 자리표(`{{status}}` 등)에 들어가는 값은 셸을 가를 수 있는 글자를 걷어내고,
  **공급자 에러 문자열은 자리표로 주지 않는다**(알림 문구로만 쓴다).
- **MCP**: 외부 서버를 stdio 자식 프로세스로 띄워 도구를 `mcp__서버__도구` 이름으로 합친다.
  파이프 읽기는 블로킹이라 요청마다 감시 스레드로 타임아웃을 건다. **중단도 같은 방법뿐이다** —
  읽기를 푸는 길이 서버를 죽이는 것밖에 없어서 중단하면 그 연결도 끊긴다 → `store/mcp.ts` 가
  곧바로 다시 붙인다(안 그러면 다음 턴에 도구가 조용히 사라진다).

설계 배경과 상세는 `README.ko.md`(영문 표지는 `README.md`). 로컬 오픈소스 모델 운용은
`docs/local-llm.md`. 디자인 규율은 `docs/design.md`. **보안 모델(무엇을 막고 무엇을 못 막는지)은
`docs/security.md`** — 도구·경로·프로세스·설정을 건드릴 때 먼저 읽는다.
