import { open } from "@tauri-apps/plugin-dialog";

import { Button, SELECT_SM } from "@/components/Panel";
import { buildModelOptions, hasCredentialFor, modelLabel, parseModelId } from "@/lib/ai/providers";
import { useT } from "@/lib/i18n/useT";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

interface TopBarProps {
  onOpenSettings: () => void;
}

/**
 * 상단 크롬 두 줄.
 * 위: 유틸리티 바(32px, surface-1) 에 프로젝트 경로·DB 같은 메타.
 * 아래: 내비(48px, canvas) 에 제품명과 실제로 누르는 것들.
 */
export function TopBar({ onOpenSettings }: TopBarProps) {
  const t = useT();
  const { project, dbPath, schemaVersion, system, loading, openProject, closeProject } =
    useWorkspace();
  const modelId = useSettings((state) => state.modelId);
  const updateSettings = useSettings((state) => state.update);
  const credentials = useSettings((state) => state.credentials);
  const localModels = useSettings((state) => state.localModels);

  const modelOptions = buildModelOptions(localModels);
  const known = modelOptions.some((option) => option.id === modelId);
  const hasKey = hasCredentialFor(modelId, credentials());
  const provider = parseModelId(modelId).provider;
  // 로컬 서버는 키를 안 쓰므로 "준비됨" 의 의미가 다르다.
  const readyHint =
    provider === "local"
      ? t("topbar.localNoKey")
      : hasKey
        ? t("topbar.keyPresent", { provider })
        : t("topbar.keyMissing", { provider });

  async function pickFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("topbar.pickFolder"),
    });
    if (typeof selected === "string") await openProject(selected);
  }

  return (
    <header className="shrink-0">
      {/* 유틸리티 바 — 항상 거기 있지만 읽으라고 재촉하지 않는 정보 */}
      <div className="flex h-8 items-center gap-3 border-b border-hairline bg-surface-1 px-4 text-caption text-ink-muted">
        {project ? (
          <>
            <span className="shrink-0 text-ink">{project.name}</span>
            <span className="min-w-0 truncate font-mono">{project.rootPath}</span>
            <span className="ml-auto hidden min-w-0 shrink truncate font-mono lg:inline">
              {dbPath} · schema v{schemaVersion}
            </span>
          </>
        ) : (
          <span>{t("topbar.noProject")}</span>
        )}
        {system && (
          <span className="ml-auto hidden shrink-0 font-mono xl:inline">
            {system.os}/{system.arch}
          </span>
        )}
      </div>

      {/* 내비 — 48px */}
      <div className="flex h-12 items-center gap-3 border-b border-hairline bg-canvas px-4">
        <span className="shrink-0 text-body-emphasis text-ink">dongdong</span>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="primary" onClick={pickFolder} disabled={loading}>
            {t("topbar.openFolder")}
          </Button>
          {project && (
            <Button variant="ghost" onClick={() => void closeProject()} disabled={loading}>
              {t("common.close")}
            </Button>
          )}
        </div>

        {/* 모델 빠른 전환 — 상세 설정은 모달에서 */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <select
            value={known ? modelId : "custom"}
            onChange={(event) => {
              if (event.target.value !== "custom") {
                void updateSettings({ modelId: event.target.value });
              }
            }}
            className={`${SELECT_SM} w-auto max-w-64`}
          >
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {modelLabel(option)}
              </option>
            ))}
            {!known && <option value="custom">{t("topbar.customModel", { modelId })}</option>}
          </select>
          {/*
           * 키 유무는 색만으로 말하지 않는다 — 채운 원/빈 원의 모양 차이가 먼저 읽히고
           * 색(초록/노랑)은 거들기만 한다.
           */}
          <span
            title={readyHint}
            aria-label={readyHint}
            className={`shrink-0 text-caption ${hasKey ? "text-success" : "text-warning"}`}
          >
            {hasKey ? "●" : "○"}
          </span>
        </div>

        <Button variant="ghost" onClick={onOpenSettings}>
          {t("topbar.settings")}
        </Button>
      </div>
    </header>
  );
}
