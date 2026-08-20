import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/Panel";
import { buildModelOptions, hasCredentialFor, parseModelId } from "@/lib/ai/providers";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

interface TopBarProps {
  onOpenSettings: () => void;
}

export function TopBar({ onOpenSettings }: TopBarProps) {
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
      ? "로컬 서버로 호출합니다 (키 불필요)"
      : hasKey
        ? `${provider} 키가 설정되어 있습니다`
        : `${provider} 키가 없습니다`;

  async function pickFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "프로젝트 폴더 선택",
    });
    if (typeof selected === "string") await openProject(selected);
  }

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-sm font-semibold text-emerald-400">dongdong</span>
        <Button variant="primary" onClick={pickFolder} disabled={loading}>
          폴더 열기
        </Button>
        {project && (
          <Button onClick={() => void closeProject()} disabled={loading}>
            닫기
          </Button>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {project ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs text-zinc-200">
              {project.name}
              <span className="ml-2 font-mono text-[11px] text-zinc-500">{project.rootPath}</span>
            </span>
            <span className="truncate font-mono text-[10px] text-zinc-600">
              {dbPath} · schema v{schemaVersion}
            </span>
          </div>
        ) : (
          <span className="text-xs text-zinc-500">열린 프로젝트가 없습니다.</span>
        )}
      </div>

      {/* 모델 빠른 전환 — 상세 설정은 모달에서 */}
      <div className="flex items-center gap-1.5">
        <select
          value={known ? modelId : "custom"}
          onChange={(event) => {
            if (event.target.value !== "custom") {
              void updateSettings({ modelId: event.target.value });
            }
          }}
          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
        >
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          {!known && <option value="custom">{modelId} (직접 입력)</option>}
        </select>
        <span
          title={readyHint}
          className={`text-[10px] ${hasKey ? "text-emerald-400" : "text-amber-400"}`}
        >
          {hasKey ? "●" : "○"}
        </span>
      </div>

      {system && (
        <span className="hidden font-mono text-[10px] text-zinc-500 xl:inline">
          {system.os}/{system.arch}
        </span>
      )}

      <Button onClick={onOpenSettings}>설정</Button>
    </header>
  );
}
