import { useEffect, useMemo, useState } from "react";

import { McpServers } from "@/components/mcp/McpServers";
import { Button, FIELD, FIELD_SM, SELECT } from "@/components/Panel";
import {
  DEFAULT_LOCAL_BASE_URL,
  buildModelOptions,
  defaultEffortFor,
  type Effort,
} from "@/lib/ai/providers";
import { DEFAULT_SKILLS, SKILL_GROUPS, type SkillToggles } from "@/lib/ai/skills";
import { THEME_LABEL, THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";
import { useSettings } from "@/store/settings";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/** 섹션 제목 — 모달 안에서 한 계층만 쓴다. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-subhead text-ink">{children}</h3>;
}

/** 라벨 + 입력 한 벌. 라벨은 12px 로 입력 바로 위에 붙는다. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption text-ink-muted">{label}</span>
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
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
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
  const [skills, setSkills] = useState<SkillToggles>(settings.skills ?? DEFAULT_SKILLS);
  const [subagentModelId, setSubagentModelId] = useState(settings.subagentModelId);
  const [subagentMaxSteps, setSubagentMaxSteps] = useState(settings.subagentMaxSteps);
  const [useProjectInstructions, setUseProjectInstructions] = useState(
    settings.useProjectInstructions,
  );

  // 클라우드 카탈로그 + 로컬 서버가 실제로 갖고 있는 태그
  const modelOptions = useMemo(
    () => buildModelOptions(settings.localModels),
    [settings.localModels],
  );

  // 모달을 열 때마다 스토어 값으로 폼을 초기화한다.
  useEffect(() => {
    if (!open) return;
    setAnthropicKey(settings.anthropicApiKey ?? "");
    setOpenaiKey(settings.openaiApiKey ?? "");
    setLocalBaseUrl(settings.localBaseUrl || DEFAULT_LOCAL_BASE_URL);
    setLocalApiKey(settings.localApiKey ?? "");
    setProbe({ state: "idle", message: "" });
    setSystemPrompt(settings.systemPrompt);
    setEffort(settings.effort);
    setMaxSteps(settings.maxSteps);
    setSkills(settings.skills ?? DEFAULT_SKILLS);
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
      anthropicApiKey: anthropicKey.trim(),
      openaiApiKey: openaiKey.trim(),
      localBaseUrl: localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL,
      localApiKey: localApiKey.trim(),
      systemPrompt,
      modelId: resolvedModel || settings.modelId,
      effort,
      maxSteps,
      skills,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-hairline bg-canvas elevate-lg"
        onClick={(event) => event.stopPropagation()}
      >
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

        {/* 섹션은 헤어라인 한 줄로만 갈린다. */}
        <div className="min-h-0 flex-1 divide-y divide-hairline overflow-auto">
          <section className="space-y-3 p-6">
            <SectionTitle>화면</SectionTitle>
            <Field label="테마">
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
            <Help>
              고르는 즉시 적용되고 저장됩니다 ([저장] 을 누르지 않아도 됩니다).
            </Help>
          </section>

          <section className="space-y-3 p-6">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle>API 키</SectionTitle>
              <button
                className="text-caption text-accent hover:underline"
                onClick={() => setRevealKeys((value) => !value)}
              >
                {revealKeys ? "가리기" : "보기"}
              </button>
            </div>
            <Field label="Anthropic">
              <input
                type={revealKeys ? "text" : "password"}
                value={anthropicKey}
                onChange={(event) => setAnthropicKey(event.target.value)}
                placeholder="sk-ant-..."
                className={`${FIELD} font-mono`}
              />
            </Field>
            <Field label="OpenAI">
              <input
                type={revealKeys ? "text" : "password"}
                value={openaiKey}
                onChange={(event) => setOpenaiKey(event.target.value)}
                placeholder="sk-..."
                className={`${FIELD} font-mono`}
              />
            </Field>
            {settings.settingsPath && (
              <Help>
                <span className="font-mono break-all">저장 위치: {settings.settingsPath}</span>{" "}
                (평문 JSON — 이 PC 안에만 있습니다)
              </Help>
            )}
          </section>

          <section className="space-y-3 p-6">
            <SectionTitle>모델</SectionTitle>
            <select
              value={modelId}
              onChange={(event) => {
                const nextId = event.target.value;
                setModelId(nextId);
                // 권장 사고 강도는 모델마다 다르다 — 저장 전에 눈에 보이게 미리 옮겨 준다.
                const recommended = defaultEffortFor(nextId);
                if (recommended) setEffort(recommended);
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
                placeholder="anthropic:claude-opus-5 / local:gpt-oss:20b 형식으로 입력"
                className={`${FIELD} font-mono`}
              />
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="사고 강도 (Anthropic 전용)">
                <select
                  value={effort}
                  onChange={(event) => setEffort(event.target.value as Effort)}
                  className={SELECT}
                >
                  {EFFORTS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="최대 스텝 (도구 루프)">
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
          </section>

          <section className="space-y-3 p-6">
            <SectionTitle>로컬 모델 서버 (Ollama · LM Studio)</SectionTitle>
            <Help>
              이 PC 에서 도는 OpenAI 호환 서버입니다. 키가 필요 없고, 대화 내용이 밖으로 나가지
              않습니다. Ollama 는 <span className="font-mono">http://localhost:11434/v1</span>,
              LM Studio 는 <span className="font-mono">http://localhost:1234/v1</span>.
            </Help>
            <Field label="서버 주소">
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
              <Help>위 드롭다운의 로컬 모델은 여기서 불러온 목록이 전부입니다.</Help>
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
            <Help>
              에이전트는 도구 호출을 많이 쓰므로 컨텍스트를 크게 잡아야 합니다. Ollama 는 기본 4K
              라 <span className="font-mono">OLLAMA_CONTEXT_LENGTH=65536</span> 를 환경 변수로 주고
              서버를 다시 띄우세요.
            </Help>
          </section>

          <section className="space-y-3 p-6">
            <SectionTitle>스킬 (에이전트가 쓸 수 있는 도구)</SectionTitle>
            <Help>
              켜 둔 도구는 확인 없이 바로 실행됩니다. 샌드박스가 아니라 이 PC 의 사용자 권한으로
              동작하니 필요한 것만 켜세요.
            </Help>
            {SKILL_GROUPS.map((group) => (
              <label
                key={group.id}
                className="flex items-start gap-2 rounded-md border border-hairline bg-surface-1 px-3 py-2.5 transition-colors hover:bg-hover"
              >
                <input
                  type="checkbox"
                  checked={skills[group.id]}
                  onChange={(event) =>
                    setSkills((current) => ({ ...current, [group.id]: event.target.checked }))
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
          </section>

          <section className="p-6">
            <McpServers />
          </section>

          <section className="space-y-3 p-6">
            <SectionTitle>서브에이전트</SectionTitle>
            <Help>
              `delegate_task` 로 띄우는 하위 에이전트. 자기 컨텍스트를 따로 갖고, 다시 위임하지는
              못합니다.
            </Help>
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
          </section>

          <section className="space-y-3 p-6">
            <SectionTitle>프로젝트 지침</SectionTitle>
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
          </section>

          <section className="space-y-3 p-6">
            <SectionTitle>시스템 프롬프트</SectionTitle>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={6}
              className={`${FIELD_SM} resize-none`}
            />
          </section>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-hairline px-6 py-4">
          <Button size="md" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" size="md" onClick={() => void save()} disabled={settings.saving}>
            {settings.saving ? "저장 중…" : "저장"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
