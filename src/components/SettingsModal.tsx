import { useEffect, useMemo, useState } from "react";

import { HookList } from "@/components/hooks/HookList";
import { McpServers } from "@/components/mcp/McpServers";
import {
  Button,
  Disclosure,
  FIELD,
  FIELD_SM,
  Hint,
  SELECT,
  Tag,
  useBackdropDismiss,
} from "@/components/Panel";
import { SkillList } from "@/components/skills/SkillList";
import {
  DEFAULT_LOCAL_BASE_URL,
  buildModelOptions,
  defaultEffortFor,
  effortOptionsFor,
  modelLabel,
  modelNote,
  parseModelId,
  resolveEffort,
  sendsEffort,
  type Effort,
} from "@/lib/ai/providers";
import { APPROVAL_MODES, describeRule, type ApprovalMode } from "@/lib/ai/approval";
import { DEFAULT_TOOLS, TOOL_GROUPS, type ToolToggles } from "@/lib/ai/tools";
import { THEME_LABEL_KEY, THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";
import { useApprovals } from "@/store/approvals";
import { LOCALES, LOCALE_LABEL, t, type Locale, type MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/useT";
import { useSettings } from "@/store/settings";

/**
 * 사고 강도가 잠기는 이유. 공급자마다 사정이 달라서 한 문장으로 뭉뚱그리지 않는다 —
 * "받지 못한다" 와 "받는 값을 모른다" 는 사용자가 할 수 있는 일이 다르다.
 */
function effortLockReason(modelId: string): string {
  const { provider } = parseModelId(modelId);
  if (provider === "local") return t("settings.effortLock.local");
  if (provider === "anthropic") return t("settings.effortLock.anthropic");
  return t("settings.effortLock.unknown");
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 설정 섹션.
 *
 * 예전에는 전부 한 줄로 이어 붙여 스크롤했는데, 공급자·도구·스킬·훅·MCP 가 늘어나면서
 * 무엇이 어디 있는지 찾으려면 모달을 끝까지 굴려야 했다 → 왼쪽에 목록을 세우고
 * 한 번에 한 섹션만 보여 준다. [저장]은 어느 섹션을 보고 있든 폼 전체를 함께 저장한다.
 */
type SectionId = "general" | "model" | "providers" | "tools" | "skills" | "hooks" | "mcp";

const SECTIONS: { id: SectionId; labelKey: MessageKey; noteKey: MessageKey }[] = [
  { id: "general", labelKey: "settings.section.general", noteKey: "settings.section.generalNote" },
  { id: "model", labelKey: "settings.section.model", noteKey: "settings.section.modelNote" },
  {
    id: "providers",
    labelKey: "settings.section.providers",
    noteKey: "settings.section.providersNote",
  },
  { id: "tools", labelKey: "settings.section.tools", noteKey: "settings.section.toolsNote" },
  { id: "skills", labelKey: "settings.section.skills", noteKey: "settings.section.skillsNote" },
  { id: "hooks", labelKey: "settings.section.hooks", noteKey: "settings.section.hooksNote" },
  { id: "mcp", labelKey: "settings.section.mcp", noteKey: "settings.section.mcpNote" },
];

/** 클라우드 공급자 키 한 벌. 늘어나도 이 배열에 한 줄만 더한다. */
const PROVIDER_KEYS = [
  {
    id: "anthropic" as const,
    label: "Anthropic",
    placeholder: "sk-ant-...",
    noteKey: "settings.key.anthropic" as MessageKey,
  },
  {
    id: "openai" as const,
    label: "OpenAI",
    placeholder: "sk-...",
    noteKey: "settings.key.openai" as MessageKey,
  },
  {
    id: "google" as const,
    label: "Google Gemini",
    placeholder: "AIza...",
    noteKey: "settings.key.google" as MessageKey,
  },
];

type ProviderId = (typeof PROVIDER_KEYS)[number]["id"];

/** 섹션 제목 — 모달 안에서 한 계층만 쓴다. 긴 설명은 옆의 `?` 로 접는다. */
function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-subhead text-ink">
      {children}
      {hint && <Hint>{hint}</Hint>}
    </h3>
  );
}

/**
 * 라벨 + 입력 한 벌. 라벨은 12px 로 입력 바로 위에 붙는다.
 * `hint` 를 주면 라벨 옆에 `?` 가 서고, 커서를 올릴 때만 설명이 뜬다.
 */
function Field({
  label,
  hint,
  hintAlign = "left",
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /** 2열 그리드의 오른쪽 칸은 `right` — 말풍선이 모달 밖으로 나가지 않게. */
  hintAlign?: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-caption text-ink-muted">
        {label}
        {hint && (
          <Hint align={hintAlign} className="font-normal">
            {hint}
          </Hint>
        )}
      </span>
      {children}
    </label>
  );
}

/** 도움말 한 줄. */
function Help({ children }: { children: React.ReactNode }) {
  return <p className="text-caption text-ink-muted">{children}</p>;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const t = useT();
  const settings = useSettings();
  // [항상 허용] 규칙은 설정 파일이 아니라 **지금 세션**에 산다 (`store/approvals.ts`).
  const allowedCommands = useApprovals((state) => state.allowed);
  const forgetRule = useApprovals((state) => state.forget);
  const forgetAllRules = useApprovals((state) => state.forgetAll);
  const backdrop = useBackdropDismiss(onClose);

  const [section, setSection] = useState<SectionId>("general");
  const [keys, setKeys] = useState<Record<ProviderId, string>>({
    anthropic: "",
    openai: "",
    google: "",
  });
  /** 한 번에 하나만 펼친다 — 공급자가 늘어도 목록 높이가 거의 그대로여야 한다. */
  const [openKey, setOpenKey] = useState<ProviderId | null>(null);
  const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [localApiKey, setLocalApiKey] = useState("");
  const [probe, setProbe] = useState<{ state: "idle" | "loading" | "ok" | "error"; message: string }>(
    { state: "idle", message: "" },
  );
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelId, setModelId] = useState(settings.modelId);
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState<Effort>(settings.effort);
  const [maxSteps, setMaxSteps] = useState(settings.maxSteps);
  const [revealKeys, setRevealKeys] = useState(false);
  const [tools, setTools] = useState<ToolToggles>(settings.tools ?? DEFAULT_TOOLS);
  const [subagentModelId, setSubagentModelId] = useState(settings.subagentModelId);
  const [subagentMaxSteps, setSubagentMaxSteps] = useState(settings.subagentMaxSteps);
  const [useProjectInstructions, setUseProjectInstructions] = useState(
    settings.useProjectInstructions,
  );
  const [injectDateTime, setInjectDateTime] = useState(settings.injectDateTime);
  const [shellApproval, setShellApproval] = useState<ApprovalMode>(settings.shellApproval);

  // "직접 입력" 이면 입력칸의 값이 곧 고른 모델이다.
  const selectedModelId = modelId === "custom" ? customModel.trim() : modelId;
  // 사고 강도는 하나뿐인데 메인 턴과 서브에이전트가 **같이** 쓴다(`store/agents.ts`).
  // 그래서 둘 중 하나라도 실어 보내는 모델이면 열어 둬야 한다 — 메인만 보고 잠그면
  // 서브에이전트에는 실제로 나가는 값을 사용자가 못 고치게 된다.
  const subagentEffectiveId = subagentModelId || selectedModelId;
  const mainSendsEffort = sendsEffort(selectedModelId);
  // 요청에 실리지도 않는 값을 고르게 두면 켠 줄 알고 넘어간다 → 잠그고 이유를 적는다.
  const effortApplies = mainSendsEffort || sendsEffort(subagentEffectiveId);
  // 받는 값은 세대마다 다르다 — 고를 수 있는 것만 뿌린다.
  const effortOptions = effortOptionsFor(selectedModelId);
  // 저장된 값이 목록 밖이면(옛 설정) 셀렉트가 빈칸이 된다 → 그 값도 세워 둔다.
  const shownEfforts = effortOptions.includes(effort) ? effortOptions : [effort, ...effortOptions];
  // 메인과 서브에이전트가 받는 값이 다르면, 못 받는 쪽에는 가장 가까운 값이 나간다.
  const subagentEffort = resolveEffort(subagentEffectiveId, effort);

  // 클라우드 카탈로그 + 로컬 서버가 실제로 갖고 있는 태그
  const modelOptions = useMemo(
    () => buildModelOptions(settings.localModels),
    [settings.localModels],
  );

  // 모달을 열 때마다 스토어 값으로 폼을 초기화한다.
  useEffect(() => {
    if (!open) return;
    setKeys({
      anthropic: settings.anthropicApiKey ?? "",
      openai: settings.openaiApiKey ?? "",
      google: settings.googleApiKey ?? "",
    });
    setOpenKey(null);
    setLocalBaseUrl(settings.localBaseUrl || DEFAULT_LOCAL_BASE_URL);
    setLocalApiKey(settings.localApiKey ?? "");
    setProbe({ state: "idle", message: "" });
    setSystemPrompt(settings.systemPrompt);
    setEffort(settings.effort);
    setMaxSteps(settings.maxSteps);
    setTools(settings.tools ?? DEFAULT_TOOLS);
    setSubagentModelId(settings.subagentModelId);
    setSubagentMaxSteps(settings.subagentMaxSteps);
    setUseProjectInstructions(settings.useProjectInstructions);
    setInjectDateTime(settings.injectDateTime);
    setShellApproval(settings.shellApproval);

    const known = modelOptions.some((option) => option.id === settings.modelId);
    setModelId(known ? settings.modelId : "custom");
    setCustomModel(known ? "" : settings.modelId);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function save() {
    const resolvedModel = modelId === "custom" ? customModel.trim() : modelId;
    await settings.update({
      anthropicApiKey: keys.anthropic.trim(),
      openaiApiKey: keys.openai.trim(),
      googleApiKey: keys.google.trim(),
      localBaseUrl: localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL,
      localApiKey: localApiKey.trim(),
      systemPrompt,
      modelId: resolvedModel || settings.modelId,
      effort,
      maxSteps,
      tools,
      subagentModelId,
      subagentMaxSteps,
      useProjectInstructions,
      injectDateTime,
      shellApproval,
    });
    onClose();
  }

  /** 로컬 서버(`GET /v1/models`)에 실제로 깔린 모델을 읽어 드롭다운을 그 목록으로 갈아 끼운다. */
  async function refreshLocalModels() {
    setProbe({ state: "loading", message: "" });
    try {
      const models = await settings.refreshLocalModels(localBaseUrl);
      setProbe({
        state: models.length ? "ok" : "error",
        message: models.length
          ? t("settings.local.found", { count: models.length, models: models.join(", ") })
          : t("settings.local.none"),
      });
    } catch (error) {
      setProbe({
        state: "error",
        message: t("settings.local.failed", { error: String(error) }),
      });
    }
  }

  /** 채워진 키의 개수 — 섹션을 열지 않고도 상태를 알 수 있게 왼쪽 목록에 적는다. */
  const filledKeys = PROVIDER_KEYS.filter((provider) => keys[provider.id].trim()).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 backdrop-blur-[2px]"
      {...backdrop}
    >
      <div className="flex h-full max-h-[46rem] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline bg-canvas elevate-lg">
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-6 py-4">
          <h2 className="text-card-title text-ink">{t("topbar.settings")}</h2>
          <button
            className="-mr-1 rounded-sm px-2 py-1 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            title={t("common.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 섹션 목록 — 선택된 것만 옅은 면 위에 잉크색으로 선다(탭과 같은 규칙). */}
          <nav
            role="tablist"
            aria-orientation="vertical"
            className="w-40 shrink-0 space-y-0.5 overflow-auto border-r border-hairline bg-surface-1 p-2"
          >
            {SECTIONS.map((item) => {
              const selected = section === item.id;
              return (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setSection(item.id)}
                  title={t(item.noteKey)}
                  className={`flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-body-sm transition-colors ${
                    selected
                      ? "bg-selected font-semibold text-ink"
                      : "text-ink-muted hover:bg-hover hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                  {item.id === "providers" && filledKeys > 0 && (
                    <span className="shrink-0 text-caption text-ink-subtle">{filledKeys}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-6">
            {section === "general" && (
              <>
                <SectionTitle>{t("settings.display")}</SectionTitle>
                <Field label={t("settings.theme")} hint={t("settings.instantSave")}>
                  <select
                    value={settings.theme}
                    onChange={(event) =>
                      void settings.update({ theme: event.target.value as ThemePreference })
                    }
                    className={SELECT}
                  >
                    {THEME_PREFERENCES.map((value) => (
                      <option key={value} value={value}>
                        {t(THEME_LABEL_KEY[value])}
                      </option>
                    ))}
                  </select>
                </Field>

                {/*
                 * 언어는 화면만 바꾸는 것이 아니다 — 시스템 프롬프트와 도구 설명도 함께 간다.
                 * 그 사실을 힌트에 적어 두지 않으면 "영어로 골랐는데 왜 한국어로 답하지" 가 된다.
                 */}
                <Field label={t("settings.language")} hint={t("settings.languageHint")}>
                  <select
                    value={settings.language}
                    onChange={(event) =>
                      void settings.update({ language: event.target.value as Locale })
                    }
                    className={SELECT}
                  >
                    {LOCALES.map((value) => (
                      <option key={value} value={value}>
                        {LOCALE_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>
                        {t("settings.instructionsHint")}
                      </>
                    }
                  >
                    {t("settings.instructions")}
                  </SectionTitle>
                </div>
                <label className="flex items-start gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2.5 transition-colors hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={useProjectInstructions}
                    onChange={(event) => setUseProjectInstructions(event.target.checked)}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="text-ink">{t("settings.autoLoadAgents")}</span>
                    <span className="mt-0.5 block text-caption text-ink-muted">
                      {t("settings.autoLoadAgentsNote")}
                    </span>
                  </span>
                </label>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>{t("settings.datetimeHint")}</>
                    }
                  >
                    {t("settings.datetime")}
                  </SectionTitle>
                </div>
                <label className="flex items-start gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2.5 transition-colors hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={injectDateTime}
                    onChange={(event) => setInjectDateTime(event.target.checked)}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="text-ink">{t("settings.injectDatetime")}</span>
                    <span className="mt-0.5 block text-caption text-ink-muted">
                      {t("settings.injectDatetimeNote")}
                    </span>
                  </span>
                </label>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>{t("settings.systemPromptHint")}</>
                    }
                  >
                    {t("context.systemPrompt")}
                  </SectionTitle>
                </div>
                <textarea
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  rows={8}
                  className={`${FIELD_SM} resize-none`}
                />
              </>
            )}

            {section === "model" && (
              <>
                <SectionTitle>{t("settings.section.model")}</SectionTitle>
                <select
                  value={modelId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setModelId(nextId);
                    // 권장 사고 강도는 모델마다 다르다 — 저장 전에 눈에 보이게 미리 옮겨 준다.
                    // 권장값이 없으면 그 모델이 받는 값으로 당겨 둔다(셀렉트가 빈칸이 되지 않게).
                    const target = nextId === "custom" ? customModel.trim() : nextId;
                    setEffort(
                      (current) =>
                        defaultEffortFor(target) ?? resolveEffort(target, current) ?? current,
                    );
                  }}
                  className={SELECT}
                >
                  {modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {modelLabel(option)}
                      {modelNote(option) ? ` — ${modelNote(option)}` : ""}
                    </option>
                  ))}
                  <option value="custom">{t("settings.customModel")}</option>
                </select>
                {modelId === "custom" && (
                  <input
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder={t("settings.customModelPlaceholder")}
                    className={`${FIELD} font-mono`}
                  />
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label={t("settings.effort")}
                    hint={<>{t("settings.effortHint")}</>}
                  >
                    <select
                      value={effort}
                      onChange={(event) => setEffort(event.target.value as Effort)}
                      disabled={!effortApplies}
                      className={SELECT}
                    >
                      {shownEfforts.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={t("settings.maxSteps")}
                    hintAlign="right"
                    hint={<>{t("settings.maxStepsHint")}</>}
                  >
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={maxSteps}
                      onChange={(event) => setMaxSteps(Number(event.target.value) || 1)}
                      className={FIELD}
                    />
                  </Field>
                </div>
                {!effortApplies && (
                  <Help>
                    {effortLockReason(selectedModelId)}
                    {subagentEffectiveId !== selectedModelId &&
                      ` ${t("settings.effortLock.subagentToo", {
                        reason: effortLockReason(subagentEffectiveId),
                      })}`}
                  </Help>
                )}
                {effortApplies && !mainSendsEffort && (
                  <Help>{t("settings.effortSubagentOnly")}</Help>
                )}
                {/* 강도는 하나인데 두 모델이 나눠 쓴다 — 서브에이전트 쪽에 다른 값이 나가면 밝힌다. */}
                {effortApplies && mainSendsEffort && subagentEffort !== effort && (
                  <Help>
                    {t("settings.effortSubagentDiffers")}(
                    <span className="font-mono">{subagentEffectiveId}</span>){" "}
                    {subagentEffort
                      ? t("settings.effortSubagentNearest", { effort: subagentEffort })
                      : t("settings.effortSubagentNone")}
                  </Help>
                )}

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>{t("settings.subagentHint")}</>
                    }
                  >
                    {t("app.tab.agents")}
                  </SectionTitle>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("settings.section.model")}>
                    <select
                      value={subagentModelId}
                      onChange={(event) => setSubagentModelId(event.target.value)}
                      className={SELECT}
                    >
                      <option value="">{t("settings.sameAsMain")}</option>
                      {modelOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {modelLabel(option)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("settings.subagentBudget")}>
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={subagentMaxSteps}
                      onChange={(event) => setSubagentMaxSteps(Number(event.target.value) || 1)}
                      className={FIELD}
                    />
                  </Field>
                </div>
              </>
            )}

            {section === "providers" && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <SectionTitle
                    hint={
                      <>
                        {t("settings.keysHint")}
                        {settings.settingsPath && (
                          <span className="mt-1 block font-mono break-all">
                            {settings.settingsPath}
                          </span>
                        )}
                      </>
                    }
                  >
                    {t("settings.apiKeys")}
                  </SectionTitle>
                  <button
                    className="text-caption text-accent hover:underline"
                    onClick={() => setRevealKeys((value) => !value)}
                  >
                    {revealKeys ? t("settings.hide") : t("settings.reveal")}
                  </button>
                </div>
                <Help>{t("settings.keysLead")}</Help>

                <div className="space-y-1.5">
                  {PROVIDER_KEYS.map((provider) => {
                    const value = keys[provider.id];
                    return (
                      <Disclosure
                        key={provider.id}
                        open={openKey === provider.id}
                        onToggle={() =>
                          setOpenKey((current) => (current === provider.id ? null : provider.id))
                        }
                        title={provider.label}
                        summary={
                          value.trim() ? (
                            <Tag tone="accent">{t("settings.keySet")}</Tag>
                          ) : (
                            <Tag>{t("settings.keyEmpty")}</Tag>
                          )
                        }
                      >
                        <input
                          autoFocus
                          type={revealKeys ? "text" : "password"}
                          value={value}
                          onChange={(event) =>
                            setKeys((current) => ({ ...current, [provider.id]: event.target.value }))
                          }
                          placeholder={provider.placeholder}
                          className={`${FIELD} font-mono`}
                        />
                        <p className="mt-1.5 text-caption text-ink-muted">{t(provider.noteKey)}</p>
                      </Disclosure>
                    );
                  })}
                </div>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>{t("settings.localHint")}</>
                    }
                  >
                    {t("settings.localServer")}
                  </SectionTitle>
                </div>
                <Field
                  label={t("settings.serverUrl")}
                  hint={<>{t("settings.serverUrlHint")}</>}
                >
                  <input
                    value={localBaseUrl}
                    onChange={(event) => setLocalBaseUrl(event.target.value)}
                    placeholder={DEFAULT_LOCAL_BASE_URL}
                    className={`${FIELD} font-mono`}
                  />
                </Field>
                <Field label={t("settings.localKey")}>
                  <input
                    type={revealKeys ? "text" : "password"}
                    value={localApiKey}
                    onChange={(event) => setLocalApiKey(event.target.value)}
                    placeholder={t("settings.localKeyPlaceholder")}
                    className={`${FIELD} font-mono`}
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button
                    size="md"
                    onClick={() => void refreshLocalModels()}
                    disabled={probe.state === "loading"}
                  >
                    {probe.state === "loading" ? t("settings.probing") : t("settings.loadLocalModels")}
                  </Button>
                  <Help>{t("settings.localListNote")}</Help>
                </div>
                <Help>
                  {settings.localModels.length
                    ? t("settings.localCurrent", { models: settings.localModels.join(", ") })
                    : t("settings.localEmpty")}
                </Help>
                {probe.message && (
                  <p
                    className={`rounded-md border-l-2 px-3 py-2 text-caption break-all ${
                      probe.state === "ok"
                        ? "border-success bg-success-subtle text-ink"
                        : "border-warning bg-warning-subtle text-ink"
                    }`}
                  >
                    {probe.message}
                  </p>
                )}
              </>
            )}

            {section === "tools" && (
              <>
                <SectionTitle
                  hint={
                    <>{t("settings.toolsHint")}</>
                  }
                >
                  {t("settings.toolsTitle")}
                </SectionTitle>
                <Help>{t("settings.toolsLead")}</Help>
                {TOOL_GROUPS.map((group) => (
                  <label
                    key={group.id}
                    className="flex items-start gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2.5 transition-colors hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      checked={tools[group.id]}
                      onChange={(event) =>
                        setTools((current) => ({ ...current, [group.id]: event.target.checked }))
                      }
                      className="mt-0.5 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="text-ink">{t(group.labelKey)}</span>
                      <span className="mt-0.5 block font-mono text-caption break-all text-ink-muted">
                        {group.tools.join(", ")}
                      </span>
                    </span>
                  </label>
                ))}

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>{t("settings.shellApprovalHint")}</>
                    }
                  >
                    {t("settings.shellApproval")}
                  </SectionTitle>
                </div>
                {APPROVAL_MODES.map((mode) => (
                  <label
                    key={mode.id}
                    className="flex items-start gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2.5 transition-colors hover:bg-hover"
                  >
                    <input
                      type="radio"
                      name="shell-approval"
                      checked={shellApproval === mode.id}
                      onChange={() => setShellApproval(mode.id)}
                      className="mt-0.5 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="text-ink">{t(mode.labelKey)}</span>
                      <span className="mt-0.5 block text-caption text-ink-muted">
                        {t(mode.descriptionKey)}
                      </span>
                    </span>
                  </label>
                ))}

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>{t("settings.allowRulesHint")}</>
                    }
                  >
                    {t("settings.allowRules", { count: allowedCommands.length })}
                  </SectionTitle>
                </div>
                <Help>{t("settings.allowRulesLifetime")}</Help>
                {allowedCommands.length === 0 ? (
                  <Help>{t("settings.allowRulesEmpty")}</Help>
                ) : (
                  <div className="space-y-1.5">
                    {allowedCommands.map((rule) => (
                      <div
                        key={rule.id}
                        className="flex items-center gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2"
                      >
                        <code className="min-w-0 flex-1 truncate font-mono text-caption text-ink">
                          {describeRule(rule)}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          title={t("settings.forgetRule")}
                          onClick={() => forgetRule(rule.id)}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    ))}
                    <Button variant="tertiary" size="sm" onClick={forgetAllRules}>
                      {t("settings.forgetAll")}
                    </Button>
                  </div>
                )}
              </>
            )}

            {section === "skills" && (
              <>
                <SectionTitle
                  hint={
                    <>{t("settings.skillsHint")}</>
                  }
                >
                  {t("settings.skillsTitle")}
                </SectionTitle>
                <SkillList />
              </>
            )}

            {section === "hooks" && (
              <>
                <SectionTitle
                  hint={
                    <>{t("settings.hooksHint")}</>
                  }
                >
                  {t("settings.hooksTitle")}
                </SectionTitle>
                <Help>{t("settings.hooksLead")}</Help>
                <HookList />
              </>
            )}

            {section === "mcp" && <McpServers />}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-hairline px-6 py-4">
          {/* 무엇이 [저장]을 기다리는지 밝힌다 — 목록형 UI 는 이미 저장돼 있다. */}
          <span className="text-caption text-ink-subtle">{t("settings.footerNote")}</span>
          <span className="flex gap-2">
            <Button size="md" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => void save()}
              disabled={settings.saving}
            >
              {settings.saving ? t("settings.saving") : t("common.save")}
            </Button>
          </span>
        </footer>
      </div>
    </div>
  );
}
