import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_MENTION_HOST,
  isDefaultGithubMentionHost,
} from "../github-mention-host";

describe("isDefaultGithubMentionHost", () => {
  it("treats the canonical github.com host as the default", () => {
    expect(isDefaultGithubMentionHost("github.com")).toBe(true);
  });

  it("folds casing before comparing, so GitHub.com is the default too", () => {
    expect(isDefaultGithubMentionHost("GitHub.com")).toBe(true);
  });

  it("does not treat an enterprise host as the default", () => {
    expect(isDefaultGithubMentionHost("ghe.corp")).toBe(false);
  });

  it("exposes the constant the fold compares against", () => {
    expect(DEFAULT_GITHUB_MENTION_HOST).toBe("github.com");
  });
});
