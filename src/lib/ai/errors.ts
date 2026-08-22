/**
 * 공급자 에러를 사람이 읽을 수 있는 한 줄로 바꾼다.
 *
 * AI SDK 의 `APICallError.message` 는 대개 상태 문구("Bad Request") 하나뿐이고,
 * **무엇이 잘못됐는지는 `responseBody`** — 공급자가 돌려준 JSON — 에 들어 있다.
 * 그걸 버리면 화면에 "Bad Request" 만 남아 원인을 좁힐 길이 사라진다.
 * (도구를 붙이면 400 은 대부분 메시지 모양 문제라 본문 한 줄이 진단의 전부다)
 */
import { APICallError, RetryError } from "ai";

/** 배너 한 줄에 담을 수 있는 만큼만. 원문은 대개 스택 트레이스까지 붙어 온다. */
const MAX_DETAIL_CHARS = 600;

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= MAX_DETAIL_CHARS ? single : `${single.slice(0, MAX_DETAIL_CHARS)}…`;
}

/**
 * 공급자마다 오류 본문의 모양이 다르다.
 * OpenAI·Gemini 호환 계층은 `{ error: { message } }`, 구글은 그걸 배열로 감싸기도 한다.
 */
function pickMessage(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = pickMessage(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error_description"]) {
    if (typeof record[key] === "string" && record[key].trim()) return (record[key] as string).trim();
  }
  return pickMessage(record.error, depth + 1);
}

/** 응답 본문에서 읽을 만한 문장만 뽑는다. JSON 이 아니면(HTML 오류 페이지 등) 원문 앞부분. */
export function providerDetail(body: string | null | undefined): string | null {
  const text = body?.trim();
  if (!text) return null;
  try {
    const found = pickMessage(JSON.parse(text));
    if (found) return clip(found);
  } catch {
    // JSON 이 아니면 아래에서 원문을 그대로 쓴다.
  }
  return clip(text);
}

/**
 * 공급자 호출 실패면 `HTTP 400: <공급자 메시지>` 로, 아니면 `null`.
 * 재시도 래퍼(`RetryError`)는 벗겨서 마지막 실제 원인을 본다.
 */
export function describeApiError(error: unknown): string | null {
  const cause = RetryError.isInstance(error) ? (error.lastError ?? error) : error;
  if (!APICallError.isInstance(cause)) return null;

  const status = cause.statusCode ? `HTTP ${cause.statusCode}` : "요청 실패";
  const detail = providerDetail(cause.responseBody);
  return `${status}: ${detail ?? cause.message}`;
}

/** 스토어의 에러 배너에 넣을 문구. 공급자 응답이 있으면 그쪽을 우선한다. */
export function errorMessage(error: unknown): string {
  return (
    describeApiError(error) ?? (error instanceof Error ? error.message : String(error))
  );
}
