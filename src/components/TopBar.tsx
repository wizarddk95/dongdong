import { open } from "@tauri-apps/plugin-dialog";

import { Button, SELECT_SM } from "@/components/Panel";
import type { MessageKey } from "@/lib/i18n";
import { buildModelOptions, hasCredentialFor, modelLabel, parseModelId } from "@/lib/ai/providers";
import { useT } from "@/lib/i18n/useT";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

interface TopBarProps {
  onOpenSettings: () => void;
}

/**
 * 패널 여닫기 토글 — 세션 목록 · 대화 트리.
 *
 * 접힌 패널은 화면에서 사라지므로 **되돌리는 손잡이가 화면에 남아 있어야 한다**
 * (단축키만 남기면 실수로 접은 사람이 앱을 다시 켠다). 지금 열려 있는지는
 * 색이 아니라 아이콘의 채움과 `aria-pressed` 가 말한다.
 */
function PanelToggle({
  open,
  labelKey,
  hintKey,
  side,
  onToggle,
}: {
  open: boolean;
  labelKey: MessageKey;
  hintKey: MessageKey;
  /** 이 패널이 붙어 있는 쪽 — 아이콘의 채워진 칸이 그쪽으로 간다. */
  side: "left" | "right";
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <Button
      variant="ghost"
      aria-pressed={open}
      title={t(hintKey)}
      aria-label={t(hintKey)}
      onClick={onToggle}
      className={open ? "text-ink" : ""}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect
          x="1.75"
          y="2.75"
          width="12.5"
          height="10.5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        {/* 열려 있으면 그쪽 칸이 채워진다 — 색맹에게도 상태가 모양으로 읽힌다. */}
        <rect
          x={side === "left" ? 1.75 : 10.25}
          y="2.75"
          width="4"
          height="10.5"
          rx="1.5"
          fill={open ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
      <span className="hidden lg:inline">{t(labelKey)}</span>
    </Button>
  );
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
  const showSessions = useSettings((state) => state.showSessions);
  const showTree = useSettings((state) => state.showTree);

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

        <div className="flex shrink-0 items-center gap-0.5">
          <PanelToggle
            open={showSessions}
            side="left"
            labelKey="app.toggleSessions"
            hintKey={showSessions ? "app.hideSessionsHint" : "app.showSessionsHint"}
            onToggle={() => void updateSettings({ showSessions: !showSessions })}
          />
          <PanelToggle
            open={showTree}
            side="right"
            labelKey="app.toggleTree"
            hintKey={showTree ? "app.hideTreeHint" : "app.showTreeHint"}
            onToggle={() => void updateSettings({ showTree: !showTree })}
          />
        </div>

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
