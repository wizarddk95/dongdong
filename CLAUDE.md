# CLAUDE.md

`dongdong` — 노드 기반 대화 시각화를 갖춘 **로컬 코딩 에이전트** (Tauri 2 + React 19).
도커/샌드박스 없이 사용자 OS 권한으로 직접 실행하고, 프로젝트 루트의 `.agent_workspace/local.db`(SQLite)에 저장한다.
Phase 1~4 완료: 워크스페이스·대화 트리 → LLM 스트리밍 → Skill/Inspector → 서브에이전트 + MCP 브리지.

## 작업 후 반드시 통과시킬 것

```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test --lib
```

현재 기준 vitest 143 / cargo 34. 기능을 추가하면 테스트도 함께 붙인다.
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
- 주석과 UI 문구는 **한국어**. 주변 코드의 주석 밀도·네이밍을 따른다.

## 함정 (겪은 것들)

- **CORS**: 웹뷰 기본 `fetch` 로는 Anthropic 이 막힌다. `@tauri-apps/plugin-http` 의 `fetch` 를 provider 에 주입해 Rust(reqwest)를 경유한다. **새 LLM 도메인을 쓰면 `src-tauri/capabilities/default.json` 의 `http:default` 스코프에 URL 추가** 필수.
- Tauri HTTP 플러그인은 그래도 요청마다 웹뷰 주소로 **`Origin` 헤더를 강제로 붙인다**(플러그인 Rust 쪽 `commands.rs`). Anthropic 은 `Origin` 이 있으면 브라우저 직접 호출로 보고 `CORS requests must set 'anthropic-dangerous-direct-browser-access' header` 로 거부한다 → `createAnthropic({ headers: { "anthropic-dangerous-direct-browser-access": "true" } })` 로 켜 준다. 키가 로컬 밖으로 안 나가므로 안전하다.
- **AI SDK 의 중단은 "청크가 흐를 때만" 관측된다**. `streamText` 는 스트림에서 청크를 하나 읽은 뒤에 `abortSignal.aborted` 를 확인한다. 도구가 실행 중이면 청크가 없으므로 [중단]을 눌러도 아무 일도 일어나지 않는다 → 도구 자체를 중단 시그널과 경주시킨다(`lib/ai/abort.ts`). 도구가 거절되면 tool-error 청크가 흐르고 그때 스트림이 닫힌다.
- **Windows 에서 자식만 kill 하면 파이프가 안 닫힌다**. `cmd /C pnpm dev` 처럼 손자가 생기는 명령은 cmd 를 죽여도 손자가 stdout 을 물고 있어 리더 스레드의 `read` 가 EOF 를 못 본다 → `join()` 이 영구 대기하고 도구 호출이 영영 안 끝난다. `taskkill /T /F` 로 트리째 죽이고, 리더 조인에도 유예 시간을 둔다(`commands/shell.rs`).
- Anthropic 4.6+ 는 `temperature` 를 거부한다 → adaptive thinking + `effort`(`providerOptionsFor()`).
- `ModelMessage` / `ToolSet` / `tool` / `dynamicTool` / `jsonSchema` 는 `ai` 가 아니라 **`@ai-sdk/provider-utils`** 에서 import.
- Windows `cmd` 출력은 CP949 로 깨진다 → `chcp 65001` 선행. `npx` 같은 `.cmd` 는 직접 spawn 되지 않아 `cmd /C` 경유.
- React Flow 노드의 `onNodeDoubleClick` 은 `zoomOnDoubleClick`(기본 `true`)과 함께 쓰면 **죽는다**. d3-zoom 의 dblclick 핸들러가 `stopImmediatePropagation()` 을 불러 이벤트가 React 루트(위임 지점)까지 못 올라간다 → 노드 더블클릭을 쓰려면 `zoomOnDoubleClick={false}`.
- API 키·MCP 서버 목록은 프로젝트 DB 가 아니라 **OS 앱 설정 디렉터리의 `settings.json`**.
- Bash 툴에서 cargo 를 쓰려면 `export PATH="$USERPROFILE/.cargo/bin:$PATH"`.
- `pnpm tauri dev` 실행 중에 Rust 를 고치면 exe 교체 실패(os error 5)로 워처가 죽는다 → 앱 프로세스를 종료하고 다시 띄운다. 종료 후 포트 1420 을 문 vite 프로세스가 남기도 한다.
- `tsconfig.node.json` 은 composite 라 `noEmit` 대신 `emitDeclarationOnly`.

## 구조

```
src/
  types/ipc.ts          Rust ↔ TS 타입 (serde camelCase 와 1:1)
  lib/ipc.ts            invoke 얇은 래퍼 — 유일한 IPC 통로
  lib/tree.ts           parent_id → 트리 복원, pathTo(), siblingsOf()
  lib/turns.ts          노드 체인 → 턴(질문+응답+도구) 묶음. 순수 파생, 스키마 무관
  lib/sessionTree.ts    parent_session_id → 세션 분기 트리
  lib/layout.ts         왼→오른쪽 tidy tree 좌표 (턴 그래프·세션 맵 공용)
  lib/agentRuns.ts      서브에이전트 상태 색·경과 시간 (트리 노드와 대시보드 공용)
  lib/markdown.ts       채팅 본문용 경량 마크다운 파서 (의존성 없음)
  lib/ai/abort.ts       도구 실행에 중단 붙이기 (ToolSet 래퍼)
  lib/ai/providers.ts   "provider:modelId" 라우팅 + Tauri fetch 주입
  lib/ai/runner.ts      streamText 한 턴 (DB 안 건드림) + tool 파트 변환
  lib/ai/skills.ts      IPC → AI SDK 도구 (zod 스키마 · 토글 · delegate_task)
  lib/ai/subagent.ts    서브에이전트 한 명의 격리된 실행
  lib/ai/mcp.ts         MCP 도구 → dynamicTool (서버의 JSON Schema 그대로)
  lib/ai/instructions.ts 프로젝트 AGENTS.md 로딩 + 시스템 프롬프트 조합
  store/                workspace(트리) · chat(턴) · agents(서브) · mcp · settings
  components/           chat · flow(턴 그래프) · sessions(세션 맵) · agents · mcp · inspect
                        ErrorBoundary.tsx — 렌더 예외로 창이 새까매지는 것을 막는다
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
- **투명성이 이 툴의 경쟁력**: assistant 노드의 `context_snapshot` 에 그 시점 LLM 입력 원문을 남기고 인스펙터로 보여준다. 새 기능도 "무엇이 LLM 에 갔는지" 숨기지 않게 만든다.
- **프로젝트 지침**: 연 프로젝트 루트의 `AGENTS.md` 를 매 턴 다시 읽어 시스템 프롬프트 맨 앞에 원문 그대로 싣는다(서브에이전트에도 전달).
- **서브에이전트**: `delegate_task` → 컨텍스트가 격리된 별도 실행, 요약만 상위로. `parent_message_id` 가 가리키는 노드의 턴에서 위/아래로 분기해 그려진다(대시보드 탭과 병행). `onDelegate` 없이 ToolSet 을 만들면 도구가 노출되지 않아 재위임이 구조적으로 불가능하다. 상태는 `agent_runs`.
- **MCP**: 외부 서버를 stdio 자식 프로세스로 띄워 도구를 `mcp__서버__도구` 이름으로 합친다. 파이프 읽기는 블로킹이라 요청마다 감시 스레드로 타임아웃을 건다.

설계 배경과 상세는 `README.md`.
