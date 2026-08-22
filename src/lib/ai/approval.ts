/**
 * 셸 실행 승인 — "이 명령을 정말 돌릴까" 를 사용자에게 묻는 판정층.
 *
 * 이 앱은 샌드박스가 없다. 도구는 사용자 OS 권한으로 그대로 돌고, 셸이 켜져 있으면
 * `paths.rs` 의 경로 담장도 `cd ..` 한 줄이면 넘어간다(`docs/security.md`).
 * 그래서 **무엇을 돌릴지 고르는 마지막 판단은 사람이 한다** — 자동 실행은 사용자가
 * 명시적으로 켠 모드일 때만이다.
 *
 * 여기 있는 것은 전부 순수 함수다. 실제로 묻고 기다리는 일은 `store/approvals.ts`,
 * 화면은 `components/chat/ApprovalPrompt.tsx` 가 맡는다. 판정을 UI 에 따로 적으면
 * 반드시 어긋나므로(설정 화면의 미리보기도 이 함수를 쓴다) 규칙은 이 파일 하나뿐이다.
 */

/** 실행 권한 모드. */
export type ApprovalMode =
  /** 묻지 않고 바로 실행한다. 사용자가 스스로 켠 경우에만 */
  | "auto"
  /** 매번 묻는다. 허용 규칙에 걸리면 그것만 조용히 지나간다 */
  | "ask";

export const APPROVAL_MODES: { id: ApprovalMode; label: string; description: string }[] = [
  {
    id: "ask",
    label: "승인 필요",
    description:
      "셸 명령과 파일 삭제 전에 매번 묻습니다. [항상 허용] 을 누른 명령만 다음부터 그냥 지나갑니다 (삭제는 언제나 묻습니다).",
  },
  {
    id: "auto",
    label: "자동 실행",
    description:
      "묻지 않고 바로 실행합니다(삭제도 포함). 에이전트가 만든 명령이 그대로 이 컴퓨터에서 돕니다 — 무엇이 실행되는지 감시할 수 있을 때만 켜세요.",
  },
];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";

/**
 * 사용자가 눌러 만든 "항상 허용" 규칙. **지금 세션 동안만** 산다(`store/approvals.ts`).
 *
 * `exact` 가 아닌 규칙은 **앞 토큰이 같은 단일 명령**만 통과시킨다 —
 * `pnpm test` 를 허용했다고 `pnpm test && rm -rf .` 까지 열어 주면 규칙이 뒷문이 된다.
 */
export interface AllowRule {
  id: string;
  /** 정규화된 명령의 앞부분(prefix) 또는 명령 전체(exact) */
  pattern: string;
  /** true 면 명령 전체가 정확히 같을 때만 통과 */
  exact: boolean;
  createdAt: string;
}

/** 승인 요청 하나. 화면에 뜨는 카드가 이 값을 그대로 읽는다. */
export interface ApprovalRequest {
  id: string;
  /** 셸 실행인지 삭제인지 — 카드 문구와 [항상 허용] 제공 여부가 갈린다 */
  kind: ApprovalKind;
  toolName: string;
  /** 셸이면 명령 원문, 삭제면 지울 경로 */
  command: string;
  /** 명령만으로는 안 보이는 사실 한 줄 (예: "하위까지 통째로 지웁니다") */
  detail?: string;
  /** 작업 디렉터리 (생략 시 프로젝트 루트) */
  cwd?: string;
  /** 서브에이전트가 부른 것이면 그 이름 — 누가 요청했는지 화면에 밝힌다 */
  origin?: string;
  /**
   * [항상 허용] 을 눌렀을 때 만들어질 규칙. `null` 이면 그 버튼을 내주지 않는다
   * (되돌리기 어려운 명령 · 삭제). 한 번의 클릭이 영구 백지수표가 되면 안 된다.
   */
  rule: { pattern: string; exact: boolean } | null;
  /** 되돌리기 어려워 보이는가 (카드의 경고 태그) */
  destructive: boolean;
}

/** 승인 결과. 거부도 정상적인 결말이다 — 턴을 죽이지 않고 도구 결과로 돌아간다. */
export interface ApprovalOutcome {
  approved: boolean;
  /** 사용자가 적어 준 거부 사유. 모델이 다음 수를 고르는 데 쓴다 */
  reason?: string;
  /** [항상 허용] 으로 새로 생긴 규칙 */
  remembered?: AllowRule;
}

/**
 * 승인을 받는 동작의 종류. 셸만 규칙으로 미리 열어 둘 수 있다.
 */
export type ApprovalKind =
  /** `execute_shell_command` */
  | "shell"
  /** `delete_path` — 되돌릴 수 없어서 **언제나** 묻는다 */
  | "delete";

/**
 * **뒤에 오는 것을 그대로 실행해 주는 명령들.**
 *
 * `uv run <스크립트>` 를 허용하면 `uv run <다른 스크립트>` 도 열린다 — 규칙이 덮는 것이
 * "비슷한 명령" 이 아니라 "임의 코드 실행" 이 되어 버린다. 실제로 이것 때문에
 * `uv run python demo_run.py` 가 카드 없이 조용히 돌았다.
 * 그래서 이 계열은 **명령 전체가 같을 때만** 통과시킨다.
 */
const RUNNERS = new Set([
  "npx",
  "uvx",
  "bunx",
  "node",
  "deno",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "osascript",
  "eval",
  "xargs",
]);

/** 프로그램 + 하위 명령이 함께여야 "실행기" 가 되는 것들. */
const RUNNER_PAIRS = new Set([
  "uv run",
  "pnpm dlx",
  "yarn dlx",
  "npm exec",
  "poetry run",
  "pipx run",
  "cargo run",
  "go run",
  "deno run",
  "dotnet run",
  "docker run",
  "docker exec",
  "kubectl exec",
]);

/**
 * 첫 토큰만으로는 뜻이 안 잡히는 명령들. `git` 하나를 허용하면 `git push` 까지
 * 열리므로 두 번째 토큰까지 묶어 규칙을 만든다.
 */
const MULTI_VERB = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "cargo",
  "docker",
  "kubectl",
  "go",
  "dotnet",
  "gh",
  "pip",
  "poetry",
  "uv",
  "brew",
  "apt",
  "apt-get",
  "winget",
  "choco",
  "scoop",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "make",
  "just",
  "tauri",
  "deno",
]);

/**
 * 되돌릴 수 없거나 바깥으로 나가는 명령. 한 번은 눌러서 돌릴 수 있어도
 * **[항상 허용] 은 내주지 않는다** — 한 번의 클릭이 영구 백지수표가 되면 안 된다.
 */
const DESTRUCTIVE_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "rd",
  "del",
  "erase",
  "format",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "halt",
  "diskpart",
  "sudo",
  "runas",
  "chown",
  "chmod",
  "kill",
  "taskkill",
  "reg",
  "regedit",
  "netsh",
  "curl",
  "wget",
  "iwr",
  "irm",
  "scp",
  "ssh",
]);

/** 프로그램 + 하위 명령까지 봐야 위험한 것들. */
const DESTRUCTIVE_PAIRS = new Set([
  "git push",
  "git reset",
  "git clean",
  "git checkout",
  "git restore",
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "cargo publish",
  "docker system",
  "docker rm",
  "docker rmi",
  "kubectl delete",
  "terraform apply",
  "terraform destroy",
  "gh release",
  "gh pr",
]);

/** 공백을 한 칸으로 접고 앞뒤를 턴다. 규칙 비교의 기준 모양. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/**
 * 명령을 셸 연산자로 자른다. 따옴표 안의 연산자는 세지 않는다 —
 * `echo "a && b"` 는 명령 하나다.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "|" || char === ";" || char === "\n" || char === "&") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * 이 명령이 셸의 힘(연쇄·파이프·리다이렉션·치환)을 쓰는가.
 *
 * 쓴다면 앞 토큰만 보고 판단할 수 없다 — 뒤에 무엇이든 이어 붙일 수 있기 때문이다.
 * 그런 명령은 규칙을 만들 때도 매칭할 때도 **전체가 같을 때만** 통과시킨다.
 */
export function hasShellOperators(command: string): boolean {
  if (splitSegments(command).length > 1) return true;

  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">" || char === "<" || char === "`") return true;
    if (char === "$" && command[i + 1] === "(") return true;
  }
  return false;
}

/** 따옴표를 존중하며 토큰으로 자른다. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 경로와 확장자를 걷어낸 실행 파일 이름 (`C:\bin\git.exe` → `git`). */
export function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * 이 명령에서 만들 "항상 허용" 규칙.
 *
 * 단일 명령이면 프로그램(+ 하위 명령)까지만 잘라 비슷한 명령을 함께 덮고,
 * 연산자가 섞였으면 명령 전체를 그대로 규칙으로 삼는다.
 */
export function commandRule(command: string): { pattern: string; exact: boolean } {
  const normalized = normalizeCommand(command);
  if (!normalized) return { pattern: "", exact: true };
  if (hasShellOperators(normalized)) return { pattern: normalized, exact: true };

  const tokens = tokenize(normalized);
  if (tokens.length === 0) return { pattern: normalized, exact: true };

  const program = programName(tokens[0]);
  const sub = tokens[1];

  // 실행기는 뒤에 오는 것이 곧 명령이다 → 앞부분만 잘라 두면 규칙이 백지수표가 된다.
  if (isRunner(program, sub)) return { pattern: normalized, exact: true };

  if (MULTI_VERB.has(program) && sub && !sub.startsWith("-")) {
    return { pattern: `${program} ${sub}`, exact: false };
  }
  return { pattern: program, exact: false };
}

/** 이 명령이 "뒤에 오는 것을 그대로 실행" 하는 계열인가. */
export function isRunner(program: string, sub?: string): boolean {
  if (RUNNERS.has(program)) return true;
  return Boolean(sub) && RUNNER_PAIRS.has(`${program} ${sub?.toLowerCase()}`);
}

/** 규칙이 이 명령을 덮는가. */
export function ruleMatches(rule: Pick<AllowRule, "pattern" | "exact">, command: string): boolean {
  const normalized = normalizeCommand(command);
  const pattern = normalizeCommand(rule.pattern);
  if (!pattern || !normalized) return false;

  if (rule.exact) return normalized === pattern;

  // prefix 규칙은 연산자가 없는 단일 명령에만 쓴다. 안 그러면 `pnpm test` 허용이
  // `pnpm test && <아무거나>` 까지 열어 준다.
  if (hasShellOperators(normalized)) return false;

  const target = tokenize(normalized);
  const wanted = tokenize(pattern);
  if (wanted.length === 0 || wanted.length > target.length) return false;

  // 첫 토큰은 경로·확장자를 걷어내고 비교한다 (`./node_modules/.bin/vitest` 도 `vitest`).
  if (programName(target[0]) !== programName(wanted[0])) return false;
  for (let i = 1; i < wanted.length; i += 1) {
    if (target[i] !== wanted[i]) return false;
  }
  return true;
}

/** 되돌릴 수 없어 보이는 명령인가. 하나의 세그먼트라도 걸리면 위험으로 본다. */
export function isDestructive(command: string): boolean {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const program = programName(tokens[0]);
    if (DESTRUCTIVE_PROGRAMS.has(program)) return true;
    const sub = tokens[1];
    if (sub && DESTRUCTIVE_PAIRS.has(`${program} ${sub.toLowerCase()}`)) return true;
  }
  return false;
}

/**
 * 이 명령을 지금 그냥 돌려도 되는가.
 * `"ask"` 면 화면에 카드가 뜨고, `"allow"` 면 아무 일도 일어나지 않는다.
 */
export function decideCommand(
  command: string,
  mode: ApprovalMode,
  rules: AllowRule[] = [],
): "allow" | "ask" {
  if (mode === "auto") return "allow";
  return rules.some((rule) => ruleMatches(rule, command)) ? "allow" : "ask";
}

/**
 * 이 요청을 지금 그냥 통과시켜도 되는가.
 *
 * **삭제는 규칙으로 미리 열 수 없다** — 지운 파일은 되돌아오지 않으므로 "비슷한 것도 함께"
 * 라는 개념 자체가 성립하지 않는다. `자동 실행` 모드를 고른 경우에만 묻지 않는다.
 */
export function decideApproval(
  kind: ApprovalKind,
  command: string,
  mode: ApprovalMode,
  rules: AllowRule[] = [],
): "allow" | "ask" {
  if (mode === "auto") return "allow";
  if (kind === "delete") return "ask";
  return decideCommand(command, mode, rules);
}

/** 규칙 id. `crypto.randomUUID` 가 없는 환경(구형 웹뷰)도 대비한다. */
export function newRuleId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/** 이 명령을 덮는 규칙 하나를 만든다. 이미 같은 규칙이 있으면 `null`. */
export function makeAllowRule(command: string, existing: AllowRule[] = []): AllowRule | null {
  const { pattern, exact } = commandRule(command);
  if (!pattern) return null;
  if (existing.some((rule) => rule.pattern === pattern && rule.exact === exact)) return null;
  return { id: newRuleId(), pattern, exact, createdAt: new Date().toISOString() };
}

/** 규칙을 사람이 읽는 한 줄로. 설정 목록과 승인 카드가 같은 문구를 쓴다. */
export function describeRule(rule: Pick<AllowRule, "pattern" | "exact">): string {
  return rule.exact ? `${rule.pattern} (완전히 같은 명령만)` : `${rule.pattern} …`;
}
