/**
 * 사용자 단위 설정 (API 키, 기본 모델, 시스템 프롬프트).
 * Rust 의 `settings.json` 과 동기화된다.
 */
import { create } from "zustand";

import * as ipc from "@/lib/ipc";
import type { McpServerConfig } from "@/types/ipc";
import {
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODEL_ID,
  canonicalModelId,
  defaultEffortFor,
  fetchLocalModels,
  resolveEffort,
  type Effort,
  type ProviderCredentials,
} from "@/lib/ai/providers";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "@/lib/ai/approval";
import { setRedactionSecrets } from "@/lib/ai/redact";
import { DEFAULT_TOOLS, type ToolToggles } from "@/lib/ai/tools";
import type { HookConfig } from "@/lib/hooks";
import { DEFAULT_THEME, applyTheme, normalizeTheme, type ThemePreference } from "@/lib/theme";

export const DEFAULT_SYSTEM_PROMPT = `당신은 사용자의 로컬 머신에서 동작하는 코딩 에이전트입니다.
- 답변은 한국어로, 간결하고 구체적으로 합니다.
- 코드를 제시할 때는 파일 경로를 함께 밝힙니다.
- 확실하지 않은 것은 추측하지 말고 모른다고 말합니다.`;

interface SettingsState extends ProviderCredentials {
  modelId: string;
  /** 화면 테마. 실제 적용은 `applyTheme` 가 `<html data-theme>` 에 새긴다. */
  theme: ThemePreference;
  systemPrompt: string;
  effort: Effort;
  maxSteps: number;
  /** 프로젝트 루트의 AGENTS.md 를 컨텍스트 맨 앞에 자동으로 싣는다 */
  useProjectInstructions: boolean;
  /**
   * 지금 시각을 시스템 프롬프트에 싣는다. 안 실으면 모델은 학습 시점을 "지금" 으로
   * 착각해서 최신 정보를 한두 해 전 기준으로 찾는다.
   */
  injectDateTime: boolean;
  /**
   * 셸 실행 권한 모드 — 매번 물을지, 묻지 않고 돌릴지.
   * [항상 허용]으로 쌓이는 규칙은 여기 없다 — **세션 수명**이라 디스크에 남기지 않는다
   * (`store/approvals.ts`).
   */
  shellApproval: ApprovalMode;
  /** 에이전트에게 열어 줄 도구 묶음 */
  tools: ToolToggles;
  /**
   * 스킬 활성 여부 — 키는 스킬 이름이다. 목록에 없으면 켜진 것으로 본다
   * (새 내장 스킬이 추가돼도 예전 settings.json 이 그걸 끄지 않게).
   */
  skillsEnabled: Record<string, boolean>;
  /** 내장 훅 활성 여부 — 키는 훅 id. 목록에 없으면 기본값(`BUILTIN_HOOKS`)을 따른다. */
  builtinHooks: Record<string, boolean>;
  /** 사용자가 등록한 훅 (이벤트 → 셸 명령) */
  hooks: HookConfig[];
  /** 서브에이전트가 쓸 모델. 비우면 메인 모델과 같다. */
  subagentModelId: string;
  /** 서브에이전트 한 명의 스텝 예산 */
  subagentMaxSteps: number;
  /** MCP 서버 실행 설정 목록 */
  mcpServers: McpServerConfig[];
  /**
   * 로컬 서버가 **실제로 갖고 있다고 답한** 모델 태그. 드롭다운의 로컬 항목은 이게 전부다.
   * 서버가 꺼져 있어도 드롭다운이 비지 않게 마지막 목록을 저장해 둔다.
   */
  localModels: string[];

  settingsPath: string | null;
  loaded: boolean;
  saving: boolean;

  load: () => Promise<void>;
  update: (patch: Partial<PersistedSettings>) => Promise<void>;
  /**
   * 로컬 서버에 지금 무엇이 깔려 있는지 다시 묻는다.
   * 실패하면(서버가 꺼져 있음) 던진다 — 직전 목록은 그대로 두는 게 맞다.
   */
  refreshLocalModels: (baseUrl?: string) => Promise<string[]>;
  credentials: () => ProviderCredentials;
}

/** 디스크에 저장되는 필드만 추린 타입. */
type PersistedSettings = Pick<
  SettingsState,
  | "anthropicApiKey"
  | "openaiApiKey"
  | "googleApiKey"
  | "anthropicBaseUrl"
  | "openaiBaseUrl"
  | "googleBaseUrl"
  | "localBaseUrl"
  | "localApiKey"
  | "localModels"
  | "modelId"
  | "theme"
  | "systemPrompt"
  | "effort"
  | "maxSteps"
  | "useProjectInstructions"
  | "injectDateTime"
  | "shellApproval"
  | "tools"
  | "skillsEnabled"
  | "builtinHooks"
  | "hooks"
  | "subagentModelId"
  | "subagentMaxSteps"
  | "mcpServers"
>;

const PERSISTED_KEYS: (keyof PersistedSettings)[] = [
  "anthropicApiKey",
  "openaiApiKey",
  "googleApiKey",
  "anthropicBaseUrl",
  "openaiBaseUrl",
  "googleBaseUrl",
  "localBaseUrl",
  "localApiKey",
  "localModels",
  "modelId",
  "theme",
  "systemPrompt",
  "effort",
  "maxSteps",
  "useProjectInstructions",
  "injectDateTime",
  "shellApproval",
  "tools",
  "skillsEnabled",
  "builtinHooks",
  "hooks",
  "subagentModelId",
  "subagentMaxSteps",
  "mcpServers",
];

/** 옛 키(`skills`)에 담겨 있던 도구 토글. 없으면 `undefined`. */
function legacyTools(stored: Record<string, unknown>): Partial<ToolToggles> | undefined {
  const legacy = stored.skills;
  return legacy && typeof legacy === "object" ? (legacy as Partial<ToolToggles>) : undefined;
}

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
  googleApiKey: "",
  anthropicBaseUrl: "",
  openaiBaseUrl: "",
  googleBaseUrl: "",
  localBaseUrl: DEFAULT_LOCAL_BASE_URL,
  localApiKey: "",
  localModels: [],
  modelId: DEFAULT_MODEL_ID,
  theme: DEFAULT_THEME,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  effort: "high",
  maxSteps: 8,
  useProjectInstructions: true,
  injectDateTime: true,
  // 기본은 "묻는다". 샌드박스가 없는 도구라 무엇을 돌릴지는 사람이 정하는 게 맞다.
  shellApproval: DEFAULT_APPROVAL_MODE,
  tools: DEFAULT_TOOLS,
  skillsEnabled: {},
  builtinHooks: {},
  hooks: [],
  subagentModelId: "",
  subagentMaxSteps: 12,
  mcpServers: [],

  settingsPath: null,
  loaded: false,
  saving: false,

  load: async () => {
    try {
      const [stored, path] = await Promise.all([ipc.readAppSettings(), ipc.appSettingsPath()]);
      const persisted = stored as Partial<SettingsState> & { allowedCommands?: unknown };
      // 옛 키. [항상 허용] 규칙은 세션 수명으로 옮겼으므로 디스크에서 걷어낸다
      // (다음 저장에서 파일에서도 사라진다).
      delete persisted.allowedCommands;
      set({
        ...persisted,
        // 새 도구가 추가돼도 예전 settings.json 이 덮어쓰지 않도록 기본값 위에 병합한다.
        // `skills` 는 옛 이름이다 — 도구와 스킬을 가르면서 `tools` 로 옮겼고,
        // 이미 저장된 설정을 고아로 만들지 않으려고 여기서 한 번 받아 준다.
        tools: { ...DEFAULT_TOOLS, ...(legacyTools(stored) ?? {}), ...(persisted.tools ?? {}) },
        skillsEnabled: persisted.skillsEnabled ?? {},
        // 예전 settings.json 에는 없던 키다. 없으면 안전한 쪽(승인 필요)으로 시작한다.
        shellApproval: persisted.shellApproval === "auto" ? "auto" : DEFAULT_APPROVAL_MODE,
        injectDateTime: persisted.injectDateTime ?? true,
        builtinHooks: persisted.builtinHooks ?? {},
        hooks: persisted.hooks ?? [],
        // 카탈로그에서 id 가 바뀐 모델(예: 날짜 접미사가 붙은 Haiku 4.5)을 되돌린다.
        // 안 하면 드롭다운이 "직접 입력" 으로 떨어지고 모델 능력 조회도 빗나간다.
        modelId: canonicalModelId(persisted.modelId ?? DEFAULT_MODEL_ID),
        subagentModelId: persisted.subagentModelId
          ? canonicalModelId(persisted.subagentModelId)
          : "",
        theme: normalizeTheme(persisted.theme),
        mcpServers: persisted.mcpServers ?? [],
        localBaseUrl: persisted.localBaseUrl || DEFAULT_LOCAL_BASE_URL,
        localModels: persisted.localModels ?? [],
        settingsPath: path,
        loaded: true,
      });
      // 디스크에 적힌 테마가 인라인 스크립트가 미리 깐 캐시와 다를 수 있다 — 여기서 맞춘다.
      applyTheme(get().theme);
      // 저장된 목록은 지난번 스냅샷일 뿐이다. 그 사이 모델을 지웠을 수도 있으니
      // 한 번 다시 물어 실제로 있는 것만 남긴다. 서버가 꺼져 있으면 조용히 넘어간다.
      void get()
        .refreshLocalModels()
        .catch(() => undefined);
    } catch {
      // 설정을 못 읽어도 앱은 떠야 한다. 기본값으로 계속 진행.
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    const next = { ...patch };
    // 모델을 바꾸면 그 모델에 권장되는 사고 강도로 함께 옮긴다.
    // 같은 patch 에 effort 가 들어 있으면(설정 모달의 저장) 사용자가 고른 값이 우선이다.
    if (next.modelId && next.modelId !== get().modelId && next.effort === undefined) {
      const recommended = defaultEffortFor(next.modelId);
      // 권장값이 없으면 지금 강도를 그 모델이 받는 값으로 당겨 둔다. 안 그러면
      // 드롭다운에 없는 값이 저장된 채로 남아 셀렉트가 빈칸처럼 보인다
      // (요청 자체는 `resolveEffort` 가 다시 당기므로 400 은 나지 않는다).
      next.effort = recommended ?? resolveEffort(next.modelId, get().effort) ?? get().effort;
    }
    set({ ...next, saving: true });
    // 저장을 기다리지 않고 바로 칠한다. 디스크가 느려도 클릭이 즉시 반응해야 한다.
    if (next.theme !== undefined) applyTheme(next.theme);
    try {
      await ipc.writeAppSettings(pickPersisted(get()) as unknown as Record<string, unknown>);
    } finally {
      set({ saving: false });
    }
  },

  refreshLocalModels: async (baseUrl) => {
    const url = baseUrl?.trim() || get().localBaseUrl || DEFAULT_LOCAL_BASE_URL;
    const models = await fetchLocalModels(url);
    const state = get();
    // 앱을 띄울 때마다 도는 경로라, 달라진 게 없으면 디스크를 건드리지 않는다.
    const changed =
      url !== state.localBaseUrl ||
      models.length !== state.localModels.length ||
      models.some((model, index) => model !== state.localModels[index]);
    if (changed) await state.update({ localBaseUrl: url, localModels: models });
    return models;
  },

  credentials: () => {
    const state = get();
    return {
      anthropicApiKey: state.anthropicApiKey,
      openaiApiKey: state.openaiApiKey,
      googleApiKey: state.googleApiKey,
      anthropicBaseUrl: state.anthropicBaseUrl || undefined,
      openaiBaseUrl: state.openaiBaseUrl || undefined,
      googleBaseUrl: state.googleBaseUrl || undefined,
      localBaseUrl: state.localBaseUrl || undefined,
      localApiKey: state.localApiKey || undefined,
    };
  },
}));

/**
 * 도구 출력에서 가려야 할 값들. API 키뿐 아니라 **MCP 서버에 넘긴 환경 변수 값**도 넣는다 —
 * 거기에도 토큰을 적어 두는 게 보통이고, `env` 를 그대로 찍는 명령 한 줄이면 되돌아온다.
 */
function secretsOf(state: SettingsState): (string | undefined)[] {
  return [
    state.anthropicApiKey,
    state.openaiApiKey,
    state.googleApiKey,
    state.localApiKey,
    ...state.mcpServers.flatMap((server) => Object.values(server.env ?? {})),
  ];
}

// 설정이 바뀔 때마다 가릴 목록을 갈아 끼운다. 스토어 안에서 부르지 않고 밖에서 구독하는 이유는
// 키를 넣는 길이 `load`·`update` 둘만이 아니기 때문이다 — 어디서 set 하든 여기로 모인다.
useSettings.subscribe((state) => setRedactionSecrets(secretsOf(state)));
