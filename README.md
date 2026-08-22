# dongdong

*English · [한국어](README.ko.md)*

**A local coding agent where the conversation is a graph, not a scrollback.**

dongdong is a desktop coding agent (Tauri 2 + React 19) that runs on your machine with
your permissions. Every turn is a node you can branch from, delete, copy, or replay —
and every node shows you the exact text that was sent to the model, what it cost, and
how much context you have left.

[![CI](https://github.com/wizarddk95/dongdong/actions/workflows/ci.yml/badge.svg)](https://github.com/wizarddk95/dongdong/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#getting-started)

<!--
  TODO before announcing: drop a screenshot or a short GIF here.
  The turn graph with a subagent lane is the single most convincing frame.
  Suggested: docs/images/turn-graph.png (light theme, ~1400px wide).
-->

---

## ⚠️ Read this first

**There is no sandbox.** dongdong executes shell commands and file writes directly, as
your OS user, with no approval prompt. That is deliberate — it is what makes the agent
useful on a real project — but it means:

> **Opening an untrusted repository is close to running its instructions.**
> A repo's `AGENTS.md` goes into the system prompt verbatim on every turn, its
> `.dongdong/skills/` are advertised to the model, and a comment in a source file can
> reach a shell.

Before you open code you don't trust, switch off **Shell** and **File write** in
Settings → Tools. The full threat model — what is defended, what isn't, and why — is in
**[docs/security.md](docs/security.md)** (Korean) and **[SECURITY.md](SECURITY.md)**
(English).

---

## Why this exists

Most agent UIs give you a linear chat and ask you to trust it. Two things follow from
that, and dongdong is built around fixing both.

**1. A linear chat throws away your best move: going back.**
When an agent takes a wrong turn, the useful action is to return to the last good state
and try a different approach — not to argue with it for ten more messages. Here the
conversation is stored as a tree (`messages.parent_id`), rendered as a left-to-right
turn graph. Click any turn to continue from there. Delete one turn out of the middle and
its children re-attach to the surviving ancestor. Undo restores the original ids, so
subagent links and child pointers survive. Copy a turn into another branch or another
session.

**2. You cannot reason about cost or context you cannot see.**
Every assistant node stores a `context_snapshot` — the literal payload that went to the
provider — and the measured token usage for that one call. The inspector shows both.
The context gauge answers the only question that matters: *if I hit send right now, how
much goes out?* It pins to the last measured call and converts only the growth since
then, using a ratio this conversation just produced, so it re-calibrates every turn.
Cost is never stored — it is always recomputed from the rate table, because a stored
number and a recomputed total drift apart and then neither is trustworthy.

Everything else follows from being local-first: no account, no telemetry, no cloud
database. Conversations live in `.agent_workspace/local.db` inside the project itself.

---

## Features

- **Four providers, one string.** `provider:modelId` selects Anthropic, OpenAI, Google
  Gemini, or `local:` — any OpenAI-compatible server on your machine (Ollama, LM Studio,
  llama.cpp, vLLM). Pricing, context windows, and capability flags live in one catalog.
  With a local model, nothing leaves the machine.
- **Tools** — file read/write, shell, memory, and subagent delegation, each toggleable.
  Tool output is capped so one crawl result can't eat the whole context window.
- **Skills, which are not tools.** A skill is a procedure document. Only its name and
  one-line description are loaded each turn; the model pulls the body with `load_skill`
  when it decides it needs it — so a long procedure costs nothing until it's used.
  Excel / Word / PDF procedures ship built in; add your own globally or per-project.
- **Subagents.** `delegate_task` runs an isolated context and returns only a summary.
  Runs are drawn as lanes branching off the turn that spawned them, with live status,
  elapsed time, and their own token accounting.
- **MCP bridge.** External MCP servers run as stdio child processes; their tools are
  merged in as `mcp__<server>__<tool>`.
- **Hooks.** Non-blocking side effects on turn start / finish / error — an OS
  notification when a long turn finishes, or a shell command of your own.
- **Transparency UI.** Per-node context inspector, per-model cost breakdown, and a
  context ring shared by the composer and the session cards.
- Light and dark themes, driven entirely by semantic tokens in one stylesheet.

---

## Getting started

### Prerequisites

| | Version | Notes |
| --- | --- | --- |
| Node.js | 22.13+ | required by the pinned pnpm 11 |
| pnpm | 10+ | tested on v11 |
| Rust | 1.77.2+ | **required** — <https://rustup.rs> |
| Platform deps | — | see [Tauri prerequisites](https://tauri.app/start/prerequisites/) |
| Python | 3.10+ | *optional* — only for the built-in document skills |

On Windows you also need MSVC Build Tools ("Desktop development with C++"); WebView2
ships with Windows 11.

### Run it

```bash
git clone https://github.com/wizarddk95/dongdong.git
cd dongdong
pnpm install
pnpm tauri dev
```

Then: open a project folder → open Settings → paste an API key for one provider (or
point `local:` at your Ollama server) → start a session.

### Build a release binary

```bash
pnpm tauri build
```

The binary is unsigned, so Windows SmartScreen and macOS Gatekeeper will warn about it.

### API keys

Keys are stored as plaintext JSON in your OS app-config directory — **never** in the
project database, so they can't be committed by accident:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\dev.dongdong.agent\settings.json` |
| macOS | `~/Library/Application Support/dev.dongdong.agent/settings.json` |
| Linux | `~/.config/dev.dongdong.agent/settings.json` |

Keys leave your machine only to the provider endpoint you configured. There is no
telemetry, no auto-update, and no crash reporter. Three things guard them: a Tauri
network allowlist (requests to anything but the configured provider hosts are blocked),
a strict CSP, and secret redaction on every path that feeds text back into the model.
Details and limits: [docs/security.md](docs/security.md).

Use a dedicated key with a spend limit. That limit is your last line of defense.

---

## Verifying a change

```bash
pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo test --lib
```

CI runs exactly this, with the Rust suite on Windows, macOS, and Linux.

---

## Architecture

```
src/
  lib/           pure logic — tree, turns, layout, markdown, theme, hooks
  lib/ai/        providers · runner · tools · skills · subagent · mcp · redact
  store/         zustand: workspace · chat · agents · mcp · skills · settings
  components/    chat · flow (turn graph) · agents · mcp · inspect · skills · hooks
  index.css      every color and type token in the app — the only source of color
src-tauri/src/
  commands/      workspace · shell · fs · session · settings · skills · memory · agent · mcp
  db/            schema (append-only migrations) · models · queries (all SQL lives here)
  paths.rs       path normalization + project-root containment
  process.rs     process-tree kill (shell and MCP share it)
```

Design decisions, the rules that keep it coherent, and the platform traps already paid
for are in **[CLAUDE.md](CLAUDE.md)** — read it before a substantial change. Deeper
dives: [docs/security.md](docs/security.md) (threat model),
[docs/design.md](docs/design.md) (design system),
[docs/local-llm.md](docs/local-llm.md) (running open-weight models locally).

**Stack:** React 19 · Vite 6 · TypeScript · Tailwind v4 · Zustand 5 · React Flow 12 ·
zod 4 · Vercel AI SDK Core v7 · Tauri 2 (Rust, bundled rusqlite). LLM calls go straight
through `streamText` — no LangChain-style abstraction layer.

---

## Status

Pre-1.0 and built in the open. Phases 1–4 (workspace and conversation tree → streaming →
tools and inspector → subagents and MCP) are complete, with skills and hooks on top.
Most development happens on Windows; macOS and Linux are supported but less exercised —
platform reports are genuinely useful.

## Contributing

Issues and PRs welcome — start with [CONTRIBUTING.md](CONTRIBUTING.md). For anything
larger than a bug fix, open an issue first; some architectural rules are fixed and it
saves you the work. Korean or English are both fine.

Found a vulnerability? Don't open a PR — see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE) © 2026 wizarddk95. See [NOTICE](NOTICE) for bundled
third-party assets.
