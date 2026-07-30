import { describe, expect, it } from "vitest";
import { deepScrubSupportValue, scrubSupportText } from "../support-scrubber";

describe("scrubSupportText", () => {
  it("redacts a Bearer token", () => {
    expect(scrubSupportText("Bearer abc123.def456-ghi")).toBe(
      "Bearer <redacted>",
    );
  });

  it("redacts only the token query value in a URL, preserving structure", () => {
    // The Windows-drive-letter path regex must not match the "s:" of "https:"
    // (negative lookbehind). Only the token value is redacted.
    expect(
      scrubSupportText("url: https://x.com/oauth?token=SECRET123&foo=bar"),
    ).toBe("url: https://x.com/oauth?token=<redacted>&foo=bar");
  });

  it("redacts an inline password assignment", () => {
    expect(scrubSupportText('password: "hunter2"')).toBe(
      "password: <redacted>",
    );
  });

  it("pseudonymizes a POSIX path including trailing :line:col in one token", () => {
    expect(
      scrubSupportText(
        "at ChatRuntime.subscribe (/Users/anurag/Desktop/acme-corp/src/chat-runtime.ts:42:10)",
      ),
    ).toBe("at ChatRuntime.subscribe (<path-1>)");
  });

  it("pseudonymizes a quoted POSIX path, preserving surrounding quotes", () => {
    expect(
      scrubSupportText(
        "Cannot find module '/Applications/Traycer.app/Contents/Resources/lifecycle_lock.node'",
      ),
    ).toBe("Cannot find module '<path-1>'");
  });

  it("pseudonymizes a Windows drive path", () => {
    expect(
      scrubSupportText(
        "windows path C:\\Users\\anurag\\AppData\\Local\\Traycer\\log.txt end",
      ),
    ).toBe("windows path <path-1> end");
  });

  it("pseudonymizes a UNC path", () => {
    expect(
      scrubSupportText("unc path \\\\server\\share\\folder\\file.txt end"),
    ).toBe("unc path <path-1> end");
  });

  it("leaves API-route-looking text alone (not a recognized filesystem root)", () => {
    const input = "GET /api/v1/host/status 200";
    expect(scrubSupportText(input)).toBe(input);
  });

  it("reuses the same path pseudonym for identical paths within one call", () => {
    const input =
      "first /Users/anurag/project/a.ts then again /Users/anurag/project/a.ts";
    expect(scrubSupportText(input)).toBe("first <path-1> then again <path-1>");
  });

  it("assigns distinct path pseudonyms for different paths within one call", () => {
    const input = "see /Users/anurag/one.ts and /Users/anurag/two.ts";
    expect(scrubSupportText(input)).toBe("see <path-1> and <path-2>");
  });

  it("does not truncate a long match-free string (no 1000-char cap)", () => {
    const input = "x".repeat(5000);
    const result = scrubSupportText(input);
    expect(result).toBe(input);
    expect(result.length).toBe(5000);
  });

  it("does not truncate a multi-line log-tail-sized input", () => {
    // ~2000 lines, well past the old redactLogText whole-string 1000-char cap.
    const lines = Array.from({ length: 2000 }, (_, i) => `log-line-${i}-ok`);
    const input = lines.join("\n");
    const result = scrubSupportText(input);
    expect(result).toBe(input);
    expect(result.split("\n")).toHaveLength(2000);
  });

  it("redacts sensitive patterns line-wise across a multi-line block", () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `line ${i}: Bearer token${i}.abc`,
    );
    const result = scrubSupportText(lines.join("\n"));
    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(12);
    for (const [i, line] of resultLines.entries()) {
      expect(line).toBe(`line ${i}: Bearer <redacted>`);
    }
  });
});

describe("deepScrubSupportValue", () => {
  it("scrubs string leaves", () => {
    expect(deepScrubSupportValue({ a: "token: abc" })).toEqual({
      a: "token: <redacted>",
    });
  });

  it("recurses into nested objects", () => {
    expect(
      deepScrubSupportValue({
        nested: { stack: "at foo (/Users/anurag/x.ts:1:1)" },
      }),
    ).toEqual({ nested: { stack: "at foo (<path-1>)" } });
  });

  it("fully redacts values whose key matches SENSITIVE_KEY_PATTERN", () => {
    expect(
      deepScrubSupportValue({ apiKey: "should-be-fully-redacted-by-key-name" }),
    ).toEqual({ apiKey: "<redacted>" });
  });

  it("recurses into arrays", () => {
    expect(
      deepScrubSupportValue({ arr: ["/Users/anurag/one.ts", "plain"] }),
    ).toEqual({ arr: ["<path-1>", "plain"] });
  });

  it("passes numbers, booleans, and null through unchanged", () => {
    expect(
      deepScrubSupportValue({
        n: 42,
        b: true,
        z: false,
        empty: null,
      }),
    ).toEqual({
      n: 42,
      b: true,
      z: false,
      empty: null,
    });
  });

  it("fully scrubs a realistic depth-3/4 nested object (bounds do not fire)", () => {
    const input = {
      cause: {
        type: "Error",
        message: "boom at /Users/anurag/secret/x.ts:1:1",
        stack: "at run (/Users/anurag/secret/x.ts:1:1)",
        nested: {
          layer0: {
            note: "path /Users/anurag/secret/y.ts seen",
          },
        },
      },
      processMetrics: {
        cpu: 12.5,
        mem: 1024,
      },
    };
    expect(deepScrubSupportValue(input)).toEqual({
      cause: {
        type: "Error",
        message: "boom at <path-1>",
        stack: "at run (<path-1>)",
        nested: {
          layer0: {
            note: "path <path-1> seen",
          },
        },
      },
      processMetrics: {
        cpu: 12.5,
        mem: 1024,
      },
    });
  });
});
