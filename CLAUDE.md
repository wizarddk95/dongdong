# CLAUDE.md

`dongdong` — 노드 기반 대화 시각화를 갖춘 **로컬 코딩 에이전트** (Tauri 2 + React 19).
도커/샌드박스 없이 사용자 OS 권한으로 직접 실행하고, 프로젝트 루트의 `.agent_workspace/local.db`(SQLite)에 저장한다.
Phase 1~4 완료: 워크스페이스·대화 트리 → LLM 스트리밍 → Skill/Inspector → 서브에이전트 + MCP 브리지.

## 작업 후 반드시 통과시킬 것

```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test --lib
```

현재 기준 vitest 84 / cargo 29. 기능을 추가하면 테스트도 함께 붙인다.
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
- **스트리밍 중 DB 쓰기 금지**. 토큰은 Zustand 에만 쌓고 **스텝 경계**(도구 호출 확정 / 턴 종료)에서만 저장한다.
- **`MODEL_CATALOG`(`lib/ai/providers.ts`) 는 사용자 소유** — 임의로 고치지 않는다.
- 주석과 UI 문구는 **한국어**. 주변 코드의 주석 밀도·네이밍을 따른다.

## 함정 (겪은 것들)

- **CORS**: 웹뷰 기본 `fetch` 로는 Anthropic 이 막힌다. `@tauri-apps/plugin-http` 의 `fetch` 를 provider 에 주입해 Rust(reqwest)를 경유한다. **새 LLM 도메인을 쓰면 `src-tauri/capabilities/default.json` 의 `http:default` 스코프에 URL 추가** 필수.
- Anthropic 4.6+ 는 `temperature` 를 거부한다 → adaptive thinking + `effort`(`providerOptionsFor()`).
- `ModelMessage` / `ToolSet` / `tool` / `dynamicTool` / `jsonSchema` 는 `ai` 가 아니라 **`@ai-sdk/provider-utils`** 에서 import.
- Windows `cmd` 출력은 CP949 로 깨진다 → `chcp 65001` 선행. `npx` 같은 `.cmd` 는 직접 spawn 되지 않아 `cmd /C` 경유.
- API 키·MCP 서버 목록은 프로젝트 DB 가 아니라 **OS 앱 설정 디렉터리의 `settings.json`**.
- Bash 툴에서 cargo 를 쓰려면 `export PATH="$USERPROFILE/.cargo/bin:$PATH"`.
- `pnpm tauri dev` 실행 중에 Rust 를 고치면 exe 교체 실패(os error 5)로 워처가 죽는다 → 앱 프로세스를 종료하고 다시 띄운다. 종료 후 포트 1420 을 문 vite 프로세스가 남기도 한다.
- `tsconfig.node.json` 은 composite 라 `noEmit` 대신 `emitDeclarationOnly`.

## 구조

```
src/
  types/ipc.ts          Rust ↔ TS 타입 (serde camelCase 와 1:1)
  lib/ipc.ts            invoke 얇은 래퍼 — 유일한 IPC 통로
  lib/tree.ts           parent_id → 트리 복원, pathTo(), 좌표 계산
  lib/ai/providers.ts   "provider:modelId" 라우팅 + Tauri fetch 주입
  lib/ai/runner.ts      streamText 한 턴 (DB 안 건드림) + tool 파트 변환
  lib/ai/skills.ts      IPC → AI SDK 도구 (zod 스키마 · 토글 · delegate_task)
  lib/ai/subagent.ts    서브에이전트 한 명의 격리된 실행
  lib/ai/mcp.ts         MCP 도구 → dynamicTool (서버의 JSON Schema 그대로)
  lib/ai/instructions.ts 프로젝트 AGENTS.md 로딩 + 시스템 프롬프트 조합
  store/                workspace(트리) · chat(턴) · agents(서브) · mcp · settings
  components/           chat · flow · agents · mcp · inspect(Context/Memory)
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
- **도구 실행**: 한 턴이 여러 스텝. 스텝마다 `assistant`(호출) → `tool`(결과) → `assistant` 노드가 쌓인다. 짝 없는 tool-call/result 는 `toModelMessages()` 가 걸러낸다(공급자가 400 을 낸다).
- **투명성이 이 툴의 경쟁력**: assistant 노드의 `context_snapshot` 에 그 시점 LLM 입력 원문을 남기고 인스펙터로 보여준다. 새 기능도 "무엇이 LLM 에 갔는지" 숨기지 않게 만든다.
- **프로젝트 지침**: 연 프로젝트 루트의 `AGENTS.md` 를 매 턴 다시 읽어 시스템 프롬프트 맨 앞에 원문 그대로 싣는다(서브에이전트에도 전달).
- **서브에이전트**: `delegate_task` → 컨텍스트가 격리된 별도 실행, 요약만 상위로. `onDelegate` 없이 ToolSet 을 만들면 도구가 노출되지 않아 재위임이 구조적으로 불가능하다. 상태는 `agent_runs`.
- **MCP**: 외부 서버를 stdio 자식 프로세스로 띄워 도구를 `mcp__서버__도구` 이름으로 합친다. 파이프 읽기는 블로킹이라 요청마다 감시 스레드로 타임아웃을 건다.

설계 배경과 상세는 `README.md`.
