import { describe, expect, it } from "vitest";
import {
  HOST_DIAGNOSTIC_REPORT_FLAGS,
  HOST_V8_FLAGS,
  withHostNodeOptions,
} from "../host-node-options";

const CANONICAL = `${HOST_V8_FLAGS} ${HOST_DIAGNOSTIC_REPORT_FLAGS}`;

/**
 * A malformed NODE_OPTIONS means the host never starts: Node rejects the
 * whole string on an unrecognized bare token. Every result of
 * withHostNodeOptions must therefore be only `--flag` / `--flag=value` tokens.
 */
function assertOnlyFlagTokens(result: string): void {
  for (const token of result.split(/\s+/).filter((t) => t.length > 0)) {
    expect(token.startsWith("--")).toBe(true);
  }
}

describe("withHostNodeOptions", () => {
  it("returns the canonical flags when nothing is inherited", () => {
    expect(withHostNodeOptions(undefined)).toBe(CANONICAL);
    expect(withHostNodeOptions("")).toBe(CANONICAL);
    expect(CANONICAL).toContain("--report-on-fatalerror");
    expect(CANONICAL).toContain("--report-compact");
    expect(CANONICAL).toContain("--report-directory=crash-reports");
    expect(CANONICAL).toContain("--max-semi-space-size=64");
    assertOnlyFlagTokens(CANONICAL);
  });

  describe("value-flag matrix (=value and space-separated)", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input: string;
      readonly preservedPrefix: string | null;
    }> = [
      // --max-semi-space-size. The inherited value is 16 - the cap this helper
      // used to append - and must not be the canonical one: an input that
      // already carries the value we append makes the strip unobservable in
      // everything except the duplicate count below, and 16 is also the exact
      // string a host inherits from a plist written before the cap was raised.
      {
        name: "max-semi-space-size =value mid",
        input: "--trace-warnings --max-semi-space-size=16 --inspect=0",
        preservedPrefix: "--trace-warnings --inspect=0",
      },
      {
        name: "max-semi-space-size =value leading",
        input: "--max-semi-space-size=16 --trace-warnings",
        preservedPrefix: "--trace-warnings",
      },
      {
        name: "max-semi-space-size =value trailing",
        input: "--trace-warnings --max-semi-space-size=16",
        preservedPrefix: "--trace-warnings",
      },
      {
        name: "max-semi-space-size space-separated mid",
        input: "--trace-warnings --max-semi-space-size 16 --inspect=0",
        preservedPrefix: "--trace-warnings --inspect=0",
      },
      // --report-directory
      {
        name: "report-directory =value mid",
        input: "--trace-warnings --report-directory=/tmp/x --inspect=0",
        preservedPrefix: "--trace-warnings --inspect=0",
      },
      {
        name: "report-directory space-separated mid",
        input: "--trace-warnings --report-directory /tmp/x --inspect=0",
        preservedPrefix: "--trace-warnings --inspect=0",
      },
      {
        name: "report-directory =value leading",
        input: "--report-directory=/tmp/x --trace-warnings",
        preservedPrefix: "--trace-warnings",
      },
      {
        name: "report-directory space-separated trailing",
        input: "--trace-warnings --report-directory /tmp/x",
        preservedPrefix: "--trace-warnings",
      },
      // --report-filename (stripped even though we do not append it)
      {
        name: "report-filename =value mid",
        input: "--trace-warnings --report-filename=report.json --inspect=0",
        preservedPrefix: "--trace-warnings --inspect=0",
      },
      {
        name: "report-filename space-separated",
        input: "--report-filename report.json --trace-warnings",
        preservedPrefix: "--trace-warnings",
      },
    ];

    it.each(cases)("$name → stripped cleanly", ({ input, preservedPrefix }) => {
      const result = withHostNodeOptions(input);
      assertOnlyFlagTokens(result);
      expect(result.endsWith(CANONICAL)).toBe(true);
      if (preservedPrefix !== null) {
        expect(result.startsWith(`${preservedPrefix} `)).toBe(true);
      }
      expect(result).not.toMatch(/\/tmp\/x\b/);
      expect(result).not.toContain("report.json");
      // No duplicate owned flags.
      expect(result.match(/--max-semi-space-size/g)).toHaveLength(1);
      expect(result.match(/--report-directory/g)).toHaveLength(1);
    });
  });

  it("replaces the 16 MB cap a host inherited from an older plist", () => {
    // The upgrade path for the cap being raised, and the reason the strip
    // covers `--max-semi-space-size` at all rather than only appending. A
    // macOS host installed before the raise has `--max-semi-space-size=16`
    // baked into its LaunchAgent plist and inherits it through `process.env`;
    // the supervisor is what corrects it, so a host that is never reinstalled
    // still gets the new cap on its next start.
    const result = withHostNodeOptions("--max-semi-space-size=16");

    expect(result).toBe(CANONICAL);
    expect(result).toContain("--max-semi-space-size=64");
    expect(result).not.toContain("--max-semi-space-size=16");
    expect(result.match(/--max-semi-space-size/g)).toHaveLength(1);
    assertOnlyFlagTokens(result);
  });

  it("does not corrupt neighbors when a value CONTAINS another flag name", () => {
    // A path that embeds `--max-semi-space-size` must not re-trigger the
    // semi-space strip or leave an orphan token.
    const result = withHostNodeOptions(
      "--report-directory=/tmp/--max-semi-space-size/x --trace-warnings",
    );
    assertOnlyFlagTokens(result);
    expect(result).toBe(`--trace-warnings ${CANONICAL}`);
    expect(result).not.toContain("/tmp/");
    expect(result.match(/--max-semi-space-size/g)).toHaveLength(1);
  });

  it("fully strips a quoted report-directory with spaces (no orphan tokens)", () => {
    const result = withHostNodeOptions(
      '--report-directory="/path with spaces" --trace-warnings',
    );
    assertOnlyFlagTokens(result);
    expect(result).toBe(`--trace-warnings ${CANONICAL}`);
    expect(result).not.toContain("with spaces");
    expect(result).not.toContain('"');
  });

  it("strips the space-separated quoted form", () => {
    const result = withHostNodeOptions(
      '--report-directory "/path with spaces" --inspect=0',
    );
    assertOnlyFlagTokens(result);
    expect(result).toBe(`--inspect=0 ${CANONICAL}`);
    expect(result).not.toContain("with spaces");
  });

  it("does not swallow a following --flag when report-directory has no value", () => {
    // Value-less token must not eat its neighbor.
    const result = withHostNodeOptions("--report-directory --inspect");
    assertOnlyFlagTokens(result);
    expect(result).toContain("--inspect");
    expect(result.endsWith(CANONICAL)).toBe(true);
  });

  it("preserves a prefix token like --report-directory-x", () => {
    const result = withHostNodeOptions("--report-directory-x --trace-warnings");
    assertOnlyFlagTokens(result);
    expect(result).toContain("--report-directory-x");
    expect(result.startsWith("--report-directory-x --trace-warnings ")).toBe(
      true,
    );
    expect(result.endsWith(CANONICAL)).toBe(true);
  });

  it("strips inherited duplicates of every canonical boolean token", () => {
    const result = withHostNodeOptions(
      "--report-on-fatalerror --report-compact --trace-warnings",
    );
    assertOnlyFlagTokens(result);
    expect(result).toBe(`--trace-warnings ${CANONICAL}`);
    expect(result.match(/--report-on-fatalerror/g)).toHaveLength(1);
    expect(result.match(/--report-compact/g)).toHaveLength(1);
  });

  it("is idempotent when applied twice", () => {
    const once = withHostNodeOptions(undefined);
    const twice = withHostNodeOptions(once);
    expect(twice).toBe(once);
    expect(twice).toBe(CANONICAL);
    assertOnlyFlagTokens(twice);
  });

  it("idempotent after stripping a messy inherited string", () => {
    const messy =
      '--report-directory="/path with spaces" --max-semi-space-size 99 --report-filename=x.json --report-on-fatalerror --trace-warnings';
    const once = withHostNodeOptions(messy);
    const twice = withHostNodeOptions(once);
    expect(twice).toBe(once);
    assertOnlyFlagTokens(once);
  });
});
