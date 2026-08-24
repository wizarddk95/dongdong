/**
 * 스킬 목록 관리 — 켜고 끄기 · 새로 만들기 · **본문 고쳐 쓰기** · 지우기.
 *
 * 토글과 파일은 **즉시 저장**된다(MCP 목록과 같은 규칙). 설정 모달의 [저장]은
 * 폼 입력(키·모델·프롬프트)만 책임진다 — 목록형 UI 까지 저장 버튼에 묶으면
 * "추가했는데 왜 안 보이지" 가 반드시 생긴다.
 *
 * **편집기만은 예외로 명시적 [저장]을 둔다** — 절차서는 한 글자 칠 때마다 디스크에
 * 쓸 것이 아니고(모델이 그 사이 `load_skill` 로 반쪽 문서를 읽는다), 실수로 지운
 * 문단을 되돌릴 자리도 있어야 한다.
 */
import { useEffect, useMemo, useState } from "react";

import { Button, Disclosure, FIELD_SM, SELECT_SM, Tag } from "@/components/Panel";
import {
  SKILL_SOURCE_LABEL_KEY,
  mergeSkills,
  skillNameProblem,
  type SkillDoc,
} from "@/lib/ai/skills";
import { useSettings } from "@/store/settings";
import { t } from "@/lib/i18n";
import { useSkills } from "@/store/skills";
import { useWorkspace } from "@/store/workspace";

/** 이름이 걸린 이유 → 화면 문구. 판정은 `lib/fileNames.ts` 가 지고 여기는 문구만 고른다. */
const NAME_PROBLEM_KEY = {
  empty: "skills.nameEmpty",
  separator: "skills.nameSeparator",
  chars: "skills.nameChars",
  reserved: "skills.nameReserved",
  duplicate: "skills.nameDuplicate",
} as const;

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
  const save = useSkills((state) => state.save);
  const remove = useSkills((state) => state.remove);

  const skillsEnabled = useSettings((state) => state.skillsEnabled);
  const update = useSettings((state) => state.update);
  const hasProject = useWorkspace((state) => Boolean(state.project));

  const [openName, setOpenName] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [error, setError] = useState<string | null>(null);

  /** 편집 중인 원문. `null` 이면 아직 손대지 않았다는 뜻이라 디스크 쪽을 그대로 보여준다. */
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 프로젝트를 닫으면 프로젝트 범위로는 만들 수 없다 → 고른 값도 되돌린다.
  // (그대로 두면 [추가]가 "프로젝트가 없습니다" 로만 튕긴다)
  useEffect(() => {
    if (!hasProject) setScope("user");
  }, [hasProject]);

  const nameProblem = draftName.trim() ? skillNameProblem(draftName, skills, scope) : null;

  async function toggle(skill: SkillDoc, enabled: boolean) {
    await update({ skillsEnabled: { ...skillsEnabled, [skill.name]: enabled } });
  }

  async function add() {
    const name = draftName.trim();
    if (!name || nameProblem) return;
    setError(null);
    try {
      await create(name, scope);
      setDraftName("");
      // 만들자마자 편집기를 연다 — 틀만 깔아 두고 닫으면 "이름만 만들 수 있다" 그대로다.
      setDraftBody(null);
      setOpenName(name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * 본문 칸을 연다/닫는다. 열 때마다 편집 버퍼를 비워 디스크 원문에서 다시 시작한다.
   * 버퍼는 한 벌뿐이므로 **고치다 만 문서를 두고 다른 문서를 열면 묻는다** —
   * 아무 말 없이 날리면 방금 쓴 절차가 어디로 갔는지 알 길이 없다.
   */
  function toggleBody(skill: SkillDoc) {
    const editing = skills.find((doc) => doc.name === openName);
    const losing = draftBody !== null && editing !== undefined && draftBody !== editing.raw;
    if (losing && !window.confirm(t("skills.discardEdits", { name: editing.name }))) return;
    setDraftBody(null);
    setOpenName((current) => (current === skill.name ? null : skill.name));
  }

  async function commit(skill: SkillDoc) {
    if (!skill.path || draftBody === null) return;
    setError(null);
    setSaving(true);
    try {
      await save(skill.path, draftBody);
      setDraftBody(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
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
      if (openName === skill.name) {
        setOpenName(null);
        setDraftBody(null);
      }
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
        <Button onClick={() => void add()} disabled={!draftName.trim() || Boolean(nameProblem)}>
          {t("skills.add")}
        </Button>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? t("skills.reading") : t("common.refresh")}
        </Button>
      </div>

      {/* 왜 프로젝트를 고를 수 없는지 글자로 적는다 — 회색으로 잠긴 칸만 두면
          "프로젝트 스킬은 아예 못 만든다" 로 읽힌다. */}
      {!hasProject && <p className="text-caption text-ink-subtle">{t("skills.scopeNoProject")}</p>}
      {nameProblem && (
        <p className="text-caption text-warning">{t(NAME_PROBLEM_KEY[nameProblem])}</p>
      )}

      {(error || loadError) && (
        <p className="rounded-md border-l-2 border-error bg-error-subtle px-3 py-2 text-caption break-all text-ink">
          {error ?? loadError}
        </p>
      )}

      <div className="space-y-1.5">
        {skills.map((skill) => {
          const enabled = skillsEnabled[skill.name] !== false;
          const open = openName === skill.name;
          const editable = Boolean(skill.path);
          const text = draftBody ?? skill.raw;
          const dirty = draftBody !== null && draftBody !== skill.raw;
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
                  onClick={() => toggleBody(skill)}
                >
                  {open
                    ? t("skills.hideBody")
                    : editable
                      ? t("skills.editBody")
                      : t("skills.showBody")}
                </button>
                <button
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-caption text-ink-subtle transition-colors hover:bg-hover hover:text-error"
                  title={skill.path ? t("skills.deleteFile") : t("skills.builtinOnlyToggle")}
                  onClick={() => void drop(skill)}
                >
                  ✕
                </button>
              </div>

              {open &&
                (editable ? (
                  <div className="mt-2 space-y-1.5">
                    <textarea
                      value={text}
                      onChange={(event) => setDraftBody(event.target.value)}
                      spellCheck={false}
                      rows={16}
                      className={`${FIELD_SM} resize-y font-mono leading-relaxed`}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        onClick={() => void commit(skill)}
                        disabled={!dirty || saving}
                      >
                        {saving ? t("skills.saving") : t("common.save")}
                      </Button>
                      <Button variant="ghost" onClick={() => setDraftBody(null)} disabled={!dirty}>
                        {t("skills.revert")}
                      </Button>
                      <span className="text-caption text-ink-subtle">
                        {dirty ? t("skills.unsaved") : t("skills.frontmatterHint")}
                      </span>
                    </div>
                  </div>
                ) : (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-canvas p-2.5 font-mono text-caption whitespace-pre-wrap text-ink-muted">
                    {skill.body}
                  </pre>
                ))}
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
