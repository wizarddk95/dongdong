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
import { useT } from "@/lib/i18n/useT";
import { useSettings } from "@/store/settings";

export function HookList() {
  const t = useT();
  // 이벤트 이름은 언어를 따라가므로 렌더마다 다시 만든다(항목이 셋뿐이라 부담이 없다).
  const eventLabel = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event.id, t(event.labelKey)]),
  ) as Record<HookEvent, string>;
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
              <span className="text-ink">{t(hook.labelKey)}</span>
              <Tag>{eventLabel[hook.event]}</Tag>
              <Tag>{t("hooks.builtin")}</Tag>
            </span>
            <span className="mt-0.5 block text-caption text-ink-muted">
              {t(hook.descriptionKey)}
            </span>
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
            <Tag>{eventLabel[hook.event] ?? hook.event}</Tag>
            <button
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-caption text-ink-subtle transition-colors hover:bg-hover hover:text-error"
              title={t("hooks.remove")}
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
              placeholder={t("hooks.namePlaceholder")}
              className={FIELD_SM}
            />
            <select
              value={draft.event}
              onChange={(event) => setDraft({ ...draft, event: event.target.value as HookEvent })}
              className={SELECT_SM}
            >
              {HOOK_EVENTS.map((event) => (
                <option key={event.id} value={event.id}>
                  {t(event.labelKey)} — {t(event.descriptionKey)}
                </option>
              ))}
            </select>
          </div>
          <input
            value={draft.command}
            onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            placeholder={t("hooks.commandPlaceholder")}
            className={`${FIELD_SM} font-mono`}
          />
          <p className="text-caption text-ink-muted">
            {t("hooks.placeholders")} <span className="font-mono">{"{{event}}"}</span>{" "}
            <span className="font-mono">{"{{status}}"}</span>{" "}
            <span className="font-mono">{"{{sessionId}}"}</span>{" "}
            <span className="font-mono">{"{{durationMs}}"}</span>{" "}
            <span className="font-mono">{"{{project}}"}</span>. {t("hooks.noErrorPlaceholder")}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void add()} disabled={!draft.command.trim()}>
              {t("common.add")}
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>{t("hooks.add")}</Button>
      )}
    </div>
  );
}
