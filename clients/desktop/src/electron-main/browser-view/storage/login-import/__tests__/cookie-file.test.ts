import { describe, expect, it } from "vitest";
import { parseCookieFile } from "../cookie-file";

describe("parseCookieFile: Netscape cookies.txt", () => {
  it("parses a standard line and a #HttpOnly_-prefixed line", () => {
    const text = [
      "# Netscape HTTP Cookie File",
      "example.com\tFALSE\t/\tFALSE\t0\tsid\tabc123",
      "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t2147483647\ttoken\tsecret-value",
    ].join("\n");

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      {
        domain: "example.com",
        name: "sid",
        path: "/",
        expires: -1,
        secure: false,
        httpOnly: false,
        sameSite: "Lax",
        partitioned: false,
        secret: { kind: "plain", value: "abc123" },
      },
      {
        domain: ".example.com",
        name: "token",
        path: "/",
        expires: 2_147_483_647,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        partitioned: false,
        secret: { kind: "plain", value: "secret-value" },
      },
    ]);
  });

  it("skips # comment lines and blank lines", () => {
    const text = [
      "# This is a comment, not a cookie",
      "",
      "example.com\tFALSE\t/\tFALSE\t0\tsid\tabc123",
      "",
    ].join("\n");

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
  });

  it("strips a leading BOM before sniffing the format", () => {
    const text = "﻿example.com\tFALSE\t/\tFALSE\t0\tsid\tabc123";

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("sid");
  });

  it("sets a leading-dot domain when the includeSubdomains flag is TRUE", () => {
    const text = "example.com\tTRUE\t/\tFALSE\t0\tsid\tabc123";

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.domain).toBe(".example.com");
  });

  it("omits the leading dot when the includeSubdomains flag is FALSE", () => {
    const text = "example.com\tFALSE\t/\tFALSE\t0\tsid\tabc123";

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.domain).toBe("example.com");
  });

  it("treats an expiry of 0 as a session cookie", () => {
    const text = "example.com\tFALSE\t/\tFALSE\t0\tsid\tabc123";

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.expires).toBe(-1);
  });

  it("keeps a positive expiry as-is", () => {
    const text = "example.com\tFALSE\t/\tFALSE\t1893456000\tsid\tabc123";

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.expires).toBe(1_893_456_000);
  });
});

describe("parseCookieFile: Cookie-Editor JSON", () => {
  it("parses hostOnly, session, and sameSite: no_restriction / null", () => {
    const text = JSON.stringify([
      {
        domain: "example.com",
        name: "host-only-cookie",
        value: "v1",
        path: "/",
        hostOnly: true,
        session: false,
        expirationDate: 1_893_456_000,
        secure: true,
        httpOnly: false,
        sameSite: "no_restriction",
      },
      {
        domain: "example.com",
        name: "session-cookie",
        value: "v2",
        path: "/",
        hostOnly: false,
        session: true,
        expirationDate: 1_893_456_000,
        secure: false,
        httpOnly: false,
        sameSite: null,
      },
    ]);

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hostOnly = result.rows.find((row) => row.name === "host-only-cookie");
    const session = result.rows.find((row) => row.name === "session-cookie");

    expect(hostOnly?.domain).toBe("example.com");
    expect(hostOnly?.sameSite).toBe("None");
    expect(hostOnly?.expires).toBe(1_893_456_000);

    expect(session?.domain).toBe(".example.com");
    expect(session?.sameSite).toBe("Lax");
    expect(session?.expires).toBe(-1);
  });

  it("flags Cookie-Editor rows that carry a partition key", () => {
    const text = JSON.stringify([
      {
        domain: "example.com",
        name: "object-top-level-site",
        value: "v1",
        path: "/",
        partitionKey: { topLevelSite: "https://example.com" },
      },
      {
        domain: "example.com",
        name: "string-partition-key",
        value: "v2",
        path: "/",
        partitionKey: "https://example.com",
      },
      {
        domain: "example.com",
        name: "object-null-top-level-site",
        value: "v3",
        path: "/",
        partitionKey: { topLevelSite: null },
      },
      {
        domain: "example.com",
        name: "null-partition-key",
        value: "v4",
        path: "/",
        partitionKey: null,
      },
      {
        domain: "example.com",
        name: "missing-partition-key",
        value: "v5",
        path: "/",
      },
    ]);

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const partitionedByName = new Map(
      result.rows.map((row) => [row.name, row.partitioned]),
    );

    expect(partitionedByName.get("object-top-level-site")).toBe(true);
    expect(partitionedByName.get("string-partition-key")).toBe(true);
    expect(partitionedByName.get("object-null-top-level-site")).toBe(false);
    expect(partitionedByName.get("null-partition-key")).toBe(false);
    expect(partitionedByName.get("missing-partition-key")).toBe(false);
  });
});

describe("parseCookieFile: Playwright storage state", () => {
  it("parses cookies and ignores the origins array", () => {
    const text = JSON.stringify({
      cookies: [
        {
          domain: ".example.com",
          name: "sid",
          value: "abc",
          path: "/",
          expires: 1_893_456_000,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          partitionKey: null,
        },
      ],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "token", value: "should-be-ignored" }],
        },
      ],
    });

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("sid");
    // No field of the row carries anything from `origins` - the schema for
    // this format has no such field at all.
    expect(Object.keys(result.rows[0] ?? {})).not.toContain("origins");
  });

  it("flags a cookie with a non-null partitionKey as partitioned", () => {
    const text = JSON.stringify({
      cookies: [
        {
          domain: "example.com",
          name: "chips-cookie",
          value: "abc",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "None",
          partitionKey: "https://top-level.example",
        },
      ],
    });

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.partitioned).toBe(true);
  });

  it("does not flag a cookie with a null partitionKey", () => {
    const text = JSON.stringify({
      cookies: [
        {
          domain: "example.com",
          name: "plain-cookie",
          value: "abc",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
          partitionKey: null,
        },
      ],
    });

    const result = parseCookieFile(text);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.partitioned).toBe(false);
  });
});

describe("parseCookieFile: unrecognized input", () => {
  it("returns ok: false for JSON that matches neither schema", () => {
    const result = parseCookieFile(JSON.stringify({ nonsense: true }));

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false for malformed JSON", () => {
    const result = parseCookieFile("{ not: valid json");

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false for plain-text garbage with no tab-separated fields", () => {
    const result = parseCookieFile(
      "this is not a cookie file at all\njust prose",
    );

    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false for an empty file", () => {
    const result = parseCookieFile("");

    expect(result).toEqual({ ok: false });
  });
});
