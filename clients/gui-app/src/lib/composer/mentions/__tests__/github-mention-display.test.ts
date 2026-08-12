import { describe, expect, it } from "vitest";
import type {
  GithubIssueMentionRow,
  GithubMentionRepository,
  GithubPullRequestMentionRow,
} from "@traycer/protocol/host/mention-schemas";

import {
  githubMentionAttachmentFromRow,
  githubMentionDisplayState,
  githubMentionRowTrailing,
  githubMentionToken,
  githubRepositoryQualification,
} from "../github-mention-display";

/**
 * Two things a row must not overstate: how its issue was closed, and which
 * repository it belongs to.
 */

function repository(
  owner: string,
  repo: string,
  githubHost: string,
): GithubMentionRepository {
  return { githubHost, owner, repo };
}

function issue(fields: {
  readonly state: "open" | "closed";
  readonly stateReason: string | null;
}): GithubIssueMentionRow {
  return {
    kind: "issue",
    githubHost: "github.com",
    owner: "acme",
    repo: "api",
    number: 7,
    title: "Something",
    url: "https://github.com/acme/api/issues/7",
    author: null,
    updatedAt: 1_000,
    buckets: ["recent"],
    labels: [],
    assignees: [],
    ...fields,
  };
}

function pullRequest(owner: string, repo: string): GithubPullRequestMentionRow {
  return {
    kind: "pull-request",
    githubHost: "github.com",
    owner,
    repo,
    number: 123,
    title: "Something",
    url: `https://github.com/${owner}/${repo}/pull/123`,
    author: null,
    updatedAt: 1_000,
    buckets: ["recent"],
    state: "open",
    isDraft: false,
    baseRefName: null,
    headRefName: null,
    reviewDecision: null,
    checksRollup: null,
  };
}

describe("githubMentionDisplayState", () => {
  it("separates a not-planned closure from a completed one", () => {
    // The two closures are opposite outcomes, and `issue-closed` carries a
    // check glyph and the purple "landed" tint - so collapsing them presents a
    // dismissal as a resolution.
    expect(
      githubMentionDisplayState(
        issue({ state: "closed", stateReason: "not_planned" }),
      ),
    ).toBe("issue-not-planned");
    expect(
      githubMentionDisplayState(
        issue({ state: "closed", stateReason: "completed" }),
      ),
    ).toBe("issue-closed");
  });

  it("treats any other explicit reason as not completed", () => {
    // `stateReason` is a free-form string on the wire, so this must not be an
    // equality test against one known value.
    expect(
      githubMentionDisplayState(
        issue({ state: "closed", stateReason: "duplicate" }),
      ),
    ).toBe("issue-not-planned");
  });

  it("keeps the settled reading when no reason was carried", () => {
    // The control, and the deliberate asymmetry: an absent reason is legacy or
    // unpopulated data, not a dismissal. Inventing one from an absence would
    // be the same overclaim pointing the other way.
    expect(
      githubMentionDisplayState(issue({ state: "closed", stateReason: null })),
    ).toBe("issue-closed");
    expect(
      githubMentionDisplayState(issue({ state: "open", stateReason: null })),
    ).toBe("issue-open");
  });
});

describe("githubRepositoryQualification", () => {
  const ACME_API = repository("acme", "api", "github.com");
  const CONTOSO_API = repository("contoso", "api", "github.com");
  const ACME_WEB = repository("acme", "web", "github.com");
  const GHE_ACME_API = repository("acme", "api", "ghe.acme.dev");

  it("names nothing when the scope is a single repository", () => {
    expect(
      githubRepositoryQualification(pullRequest("acme", "api"), [ACME_API]),
    ).toBe("none");
  });

  it("names the repository when nothing else in scope shares it", () => {
    expect(
      githubRepositoryQualification(pullRequest("acme", "api"), [
        ACME_API,
        ACME_WEB,
      ]),
    ).toBe("repo");
  });

  it("adds the owner when two repositories share a name", () => {
    expect(
      githubRepositoryQualification(pullRequest("acme", "api"), [
        ACME_API,
        CONTOSO_API,
      ]),
    ).toBe("owner-repo");
  });

  it("adds the host when owner and name both collide", () => {
    expect(
      githubRepositoryQualification(pullRequest("acme", "api"), [
        ACME_API,
        GHE_ACME_API,
      ]),
    ).toBe("host-owner-repo");
  });

  it("labels colliding chips distinguishably", () => {
    // The user-visible consequence: both the composer decorator and the posted
    // message render `mention.label`, so two same-named repositories produced
    // two chips reading `api#123` for different attachments.
    const scope = [ACME_API, CONTOSO_API];
    expect(
      githubMentionAttachmentFromRow(pullRequest("acme", "api"), scope).label,
    ).toBe("acme/api#123");
    expect(
      githubMentionAttachmentFromRow(pullRequest("contoso", "api"), scope)
        .label,
    ).toBe("contoso/api#123");
  });

  it("keeps the short label when there is no collision", () => {
    // The control. The fix must not qualify every multi-repository scope.
    const scope = [ACME_API, ACME_WEB];
    expect(
      githubMentionAttachmentFromRow(pullRequest("acme", "api"), scope).label,
    ).toBe("api#123");
    expect(
      githubMentionAttachmentFromRow(pullRequest("acme", "api"), [ACME_API])
        .label,
    ).toBe("#123");
  });

  it("qualifies the trailing segment on the same rule as the label", () => {
    // The row's detail and its chip must not disagree about which repository
    // the row is from.
    expect(
      githubMentionRowTrailing(
        pullRequest("acme", "api"),
        [ACME_API, CONTOSO_API],
        1_000,
      ),
    ).toMatch(/^acme\/api · /);
    expect(
      githubMentionRowTrailing(
        pullRequest("acme", "api"),
        [ACME_API, ACME_WEB],
        1_000,
      ),
    ).toMatch(/^api · /);
  });
});

describe("githubMentionToken", () => {
  function onHost(githubHost: string): GithubPullRequestMentionRow {
    return { ...pullRequest("acme", "api"), githubHost };
  }

  it("keeps the default host implicit", () => {
    // Compatibility, not brevity. This token is the attachment's durable
    // `path`; writing `github.com/` into it would give the same pull request a
    // different identity before and after this change, so one message holding
    // both inserts would render it twice.
    expect(githubMentionToken(onHost("github.com"))).toBe(
      "github-pr:acme/api#123",
    );
  });

  it("names a non-default host", () => {
    expect(githubMentionToken(onHost("ghe.acme.dev"))).toBe(
      "github-pr:ghe.acme.dev/acme/api#123",
    );
  });

  it("distinguishes the same reference on two hosts", () => {
    // The defect: `path` is the node id, what `buildAttachmentsFromJSONContent`
    // dedupes on, and what the sent-message renderer indexes by - so one token
    // for two rows dropped or aliased an attachment.
    expect(githubMentionToken(onHost("github.com"))).not.toBe(
      githubMentionToken(onHost("ghe.acme.dev")),
    );
  });

  it("stays a token `segments.ts` recognizes on either host", () => {
    // The entity-token pattern requires a `/` after the prefix and allows more
    // after it, so the host segment must not need a grammar change.
    const pattern =
      /^(epic:[^/\s]+|(spec|ticket|story|review|chat|terminal-agent|terminal|github-pr|github-issue):[^/\s]+\/[^\s]+)$/u;
    expect(pattern.test(githubMentionToken(onHost("github.com")))).toBe(true);
    expect(pattern.test(githubMentionToken(onHost("ghe.acme.dev")))).toBe(true);
  });
});
