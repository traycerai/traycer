import { describe, expect, it } from "vitest";
import {
  HOST_DIAGNOSTIC_REPORT_FLAGS,
  HOST_V8_FLAGS,
  withHostNodeOptions,
} from "../host-node-options";

const CANONICAL = `${HOST_V8_FLAGS} ${HOST_DIAGNOSTIC_REPORT_FLAGS}`;

describe("withHostNodeOptions", () => {
  it("returns the canonical flags when nothing is inherited", () => {
    expect(withHostNodeOptions(undefined)).toBe(CANONICAL);
    expect(withHostNodeOptions("")).toBe(CANONICAL);
    // Canonical set includes the relative report directory so a crash before
    // the host's own runtime arming still lands under the spawn cwd.
    expect(CANONICAL).toContain("--report-on-fatalerror");
    expect(CANONICAL).toContain("--report-compact");
    expect(CANONICAL).toContain("--report-directory=crash-reports");
    expect(CANONICAL).toContain("--max-semi-space-size=16");
  });

  it("strips inherited duplicates of every canonical token including report-directory", () => {
    const result = withHostNodeOptions(
      "--max-semi-space-size=64 --report-on-fatalerror --report-compact --report-directory=/operator/path",
    );
    expect(result).toBe(CANONICAL);
    expect(result.match(/--max-semi-space-size/g)).toHaveLength(1);
    expect(result.match(/--report-on-fatalerror/g)).toHaveLength(1);
    expect(result.match(/--report-compact/g)).toHaveLength(1);
    expect(result.match(/--report-directory/g)).toHaveLength(1);
    expect(result).toContain("--report-directory=crash-reports");
    expect(result).not.toContain("/operator/path");
  });

  it("strips an operator --report-directory and lands on the canonical relative path", () => {
    // Deliberate design: operator overrides of report-directory are stripped
    // so the supervisor scan path and the child's write path always agree.
    const result = withHostNodeOptions("--report-directory=/x");
    expect(result).toBe(CANONICAL);
    expect(result).not.toContain("/x");
  });

  it("fully strips a quoted report-directory with spaces (no orphan tokens)", () => {
    // Naive \\S+ strip would leave `with spaces"` behind and unbalance
    // NODE_OPTIONS so Node dies before any user code runs.
    const result = withHostNodeOptions(
      '--report-directory="/path with spaces" --trace-warnings',
    );
    expect(result).toBe(`--trace-warnings ${CANONICAL}`);
    expect(result).not.toContain("with spaces");
    expect(result).not.toContain('"');
    // Balanced: no dangling quote fragments.
    expect((result.match(/"/g) ?? []).length).toBe(0);
  });

  it("strips the space-separated form --report-directory /x", () => {
    const result = withHostNodeOptions(
      "--report-directory /x --trace-warnings",
    );
    expect(result).toBe(`--trace-warnings ${CANONICAL}`);
    expect(result).not.toContain("/x");
  });

  it('strips the space-separated quoted form --report-directory "/path with spaces"', () => {
    const result = withHostNodeOptions(
      '--report-directory "/path with spaces" --inspect=0',
    );
    expect(result).toBe(`--inspect=0 ${CANONICAL}`);
    expect(result).not.toContain("with spaces");
  });

  it("preserves a prefix token like --report-directory-x", () => {
    // The strip must not swallow an unrelated flag that merely shares a prefix.
    const result = withHostNodeOptions("--report-directory-x --trace-warnings");
    expect(result).toContain("--report-directory-x");
    expect(result.startsWith("--report-directory-x --trace-warnings ")).toBe(
      true,
    );
    expect(result.endsWith(CANONICAL)).toBe(true);
  });

  it("is idempotent when applied twice", () => {
    const once = withHostNodeOptions(undefined);
    const twice = withHostNodeOptions(once);
    expect(twice).toBe(once);
    expect(twice).toBe(CANONICAL);
  });

  it("preserves unrelated NODE_OPTIONS tokens", () => {
    const result = withHostNodeOptions("--trace-warnings --inspect=0");
    expect(result.startsWith("--trace-warnings --inspect=0 ")).toBe(true);
    expect(result.endsWith(CANONICAL)).toBe(true);
  });
});
