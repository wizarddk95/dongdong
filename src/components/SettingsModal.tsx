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
  parseModelId,
  resolveEffort,
  sendsEffort,
  type Effort,
} from "@/lib/ai/providers";
import { DEFAULT_TOOLS, TOOL_GROUPS, type ToolToggles } from "@/lib/ai/tools";
import { THEME_LABEL, THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";
import { useSettings } from "@/store/settings";

/**
 * 사고 강도가 잠기는 이유. 공급자마다 사정이 달라서 한 문장으로 뭉뚱그리지 않는다 —
 * "받지 못한다" 와 "받는 값을 모른다" 는 사용자가 할 수 있는 일이 다르다.
 */
function effortLockReason(modelId: string): string {
  const { provider } = parseModelId(modelId);
  if (provider === "local") return "로컬 서버에는 사고 강도 개념이 없습니다.";
  if (provider === "anthropic")
    return "이 모델은 adaptive thinking 을 몰라 사고 강도를 받지 않습니다 (보내면 400).";
  return "카탈로그에 없는 모델이라 어떤 강도 값을 받는지 알 수 없어 보내지 않습니다 (틀린 값은 400 입니다).";
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

const SECTIONS: { id: SectionId; label: string; note: string }[] = [
  { id: "general", label: "일반", note: "테마 · 지침 · 시스템 프롬프트" },
  { id: "model", label: "모델", note: "모델 · 사고 강도 · 서브에이전트" },
  { id: "providers", label: "공급자", note: "API 키 · 로컬 서버" },
  { id: "tools", label: "도구", note: "에이전트가 바로 실행하는 것" },
  { id: "skills", label: "스킬", note: "판단해서 열어 보는 절차서" },
  { id: "hooks", label: "훅", note: "정해진 시점의 자동 동작" },
  { id: "mcp", label: "MCP", note: "외부 서버의 도구" },
];

/** 클라우드 공급자 키 한 벌. 늘어나도 이 배열에 한 줄만 더한다. */
const PROVIDER_KEYS = [
  {
    id: "anthropic" as const,
    label: "Anthropic",
    placeholder: "sk-ant-...",
    note: "Claude 계열. console.anthropic.com 에서 발급합니다.",
  },
  {
    id: "openai" as const,
    label: "OpenAI",
    placeholder: "sk-...",
    note: "GPT 계열. platform.openai.com 에서 발급합니다.",
  },
  {
    id: "google" as const,
    label: "Google Gemini",
    placeholder: "AIza...",
    note: "Gemini 계열. aistudio.google.com 에서 발급합니다.",
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
  const settings = useSettings();
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
          ? `${models.length}개 발견: ${models.join(", ")}`
          : "서버는 응답했지만 받은 모델이 없습니다. `ollama pull gpt-oss:20b` 로 먼저 내려받으세요.",
      });
    } catch (error) {
      setProbe({
        state: "error",
        message: `연결 실패 — 서버가 떠 있는지 확인하세요 (${String(error)})`,
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
          <h2 className="text-card-title text-ink">설정</h2>
          <button
            className="-mr-1 rounded-sm px-2 py-1 text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            title="닫기"
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
                  title={item.note}
                  className={`flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-body-sm transition-colors ${
                    selected
                      ? "bg-selected font-semibold text-ink"
                      : "text-ink-muted hover:bg-hover hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
                <SectionTitle>화면</SectionTitle>
                <Field
                  label="테마"
                  hint="고르는 즉시 적용되고 저장됩니다 ([저장] 을 누르지 않아도 됩니다)."
                >
                  <select
                    value={settings.theme}
                    onChange={(event) =>
                      void settings.update({ theme: event.target.value as ThemePreference })
                    }
                    className={SELECT}
                  >
                    {THEME_PREFERENCES.map((value) => (
                      <option key={value} value={value}>
                        {THEME_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>
                        연 프로젝트 루트의 <span className="font-mono">AGENTS.md</span> 를 매 턴 다시
                        읽어 원문 그대로 싣습니다. 파일을 고치면 다음 턴부터 바로 반영됩니다.
                      </>
                    }
                  >
                    프로젝트 지침
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
                    <span className="text-ink">프로젝트 루트의 AGENTS.md 자동 로드</span>
                    <span className="mt-0.5 block text-caption text-ink-muted">
                      파일이 있으면 매 턴 컨텍스트 맨 앞에 원문을 싣습니다. 서브에이전트에게도 같은
                      지침이 전달됩니다.
                    </span>
                  </span>
                </label>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>
                        매 턴 컨텍스트에 실리는 지시문입니다. 프로젝트의{" "}
                        <span className="font-mono">AGENTS.md</span> 를 켜 두면 그 원문이 이 앞에
                        붙고, 스킬 목록은 이 뒤에 붙습니다.
                      </>
                    }
                  >
                    시스템 프롬프트
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
                <SectionTitle>모델</SectionTitle>
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
                      {option.label}
                      {option.note ? ` — ${option.note}` : ""}
                    </option>
                  ))}
                  <option value="custom">직접 입력…</option>
                </select>
                {modelId === "custom" && (
                  <input
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder="google:gemini-3.7-flash / local:gpt-oss:20b 형식으로 입력"
                    className={`${FIELD} font-mono`}
                  />
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="사고 강도"
                    hint={
                      <>
                        답하기 전에 모델이 얼마나 오래 생각할지입니다. 높일수록 어려운 문제에
                        강해지지만 사고 토큰도 함께 나가 느려지고 비쌉니다. 받는 값은 모델마다 달라서
                        지금 고른 모델이 받는 것만 뿌립니다.
                      </>
                    }
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
                    label="최대 스텝 (도구 루프)"
                    hintAlign="right"
                    hint={
                      <>
                        한 턴에서 도구를 부르고 그 결과를 다시 읽는 왕복의 최대 횟수입니다. 여기에
                        걸리면 답이 끊긴 채로 턴이 끝나므로, 도구를 많이 쓰는 작업은 넉넉히 잡습니다.
                      </>
                    }
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
                      ` 서브에이전트 모델도 마찬가지입니다 — ${effortLockReason(subagentEffectiveId)}`}
                  </Help>
                )}
                {effortApplies && !mainSendsEffort && (
                  <Help>메인 모델에는 나가지 않고 서브에이전트 모델에만 적용됩니다.</Help>
                )}
                {/* 강도는 하나인데 두 모델이 나눠 쓴다 — 서브에이전트 쪽에 다른 값이 나가면 밝힌다. */}
                {effortApplies && mainSendsEffort && subagentEffort !== effort && (
                  <Help>
                    서브에이전트 모델(<span className="font-mono">{subagentEffectiveId}</span>)은 이
                    값을 받지 않아{" "}
                    {subagentEffort
                      ? `가장 가까운 ${subagentEffort} 로 보냅니다.`
                      : "사고 강도 없이 부릅니다."}
                  </Help>
                )}

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>
                        <span className="font-mono">delegate_task</span> 로 띄우는 하위
                        에이전트입니다. 자기 컨텍스트를 따로 갖고 요약만 위로 올리므로, 긴 탐색으로
                        메인 대화가 불어나는 것을 막습니다. 다시 위임하지는 못합니다.
                      </>
                    }
                  >
                    서브에이전트
                  </SectionTitle>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="모델">
                    <select
                      value={subagentModelId}
                      onChange={(event) => setSubagentModelId(event.target.value)}
                      className={SELECT}
                    >
                      <option value="">메인 모델과 동일</option>
                      {modelOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="스텝 예산 (1명당)">
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
                        키는 프로젝트가 아니라 OS 앱 설정 디렉터리의{" "}
                        <span className="font-mono">settings.json</span> 에 평문으로 저장됩니다 — 이
                        PC 안에만 있고 대화 기록과 함께 옮겨지지 않습니다.
                        {settings.settingsPath && (
                          <span className="mt-1 block font-mono break-all">
                            {settings.settingsPath}
                          </span>
                        )}
                      </>
                    }
                  >
                    API 키
                  </SectionTitle>
                  <button
                    className="text-caption text-accent hover:underline"
                    onClick={() => setRevealKeys((value) => !value)}
                  >
                    {revealKeys ? "가리기" : "보기"}
                  </button>
                </div>
                <Help>쓰는 공급자만 펼쳐 채우면 됩니다. 접힌 줄에도 채움 여부는 보입니다.</Help>

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
                          value.trim() ? <Tag tone="accent">설정됨</Tag> : <Tag>비어 있음</Tag>
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
                        <p className="mt-1.5 text-caption text-ink-muted">{provider.note}</p>
                      </Disclosure>
                    );
                  })}
                </div>

                <div className="pt-3">
                  <SectionTitle
                    hint={
                      <>
                        이 PC 에서 도는 OpenAI 호환 서버입니다. 키가 필요 없고 대화 내용이 밖으로
                        나가지 않습니다. Ollama 는{" "}
                        <span className="font-mono">localhost:11434/v1</span>, LM Studio 는{" "}
                        <span className="font-mono">localhost:1234/v1</span> 입니다.
                      </>
                    }
                  >
                    로컬 모델 서버 (Ollama · LM Studio)
                  </SectionTitle>
                </div>
                <Field
                  label="서버 주소"
                  hint={
                    <>
                      에이전트는 도구 스키마만으로도 컨텍스트를 크게 먹습니다. Ollama 는 기본이 4K 라
                      응답이 잘리거나 빈 문자열이 옵니다 —{" "}
                      <span className="font-mono">OLLAMA_CONTEXT_LENGTH=65536</span> 을 환경 변수로
                      주고 서버를 다시 띄우세요.
                    </>
                  }
                >
                  <input
                    value={localBaseUrl}
                    onChange={(event) => setLocalBaseUrl(event.target.value)}
                    placeholder={DEFAULT_LOCAL_BASE_URL}
                    className={`${FIELD} font-mono`}
                  />
                </Field>
                <Field label="키 (서버가 요구할 때만)">
                  <input
                    type={revealKeys ? "text" : "password"}
                    value={localApiKey}
                    onChange={(event) => setLocalApiKey(event.target.value)}
                    placeholder="보통 비워 둡니다"
                    className={`${FIELD} font-mono`}
                  />
                </Field>
                <div className="flex items-center gap-3">
                  <Button
                    size="md"
                    onClick={() => void refreshLocalModels()}
                    disabled={probe.state === "loading"}
                  >
                    {probe.state === "loading" ? "확인 중…" : "설치된 모델 불러오기"}
                  </Button>
                  <Help>모델 목록의 로컬 항목은 여기서 불러온 것이 전부입니다.</Help>
                </div>
                <Help>
                  {settings.localModels.length
                    ? `현재 목록: ${settings.localModels.join(", ")}`
                    : "발견된 로컬 모델이 없습니다 — 서버를 띄운 뒤 다시 불러오세요."}
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
                    <>
                      도구는 <b>실행 경로</b>입니다 — 스키마가 매 턴 컨텍스트에 실리고 모델이 곧바로
                      부릅니다. 절차를 적어 두고 필요할 때만 열어 보는 <b>스킬</b>과는 다른 층입니다.
                    </>
                  }
                >
                  도구 (에이전트가 바로 실행하는 것)
                </SectionTitle>
                <Help>
                  켜 둔 도구는 확인 없이 바로 실행됩니다. 샌드박스가 아니라 이 PC 의 사용자 권한으로
                  동작하니 필요한 것만 켜세요.
                </Help>
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
                      <span className="text-ink">{group.label}</span>
                      <span className="mt-0.5 block font-mono text-caption break-all text-ink-muted">
                        {group.tools.join(", ")}
                      </span>
                    </span>
                  </label>
                ))}
              </>
            )}

            {section === "skills" && (
              <>
                <SectionTitle
                  hint={
                    <>
                      스킬은 <b>절차서</b>입니다. 매 턴 실리는 것은 이름과 설명 한 줄뿐이고, 모델이
                      필요하다고 판단하면 <span className="font-mono">load_skill</span> 로 본문을
                      끌어옵니다. 그래서 절차를 아무리 길게 적어도 평소 컨텍스트는 늘지 않습니다.
                    </>
                  }
                >
                  스킬 (판단해서 열어 보는 절차서)
                </SectionTitle>
                <SkillList />
              </>
            )}

            {section === "hooks" && (
              <>
                <SectionTitle
                  hint={
                    <>
                      정해진 시점에 자동으로 도는 동작입니다. 턴을 막거나 되돌리지 못하고(비차단),
                      실패해도 대화에는 영향이 없습니다.
                    </>
                  }
                >
                  훅 (정해진 시점의 자동 동작)
                </SectionTitle>
                <Help>
                  내장 훅은 켜고 끄기만 하고, 사용자 훅은 셸 명령 한 줄을 그 시점에 실행합니다.
                </Help>
                <HookList />
              </>
            )}

            {section === "mcp" && <McpServers />}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-hairline px-6 py-4">
          {/* 무엇이 [저장]을 기다리는지 밝힌다 — 목록형 UI 는 이미 저장돼 있다. */}
          <span className="text-caption text-ink-subtle">
            스킬 · 훅 · MCP 목록은 바꾸는 즉시 저장됩니다.
          </span>
          <span className="flex gap-2">
            <Button size="md" onClick={onClose}>
              취소
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => void save()}
              disabled={settings.saving}
            >
              {settings.saving ? "저장 중…" : "저장"}
            </Button>
          </span>
        </footer>
      </div>
    </div>
  );
}
