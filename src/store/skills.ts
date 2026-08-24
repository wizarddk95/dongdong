/**
 * 디스크에 있는 스킬 문서.
 *
 * 켜고 끄는 토글은 사용자 설정이라 `store/settings.ts`(settings.json)가 갖고,
 * 여기서는 "지금 디스크에 무엇이 있는가" 만 들고 있는다.
 * 파일은 대화 중에도 바뀐다(에이전트가 직접 쓰기도 한다) → 턴마다 다시 읽는다.
 */
import { create } from "zustand";

import { errorMessage } from "@/lib/ai/errors";
import { skillTemplate } from "@/lib/ai/builtinSkills";
import { enabledSkills, mergeSkills, type SkillDoc } from "@/lib/ai/skills";
import * as ipc from "@/lib/ipc";
import { useSettings } from "@/store/settings";
import type { SkillDirs, SkillFile } from "@/types/ipc";

interface SkillsState {
  files: SkillFile[];
  dirs: SkillDirs | null;
  loading: boolean;
  /** 마지막 읽기 실패. 스킬을 못 읽었다고 턴을 막지는 않는다. */
  error: string | null;

  /**
   * 디스크를 다시 읽는다. **던지지 않는다** — 턴을 시작할 때마다 도는 경로라
   * 여기서 실패가 새어 나가면 스킬 파일 하나 때문에 대화가 멈춘다.
   */
  refresh: () => Promise<void>;
  /** 내장 + 디스크를 합친 전체 목록 (설정 화면용) */
  all: () => SkillDoc[];
  /** 그중 켜져 있는 것만 (에이전트에게 실리는 목록) */
  enabled: () => SkillDoc[];
  create: (name: string, scope: "user" | "project") => Promise<string>;
  /**
   * 스킬 문서 원문을 통째로 고쳐 쓴다 — frontmatter 를 포함한 **파일 전체**다.
   * 본문만 받으면 저장할 때마다 머리말을 다시 붙여야 하고, 그 조립이 파싱과 어긋나는 순간
   * 사람이 적은 description 이 조용히 사라진다.
   */
  save: (path: string, content: string) => Promise<void>;
  remove: (skill: SkillDoc) => Promise<void>;
}

export const useSkills = create<SkillsState>((set, get) => ({
  files: [],
  dirs: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const [files, dirs] = await Promise.all([ipc.listSkillFiles(), ipc.skillDirs()]);
      set({ files, dirs, error: null });
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ loading: false });
    }
  },

  all: () => mergeSkills(get().files),

  enabled: () => enabledSkills(get().all(), useSettings.getState().skillsEnabled),

  create: async (name, scope) => {
    const path = await ipc.createSkillFile(name, scope, skillTemplate(name.trim()));
    await get().refresh();
    return path;
  },

  save: async (path, content) => {
    await ipc.writeSkillFile(path, content);
    await get().refresh();
  },

  remove: async (skill) => {
    // 내장 스킬은 파일이 없다 — 지우는 대신 설정에서 끈다.
    if (!skill.path) {
      await useSettings.getState().update({
        skillsEnabled: { ...useSettings.getState().skillsEnabled, [skill.name]: false },
      });
      return;
    }
    await ipc.deleteSkillFile(skill.path);
    await get().refresh();
  },
}));
