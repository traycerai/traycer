import { describe, it, expect } from "vitest";
import { buildGitHubIssueUrl, type IssueReportInfo } from "../issue-reporter";

const TRUNCATION_MARKER = " (truncated, see support report)";
const MAX_URL_LENGTH = 8 * 1024;
const REPRO_PLACEHOLDER = "Filed from the in-app reporter.";

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

// Same as `base` but with the fields the old dialog leaves blank most often,
// so tests about the narrative/repro/placeholder shape don't have to fight
// unrelated non-empty defaults.
const minimal: IssueReportInfo = {
  ...base,
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
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

  it("prefills title/version/os from the mapped IssueReportInfo properties", () => {
    const params = paramsOf(buildGitHubIssueUrl(base));
    expect(params.get("title")).toBe("Something broke");
    expect(params.get("version")).toBe("1.2.3");
    expect(params.get("os")).toBe("darwin (arm64)");
  });

  it("hardcodes component to Desktop app", () => {
    expect(paramsOf(buildGitHubIssueUrl(base)).get("component")).toBe(
      "Desktop app",
    );
  });

  it("does not set body or labels (the template owns those)", () => {
    const params = paramsOf(buildGitHubIssueUrl(base));
    expect(params.has("body")).toBe(false);
    expect(params.has("labels")).toBe(false);
  });

  it("ignores runtime/host detail and reportId, which no longer map to the form", () => {
    const withExtras: IssueReportInfo = {
      ...base,
      electronVersion: "28.0.0",
      chromeVersion: "120.0.0",
      nodeVersion: "20.11.0",
      hostVersion: "0.5.1",
      hostStatus: "ready",
      hostPid: 1234,
      reportId: "rpt_abc123",
    };
    const url = buildGitHubIssueUrl(withExtras);
    expect(url).not.toContain("28.0.0");
    expect(url).not.toContain("120.0.0");
    expect(url).not.toContain("20.11.0");
    expect(url).not.toContain("0.5.1");
    expect(url).not.toContain("rpt_abc123");
    const params = paramsOf(url);
    for (const value of params.values()) {
      expect(value).not.toBe("ready");
      expect(value).not.toBe("1234");
    }
  });

  describe("what-happened composition", () => {
    it("is just the narrative when expected/actual are empty", () => {
      const params = paramsOf(buildGitHubIssueUrl(minimal));
      expect(params.get("what-happened")).toBe("The app crashed");
    });

    it("folds non-empty expected/actual behavior in under labeled sections", () => {
      const whatHappened = paramsOf(buildGitHubIssueUrl(base)).get(
        "what-happened",
      );
      expect(whatHappened).toBe(
        "The app crashed\n\nExpected: It should work\n\nActual: It crashed",
      );
    });

    it("omits an empty expected or actual section individually", () => {
      const whatHappened = paramsOf(
        buildGitHubIssueUrl({ ...base, actualBehavior: "" }),
      ).get("what-happened");
      expect(whatHappened).toBe("The app crashed\n\nExpected: It should work");
    });

    it("treats whitespace-only expected/actual as empty", () => {
      const whatHappened = paramsOf(
        buildGitHubIssueUrl({
          ...base,
          expectedBehavior: "   ",
          actualBehavior: "\n",
        }),
      ).get("what-happened");
      expect(whatHappened).toBe("The app crashed");
    });
  });

  describe("repro prefill", () => {
    it("uses the standard placeholder when stepsToReproduce is empty", () => {
      expect(paramsOf(buildGitHubIssueUrl(minimal)).get("repro")).toBe(
        REPRO_PLACEHOLDER,
      );
    });

    it("uses the standard placeholder when stepsToReproduce is whitespace-only", () => {
      const url = buildGitHubIssueUrl({
        ...base,
        stepsToReproduce: "   \n  ",
      });
      expect(paramsOf(url).get("repro")).toBe(REPRO_PLACEHOLDER);
    });

    it("prefills repro with user-typed steps to reproduce when present", () => {
      expect(paramsOf(buildGitHubIssueUrl(base)).get("repro")).toBe(
        "1. Open app\n2. Click button",
      );
    });
  });

  it("keeps short reports under the 8 KiB budget without truncating", () => {
    const url = buildGitHubIssueUrl(base);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    const params = paramsOf(url);
    expect(params.get("what-happened")).not.toContain(TRUNCATION_MARKER);
    expect(params.get("repro")).not.toContain(TRUNCATION_MARKER);
    expect(params.get("title")).not.toContain(TRUNCATION_MARKER);
  });

  it("truncates a very long whatHappened so the URL stays within 8 KiB", () => {
    const longWhatHappened = "x".repeat(20_000);
    const url = buildGitHubIssueUrl({
      ...minimal,
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
    // Title and repro (empty -> placeholder) are short enough to stay intact.
    expect(paramsOf(url).get("title")).toBe("Something broke");
    expect(paramsOf(url).get("repro")).toBe(REPRO_PLACEHOLDER);
  });

  it("truncates repro when whatHappened alone cannot free enough room", () => {
    const url = buildGitHubIssueUrl({
      ...minimal,
      whatHappened: "The app crashed after opening settings.",
      stepsToReproduce: "S".repeat(8_300),
    });

    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);

    const repro = paramsOf(url).get("repro");
    expect(repro).not.toBeNull();
    if (repro === null) {
      throw new Error("expected repro param to be present");
    }
    expect(repro.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("truncates title when whatHappened and repro alone cannot fit the budget", () => {
    const url = buildGitHubIssueUrl({
      ...minimal,
      title: "T".repeat(9_000),
      whatHappened: "The app crashed.",
      stepsToReproduce: "1. Open\n2. Click",
    });

    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);

    const title = paramsOf(url).get("title");
    expect(title).not.toBeNull();
    if (title === null) {
      throw new Error("expected title param to be present");
    }
    expect(title.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
