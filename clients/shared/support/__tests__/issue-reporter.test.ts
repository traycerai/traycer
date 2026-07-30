import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildGitHubIssueUrl, type PublicIssueDraft } from "../issue-reporter";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(THIS_DIR, "../issue-reporter.ts");

// Every field pre-built and pre-scrubbed, exactly as `support:buildPublicDraft`
// (Electron main, ticket 09) would hand it over the IPC boundary.
const draft: PublicIssueDraft = {
  title: "chat.subscribe - RPC_ERROR: Sending a message hangs",
  fields: {
    "what-happened": "The app crashed",
    version: "1.2.3",
    os: "darwin (arm64)",
    component: "Desktop app",
    repro: "1. Open app\n2. Click button",
  },
};

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("buildGitHubIssueUrl", () => {
  it("points to the OSS repo issues/new endpoint", () => {
    expect(buildGitHubIssueUrl(draft)).toMatch(
      /^https:\/\/github\.com\/.*\/issues\/new\?/,
    );
  });

  it("routes through the bug_report.yml issue form template", () => {
    expect(paramsOf(buildGitHubIssueUrl(draft)).get("template")).toBe(
      "bug_report.yml",
    );
  });

  it("assembles every field verbatim from the given draft - zero composition of its own", () => {
    const params = paramsOf(buildGitHubIssueUrl(draft));
    expect(params.get("title")).toBe(draft.title);
    expect(params.get("what-happened")).toBe(draft.fields["what-happened"]);
    expect(params.get("version")).toBe(draft.fields.version);
    expect(params.get("os")).toBe(draft.fields.os);
    expect(params.get("component")).toBe(draft.fields.component);
    expect(params.get("repro")).toBe(draft.fields.repro);
  });

  it("does not set body or labels (the template owns those)", () => {
    const params = paramsOf(buildGitHubIssueUrl(draft));
    expect(params.has("body")).toBe(false);
    expect(params.has("labels")).toBe(false);
  });

  it("never truncates - the 8 KiB URL budget is the caller's contract to uphold, not this module's", () => {
    const oversized: PublicIssueDraft = {
      ...draft,
      fields: { ...draft.fields, "what-happened": "x".repeat(20_000) },
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
      "composeRepro",
      "truncateToFit",
      "shrinkField",
      "deriveTitle",
    ]) {
      expect(source).not.toContain(bannedIdentifier);
    }
  });
});
