/**
 * 스킬 목록 관리 — 켜고 끄기 · 새로 만들기 · 지우기 · 본문 들여다보기.
 *
 * 토글과 파일은 **즉시 저장**된다(MCP 목록과 같은 규칙). 설정 모달의 [저장]은
 * 폼 입력(키·모델·프롬프트)만 책임진다 — 목록형 UI 까지 저장 버튼에 묶으면
 * "추가했는데 왜 안 보이지" 가 반드시 생긴다.
 */
import { useEffect, useMemo, useState } from "react";

import { Button, Disclosure, FIELD_SM, SELECT_SM, Tag } from "@/components/Panel";
import { SKILL_SOURCE_LABEL, mergeSkills, type SkillDoc } from "@/lib/ai/skills";
import { useSettings } from "@/store/settings";
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
      ? `스킬 "${skill.name}" 파일을 삭제합니다.\n${skill.path}`
      : `내장 스킬 "${skill.name}" 은 파일이 없어 지울 수 없습니다. 대신 끕니다.`;
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
          placeholder="새 스킬 이름 (예: 사내-보고서-양식)"
          className={`${FIELD_SM} min-w-0 flex-1`}
        />
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as "user" | "project")}
          className={`${SELECT_SM} w-32 shrink-0`}
          title="전역은 모든 프로젝트에서, 프로젝트는 이 리포에서만 보입니다"
        >
          <option value="user">전역</option>
          <option value="project" disabled={!hasProject}>
            프로젝트
          </option>
        </select>
        <Button onClick={() => void add()} disabled={!draftName.trim()}>
          + 추가
        </Button>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? "읽는 중…" : "새로고침"}
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
                  title="끄면 목록에서 빠져 모델이 이 스킬을 보지 못합니다"
                  className="mt-1 accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-body-sm text-ink">{skill.name}</span>
                    <Tag tone={skill.source === "builtin" ? "neutral" : "accent"}>
                      {SKILL_SOURCE_LABEL[skill.source]}
                    </Tag>
                    {skill.truncated && <Tag tone="warning">잘림</Tag>}
                  </div>
                  <p className="mt-0.5 text-caption text-ink-muted">
                    {skill.description || "(설명이 없습니다 — frontmatter 에 description 을 적으세요)"}
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
                  {openName === skill.name ? "본문 닫기" : "본문"}
                </button>
                <button
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-caption text-ink-subtle transition-colors hover:bg-hover hover:text-error"
                  title={skill.path ? "파일 삭제" : "내장 스킬 — 끄기만 됩니다"}
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
        title="스킬 파일을 두는 곳"
        summary={`${skills.filter((skill) => skill.source !== "builtin").length}개 파일`}
      >
        <div className="space-y-2 text-caption text-ink-muted">
          <p>
            <span className="text-ink">전역</span> — 모든 프로젝트에서 보입니다.
            <span className="mt-0.5 block font-mono break-all text-ink-subtle">
              {dirs?.user ?? "(아직 읽지 못했습니다)"}
            </span>
          </p>
          <p>
            <span className="text-ink">프로젝트</span> — 이 리포에서만 보이고 커밋됩니다.
            <span className="mt-0.5 block font-mono break-all text-ink-subtle">
              {dirs?.project ?? "(프로젝트를 열면 표시됩니다)"}
            </span>
          </p>
          <p>
            한 폴더에 <span className="font-mono">&lt;이름&gt;/SKILL.md</span> 를 두거나{" "}
            <span className="font-mono">&lt;이름&gt;.md</span> 파일 하나만 둬도 됩니다. 맨 앞의{" "}
            <span className="font-mono">---</span> 블록에 적은{" "}
            <span className="font-mono">description</span> 한 줄만 매 턴 컨텍스트에 실리고, 본문은
            모델이 <span className="font-mono">load_skill</span> 을 부를 때 들어갑니다. 같은 이름이면
            프로젝트 &gt; 전역 &gt; 내장 순으로 이깁니다.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
