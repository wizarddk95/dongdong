import { afterEach, describe, expect, it } from "vitest";

import { REDACTED, redact, redactionSecretCount, setRedactionSecrets } from "./redact";
import { clip } from "./tools";

afterEach(() => setRedactionSecrets([]));

describe("setRedactionSecrets", () => {
  it("빈 값과 짧은 값은 등록하지 않는다", () => {
    // `local` 같은 자리채움까지 등록하면 본문에서 그 글자가 전부 사라진다.
    setRedactionSecrets(["", "   ", null, undefined, "local", "short"]);
    expect(redactionSecretCount()).toBe(0);
  });

  it("같은 값을 여러 번 줘도 한 번만 센다", () => {
    setRedactionSecrets(["sk-ant-aaaaaaaaaaaa", " sk-ant-aaaaaaaaaaaa "]);
    expect(redactionSecretCount()).toBe(1);
  });
});

describe("redact", () => {
  it("등록된 키를 본문에서 지운다", () => {
    setRedactionSecrets(["sk-ant-0123456789abcdef"]);
    expect(redact("ANTHROPIC_API_KEY=sk-ant-0123456789abcdef")).toBe(
      `ANTHROPIC_API_KEY=${REDACTED}`,
    );
  });

  it("한 본문에 여러 번 나와도 모두 지운다", () => {
    setRedactionSecrets(["sk-ant-0123456789abcdef"]);
    const out = redact("a sk-ant-0123456789abcdef b sk-ant-0123456789abcdef");
    expect(out).not.toContain("sk-ant-0123456789abcdef");
    expect(out.split(REDACTED)).toHaveLength(3);
  });

  it("접두사가 겹치면 긴 값부터 지워 조각을 남기지 않는다", () => {
    setRedactionSecrets(["sk-abcdefghijkl", "sk-abcdefghijklmnop"]);
    expect(redact("key=sk-abcdefghijklmnop")).toBe(`key=${REDACTED}`);
  });

  it("등록된 값이 없으면 원문 그대로다", () => {
    setRedactionSecrets([]);
    expect(redact("아무 일도 없었다")).toBe("아무 일도 없었다");
  });
});

describe("clip", () => {
  it("도구 출력에서도 키가 지워진다", () => {
    // 도구 출력이 컨텍스트로 들어가는 목은 `clip` 하나뿐이다 — 여기서 새면 DB 와 공급자로 나간다.
    setRedactionSecrets(["sk-ant-0123456789abcdef"]);
    expect(clip("cat settings.json → sk-ant-0123456789abcdef").text).not.toContain("sk-ant-");
  });

  it("자르기보다 가리기가 먼저다 — 경계에 걸린 키가 반쪽으로 남지 않는다", () => {
    const secret = "sk-ant-0123456789abcdef";
    setRedactionSecrets([secret]);
    const head = "x".repeat(10);
    const { text, clipped } = clip(`${head}${secret}`, head.length + 5);
    expect(clipped).toBe(true);
    expect(text).not.toContain("sk-ant-0123");
  });
});

