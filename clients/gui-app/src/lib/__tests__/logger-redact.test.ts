import { describe, expect, it } from "vitest";
import { redactLogText } from "../logger";

describe("redactLogText", () => {
  it.each([
    ["OPENAI_API_KEY=sk-x", "sk-x"],
    ["GITHUB_TOKEN=ghp_x", "ghp_x"],
    ['{"api_key":"sk-x"}', "sk-x"],
    ["Authorization: Basic YWJj", "YWJj"],
    ["Authorization: Bearer abc", "abc"],
    // Schemes are matched generically: enumerating Basic/Bearer/Digest let an
    // unlisted scheme (GitHub's `token`) be eaten as the credential, leaving
    // the real secret behind as `authorization: <redacted> ghs_x`.
    ["authorization: token ghs_x", "ghs_x"],
    ["Authorization: Digest xyz789", "xyz789"],
    ["Proxy-Authorization: Bearer px_1", "px_1"],
    ["Authorization: abc123", "abc123"],
    ["https://tok@example.com/r.git", "tok@"],
    ["https://u:p@h/x", "u:p@"],
    ["https://h/x?token=abc", "token=abc"],
    // Cookie / Set-Cookie headers (previously bypassed).
    ["Cookie: session=COOKIESECRET", "COOKIESECRET"],
    ["Set-Cookie: session=COOKIESECRET; Path=/", "COOKIESECRET"],
    // Quoted-JSON Cookie / Set-Cookie (JSON diagnostic payloads).
    ['{"Cookie":"session=COOKIESECRET","status":401}', "COOKIESECRET"],
    [
      '{"Set-Cookie":"session=COOKIESECRET; Path=/","status":401}',
      "COOKIESECRET",
    ],
    ['"Cookie": "session=COOKIESECRET"', "COOKIESECRET"],
    // Quoted-JSON Authorization (key+value quoted; unquoted pattern stops).
    ['"Authorization": "Bearer QUOTEDJSONSECRET"', "QUOTEDJSONSECRET"],
    ['"Authorization": "token ghs_QUOTED"', "ghs_QUOTED"],
    ['{"Authorization": "abc123secret"}', "abc123secret"],
    // Digest multipart leaves response= after scheme redaction.
    [
      'Authorization: Digest username="u", response="DIGESTSECRET"',
      "DIGESTSECRET",
    ],
    // AWS4 multipart leaves Signature= after scheme redaction.
    [
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIA/x, Signature=SIGSECRET",
      "SIGSECRET",
    ],
  ] as const)("redacts secret material in %s", (input, secretFragment) => {
    const out = redactLogText(input);
    expect(out).not.toContain(secretFragment);
    expect(out).toContain("<redacted>");
  });

  it("redacts multi-pair and comma-joined Cookie/Set-Cookie values entirely", () => {
    const multi = redactLogText("Cookie: a=SECRET1; b=SECRET2; c=SECRET3");
    expect(multi).not.toContain("SECRET1");
    expect(multi).not.toContain("SECRET2");
    expect(multi).not.toContain("SECRET3");
    expect(multi).toBe("Cookie: <redacted>");

    // Naive multi-Set-Cookie joining (and Expires= commas) — never stop at `,`.
    const multiSet = redactLogText(
      "Set-Cookie: a=SECRET1; Path=/, b=SECRET2; HttpOnly",
    );
    expect(multiSet).not.toContain("SECRET1");
    expect(multiSet).not.toContain("SECRET2");
    expect(multiSet).toBe("Set-Cookie: <redacted>");
  });

  it("still redacts every field on a multi-secret line", () => {
    const out = redactLogText("Authorization: Bearer tok1, X-Api-Key: k2");
    expect(out).not.toContain("tok1");
    expect(out).not.toContain("k2");
  });
});
