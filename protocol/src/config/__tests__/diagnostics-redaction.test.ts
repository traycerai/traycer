import { describe, expect, it } from "vitest";
import {
  redactDiagnosticsLogTail,
  redactDiagnosticsText,
} from "../diagnostics-redaction";

describe("redactDiagnosticsText", () => {
  it("redacts common secret shapes without removing surrounding diagnostics", () => {
    const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
    const privateKeyBegin = ["-----BEGIN", `${privateKeyLabel}-----`].join(" ");
    const privateKeyEnd = ["-----END", `${privateKeyLabel}-----`].join(" ");
    const redacted = redactDiagnosticsText(
      [
        "GET https://example.test/callback?access_token=abc123&state=ok",
        "Authorization: Bearer secret-token",
        "Proxy-Authorization: Basic proxy-secret value",
        "Cookie: first=secret-one; second=secret-two",
        "Set-Cookie: session=secret-three; HttpOnly",
        "refresh_token='refresh-123'",
        privateKeyBegin,
        "private-body",
        privateKeyEnd,
      ].join("\n"),
    );

    expect(redacted).toContain("state=ok");
    expect(redacted).toContain("access_token=<redacted>");
    expect(redacted).toContain("Authorization: <redacted>");
    expect(redacted).toContain("Proxy-Authorization: <redacted>");
    expect(redacted).toContain("Cookie: <redacted>");
    expect(redacted).toContain("Set-Cookie: <redacted>");
    expect(redacted).toContain("refresh_token=<redacted>");
    expect(redacted).toContain("<redacted-private-key>");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("proxy-secret");
    expect(redacted).not.toContain("secret-one");
    expect(redacted).not.toContain("secret-two");
    expect(redacted).not.toContain("secret-three");
    expect(redacted).not.toContain("private-body");
  });

  it("redacts sensitive headers with indentation and CRLF endings", () => {
    const redacted = redactDiagnosticsText(
      [
        "\tAuthorization :   Basic spaced-secret\r",
        "Proxy-Authorization:\tproxy-secret\r",
        "info: still useful",
      ].join("\n"),
    );

    expect(redacted).toContain("\tAuthorization :   <redacted>\r");
    expect(redacted).toContain("Proxy-Authorization:\t<redacted>\r");
    expect(redacted).toContain("info: still useful");
    expect(redacted).not.toContain("spaced-secret");
    expect(redacted).not.toContain("proxy-secret");
  });
});

describe("redactDiagnosticsLogTail", () => {
  it("drops the partial first line of a truncated tail so a split header can't leak", () => {
    // The byte window began mid-line, after the `Authorization:`/`Cookie:`
    // header name - exactly the case the line-anchored header pattern can't
    // catch and Basic/Cookie values are not Bearer/inline shapes.
    const tail = [
      "Basic dXNlcjpwYXNzd29yZA==",
      "Cookie: session=second-line-secret",
      "info: ready",
    ].join("\n");

    const redacted = redactDiagnosticsLogTail(tail, true);

    expect(redacted).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(redacted).not.toContain("second-line-secret");
    expect(redacted).toContain("Cookie: <redacted>");
    expect(redacted).toContain("info: ready");
  });

  it("keeps the first line intact for a whole-file read", () => {
    const whole = ["info: first line", "info: second line"].join("\n");
    expect(redactDiagnosticsLogTail(whole, false)).toBe(whole);
  });

  it("yields no orphaned content when a truncated tail has no newline", () => {
    expect(redactDiagnosticsLogTail("Basic dXNlcjpwYXNz", true)).toBe("");
  });

  it("redacts a truncated tail that starts inside a private key body", () => {
    const tail = [
      "partial-base64-line-from-before-window",
      "still-secret-private-key-body",
      "-----END PRIVATE KEY-----",
      "info: ready",
    ].join("\n");

    const redacted = redactDiagnosticsLogTail(tail, true);

    expect(redacted).toContain("<redacted-private-key>");
    expect(redacted).toContain("info: ready");
    expect(redacted).not.toContain("still-secret-private-key-body");
    expect(redacted).not.toContain("-----END PRIVATE KEY-----");
  });
});
