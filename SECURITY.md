# Security Policy

한국어 상세판: [docs/security.md](docs/security.md)

## The one thing to understand first

dongdong runs an LLM agent **with your OS user's full privileges — no container, no
sandbox**. That is the design, not an oversight. Anything the agent can be persuaded
to do, it does as you.

**Opening an untrusted repository is close to running its instructions.** A repo's
`AGENTS.md` is loaded verbatim into the system prompt every turn, its
`.dongdong/skills/` are listed to the model, and shell commands execute without an
approval step. Comments in source files, `npm install` output, and MCP tool results
are all prompt-injection surfaces that reach a shell.

Before opening code you don't trust, turn off **Shell** and **File write** in
Settings → Tools, and turn off **AGENTS.md auto-loading** in Settings → General.
For genuinely hostile code, use a VM or a separate OS account.

## Supported versions

The project is pre-1.0. Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/wizarddk95/dongdong/security/advisories/new)

Please include:

- affected version / commit
- OS and provider (Anthropic / OpenAI / Gemini / local)
- reproduction steps, ideally a minimal repo or settings file
- what an attacker gains

Expect an acknowledgement within **7 days** and an assessment within **30 days**.
This is a spare-time project — that is a best effort, not an SLA. Please allow
90 days before public disclosure, or sooner by mutual agreement. There is no bug
bounty; credit in the advisory and release notes is offered instead.

## In scope

- API keys or `settings.json` contents leaving the machine to anywhere other than the
  configured provider endpoint
- Escaping `paths::resolve_within()` **while file tools are the only ones enabled**
- Bypassing the Tauri HTTP capability allowlist, or the CSP
- Secret redaction (`src/lib/ai/redact.ts`) failing on realistic output
- SQL injection, or memory-safety issues in the Rust layer
- Privilege escalation beyond the user account the app runs as

## Out of scope (known and documented)

These are documented design decisions, not vulnerabilities. Reports about them will
be closed with a pointer to [docs/security.md](docs/security.md):

- Prompt injection causing tool execution — there is no approval gate by design
- The shell tool reaching outside the project root — `cd ..` is not a bypass
- API keys stored as plaintext JSON (no OS keychain yet)
- The project database being unencrypted
- An MCP server you configured yourself running arbitrary code
- Conversation content being sent to the LLM provider you configured

## Hardening checklist for users

- Create a **dedicated API key** for this app and set a spend limit on it.
- Keep the app's directories out of shared/synced folders.
- Work inside version control so bad writes are recoverable.
- If a key may have been exposed, **revoke it** — redaction is a net, not a wall.
