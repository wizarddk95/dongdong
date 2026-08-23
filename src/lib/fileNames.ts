/**
 * 새로 만들 파일·폴더 이름 판정(순수).
 *
 * 진짜 담장은 Rust 의 `resolve_within()` 이다. 여기는 그 **앞에서** 실수를 걸러 내고,
 * 무엇보다 **왜 안 되는지를 화면에서 말해 주기 위한** 자다 — 판정과 문구가 같은 자리에서
 * 나와야 "만들기를 눌렀는데 아무 일도 안 일어난다" 가 되지 않는다.
 *
 * 규칙은 윈도우 기준으로 잡는다. 프로젝트는 OS 를 오가는데 리눅스에서 만든 `a:b` 하나가
 * 윈도우에서는 아예 열리지 않는 파일이 된다.
 */

/** 이름이 걸린 이유. 문구는 `lib/i18n` 이 지고 여기서는 종류만 정한다. */
export type NameProblem = "empty" | "separator" | "chars" | "reserved" | "duplicate";

/** 윈도우가 파일 이름에 못 쓰는 글자(경로 구분자는 따로 가른다 — 안내 문구가 다르다). */
const FORBIDDEN_CHARS = /[<>:"|?*]/;

/** 제어문자 검사. 붙여넣기로 흘러들면 눈에 안 보이는 채로 이름에 박힌다. */
function hasControlChar(name: string): boolean {
  return [...name].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** 윈도우 예약 장치 이름 — 확장자를 붙여도 여전히 못 쓴다(`con.txt`). */
const RESERVED_DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 이름을 검사한다. 통과하면 `null`.
 *
 * `existing` 은 지금 폴더에 이미 있는 이름들이다. **대소문자를 접어서** 비교한다 —
 * 윈도우에서 `README.md` 와 `readme.md` 는 같은 파일이라, 다른 이름인 줄 알고 만들면
 * 기존 파일을 통째로 덮어쓴다.
 */
export function entryNameProblem(raw: string, existing: readonly string[] = []): NameProblem | null {
  const name = raw.trim();
  if (!name) return "empty";

  // 구분자를 허용하면 "현재 폴더에 만든다" 는 약속이 깨지고, 중복 검사도 헛돈다.
  if (name.includes("/") || name.includes("\\")) return "separator";
  if (FORBIDDEN_CHARS.test(name) || hasControlChar(name)) return "chars";
  if (name === "." || name === "..") return "reserved";
  // 윈도우는 끝의 점·공백을 조용히 떼어 낸다 → 만든 이름과 생긴 이름이 달라진다.
  if (/[. ]$/.test(name)) return "reserved";
  if (RESERVED_DEVICES.test(name)) return "reserved";

  const lower = name.toLowerCase();
  if (existing.some((entry) => entry.trim().toLowerCase() === lower)) return "duplicate";
  return null;
}

/**
 * 지금 보고 있는 폴더(`cwd`) 아래의 상대 경로. `.` 과 빈 문자열은 프로젝트 루트다.
 * 목록·읽기와 같은 모양(슬래시 구분)으로 만들어야 IPC 가 그대로 받는다.
 */
export function joinRelative(cwd: string, name: string): string {
  const base = cwd === "." || cwd === "" ? "" : `${cwd.replace(/[\\/]+$/, "")}/`;
  return `${base}${name.trim()}`;
}
