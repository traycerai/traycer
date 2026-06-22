import { describe, it, expect } from "vitest";
import { buildGitHubIssueUrl } from "../issue-reporter";

const base: Parameters<typeof buildGitHubIssueUrl>[0] = {
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

function extractBody(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("body")!);
}

function extractTitle(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("title")!);
}

describe("buildGitHubIssueUrl", () => {
  it("points to the OSS repo issues/new endpoint", () => {
    const url = buildGitHubIssueUrl(base);
    expect(url).toMatch(/^https:\/\/github\.com\/.*\/issues\/new/);
  });

  it("sets the title param from info.title", () => {
    expect(extractTitle(buildGitHubIssueUrl(base))).toBe("Something broke");
  });

  it("includes app version and platform in body", () => {
    const body = extractBody(buildGitHubIssueUrl(base));
    expect(body).toContain("1.2.3");
    expect(body).toContain("darwin (arm64)");
  });

  it("omits optional runtime fields when null", () => {
    const body = extractBody(buildGitHubIssueUrl(base));
    expect(body).not.toContain("Electron");
    expect(body).not.toContain("Node.js");
    expect(body).not.toContain("Host");
  });

  it("includes runtime versions when provided", () => {
    const body = extractBody(
      buildGitHubIssueUrl({
        ...base,
        electronVersion: "28.0.0",
        chromeVersion: "120.0.0",
        nodeVersion: "20.11.0",
        hostVersion: "0.5.1",
        hostStatus: "ready",
        hostPid: 1234,
      }),
    );
    expect(body).toContain("28.0.0");
    expect(body).toContain("120.0.0");
    expect(body).toContain("20.11.0");
    expect(body).toContain("0.5.1");
    expect(body).toContain("ready");
    expect(body).toContain("1234");
  });

  it("includes report ID when provided", () => {
    const body = extractBody(
      buildGitHubIssueUrl({ ...base, reportId: "rpt_abc123" }),
    );
    expect(body).toContain("rpt_abc123");
    expect(body).toContain("Support Report");
  });

  it("omits support report row when reportId is null", () => {
    const body = extractBody(buildGitHubIssueUrl(base));
    expect(body).not.toContain("Support Report");
  });

  it("includes user-provided content in body", () => {
    const body = extractBody(buildGitHubIssueUrl(base));
    expect(body).toContain("The app crashed");
    expect(body).toContain("1. Open app");
    expect(body).toContain("It should work");
    expect(body).toContain("It crashed");
  });

  it("includes all required template sections", () => {
    const body = extractBody(buildGitHubIssueUrl(base));
    expect(body).toContain("### What happened?");
    expect(body).toContain("### Steps to reproduce");
    expect(body).toContain("### Expected behavior");
    expect(body).toContain("### Actual behavior");
    expect(body).toContain("### Additional context");
  });
});
