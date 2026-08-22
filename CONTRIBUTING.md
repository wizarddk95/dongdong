# Contributing to dongdong

Thanks for taking a look. This is a small, opinionated project — the fastest way to
get a change merged is to read this page first.

한국어로 이슈·PR 을 써도 좋습니다. 코드 주석과 UI 문구는 **한국어가 원칙**입니다.

## Before you write code

**Open an issue first for anything beyond a bug fix.** The architecture doc
([CLAUDE.md](CLAUDE.md)) lists rules that are not negotiable — the tech stack, the IPC
boundary, the design tokens. A PR that crosses one of those gets closed no matter how
good the code is, and that wastes your time. An issue costs five minutes.

Good first contributions: bug fixes with a failing test, platform fixes (macOS and
Linux are far less exercised than Windows), documentation, and provider/model catalog
updates.

## Setup

```bash
pnpm install
pnpm tauri dev
```

You need Node 22.13+ (the pinned pnpm 11 requires it), and the Rust toolchain plus your platform's Tauri
prerequisites (<https://tauri.app/start/prerequisites/>).

## The gate

Every PR must pass:

```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test --lib
```

CI runs exactly this. **If you add a feature, add tests.** Current counts are in
CLAUDE.md; they should go up, not sideways.

Pure logic lives in `src/lib/**` precisely so it can be tested without a DOM or a
running app — put new logic there and test it directly rather than reaching for
component tests.

## Rules that trip people up

Read [CLAUDE.md](CLAUDE.md) in full before a substantial change. The ones that bite
most often:

- **Never call `invoke()` directly.** Everything goes through `src/lib/ipc.ts`.
- **A new Tauri command touches four files**: `src-tauri/src/commands/*.rs` →
  `lib.rs` `invoke_handler` → `src/types/ipc.ts` → `src/lib/ipc.ts`. Miss one and it
  only breaks at runtime.
- **All SQL lives in `db/queries.rs`.** Connections only through `state.rs`
  `with_conn()`.
- **Migrations are append-only.** Add to the end of `MIGRATIONS` in `db/schema.rs`;
  never edit an existing entry — databases in the wild already ran it.
- **No hardcoded colors.** Use the semantic tokens in `src/index.css`
  (`bg-canvas`, `text-ink-muted`, `border-hairline`…). See [docs/design.md](docs/design.md).
  A `zinc-800` or `#hex` in a component breaks the dark theme in exactly that spot.
- **Respect `abortSignal` in new tools.** If your tool starts a real process, it must
  clean it up itself — `runner.ts` only races the promise.
- **Cap tool output.** Everything goes through `clip()` in `src/lib/ai/tools.ts`.
- **Never write to the database mid-stream.** Tokens accumulate in Zustand; persist
  only at step boundaries.
- **Don't touch `MODEL_CATALOG`** in `src/lib/ai/providers.ts` without discussion —
  pricing and capability data there is load-bearing for the cost meter.

## Security-sensitive changes

If your change touches any of these, say so in the PR description and explain the
reasoning:

- anything that puts text into the LLM context (it must pass through `clip()`, which
  is where secret redaction happens)
- `paths.rs`, the Tauri capability allowlist, or the CSP in `tauri.conf.json`
- process spawning (`shell.rs`, `mcp.rs`, `process.rs`)
- how settings or API keys are read or written

Found a vulnerability? Don't open a PR — follow [SECURITY.md](SECURITY.md).

## Commits and PRs

- Commit messages in this repo are written in **Korean, present tense, describing the
  intent** rather than the mechanics ("모달 안에서 드래그를 시작해 밖에서 떼도 닫히지
  않게 한다"). Match that if you can; English is fine if you can't.
- One concern per PR. A refactor bundled with a feature is two PRs.
- Include what you actually verified. "Tests pass" and "I ran the app and clicked it"
  are different claims — say which one you're making.

## Licensing

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same as the project.
