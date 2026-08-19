import { useEffect, useState } from "react";

import { McpServers } from "@/components/mcp/McpServers";
import { Button } from "@/components/Panel";
import { MODEL_CATALOG, type Effort } from "@/lib/ai/providers";
import { DEFAULT_SKILLS, SKILL_GROUPS, type SkillToggles } from "@/lib/ai/skills";
import { useSettings } from "@/store/settings";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const settings = useSettings();
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
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

  // 모달을 열 때마다 스토어 값으로 폼을 초기화한다.
  useEffect(() => {
    if (!open) return;
    setAnthropicKey(settings.anthropicApiKey ?? "");
    setOpenaiKey(settings.openaiApiKey ?? "");
    setSystemPrompt(settings.systemPrompt);
    setEffort(settings.effort);
    setMaxSteps(settings.maxSteps);
    setSkills(settings.skills ?? DEFAULT_SKILLS);
    setSubagentModelId(settings.subagentModelId);
    setSubagentMaxSteps(settings.subagentMaxSteps);
    setUseProjectInstructions(settings.useProjectInstructions);

    const known = MODEL_CATALOG.some((option) => option.id === settings.modelId);
    setModelId(known ? settings.modelId : "custom");
    setCustomModel(known ? "" : settings.modelId);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function save() {
    const resolvedModel = modelId === "custom" ? customModel.trim() : modelId;
    await settings.update({
      anthropicApiKey: anthropicKey.trim(),
      openaiApiKey: openaiKey.trim(),
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-200">설정</h2>
          <button className="text-zinc-500 hover:text-zinc-200" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-xs">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-300">API 키</h3>
              <button
                className="text-[10px] text-zinc-500 hover:text-zinc-300"
                onClick={() => setRevealKeys((value) => !value)}
              >
                {revealKeys ? "가리기" : "보기"}
              </button>
            </div>
            <label className="block">
              <span className="text-zinc-500">Anthropic</span>
              <input
                type={revealKeys ? "text" : "password"}
                value={anthropicKey}
                onChange={(event) => setAnthropicKey(event.target.value)}
                placeholder="sk-ant-..."
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-zinc-100"
              />
            </label>
            <label className="block">
              <span className="text-zinc-500">OpenAI</span>
              <input
                type={revealKeys ? "text" : "password"}
                value={openaiKey}
                onChange={(event) => setOpenaiKey(event.target.value)}
                placeholder="sk-..."
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-zinc-100"
              />
            </label>
            {settings.settingsPath && (
              <p className="font-mono text-[10px] break-all text-zinc-600">
                저장 위치: {settings.settingsPath} (평문 JSON — 이 PC 안에만 있습니다)
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold text-zinc-300">모델</h3>
            <select
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
            >
              {MODEL_CATALOG.map((option) => (
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
                placeholder="anthropic:claude-opus-5 형식으로 입력"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-zinc-100"
              />
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-zinc-500">사고 강도 (Anthropic 전용)</span>
                <select
                  value={effort}
                  onChange={(event) => setEffort(event.target.value as Effort)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                >
                  {EFFORTS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-zinc-500">최대 스텝 (도구 루프)</span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={maxSteps}
                  onChange={(event) => setMaxSteps(Number(event.target.value) || 1)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                />
              </label>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold text-zinc-300">스킬 (에이전트가 쓸 수 있는 도구)</h3>
            <p className="text-[10px] text-zinc-600">
              켜 둔 도구는 확인 없이 바로 실행됩니다. 샌드박스가 아니라 이 PC 의 사용자 권한으로
              동작하니 필요한 것만 켜세요.
            </p>
            {SKILL_GROUPS.map((group) => (
              <label
                key={group.id}
                className="flex items-start gap-2 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={skills[group.id]}
                  onChange={(event) =>
                    setSkills((current) => ({ ...current, [group.id]: event.target.checked }))
                  }
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-zinc-200">{group.label}</span>
                  <span className="ml-2 font-mono text-[10px] break-all text-zinc-600">
                    {group.tools.join(", ")}
                  </span>
                </span>
              </label>
            ))}
          </section>

          <McpServers />

          <section className="space-y-2">
            <h3 className="font-semibold text-zinc-300">서브에이전트</h3>
            <p className="text-[10px] text-zinc-600">
              `delegate_task` 로 띄우는 하위 에이전트. 자기 컨텍스트를 따로 갖고, 다시 위임하지는
              못합니다.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-zinc-500">모델</span>
                <select
                  value={subagentModelId}
                  onChange={(event) => setSubagentModelId(event.target.value)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                >
                  <option value="">메인 모델과 동일</option>
                  {MODEL_CATALOG.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-zinc-500">스텝 예산 (1명당)</span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={subagentMaxSteps}
                  onChange={(event) => setSubagentMaxSteps(Number(event.target.value) || 1)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                />
              </label>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold text-zinc-300">프로젝트 지침</h3>
            <label className="flex items-start gap-2 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
              <input
                type="checkbox"
                checked={useProjectInstructions}
                onChange={(event) => setUseProjectInstructions(event.target.checked)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="text-zinc-200">프로젝트 루트의 AGENTS.md 자동 로드</span>
                <span className="mt-0.5 block text-[10px] text-zinc-600">
                  파일이 있으면 매 턴 컨텍스트 맨 앞에 원문을 싣습니다. 서브에이전트에게도 같은
                  지침이 전달됩니다.
                </span>
              </span>
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold text-zinc-300">시스템 프롬프트</h3>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={6}
              className="w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
            />
          </section>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => void save()} disabled={settings.saving}>
            {settings.saving ? "저장 중…" : "저장"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
