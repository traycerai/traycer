import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildGitHubIssueUrl, type PublicIssueDraft } from "../issue-reporter";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(THIS_DIR, "../issue-reporter.ts");

// Every field pre-built and pre-scrubbed, exactly as `support:buildPublicDraft`
// (Electron main, ticket 09 / ticket 07's type-to-template routing) would
// hand it over the IPC boundary.
const bugDraft: PublicIssueDraft = {
  template: "bug_report.yml",
  title: "chat.subscribe - RPC_ERROR: Sending a message hangs",
  fields: {
    "what-happened": "The app crashed",
    version: "1.2.3",
    os: "darwin (arm64)",
    component: "Desktop app",
    repro: "1. Open app\n2. Click button",
  },
};

const ideaDraft: PublicIssueDraft = {
  template: "feature_request.yml",
  title: "Add a dark-mode toggle",
  fields: {
    problem: "There's no dark mode",
    proposal:
      "Not captured separately - see the private support report rpt_test.",
    alternatives: "",
    component: "Desktop app",
  },
};

const otherDraft: PublicIssueDraft = {
  template: "general.yml",
  title: "Feedback on onboarding",
  fields: {
    details: "The onboarding flow was confusing",
  },
};

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("buildGitHubIssueUrl", () => {
  it("points to the OSS repo issues/new endpoint", () => {
    expect(buildGitHubIssueUrl(bugDraft)).toMatch(
      /^https:\/\/github\.com\/.*\/issues\/new\?/,
    );
  });

  it("routes a bug report through the bug_report.yml issue form template", () => {
    expect(paramsOf(buildGitHubIssueUrl(bugDraft)).get("template")).toBe(
      "bug_report.yml",
    );
  });

  it("routes an idea through the feature_request.yml issue form template", () => {
    expect(paramsOf(buildGitHubIssueUrl(ideaDraft)).get("template")).toBe(
      "feature_request.yml",
    );
  });

  it("routes 'something else' through the general.yml issue form template", () => {
    expect(paramsOf(buildGitHubIssueUrl(otherDraft)).get("template")).toBe(
      "general.yml",
    );
  });

  it("assembles every bug field verbatim from the given draft - zero composition of its own", () => {
    const params = paramsOf(buildGitHubIssueUrl(bugDraft));
    expect(params.get("title")).toBe(bugDraft.title);
    expect(params.get("what-happened")).toBe(bugDraft.fields["what-happened"]);
    expect(params.get("version")).toBe(bugDraft.fields.version);
    expect(params.get("os")).toBe(bugDraft.fields.os);
    expect(params.get("component")).toBe(bugDraft.fields.component);
    expect(params.get("repro")).toBe(bugDraft.fields.repro);
  });

  it("assembles every idea field verbatim from the given draft", () => {
    const params = paramsOf(buildGitHubIssueUrl(ideaDraft));
    expect(params.get("title")).toBe(ideaDraft.title);
    expect(params.get("problem")).toBe(ideaDraft.fields.problem);
    expect(params.get("proposal")).toBe(ideaDraft.fields.proposal);
    expect(params.get("alternatives")).toBe(ideaDraft.fields.alternatives);
    expect(params.get("component")).toBe(ideaDraft.fields.component);
  });

  it("assembles every 'something else' field verbatim from the given draft", () => {
    const params = paramsOf(buildGitHubIssueUrl(otherDraft));
    expect(params.get("title")).toBe(otherDraft.title);
    expect(params.get("details")).toBe(otherDraft.fields.details);
  });

  it("does not set body or labels (the template owns those)", () => {
    for (const draft of [bugDraft, ideaDraft, otherDraft]) {
      const params = paramsOf(buildGitHubIssueUrl(draft));
      expect(params.has("body")).toBe(false);
      expect(params.has("labels")).toBe(false);
    }
  });

  it("never truncates - the 8 KiB URL budget is the caller's contract to uphold, not this module's", () => {
    const oversized: PublicIssueDraft = {
      ...bugDraft,
      fields: { ...bugDraft.fields, "what-happened": "x".repeat(20_000) },
    };
    const params = paramsOf(buildGitHubIssueUrl(oversized));
    expect(params.get("what-happened")).toBe("x".repeat(20_000));
  });

  // Ticket 09 guardrail (critique C1): the renderer emitting public text is
  // the anti-pattern this ticket exists to kill. A grep-level check is the
  // tripwire since TypeScript alone can't enforce "contains no logic".
  it("contains no body/title composition or truncation logic", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    for (const bannedIdentifier of [
      "composeWhatHappened",
      "composeReportBody",
      "composeRepro",
      "composePlaceholderField",
      "truncateToFit",
      "shrinkField",
      "deriveTitle",
    ]) {
      expect(source).not.toContain(bannedIdentifier);
    }
  });
});
