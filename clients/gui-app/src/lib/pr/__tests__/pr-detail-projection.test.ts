import { describe, it, expect } from "vitest";
import type {
  PrActivityItem,
  PrActivitySection,
  PrCheckContext,
  PrDetailCore,
} from "@traycer/protocol/host/pr-schemas";
import {
  formatPrCheckStatusLabel,
  prParticipantActors,
  prReviewerRows,
} from "@/lib/pr/pr-detail-projection";

function core(overrides: Partial<PrDetailCore>): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add feature X",
    body: null,
    author: { login: "author", avatarUrl: null },
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: "abc123",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    reviewRequests: [],
    commentCount: 0,
    updatedAt: 1_000,
    mergedAt: null,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

function activity(items: PrActivityItem[]): PrActivitySection {
  return { observedAt: 1_000, items, isTruncated: false };
}

function checkContext(overrides: Partial<PrCheckContext>): PrCheckContext {
  return {
    name: "build",
    workflowName: "CI",
    event: "pull_request",
    appName: "GitHub Actions",
    appLogoUrl: null,
    description: null,
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    ...overrides,
  };
}

describe("prReviewerRows", () => {
  it("keeps the latest review per login, chronologically", () => {
    const rows = prReviewerRows(
      core({}),
      activity([
        {
          kind: "review",
          id: "r1",
          author: { login: "alice", avatarUrl: null },
          body: "",
          state: "changes_requested",
          createdAt: 1,
        },
        {
          kind: "review",
          id: "r2",
          author: { login: "alice", avatarUrl: null },
          body: "",
          state: "approved",
          createdAt: 2,
        },
      ]),
    );

    expect(rows).toEqual([
      { actor: { login: "alice", avatarUrl: null }, state: "approved" },
    ]);
  });

  it("overrides a submitted review's state to 'requested' on a fresh re-request", () => {
    const rows = prReviewerRows(
      core({
        reviewRequests: [{ login: "alice", avatarUrl: null, kind: "user" }],
      }),
      activity([
        {
          kind: "review",
          id: "r1",
          author: { login: "alice", avatarUrl: null },
          body: "",
          state: "approved",
          createdAt: 1,
        },
      ]),
    );

    expect(rows).toEqual([
      {
        actor: { login: "alice", avatarUrl: null, kind: "user" },
        state: "requested",
      },
    ]);
  });

  it("ignores comments and authorless reviews", () => {
    const rows = prReviewerRows(
      core({}),
      activity([
        {
          kind: "comment",
          id: "c1",
          author: { login: "bob", avatarUrl: null },
          body: "",
          createdAt: 1,
        },
        {
          kind: "review",
          id: "r1",
          author: null,
          body: "",
          state: "approved",
          createdAt: 2,
        },
      ]),
    );

    expect(rows).toEqual([]);
  });
});

describe("prParticipantActors", () => {
  it("includes the author plus every unique activity author", () => {
    const actors = prParticipantActors(
      core({ author: { login: "author", avatarUrl: null } }),
      activity([
        {
          kind: "comment",
          id: "c1",
          author: { login: "bob", avatarUrl: null },
          body: "",
          createdAt: 1,
        },
        {
          kind: "comment",
          id: "c2",
          author: { login: "bob", avatarUrl: null },
          body: "",
          createdAt: 2,
        },
      ]),
    );

    expect(actors).toEqual([
      { login: "author", avatarUrl: null },
      { login: "bob", avatarUrl: null },
    ]);
  });

  it("skips authorless activity items", () => {
    const actors = prParticipantActors(
      core({ author: null }),
      activity([
        { kind: "comment", id: "c1", author: null, body: "", createdAt: 1 },
      ]),
    );

    expect(actors).toEqual([]);
  });
});

describe("formatPrCheckStatusLabel", () => {
  it("labels the two in-flight, non-completed statuses", () => {
    expect(formatPrCheckStatusLabel(checkContext({ status: "queued" }))).toBe(
      "Queued",
    );
    expect(
      formatPrCheckStatusLabel(checkContext({ status: "in_progress" })),
    ).toBe("Running");
  });

  it("labels GitHub's other pre-completion CheckStatusState values instead of falling back to a null-conclusion 'Unknown'", () => {
    expect(
      formatPrCheckStatusLabel(
        checkContext({ status: "pending", conclusion: null }),
      ),
    ).toBe("Pending");
    expect(
      formatPrCheckStatusLabel(
        checkContext({ status: "requested", conclusion: null }),
      ),
    ).toBe("Requested");
    expect(
      formatPrCheckStatusLabel(
        checkContext({ status: "waiting", conclusion: null }),
      ),
    ).toBe("Waiting");
  });

  it("labels a completed run's 'startup_failure' conclusion distinctly from the generic action-required fallback", () => {
    expect(
      formatPrCheckStatusLabel(
        checkContext({ status: "completed", conclusion: "startup_failure" }),
      ),
    ).toBe("Startup failed");
  });

  it("still falls through to the conclusion label once completed", () => {
    expect(
      formatPrCheckStatusLabel(
        checkContext({ status: "completed", conclusion: "failure" }),
      ),
    ).toBe("Failure");
  });
});
