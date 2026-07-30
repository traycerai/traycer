import { describe, it, expect } from "vitest";
import { buildGitHubIssueUrl, type IssueReportInfo } from "../issue-reporter";

const TRUNCATION_MARKER = " (truncated, see support report)";
const MAX_URL_LENGTH = 8 * 1024;

const base: IssueReportInfo = {
  appVersion: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  electronVersion: null,
  chromeVersion: null,
  nodeVersion: null,
  hostVersion: null,
  hostStatus: null,
  hostPid: null,
  title: "Something broke",
  whatHappened: "The app crashed",
  stepsToReproduce: "1. Open app\n2. Click button",
  expectedBehavior: "It should work",
  actualBehavior: "It crashed",
  reportId: null,
};

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("buildGitHubIssueUrl", () => {
  it("points to the OSS repo issues/new endpoint", () => {
    const url = buildGitHubIssueUrl(base);
    expect(url).toMatch(/^https:\/\/github\.com\/.*\/issues\/new\?/);
  });

  it("routes through the bug_report.yml issue form template", () => {
    expect(paramsOf(buildGitHubIssueUrl(base)).get("template")).toBe(
      "bug_report.yml",
    );
  });

  it("prefills form fields from the mapped IssueReportInfo properties", () => {
    const params = paramsOf(buildGitHubIssueUrl(base));
    expect(params.get("title")).toBe("Something broke");
    expect(params.get("what-happened")).toBe("The app crashed");
    expect(params.get("version")).toBe("1.2.3");
    expect(params.get("os")).toBe("darwin (arm64)");
  });

  it("hardcodes component to Desktop app and repro to the in-app placeholder", () => {
    const params = paramsOf(buildGitHubIssueUrl(base));
    expect(params.get("component")).toBe("Desktop app");
    expect(params.get("repro")).toBe("Filed from the in-app reporter.");
  });

  it("does not set body or labels (template owns those)", () => {
    const params = paramsOf(buildGitHubIssueUrl(base));
    expect(params.get("body")).toBeNull();
    expect(params.get("labels")).toBeNull();
    expect(params.has("body")).toBe(false);
    expect(params.has("labels")).toBe(false);
  });

  it("ignores unused IssueReportInfo fields that no longer map to the form", () => {
    const withExtras: IssueReportInfo = {
      ...base,
      electronVersion: "28.0.0",
      chromeVersion: "120.0.0",
      nodeVersion: "20.11.0",
      hostVersion: "0.5.1",
      hostStatus: "ready",
      hostPid: 1234,
      reportId: "rpt_abc123",
      stepsToReproduce: "should-not-appear-in-url",
      expectedBehavior: "should-not-appear-either",
      actualBehavior: "nor-this",
    };
    const url = buildGitHubIssueUrl(withExtras);
    expect(url).not.toContain("28.0.0");
    expect(url).not.toContain("120.0.0");
    expect(url).not.toContain("20.11.0");
    expect(url).not.toContain("0.5.1");
    expect(url).not.toContain("rpt_abc123");
    expect(url).not.toContain("should-not-appear-in-url");
    expect(url).not.toContain("should-not-appear-either");
    expect(url).not.toContain("nor-this");
    // Host status "ready" and pid "1234" are short enough to collide with
    // unrelated URL text; assert they never become query values either.
    const params = paramsOf(url);
    for (const value of params.values()) {
      expect(value).not.toBe("ready");
      expect(value).not.toBe("1234");
      expect(value).not.toBe("28.0.0");
    }
  });

  it("keeps short reports under the 8 KiB budget without truncating", () => {
    const url = buildGitHubIssueUrl(base);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(paramsOf(url).get("what-happened")).toBe("The app crashed");
    expect(paramsOf(url).get("what-happened")).not.toContain(TRUNCATION_MARKER);
    expect(paramsOf(url).get("title")).not.toContain(TRUNCATION_MARKER);
  });

  it("truncates a very long whatHappened so the URL stays within 8 KiB", () => {
    // Encoded length grows beyond raw char length (`%` expansion). Use a
    // payload large enough that the untruncated form clearly exceeds 8192.
    const longWhatHappened = "x".repeat(20_000);
    const url = buildGitHubIssueUrl({
      ...base,
      whatHappened: longWhatHappened,
    });

    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);

    const whatHappened = paramsOf(url).get("what-happened");
    expect(whatHappened).not.toBeNull();
    if (whatHappened === null) {
      throw new Error("expected what-happened param to be present");
    }
    expect(whatHappened.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(whatHappened.length).toBeLessThan(longWhatHappened.length);
    // Title should still be intact when what-happened alone absorbs the cut.
    expect(paramsOf(url).get("title")).toBe("Something broke");
  });

  it("truncates title when whatHappened alone cannot fit the budget", () => {
    // Force both fields to need room: a long title plus a long body so that
    // even after what-happened is reduced to the marker, title still overflows.
    const longTitle = "T".repeat(10_000);
    const longWhatHappened = "W".repeat(10_000);
    const url = buildGitHubIssueUrl({
      ...base,
      title: longTitle,
      whatHappened: longWhatHappened,
    });

    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);

    const title = paramsOf(url).get("title");
    const whatHappened = paramsOf(url).get("what-happened");
    expect(title).not.toBeNull();
    expect(whatHappened).not.toBeNull();
    if (title === null || whatHappened === null) {
      throw new Error("expected title and what-happened params");
    }
    expect(whatHappened.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(title.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
