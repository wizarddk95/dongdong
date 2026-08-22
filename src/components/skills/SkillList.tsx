/**
 * 스킬 목록 관리 — 켜고 끄기 · 새로 만들기 · 지우기 · 본문 들여다보기.
 *
 * 토글과 파일은 **즉시 저장**된다(MCP 목록과 같은 규칙). 설정 모달의 [저장]은
 * 폼 입력(키·모델·프롬프트)만 책임진다 — 목록형 UI 까지 저장 버튼에 묶으면
 * "추가했는데 왜 안 보이지" 가 반드시 생긴다.
 */
import { useEffect, useMemo, useState } from "react";

import { Button, Disclosure, FIELD_SM, SELECT_SM, Tag } from "@/components/Panel";
import { SKILL_SOURCE_LABEL_KEY, mergeSkills, type SkillDoc } from "@/lib/ai/skills";
import { useSettings } from "@/store/settings";
import { t } from "@/lib/i18n";
import { useSkills } from "@/store/skills";
import { useWorkspace } from "@/store/workspace";

export function SkillList() {
  // 셀렉터에서 목록을 만들면(`all()`) 렌더마다 새 배열이 나와 구독이 계속 깨진다
  // → 원본(files)만 구독하고 병합은 useMemo 로 한다.
  const files = useSkills((state) => state.files);
  const skills = useMemo(() => mergeSkills(files), [files]);
  const dirs = useSkills((state) => state.dirs);
  const loading = useSkills((state) => state.loading);
  const loadError = useSkills((state) => state.error);
  const refresh = useSkills((state) => state.refresh);
  const create = useSkills((state) => state.create);
  const remove = useSkills((state) => state.remove);

  const skillsEnabled = useSettings((state) => state.skillsEnabled);
  const update = useSettings((state) => state.update);
  const hasProject = useWorkspace((state) => Boolean(state.project));

  const [openName, setOpenName] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(skill: SkillDoc, enabled: boolean) {
    await update({ skillsEnabled: { ...skillsEnabled, [skill.name]: enabled } });
  }

  async function add() {
    const name = draftName.trim();
    if (!name) return;
    setError(null);
    try {
      await create(name, scope);
      setDraftName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function drop(skill: SkillDoc) {
    const question = skill.path
      ? t("skills.confirmDelete", { name: skill.name, path: skill.path })
      : t("skills.confirmDisable", { name: skill.name });
    if (!window.confirm(question)) return;
    setError(null);
    try {
      await remove(skill);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder={t("skills.namePlaceholder")}
          className={`${FIELD_SM} min-w-0 flex-1`}
        />
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as "user" | "project")}
          className={`${SELECT_SM} w-32 shrink-0`}
          title={t("skills.scopeHint")}
        >
          <option value="user">{t("skill.source.global")}</option>
          <option value="project" disabled={!hasProject}>
            {t("skill.source.project")}
          </option>
        </select>
        <Button onClick={() => void add()} disabled={!draftName.trim()}>
          {t("skills.add")}
        </Button>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? t("skills.reading") : t("common.refresh")}
        </Button>
      </div>

      {(error || loadError) && (
        <p className="rounded-md border-l-2 border-error bg-error-subtle px-3 py-2 text-caption break-all text-ink">
          {error ?? loadError}
        </p>
      )}

      <div className="space-y-1.5">
        {skills.map((skill) => {
          const enabled = skillsEnabled[skill.name] !== false;
          return (
            <div
              key={skill.name}
              className="rounded-md border border-hairline bg-surface-1 px-3 py-2.5"
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => void toggle(skill, event.target.checked)}
                  title={t("skills.toggleHint")}
                  className="mt-1 accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-body-sm text-ink">{skill.name}</span>
                    <Tag tone={skill.source === "builtin" ? "neutral" : "accent"}>
                      {t(SKILL_SOURCE_LABEL_KEY[skill.source])}
                    </Tag>
                    {skill.truncated && <Tag tone="warning">{t("skills.truncated")}</Tag>}
                  </div>
                  <p className="mt-0.5 text-caption text-ink-muted">
                    {skill.description || t("skills.noDescription")}
                  </p>
                  {skill.path && (
                    <p className="mt-0.5 truncate font-mono text-caption text-ink-subtle">
                      {skill.path}
                    </p>
                  )}
                </div>
                <button
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-caption text-ink-subtle transition-colors hover:bg-hover hover:text-ink"
                  onClick={() => setOpenName((current) => (current === skill.name ? null : skill.name))}
                >
                  {openName === skill.name ? t("skills.hideBody") : t("skills.showBody")}
                </button>
                <button
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-caption text-ink-subtle transition-colors hover:bg-hover hover:text-error"
                  title={skill.path ? t("skills.deleteFile") : t("skills.builtinOnlyToggle")}
                  onClick={() => void drop(skill)}
                >
                  ✕
                </button>
              </div>

              {openName === skill.name && (
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-canvas p-2.5 font-mono text-caption whitespace-pre-wrap text-ink-muted">
                  {skill.body}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      <Disclosure
        open={openName === "__dirs__"}
        onToggle={() => setOpenName((current) => (current === "__dirs__" ? null : "__dirs__"))}
        title={t("skills.dirsTitle")}
        summary={t("skills.fileCount", {
          count: skills.filter((skill) => skill.source !== "builtin").length,
        })}
      >
        <div className="space-y-2 text-caption text-ink-muted">
          <p>
            <span className="text-ink">{t("skill.source.global")}</span> —{" "}
            {t("skills.globalHint")}
            <span className="mt-0.5 block font-mono break-all text-ink-subtle">
              {dirs?.user ?? t("skills.dirUnknown")}
            </span>
          </p>
          <p>
            <span className="text-ink">{t("skill.source.project")}</span> —{" "}
            {t("skills.projectHint")}
            <span className="mt-0.5 block font-mono break-all text-ink-subtle">
              {dirs?.project ?? t("skills.dirNoProject")}
            </span>
          </p>
          <p>{t("skills.layoutHint")}</p>
        </div>
      </Disclosure>
    </div>
  );
}
