# CLAUDE.md

`dongdong` — 노드 기반 대화 시각화를 갖춘 **로컬 코딩 에이전트** (Tauri 2 + React 19).
도커/샌드박스 없이 사용자 OS 권한으로 직접 실행하고, 프로젝트 루트의 `.agent_workspace/local.db`(SQLite)에 저장한다.
Phase 1~4 완료: 워크스페이스·대화 트리 → LLM 스트리밍 → Skill/Inspector → 서브에이전트 + MCP 브리지.

## 작업 후 반드시 통과시킬 것

```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test --lib
```

현재 기준 vitest 235 / cargo 40. 기능을 추가하면 테스트도 함께 붙인다.
실제 구동 확인은 `pnpm tauri dev`.

## 기술 스택 (변경 금지)

React 19 · Vite 6 · TypeScript · Tailwind v4 · Zustand 5 · React Flow 12 · zod 4 ·
**Vercel AI SDK Core v7** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) · Tauri 2 (Rust, rusqlite bundled).
LangChain 같은 상위 추상화를 넣지 않는다. LLM 호출은 `streamText` 직접 호출.

## 절대 규칙

- **IPC**: 앱 코드는 `invoke()` 를 직접 부르지 않는다. 항상 `src/lib/ipc.ts` 경유.
- **새 command 는 4곳을 함께 고친다**: `src-tauri/src/commands/*.rs` → `lib.rs` 의 `invoke_handler` 등록 → `src/types/ipc.ts` → `src/lib/ipc.ts`. 하나라도 빠지면 런타임에야 터진다.
- **타입 동기화**: Rust 모델(serde `camelCase`)을 고치면 `src/types/ipc.ts` 도 같이 고친다.
- **DB**: 모든 SQL 은 `db/queries.rs` 에만. 커넥션 접근은 `state.rs` 의 `with_conn()` 이 유일한 통로.
- **마이그레이션**: `db/schema.rs` 의 `MIGRATIONS` 배열 **끝에만 추가**. 기존 항목 수정 금지(이미 만들어진 DB 와 어긋난다).
- **경로**: 파일 경로는 `paths.rs` 경유. `resolve_within()` 이 프로젝트 루트 밖 접근을 막는다.
- **오래 걸리는 command 는 `async` + `spawn_blocking`**. 동기 command 는 메인 스레드를 막아 UI 가 언다.
- **중단 경로를 끊지 말 것**: 새 도구를 붙이면 `abortSignal` 을 반드시 존중한다. `runner.ts` 가 `abortableTools()` 로 한 번 감싸 주지만, 백그라운드에서 진짜 돌고 있는 작업(프로세스·자식 프로세스)은 도구가 스스로 정리해야 한다(`execute_shell_command` → `cancel_shell_command`).
- **스트리밍 중 DB 쓰기 금지**. 토큰은 Zustand 에만 쌓고 **스텝 경계**(도구 호출 확정 / 턴 종료)에서만 저장한다.
- **`MODEL_CATALOG`(`lib/ai/providers.ts`) 는 사용자 소유** — 임의로 고치지 않는다.
- **색·활자는 토큰만 쓴다**: 컴포넌트에 `zinc-800` 같은 팔레트 값이나 `#hex` 를 직접 적지 않는다.
  전부 `index.css` 의 의미 토큰(`bg-canvas` · `text-ink-muted` · `border-hairline` · `text-caption` …)
  경유. 하드코딩하면 다크 테마에서 그 자리만 깨진다. 규율은 `docs/design.md`.
- **모서리는 둥글게 · 그림자는 아주 옅게 · 크로마틱 액센트는 청록 하나** — 두 번째 브랜드 색을
  만들지 않는다. 뜻이 더 필요하면 라벨·아이콘·자리·테두리 굵기로 가른다.
- 주석과 UI 문구는 **한국어**. 주변 코드의 주석 밀도·네이밍을 따른다.

## 함정 (겪은 것들)

- **CORS**: 웹뷰 기본 `fetch` 로는 Anthropic 이 막힌다. `@tauri-apps/plugin-http` 의 `fetch` 를 provider 에 주입해 Rust(reqwest)를 경유한다. **새 LLM 도메인을 쓰면 `src-tauri/capabilities/default.json` 의 `http:default` 스코프에 URL 추가** 필수.
- Tauri HTTP 플러그인은 그래도 요청마다 웹뷰 주소로 **`Origin` 헤더를 강제로 붙인다**(플러그인 Rust 쪽 `commands.rs`). Anthropic 은 `Origin` 이 있으면 브라우저 직접 호출로 보고 `CORS requests must set 'anthropic-dangerous-direct-browser-access' header` 로 거부한다 → `createAnthropic({ headers: { "anthropic-dangerous-direct-browser-access": "true" } })` 로 켜 준다. 키가 로컬 밖으로 안 나가므로 안전하다.
- **AI SDK 의 중단은 "청크가 흐를 때만" 관측된다**. `streamText` 는 스트림에서 청크를 하나 읽은 뒤에 `abortSignal.aborted` 를 확인한다. 도구가 실행 중이면 청크가 없으므로 [중단]을 눌러도 아무 일도 일어나지 않는다 → 도구 자체를 중단 시그널과 경주시킨다(`lib/ai/abort.ts`). 도구가 거절되면 tool-error 청크가 흐르고 그때 스트림이 닫힌다.
- **Windows 에서 자식만 kill 하면 파이프가 안 닫힌다**. `cmd /C pnpm dev` 처럼 손자가 생기는 명령은 cmd 를 죽여도 손자가 stdout 을 물고 있어 리더 스레드의 `read` 가 EOF 를 못 본다 → `join()` 이 영구 대기하고 도구 호출이 영영 안 끝난다. `taskkill /T /F` 로 트리째 죽이고, 리더 조인에도 유예 시간을 둔다(`commands/shell.rs`).
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
- **Tailwind v4 의 important 는 접미사**(`bg-x!`)다. v3 문법인 `!bg-x` 는 클래스를 아예 안 만든다 —
  오타와 똑같이 **조용히 죽어서** 타입체크도 테스트도 못 잡는다. 색이 안 먹으면 빌드된 CSS 에
  그 클래스가 있는지부터 본다(`grep -o 'bg-hairline[^{]*{[^}]*}' dist/assets/index-*.css`).
- **투명도 수식(`bg-error/10`)은 테마를 안 따라간다**. Tailwind 가 `color-mix()` 로 뽑으면서
  **라이트 값이 박힌 정적 폴백**을 같이 깔기 때문이다 → 옅은 면은 `--color-*-subtle` 토큰으로 만든다.
- **그림자를 `@theme` 에 넣으면 테마를 안 따라간다**. Tailwind 가 `shadow-*` 유틸리티를 만들면서
  값을 그대로 인라인하기 때문이다 → 평범한 `:root` 변수로 두고 `@utility`(`elevate`)로 선언한다.
- 폰트는 필요한 자족만 골라 `index.css` 가 `@font-face` 를 직접 적기도 한다. 패키지의 CSS 를
  통째로 `@import` 하면 쓰지도 않는 자족·폴백까지 실행 파일에 딸려 온다.
- `tsconfig.node.json` 은 composite 라 `noEmit` 대신 `emitDeclarationOnly`.

## 구조

```
src/
  index.css             디자인 토큰 (색·활자·모서리·그림자) — 라이트/다크 두 벌. 화면의 유일한 색 출처
  types/ipc.ts          Rust ↔ TS 타입 (serde camelCase 와 1:1)
  lib/ipc.ts            invoke 얇은 래퍼 — 유일한 IPC 통로
  lib/tree.ts           parent_id → 트리 복원, pathTo(), siblingsOf()
  lib/turns.ts          노드 체인 → 턴 묶음 + 채팅 말풍선 접기(toBubbles). 순수 파생, 스키마 무관
  lib/sessionTree.ts    parent_session_id → 세션 분기 트리
  lib/layout.ts         왼→오른쪽 tidy tree 좌표 (턴 그래프·세션 맵 공용)
  lib/agentRuns.ts      서브에이전트 상태 색·경과 시간 (트리 노드와 대시보드 공용)
  lib/markdown.ts       채팅 본문용 경량 마크다운 파서 (의존성 없음)
  lib/theme.ts          테마 결정(순수) + <html data-theme> 적용. 색값은 안 갖는다
  lib/useResolvedTheme.ts  지금 적용된 테마를 React 로 (React Flow 처럼 JS 로 명암을 넘겨야 하는 곳만)
  lib/ai/abort.ts       도구 실행에 중단 붙이기 (ToolSet 래퍼)
  lib/ai/providers.ts   "provider:modelId" 라우팅 + Tauri fetch 주입 + 로컬 서버(OpenAI 호환) 탐색
  lib/ai/usage.ts       토큰 사용량 정규화 + 요금 추정 + 컨텍스트 잔량 (순수 파생)
  lib/ai/runner.ts      streamText 한 턴 (DB 안 건드림) + tool 파트 변환
  lib/ai/skills.ts      IPC → AI SDK 도구 (zod 스키마 · 토글 · delegate_task)
  lib/ai/subagent.ts    서브에이전트 한 명의 격리된 실행
  lib/ai/mcp.ts         MCP 도구 → dynamicTool (서버의 JSON Schema 그대로)
  lib/ai/instructions.ts 프로젝트 AGENTS.md 로딩 + 시스템 프롬프트 조합
  store/                workspace(트리) · chat(턴) · agents(서브) · mcp · settings
  components/           chat · flow(턴 그래프) · sessions(세션 맵) · agents · mcp · inspect
                        ErrorBoundary.tsx — 렌더 예외로 창이 새까매지는 것을 막는다
                        UsageMeter.tsx — 토큰·요금·컨텍스트 게이지 (채팅/턴/세션 공용)
                        Panel.tsx — 공통 부품(Button·Panel·Modal·Tag·입력 크롬). 새 UI 는 여기서 가져다 쓴다
src-tauri/src/
  lib.rs                command 등록 지점
  state.rs              프로젝트별 SQLite 커넥션 (with_conn)
  paths.rs              경로 정규화 + 루트 밖 차단
  db/{schema,models,queries}.rs
  commands/{workspace,shell,fs,session,settings,memory,agent,mcp}.rs
  mcp.rs                MCP stdio 클라이언트 (JSON-RPC 피어 + 프로세스 레지스트리)
```

## 도메인 개념

- **대화 트리**: `messages.parent_id` 가 간선. 분기는 2층 — (a) 세션 내: `activeParentId` 변경 → 형제 노드, (b) 새 세션: `branch_session` 이 조상 체인을 복제.
- **턴**: 화면에 보이는 노드 하나 = 턴 하나(user 앵커 + 그 아래 assistant/tool 체인). `lib/turns.ts` 가 매번 다시 계산하며 DB 에는 저장하지 않는다. 삭제도 턴 단위(앵커부터 CASCADE) — 반쪽 노드를 만들지 않는다.
- **세션 맵**: 프로젝트를 열면 먼저 뜨는 화면. `parent_session_id` 로 세션 분기를 그린다. 카드 집계는 `list_sessions` 가 `SessionOverview` 로 한 번에 내려준다(세션마다 메시지를 읽지 않는다).
- **도구 실행**: 한 턴이 여러 스텝. 스텝마다 `assistant`(호출) → `tool`(결과) → `assistant` 노드가 쌓인다. 짝 없는 tool-call/result 는 `toModelMessages()` 가 걸러낸다(공급자가 400 을 낸다).
  저장은 이렇게 둘로 나뉘지만 **채팅 화면에서는 한 말풍선**이다 — `toBubbles()`(`lib/turns.ts`)가 tool 노드를 자기를 부른 assistant 말풍선으로 흡수하고, 도구 묶음은 기본 접힘이다.
- **토큰·비용**: 턴이 끝나면 그 턴 전체의 사용량이 마지막 assistant 노드의 `token_usage` 에 남는다
  (`{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens, modelId }`).
  **비용은 저장하지 않는다** — 언제나 `MODEL_CATALOG` 요율표로 다시 계산한다(저장하면 노드별 합과
  세션 집계가 어긋난다). 서브에이전트는 노드를 안 남기므로 `agent_runs.token_usage` 에 따로 적는다.
  세션 카드용 누적은 `list_sessions` 가 **모델별로 나눠서**(`usageByModel`) 내려준다 — 같은 토큰도
  모델마다 단가가 다르므로 먼저 합치면 값이 틀어진다.
- **컨텍스트 잔량**: 대화는 매 턴 전체가 다시 올라가므로 누적 합이 아니라 **마지막 호출의 입력+출력**이
  다음 턴에 실릴 양이다. 그 값을 모델의 `contextWindow` 와 견줘 게이지로 보여준다.
- **투명성이 이 툴의 경쟁력**: assistant 노드의 `context_snapshot` 에 그 시점 LLM 입력 원문을 남기고 인스펙터로 보여준다. 새 기능도 "무엇이 LLM 에 갔는지" 숨기지 않게 만든다.
- **프로젝트 지침**: 연 프로젝트 루트의 `AGENTS.md` 를 매 턴 다시 읽어 시스템 프롬프트 맨 앞에 원문 그대로 싣는다(서브에이전트에도 전달).
- **서브에이전트**: `delegate_task` → 컨텍스트가 격리된 별도 실행, 요약만 상위로. `parent_message_id` 가 가리키는 노드의 턴에서 위/아래로 분기해 그려진다(대시보드 탭과 병행). `onDelegate` 없이 ToolSet 을 만들면 도구가 노출되지 않아 재위임이 구조적으로 불가능하다. 상태는 `agent_runs`.
- **MCP**: 외부 서버를 stdio 자식 프로세스로 띄워 도구를 `mcp__서버__도구` 이름으로 합친다. 파이프 읽기는 블로킹이라 요청마다 감시 스레드로 타임아웃을 건다.

설계 배경과 상세는 `README.md`. 로컬 오픈소스 모델 운용은 `docs/local-llm.md`. 디자인 규율은 `docs/design.md`.
