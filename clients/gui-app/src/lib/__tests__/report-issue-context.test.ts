import { describe, expect, it } from "vitest";
import { createReportIssueContext } from "@/lib/report-issue-context";

describe("createReportIssueContext", () => {
  it("normalizes intentionally privacy-safe error context", () => {
    expect(
      createReportIssueContext({
        title: "  Failed to load\nEpic  ",
        message: "Host returned\n\nan error",
        code: " RPC_ERROR ",
        source: " Epic snapshot ",
      }),
    ).toEqual({
      title: "Failed to load Epic",
      message: "Host returned an error",
      code: "RPC_ERROR",
      source: "Epic snapshot",
    });
  });

  it("drops empty values and caps long context", () => {
    const context = createReportIssueContext({
      title: " ",
      message: "x".repeat(500),
      code: "",
      source: null,
    });

    expect(context.title).toBe("Traycer error");
    expect(context.message?.endsWith("…")).toBe(true);
    expect(context.message?.length).toBe(300);
    expect(context.code).toBeNull();
    expect(context.source).toBeNull();
  });

  it("treats undefined values as absent instead of crashing", () => {
    // Regression: `.code` read off an error whose declared type lied (a bare
    // `Error` surfaced through a TanStack generic) is `undefined`, not `null`.
    // The old null-only guard crashed the git diff view on `.replace`.
    expect(
      createReportIssueContext({
        title: "Diff loading error",
        message: undefined,
        code: undefined,
        source: undefined,
      }),
    ).toEqual({
      title: "Diff loading error",
      message: null,
      code: null,
      source: null,
    });
  });
});
