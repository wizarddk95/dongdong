import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { describeApiError, errorMessage, providerDetail } from "@/lib/ai/errors";

function apiError(responseBody: string | undefined, statusCode = 400) {
  return new APICallError({
    message: "Bad Request",
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

describe("providerDetail", () => {
  it("OpenAI 호환 오류 본문에서 메시지만 뽑는다", () => {
    expect(providerDetail('{"error":{"code":400,"message":"invalid tool"}}')).toBe("invalid tool");
  });

  it("구글처럼 배열로 감싼 본문도 벗긴다", () => {
    const body = '[{"error":{"status":"INVALID_ARGUMENT","message":"missing a thought_signature"}}]';
    expect(providerDetail(body)).toBe("missing a thought_signature");
  });

  it("JSON 이 아니면 원문 앞부분을 쓰고 줄바꿈은 접는다", () => {
    expect(providerDetail("<html>\n  boom\n</html>")).toBe("<html> boom </html>");
  });

  it("길면 잘라 낸다", () => {
    const detail = providerDetail(JSON.stringify({ error: { message: "가".repeat(900) } }));
    expect(detail).toHaveLength(601);
    expect(detail?.endsWith("…")).toBe(true);
  });

  it("비어 있으면 null", () => {
    expect(providerDetail(undefined)).toBeNull();
    expect(providerDetail("   ")).toBeNull();
  });
});

describe("describeApiError", () => {
  it("상태 코드와 공급자 메시지를 함께 보여 준다", () => {
    expect(describeApiError(apiError('{"error":{"message":"invalid tool"}}'))).toBe(
      "HTTP 400: invalid tool",
    );
  });

  it("본문이 없으면 SDK 메시지로 물러난다", () => {
    expect(describeApiError(apiError(undefined))).toBe("HTTP 400: Bad Request");
  });

  it("재시도 래퍼는 벗겨서 마지막 원인을 본다", () => {
    const inner = apiError('{"error":{"message":"rate limited"}}', 429);
    const wrapped = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner],
    });
    expect(describeApiError(wrapped)).toBe("HTTP 429: rate limited");
  });

  it("공급자 호출 실패가 아니면 null", () => {
    expect(describeApiError(new Error("그냥 에러"))).toBeNull();
  });
});

describe("errorMessage", () => {
  it("공급자 응답이 있으면 그쪽을 쓴다", () => {
    expect(errorMessage(apiError('{"error":{"message":"invalid tool"}}'))).toBe(
      "HTTP 400: invalid tool",
    );
  });

  it("평범한 에러는 message 를 그대로", () => {
    expect(errorMessage(new Error("키가 없습니다"))).toBe("키가 없습니다");
    expect(errorMessage("문자열")).toBe("문자열");
  });
});
