/**
 * 훅 — 정해진 시점에 자동으로 도는 부수 동작.
 *
 * 두 종류가 있다:
 *   - **내장 훅**: 앱이 들고 있는 동작(지금은 OS 알림 둘). 켜고 끄기만 한다.
 *   - **사용자 훅**: 사용자가 등록한 셸 명령. 같은 시점에 함께 돈다.
 *
 * **비차단이다** — 훅은 턴의 흐름을 막거나 되돌리지 못한다. 결과를 기다리지 않고,
 * 실패해도 대화에 영향이 없다. 도구 실행을 훅이 거부할 수 있게 하려면 도구 실행 경로와
 * 중단 경주(`lib/ai/abort.ts`)에 손을 대야 해서, 중단 동작이 흔들릴 위험을 지금은 지지 않는다.
 *
 * 실행 자체는 `dispatchHooks()` 가 하고, 무엇이 도는지 고르는 판정은 전부 순수 함수다.
 */
import { t, type MessageKey } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { notify } from "@/lib/notify";

export type HookEvent = "turnStart" | "turnComplete" | "turnError";

export const HOOK_EVENTS: {
  id: HookEvent;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
}[] = [
  {
    id: "turnStart",
    labelKey: "hook.event.turnStart.label",
    descriptionKey: "hook.event.turnStart.description",
  },
  {
    id: "turnComplete",
    labelKey: "hook.event.turnEnd.label",
    descriptionKey: "hook.event.turnEnd.description",
  },
  {
    id: "turnError",
    labelKey: "hook.event.turnError.label",
    descriptionKey: "hook.event.turnError.description",
  },
];

/** 사용자가 등록한 훅 하나. settings.json 에 저장된다. */
export interface HookConfig {
  id: string;
  name: string;
  event: HookEvent;
  /** 셸 명령 한 줄. `{{event}}` 같은 자리표를 쓸 수 있다. */
  command: string;
  enabled: boolean;
}

/** 앱이 들고 있는 훅. 동작은 코드에 있고 사용자는 켜고 끄기만 한다. */
export interface BuiltinHook {
  id: string;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  event: HookEvent;
  defaultEnabled: boolean;
}

export const BUILTIN_HOOKS: BuiltinHook[] = [
  {
    id: "notify-on-complete",
    labelKey: "hook.builtin.notifyDone.label",
    descriptionKey: "hook.builtin.notifyDone.description",
    event: "turnComplete",
    defaultEnabled: true,
  },
  {
    id: "notify-on-error",
    labelKey: "hook.builtin.notifyError.label",
    descriptionKey: "hook.builtin.notifyError.description",
    event: "turnError",
    defaultEnabled: false,
  },
];

/** 훅에 넘어가는 사실들. 셸 명령의 자리표와 알림 문구가 여기서 나온다. */
export interface HookPayload {
  event: HookEvent;
  sessionId: string;
  projectPath: string;
  /** complete | aborted | error */
  status: string;
  durationMs: number;
  /** 알림 문구에만 쓴다 — 셸 명령에는 넘기지 않는다(아래 `renderHookCommand` 참고). */
  error?: string;
}

/** 내장 훅이 켜져 있는가. 설정에 값이 없으면 훅이 정한 기본값을 따른다. */
export function isBuiltinEnabled(hook: BuiltinHook, toggles: Record<string, boolean> = {}): boolean {
  return toggles[hook.id] ?? hook.defaultEnabled;
}

/** 이 이벤트에 걸린, 켜져 있는 사용자 훅만. */
export function hooksFor(hooks: HookConfig[], event: HookEvent): HookConfig[] {
  return hooks.filter((hook) => hook.enabled !== false && hook.event === event);
}

/**
 * 셸에 넘길 값에서 명령을 갈라 놓을 수 있는 글자를 걷어낸다.
 *
 * 자리표에 들어가는 값은 대부분 우리가 만든 것(uuid·상태·숫자)이지만 프로젝트 경로는
 * 사용자 디스크에서 온다 → 따옴표·파이프·줄바꿈이 섞이면 사용자가 쓴 명령이 두 개로 갈린다.
 * **공급자 에러 메시지는 아예 자리표로 주지 않는다** — 남의 서버가 보낸 문자열을
 * 셸 한 줄에 끼워 넣을 이유가 없다(알림 문구로만 쓴다).
 */
function shellSafe(value: string): string {
  return value.replace(/[\r\n"'`$&|;<>]/g, " ").trim();
}

/** 자리표를 채운 명령 한 줄. 모르는 자리표는 그대로 둔다(오타를 조용히 지우지 않는다). */
export function renderHookCommand(command: string, payload: HookPayload): string {
  const values: Record<string, string> = {
    event: payload.event,
    status: payload.status,
    sessionId: payload.sessionId,
    project: payload.projectPath,
    durationMs: String(payload.durationMs),
  };
  return command.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in values ? shellSafe(values[key]) : whole,
  );
}

/** 훅 하나가 붙잡고 있을 수 있는 시간. 넘으면 Rust 가 프로세스 트리째 정리한다. */
export const HOOK_TIMEOUT_MS = 15_000;

/** 알림 문구. 상태에 따라 말이 달라진다 — "완료" 알림이 실패를 덮으면 안 된다. */
export function notificationText(payload: HookPayload): { title: string; body: string } {
  if (payload.event === "turnError") {
    return {
      title: t("hook.notify.errorTitle"),
      body: payload.error?.slice(0, 200) || t("hook.notify.errorBody"),
    };
  }
  const seconds = Math.max(1, Math.round(payload.durationMs / 1000));
  return {
    title:
      payload.status === "aborted" ? t("hook.notify.abortedTitle") : t("hook.notify.doneTitle"),
    body: t("hook.notify.doneBody", { seconds }),
  };
}

export interface DispatchOptions {
  builtinToggles: Record<string, boolean>;
  hooks: HookConfig[];
}

/**
 * 이 시점에 걸린 훅을 모두 돌린다. **기다리지 않고, 실패해도 삼킨다** —
 * 훅이 대화를 망가뜨리는 일은 없어야 한다.
 */
export async function dispatchHooks(
  payload: HookPayload,
  options: DispatchOptions,
): Promise<void> {
  const jobs: Promise<unknown>[] = [];

  for (const builtin of BUILTIN_HOOKS) {
    if (builtin.event !== payload.event) continue;
    if (!isBuiltinEnabled(builtin, options.builtinToggles)) continue;
    const { title, body } = notificationText(payload);
    jobs.push(notify(title, body));
  }

  for (const hook of hooksFor(options.hooks, payload.event)) {
    const command = renderHookCommand(hook.command, payload).trim();
    if (!command) continue;
    jobs.push(
      ipc
        .executeShellCommand(command, {
          cwd: payload.projectPath || undefined,
          timeoutMs: HOOK_TIMEOUT_MS,
          projectPath: payload.projectPath || undefined,
        })
        // 훅이 실패해도 배너를 띄우지 않는다. 콘솔에만 남긴다.
        .catch((error: unknown) => console.warn(t("error.hookFailed", { name: hook.name }), error)),
    );
  }

  await Promise.allSettled(jobs);
}
