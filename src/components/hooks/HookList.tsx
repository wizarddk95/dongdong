/**
 * 훅 목록 관리 — 내장 훅 켜고 끄기 + 사용자 훅(셸 명령) 추가·삭제.
 *
 * 스킬 목록과 마찬가지로 **즉시 저장**한다.
 */
import { useState } from "react";

import { Button, FIELD_SM, SELECT_SM, Tag } from "@/components/Panel";
import {
  BUILTIN_HOOKS,
  HOOK_EVENTS,
  isBuiltinEnabled,
  type HookConfig,
  type HookEvent,
} from "@/lib/hooks";
import { useSettings } from "@/store/settings";

const EVENT_LABEL: Record<HookEvent, string> = Object.fromEntries(
  HOOK_EVENTS.map((event) => [event.id, event.label]),
) as Record<HookEvent, string>;

export function HookList() {
  const builtinHooks = useSettings((state) => state.builtinHooks);
  const hooks = useSettings((state) => state.hooks);
  const update = useSettings((state) => state.update);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ name: string; event: HookEvent; command: string }>({
    name: "",
    event: "turnComplete",
    command: "",
  });

  async function toggleBuiltin(id: string, enabled: boolean) {
    await update({ builtinHooks: { ...builtinHooks, [id]: enabled } });
  }

  async function add() {
    const command = draft.command.trim();
    if (!command) return;
    const config: HookConfig = {
      id: crypto.randomUUID(),
      name: draft.name.trim() || command.slice(0, 24),
      event: draft.event,
      command,
      enabled: true,
    };
    await update({ hooks: [...hooks, config] });
    setDraft({ name: "", event: "turnComplete", command: "" });
    setAdding(false);
  }

  async function toggle(id: string, enabled: boolean) {
    await update({ hooks: hooks.map((hook) => (hook.id === id ? { ...hook, enabled } : hook)) });
  }

  async function remove(id: string) {
    await update({ hooks: hooks.filter((hook) => hook.id !== id) });
  }

  return (
    <div className="space-y-3">
      {BUILTIN_HOOKS.map((hook) => (
        <label
          key={hook.id}
          className="flex items-start gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2.5 transition-colors hover:bg-hover"
        >
          <input
            type="checkbox"
            checked={isBuiltinEnabled(hook, builtinHooks)}
            onChange={(event) => void toggleBuiltin(hook.id, event.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-ink">{hook.label}</span>
              <Tag>{EVENT_LABEL[hook.event]}</Tag>
              <Tag>내장</Tag>
            </span>
            <span className="mt-0.5 block text-caption text-ink-muted">{hook.description}</span>
          </span>
        </label>
      ))}

      {hooks.map((hook) => (
        <div key={hook.id} className="rounded-md border border-hairline bg-canvas p-3 elevate">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hook.enabled !== false}
              onChange={(event) => void toggle(hook.id, event.target.checked)}
              className="accent-accent"
            />
            <span className="min-w-0 flex-1 truncate text-ink">{hook.name}</span>
            <Tag>{EVENT_LABEL[hook.event] ?? hook.event}</Tag>
            <button
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-caption text-ink-subtle transition-colors hover:bg-hover hover:text-error"
              title="훅 삭제"
              onClick={() => void remove(hook.id)}
            >
              ✕
            </button>
          </div>
          <p className="mt-1 truncate font-mono text-caption text-ink-muted">{hook.command}</p>
        </div>
      ))}

      {adding ? (
        <div className="space-y-2 rounded-md border border-hairline bg-surface-1 p-3">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="이름 (예: 완료 소리)"
              className={FIELD_SM}
            />
            <select
              value={draft.event}
              onChange={(event) => setDraft({ ...draft, event: event.target.value as HookEvent })}
              className={SELECT_SM}
            >
              {HOOK_EVENTS.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.label} — {event.description}
                </option>
              ))}
            </select>
          </div>
          <input
            value={draft.command}
            onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            placeholder='실행할 명령 (예: powershell -c "[console]::beep(880,200)")'
            className={`${FIELD_SM} font-mono`}
          />
          <p className="text-caption text-ink-muted">
            자리표: <span className="font-mono">{"{{event}}"}</span>{" "}
            <span className="font-mono">{"{{status}}"}</span>{" "}
            <span className="font-mono">{"{{sessionId}}"}</span>{" "}
            <span className="font-mono">{"{{durationMs}}"}</span>{" "}
            <span className="font-mono">{"{{project}}"}</span>. 오류 메시지는 자리표로 주지 않습니다
            — 공급자가 보낸 문자열을 셸 한 줄에 끼워 넣지 않기 위해서입니다.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              취소
            </Button>
            <Button variant="primary" onClick={() => void add()} disabled={!draft.command.trim()}>
              추가
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>+ 훅 추가</Button>
      )}
    </div>
  );
}
