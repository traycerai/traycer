import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_MENTION_HOST,
  isDefaultGithubMentionHost,
} from "../github-mention-host";

/**
 * The one predicate every omit-the-default decision goes through: the
 * serializer's mention arms, the gui token builder, and prose references all
 * defer to this rather than restating the compare - see the module doc.
 */
describe("isDefaultGithubMentionHost", () => {
  it("treats the canonical github.com host as the default", () => {
    expect(isDefaultGithubMentionHost("github.com")).toBe(true);
  });

  it("folds casing before comparing, so GitHub.com is the default too", () => {
    // GitHub host identity is case-insensitive on the wire, so a surface that
    // compared verbatim would treat this as an enterprise host - asserting a
    // qualification the identity layer says does not exist.
    expect(isDefaultGithubMentionHost("GitHub.com")).toBe(true);
  });

  it("does not treat an enterprise host as the default", () => {
    expect(isDefaultGithubMentionHost("ghe.corp")).toBe(false);
  });

  it("exposes the constant the fold compares against", () => {
    expect(DEFAULT_GITHUB_MENTION_HOST).toBe("github.com");
  });
});
