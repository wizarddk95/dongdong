# dongdong

노드 기반 시각화와 서브에이전트 모니터링을 제공하는 **로컬 코딩 에이전트** (Tauri + React).

- 도커/샌드박스 없이 **사용자 권한으로 직접** 쉘·파일 I/O 실행
- 글로벌 DB 없이 프로젝트 루트의 **`.agent_workspace/local.db`** (SQLite) 에 저장
- Windows / macOS 크로스 플랫폼

---

## 현재 상태: Phase 4 완료

| Phase | 내용 | 상태 |
| --- | --- | --- |
| 1 | Tauri 스캐폴딩, SQLite 워크스페이스, IPC 브릿지 | ✅ |
| 2 | Zustand + Vercel AI SDK Core, React Flow 노드 트리, 타임머신 분기 | ✅ |
| 3 | Skill 매핑(IPC → 도구), Context / Memory Inspector | ✅ |
| 4 | `delegate_task` 서브에이전트 + 실행 대시보드 | ✅ |
| 4-α | MCP stdio 브리지 (외부 서버 도구 병합) | ✅ |

---

## 사전 요구사항

| 도구 | 버전 | 비고 |
| --- | --- | --- |
| Node.js | 20+ | 확인됨: v22 |
| pnpm | 10+ | 확인됨: v11 |
| Rust | 1.77.2+ | **필수** — https://rustup.rs |
| MSVC Build Tools | Windows 전용 | "Desktop development with C++" 워크로드 |
| WebView2 | Windows 전용 | Win11 기본 탑재 |

Rust 설치 (Windows):

```powershell
winget install Rustlang.Rustup
# 또는 https://win.rustup.rs/x86_64 다운로드 후 실행
```

macOS:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## 실행

### 처음 띄우기

```bash
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` 가 Vite 개발 서버(`http://localhost:1420`)와 Rust 백엔드를 함께 띄우고 앱 창을 연다.
첫 실행은 Rust 의존성을 전부 컴파일하므로 몇 분 걸린다 (이후에는 증분 빌드).

창이 뜨면 순서대로:

1. 상단 **[폴더 열기]** — 작업할 프로젝트 루트를 고른다.
   그 폴더에 `.agent_workspace/local.db` 가 생기고, 세션이 없으면 "새 대화"가 자동으로 만들어진다.
2. 상단 **[설정]** — Anthropic 또는 OpenAI **API 키**를 넣고 모델을 고른다. 키가 없으면 대화가 되지 않는다.
   같은 화면에서 스킬(도구) 토글과 MCP 서버도 정한다.
3. 채팅창에 입력하면 시작. 좌측 사이드바의 **[+]** 로 세션을 더 만든다.

앱은 마지막에 연 프로젝트를 기억하지 않는다. 실행할 때마다 **[폴더 열기]** 로 다시 연다.

API 키와 MCP 서버 목록은 프로젝트 DB 가 아니라 OS 앱 설정 디렉터리의 `settings.json` 에 저장된다.

| OS | 경로 |
| --- | --- |
| Windows | `%APPDATA%\dev.dongdong.agent\settings.json` |
| macOS | `~/Library/Application Support/dev.dongdong.agent/settings.json` |
| Linux | `~/.config/dev.dongdong.agent/settings.json` |

### 명령어

```bash
pnpm tauri:dev     # 개발 모드 (Rust 필요) — 실제 구동 확인은 이것으로
pnpm dev           # 프론트엔드만. 브라우저에서 localhost:1420 (IPC 는 동작하지 않음)
pnpm typecheck     # tsc --noEmit
pnpm test          # 프론트엔드 단위 테스트 (vitest)
pnpm build         # 타입체크 + 프론트엔드 번들
pnpm tauri:build   # 배포 바이너리 (src-tauri/target/release/bundle/)

cd src-tauri && cargo test --lib   # 백엔드 단위 테스트
```

### 개발 중 자주 걸리는 것

- `pnpm tauri:dev` 가 도는 중에 Rust 를 고치면 실행 파일 교체에 실패해(Windows: os error 5) 워처가 죽는다.
  앱 창을 닫고 다시 띄운다.
- 앱을 닫아도 포트 1420 을 잡은 Vite 프로세스가 남을 때가 있다. `strictPort` 라 다음 실행이 바로 실패하니 정리하고 다시 띄운다.
- Rust 툴체인을 갓 설치했다면 셸을 새로 열어야 `cargo` 가 `PATH` 에 잡힌다.

---

## 구조

```
src/                        프론트엔드 (React + TS + Tailwind v4)
  types/ipc.ts              Rust ↔ TS 타입 정의 (serde camelCase 와 1:1)
  lib/ipc.ts                invoke 래퍼 — 모든 IPC 는 이 모듈을 경유
  lib/tree.ts               parent_id → 트리 복원 (buildIndex / pathTo / siblingsOf)
  lib/turns.ts              노드 체인 → 턴(질문+응답+도구 스텝) 묶음 — 순수 파생 계산
  lib/sessionTree.ts        parent_session_id → 세션 분기 트리 복원
  lib/layout.ts             왼→오른쪽 tidy tree 좌표 계산 (턴 그래프 · 세션 맵 공용)
  lib/agentRuns.ts          서브에이전트 실행 표시용 공통 값 (상태 색 · 경과 시간)
  lib/markdown.ts           채팅 본문용 경량 마크다운 파서 (외부 의존성 없음)
  lib/ai/providers.ts       다중 모델 라우팅 (`provider:modelId`) + Tauri fetch 주입
  lib/ai/runner.ts          streamText 한 턴 실행 (DB 는 건드리지 않음) + 도구 파트 변환
  lib/ai/skills.ts          IPC 를 AI SDK 도구로 노출 (zod 스키마 + 설정 토글)
  lib/ai/subagent.ts        서브에이전트 한 명의 격리된 실행 루프
  lib/ai/mcp.ts             MCP 도구 → AI SDK dynamicTool 변환 (JSON Schema 그대로)
  lib/ai/instructions.ts    프로젝트 AGENTS.md 로딩 + 시스템 프롬프트 조합
  store/workspace.ts        프로젝트 / 세션 / 대화 트리 (DB 반영 상태)
  store/chat.ts             턴 실행 오케스트레이션 + 스트리밍 상태
  store/agents.ts           서브에이전트 인스턴스 (실행 + agent_runs 영속화)
  store/mcp.ts              MCP 서버 연결 상태 + 도구 병합
  store/settings.ts         API 키 · 모델 · 시스템 프롬프트 · 스킬 토글
  components/chat/          ChatPanel / MessageBubble (tool 노드 렌더 포함) / Markdown 렌더러
  components/flow/          FlowCanvas / TurnNode / AgentNode (대화 턴 그래프)
  components/sessions/      SessionMap / SessionNode (채팅 앞단의 세션 맵)
  components/inspect/       ContextModal / MemoryModal / JsonTree (투명성 UI)
  components/agents/        AgentDashboard (서브에이전트 칸반)
  components/mcp/           McpServers (서버 등록 · 연결 · 도구 목록)
  components/               TopBar / SessionSidebar / SettingsModal / FileExplorer / ShellConsole

src-tauri/src/
  main.rs, lib.rs           엔트리 & command 등록
  error.rs                  AppError → 프론트엔드로 문자열 직렬화
  paths.rs                  크로스 플랫폼 경로 정규화 + 루트 밖 접근 차단
  state.rs                  열린 워크스페이스(프로젝트별 SQLite 커넥션) 보관
  db/schema.rs              마이그레이션 (PRAGMA user_version 기반)
  db/models.rs              Project / Session / SessionOverview / Message 모델
  db/queries.rs             모든 SQL 은 여기로만
  commands/workspace.rs     open_project / close_project / system_info
  commands/shell.rs         execute_shell_command (OS 분기 + 타임아웃)
  commands/fs.rs            read_file / write_file / list_directory / ...
  commands/session.rs       세션·메시지(노드) CRUD + branch_session
  commands/settings.rs      앱 전역 설정 (API 키) — OS 설정 디렉터리의 settings.json
  commands/memory.rs        에이전트 메모리 CRUD (remember / recall 의 백엔드)
  commands/agent.rs         서브에이전트 실행 기록 (agent_runs)
  commands/mcp.rs           MCP 연결 IPC (모두 async + spawn_blocking)
  mcp.rs                    MCP stdio 클라이언트 (JSON-RPC 피어 + 프로세스 레지스트리)
```

## 세션 맵 (채팅 앞단)

프로젝트를 열면 **세션 맵**이 먼저 뜬다. 이 프로젝트의 세션들과 거기서 갈라져 나온
분기 세션이 `parent_session_id` 를 따라 왼→오른쪽 트리로 그려진다.
카드에는 노드 수 · 마지막 활동 · 첫 질문 미리보기가 붙는데, 세션마다 메시지를 따로 읽지 않고
`list_sessions` 가 집계까지 한 번에 내려준다(`SessionOverview`).

카드를 더블클릭하면(또는 골라서 **[열기]**) 그 세션의 채팅으로 들어가고, 좌측 사이드바의 **[← 세션 맵]** 으로 돌아온다.

## 대화 턴 그래프와 분기 (타임머신)

우측 트리의 노드 하나는 **턴** 하나다 — 사용자 질문 + 응답 + 그 사이의 도구 스텝을
카드 한 장으로 묶어 왼→오른쪽으로 잇는다. 묶음은 `lib/turns.ts` 의 파생 계산이고,
DB 는 여전히 노드 단위(`messages.parent_id`)로 저장한다.

- **삭제도 턴 단위**다. 앵커(user) 노드부터 지우므로 질문만 남거나 응답만 남는 반쪽 상태가 없다.
  그 턴에 매달렸던 서브에이전트 실행 기록도 함께 정리된다.
- **위임된 서브에이전트**는 발화한 턴 카드에서 위/아래로 점선 분기해 붙는다.
  진행률과 현재 Skill 이 노드에서 바로 보이고, 상세·중단은 [서브에이전트] 탭에서 한다.

분기는 두 층위로 동작한다.

1. **세션 안 분기** — 턴 카드를 클릭하면 그 턴의 끝이 "다음 메시지의 부모"가 된다.
   앞선 턴을 고르고 다시 질문하면 형제 턴이 생기고, 그래프가 갈라진다.
   **[⑂ 이 턴 다시 질문]** 은 그 턴이 갈라져 나온 지점으로 되돌린다.
   채팅 말풍선의 **[여기서 다시]** 도 같은 동작이다.
2. **새 세션으로 분기** — **[⑂ 새 세션]** 은 `branch_session` 을 호출해
   해당 노드까지의 조상 체인을 **복제한 새 세션**을 만든다. 원본은 그대로 남고,
   세션 맵에서 부모 세션의 자식 노드로 나타난다.

채팅 패널은 항상 "루트 → 현재 부모 노드"의 경로만 보여준다. 다른 분기는 그래프에서 골라 이동한다.

## LLM 연동

`Vercel AI SDK Core` 의 `streamText` 를 직접 호출한다 (LangChain 같은 추상화 계층 없음).

- 모델은 `"anthropic:claude-opus-5"` 처럼 `provider:modelId` 문자열 하나로 식별한다.
- **웹뷰의 기본 `fetch` 를 쓰지 않는다.** Anthropic 은 브라우저 직접 호출을 막고 CORS 에 걸리므로,
  Rust(reqwest)를 경유하는 `@tauri-apps/plugin-http` 의 `fetch` 를 provider 에 주입한다.
  이 플러그인의 응답 body 는 실제 `ReadableStream` 이라 토큰 스트리밍이 그대로 동작한다.
- 새 공급자 도메인을 붙이려면 `src-tauri/capabilities/default.json` 의 `http:default` 스코프에
  URL 을 추가해야 한다. 안 하면 요청이 차단된다.
- Anthropic 4.6+ 모델은 `temperature` 를 거부하므로 보내지 않고, adaptive thinking + `effort` 로 사고량을 조절한다.
- 토큰마다 DB 를 쓰지 않는다. 스트리밍 중에는 Zustand 에만 쌓고, 턴이 끝날 때 `update_message` 로 한 번만 저장한다.

### 로컬 오픈소스 모델

`local` 공급자는 특정 회사가 아니라 **이 PC 에서 도는 OpenAI 호환 서버**를 가리킨다
(Ollama · LM Studio · llama.cpp server · vLLM). 키가 필요 없고 대화가 밖으로 나가지 않는다.

- 설정 → **로컬 모델 서버** 에서 주소를 넣고 **[설치된 모델 불러오기]** 를 누르면
  서버의 `GET /v1/models` 를 읽어 실제 깔린 태그가 모델 드롭다운에 합쳐진다.
- 모델 식별자는 `local:gpt-oss:20b` 처럼 `local:<태그>`.
- 호출은 `createOpenAI(...).chat()` — 기본 팩토리는 Responses API 로 가는데
  Ollama/LM Studio 가 구현한 건 `/v1/chat/completions` 뿐이다.
- 어떤 모델을 받고 어떻게 띄우는지(16GB VRAM 기준 선택, 컨텍스트 설정, 부분 오프로드)는
  **[docs/local-llm.md](docs/local-llm.md)** 에 정리해 두었다.

## Skill (도구)

`lib/ipc.ts` 의 IPC 함수를 그대로 AI SDK 도구로 감싼 것이 Skill 이다 (`lib/ai/skills.ts`).

| 묶음 | 도구 |
| --- | --- |
| 파일 읽기 | `read_file` `list_directory` `path_info` |
| 파일 쓰기 | `write_file` `create_directory` `delete_path` |
| 쉘 실행 | `execute_shell_command` |
| 메모리 | `remember` `recall` |
| 서브에이전트 | `delegate_task` |
| MCP | 연결된 서버의 도구 (`mcp__서버__도구`) |

- 켜 둔 도구는 **확인 없이 바로 실행**된다. 무엇을 열어 줄지는 [설정] 의 스킬 토글로 정한다.
- 경로가 프로젝트 루트를 벗어나지 못하게 막는 것은 Rust `paths::resolve_within` 의 몫이다.
- 도구를 쓰면 한 턴이 여러 스텝으로 늘어난다. 스텝마다 트리에
  `assistant`(호출) → `tool`(결과) → `assistant`(다음 응답) 노드가 쌓이고,
  DB 쓰기는 이 **스텝 경계**에서만 일어난다.
- 도구 출력은 컨텍스트를 잡아먹지 않도록 잘라서 모델에 돌려준다 (쉘 stdout 2만 자, 디렉터리 300개).

## 서브에이전트

메인 에이전트가 `delegate_task` 를 부르면 서브에이전트가 한 명 생긴다.

- **컨텍스트가 격리된다.** 서브에이전트는 이 대화를 모르고, 지시문 하나만 받아 자기 대화를 돈다
  (`lib/ai/subagent.ts`). 끝나면 마지막 답변(요약)만 도구 결과로 메인에게 돌아간다.
- **재위임은 막는다.** 서브에이전트용 ToolSet 은 `onDelegate` 없이 만들기 때문에
  `delegate_task` 자체가 노출되지 않는다.
- 한 스텝에서 여러 번 호출하면 **병렬로** 돈다. 각자 자기 `agent_runs` 행과 중단 스위치를 갖는다.
- 상태는 `pending → running → succeeded / failed / cancelled`. `started_at` / `finished_at` 은
  Rust 쪽에서 상태 전이에 맞춰 자동으로 찍는다.
- 진행률은 **스텝 예산 대비 비율**이지 작업 완성도가 아니다 (끝나기 전에는 95% 를 넘지 않는다).
- 요약 없이 스텝 예산을 다 쓰면 성공으로 포장하지 않고 `failed` 로 기록한다.
- 앱이 죽어 `running` 인 채 남은 실행은 세션을 열 때 `reap_agent_runs` 가 실패로 정리한다.
- 우측 **[서브에이전트]** 탭이 상태별 칸반이다. 진행바 · 지금 실행 중인 Skill · 소요 시간을
  실시간으로 보여주고, 개별 중단 / 삭제 / 끝난 것 정리를 할 수 있다.
- 모델과 스텝 예산은 [설정] 에서 따로 정한다 (기본값은 메인 모델과 동일).

## MCP 브리지

외부 MCP 서버를 자식 프로세스로 띄우고 그 도구를 같은 ToolSet 에 합친다.

- **전송 계층은 stdio.** 줄바꿈으로 구분된 JSON-RPC 2.0 메시지를 주고받는다 (`src-tauri/src/mcp.rs`).
  `initialize` → `notifications/initialized` → `tools/list` 까지 마쳐야 연결로 친다.
- 서버 목록은 API 키와 같은 곳(OS 앱 설정 디렉터리의 `settings.json`)에 저장한다. [설정] 에서 등록·연결한다.
- 도구 이름은 `mcp__<서버>__<도구>` 로 붙여 내장 Skill 과 충돌하지 않게 한다. 이름이 겹치면 번호를 덧붙인다.
- 스키마는 서버가 준 **JSON Schema 를 그대로** 공급자에게 넘긴다 (zod 로 다시 쓰지 않는다).
- MCP 의 `isError` 는 프로토콜 실패가 아니라 "도구가 실패를 보고한 것"이므로, 모델이 읽고 대응하도록 결과에 담아 넘긴다.
- 파이프 읽기는 블로킹이라 IPC 는 전부 `async + spawn_blocking`. 응답이 없는 서버에 매달리지 않도록
  요청마다 감시 스레드를 두고, 시간이 지나면 자식 프로세스를 kill 해서 읽기를 EOF 로 푼다 (기본 60초).
- 서버의 stderr 는 계속 비워 주고(파이프가 차면 서버가 멈춘다) 최근 200줄을 들고 있다가
  연결 실패 메시지와 [로그] 버튼에서 보여준다.
- Windows 에서 `npx` 같은 `.cmd` 셸 스크립트는 직접 spawn 되지 않으므로 `cmd /C` 를 거친다.
- 서브에이전트도 같은 MCP 도구를 쓴다.

## 프로젝트 지침 (AGENTS.md)

연 프로젝트 루트에 `AGENTS.md` 가 있으면 그 원문을 **매 턴 컨텍스트 맨 앞**에 싣는다.
프로젝트마다 다른 규칙(빌드 명령, 금지 사항, 구조)을 에이전트가 모른 채 움직이지 않게 하는 장치다.

- 위치는 프로젝트 루트, 이름은 `AGENTS.md`(대소문자가 구분되는 OS 를 위해 `agents.md` 도 찾는다).
- 시스템 프롬프트 앞에 `# 프로젝트 지침 (AGENTS.md)` 블록으로 붙는다. 요약하지 않고 **원문 그대로** 넣는다.
- **턴마다 다시 읽는다.** 대화 도중 파일이 바뀌어도(에이전트가 직접 고치는 경우 포함) 다음 턴에 반영된다.
- 24,000자를 넘으면 앞부분만 싣고, 전체는 파일을 직접 읽으라고 모델에게 알린다.
- 서브에이전트에게도 같은 지침이 전달된다.
- 채팅 입력창 위의 `AGENTS.md` 배지로 지금 실려 있는지 보이고, 누르면 컨텍스트 인스펙터에서 원문을 확인할 수 있다.
- [설정] → 프로젝트 지침에서 끌 수 있다.

## 투명성 UI

- **[현재 컨텍스트 보기]** — 다음 턴에 나갈 페이로드를 미리 만들어 보여준다.
  assistant 말풍선의 **[컨텍스트]** 는 그 응답을 만들 때 실제로 보낸 원문(`context_snapshot`)을 연다.
  도구 스텝처럼 원문을 따로 저장하지 않은 노드는 조상 체인으로 동일하게 재구성한다.
- **[현재 메모리 보기]** — `remember` / `recall` 이 쓰는 것과 같은 테이블을 직접 보고 고친다.
- tool 노드 말풍선은 호출 입력과 실행 결과를 JSON 트리로 펼쳐 볼 수 있다.

## 데이터 모델

`.agent_workspace/local.db` 안에:

- **`projects`** — 프로젝트 루트 경로, 설정 메타데이터
- **`sessions`** — 대화방. `parent_session_id` + `branched_from_message_id` 로 분기 이력 추적
- **`messages`** — 대화 **트리**. `parent_id` 가 트리 간선, `context_snapshot` 에 그 시점 LLM 입력 원문 보관
- **`agent_runs`** — 서브에이전트 실행 상태 (진행률 · 실행 중인 Skill · 결과 · 소요 시간)
- **`memories`** — 에이전트 메모리. `scope`(project/session) + `key` 가 유일 키 (마이그레이션 v2)

스키마를 바꿀 때는 `MIGRATIONS` 배열 **끝에만** 추가한다. 기존 항목을 고치면 이미 만들어진 DB 와 어긋난다.

## 크로스 플랫폼 규칙

- 쉘: Windows `cmd /C`, macOS `zsh -lc`, Linux `sh -c` (`shell` 옵션으로 강제 지정 가능)
- Windows `cmd` 는 출력이 CP949 로 깨지므로 `chcp 65001` 을 앞에 붙인다
- 경로는 `paths.rs` 에서 항상 OS 네이티브 구분자로 정규화하고, `\\?\` 확장 프리픽스를 제거한다
- 프로젝트가 열려 있으면 파일 접근은 **루트 밖으로 나가지 못한다** (`resolve_within`)

## 아이콘

`src-tauri/icons/` 는 개발용 플레이스홀더다 (`node scripts/gen-icons.mjs` 로 생성).
실제 브랜딩이 생기면 `pnpm tauri icon <파일.png>` 로 교체할 것.
