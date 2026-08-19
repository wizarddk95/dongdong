/**
 * 사용자 단위 설정 (API 키, 기본 모델, 시스템 프롬프트).
 * Rust 의 `settings.json` 과 동기화된다.
 */
import { create } from "zustand";

import * as ipc from "@/lib/ipc";
import type { McpServerConfig } from "@/types/ipc";
import { DEFAULT_MODEL_ID, type Effort, type ProviderCredentials } from "@/lib/ai/providers";
import { DEFAULT_SKILLS, type SkillToggles } from "@/lib/ai/skills";

export const DEFAULT_SYSTEM_PROMPT = `당신은 사용자의 로컬 머신에서 동작하는 코딩 에이전트입니다.
- 답변은 한국어로, 간결하고 구체적으로 합니다.
- 코드를 제시할 때는 파일 경로를 함께 밝힙니다.
- 확실하지 않은 것은 추측하지 말고 모른다고 말합니다.`;

interface SettingsState extends ProviderCredentials {
  modelId: string;
  systemPrompt: string;
  effort: Effort;
  maxSteps: number;
  /** 프로젝트 루트의 AGENTS.md 를 컨텍스트 맨 앞에 자동으로 싣는다 */
  useProjectInstructions: boolean;
  /** 에이전트에게 열어 줄 스킬 묶음 */
  skills: SkillToggles;
  /** 서브에이전트가 쓸 모델. 비우면 메인 모델과 같다. */
  subagentModelId: string;
  /** 서브에이전트 한 명의 스텝 예산 */
  subagentMaxSteps: number;
  /** MCP 서버 실행 설정 목록 */
  mcpServers: McpServerConfig[];

  settingsPath: string | null;
  loaded: boolean;
  saving: boolean;

  load: () => Promise<void>;
  update: (patch: Partial<PersistedSettings>) => Promise<void>;
  credentials: () => ProviderCredentials;
}

/** 디스크에 저장되는 필드만 추린 타입. */
type PersistedSettings = Pick<
  SettingsState,
  | "anthropicApiKey"
  | "openaiApiKey"
  | "anthropicBaseUrl"
  | "openaiBaseUrl"
  | "modelId"
  | "systemPrompt"
  | "effort"
  | "maxSteps"
  | "useProjectInstructions"
  | "skills"
  | "subagentModelId"
  | "subagentMaxSteps"
  | "mcpServers"
>;

const PERSISTED_KEYS: (keyof PersistedSettings)[] = [
  "anthropicApiKey",
  "openaiApiKey",
  "anthropicBaseUrl",
  "openaiBaseUrl",
  "modelId",
  "systemPrompt",
  "effort",
  "maxSteps",
  "useProjectInstructions",
  "skills",
  "subagentModelId",
  "subagentMaxSteps",
  "mcpServers",
];

function pickPersisted(state: SettingsState): PersistedSettings {
  const out = {} as Record<string, unknown>;
  for (const key of PERSISTED_KEYS) {
    const value = state[key];
    if (value !== undefined) out[key] = value;
  }
  return out as PersistedSettings;
}

export const useSettings = create<SettingsState>((set, get) => ({
  anthropicApiKey: "",
  openaiApiKey: "",
  anthropicBaseUrl: "",
  openaiBaseUrl: "",
  modelId: DEFAULT_MODEL_ID,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  effort: "high",
  maxSteps: 8,
  useProjectInstructions: true,
  skills: DEFAULT_SKILLS,
  subagentModelId: "",
  subagentMaxSteps: 12,
  mcpServers: [],

  settingsPath: null,
  loaded: false,
  saving: false,

  load: async () => {
    try {
      const [stored, path] = await Promise.all([ipc.readAppSettings(), ipc.appSettingsPath()]);
      const persisted = stored as Partial<SettingsState>;
      set({
        ...persisted,
        // 새 스킬이 추가돼도 예전 settings.json 이 덮어쓰지 않도록 기본값 위에 병합한다.
        skills: { ...DEFAULT_SKILLS, ...(persisted.skills ?? {}) },
        mcpServers: persisted.mcpServers ?? [],
        settingsPath: path,
        loaded: true,
      });
    } catch {
      // 설정을 못 읽어도 앱은 떠야 한다. 기본값으로 계속 진행.
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    set({ ...patch, saving: true });
    try {
      await ipc.writeAppSettings(pickPersisted(get()) as unknown as Record<string, unknown>);
    } finally {
      set({ saving: false });
    }
  },

  credentials: () => {
    const state = get();
    return {
      anthropicApiKey: state.anthropicApiKey,
      openaiApiKey: state.openaiApiKey,
      anthropicBaseUrl: state.anthropicBaseUrl || undefined,
      openaiBaseUrl: state.openaiBaseUrl || undefined,
    };
  },
}));
