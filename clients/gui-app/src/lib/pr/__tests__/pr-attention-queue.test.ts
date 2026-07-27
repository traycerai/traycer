import { describe, it, expect } from "vitest";
import type {
  PrActivityItem,
  PrActivitySection,
  PrCheckContext,
  PrChecksSection,
  PrDetailCore,
} from "@traycer/protocol/host/pr-schemas";
import {
  countPrChecks,
  derivePrAttentionQueue,
  formatPrAttentionHeadline,
  prAttentionRowText,
  stripInlineMarkdown,
  formatPrAttentionSubline,
} from "../pr-attention-queue";

function core(overrides: Partial<PrDetailCore>): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add feature X",
    body: "Some description",
    author: { login: "octocat", avatarUrl: null },
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
    linkGroupKey: "/tmp/worktrees/widgets",
    owners: [],
    ...overrides,
  };
}

function checks(
  contexts: PrCheckContext[],
  isTruncated: boolean,
): PrChecksSection {
  return { observedAt: 1_000, contexts, isTruncated };
}

function activity(
  items: PrActivityItem[],
  isTruncated: boolean,
): PrActivitySection {
  return { observedAt: 1_000, items, isTruncated };
}

function check(
  name: string,
  status: PrCheckContext["status"],
  conclusion: PrCheckContext["conclusion"],
): PrCheckContext {
  return {
    name,
    workflowName: null,
    event: null,
    appName: null,
    appLogoUrl: null,
    description: null,
    status,
    conclusion,
    detailsUrl: `https://ci/${name}`,
  };
}

function review(args: {
  readonly id: string;
  readonly login: string;
  readonly state: Extract<PrActivityItem, { kind: "review" }>["state"];
  readonly createdAt: number;
  readonly body: string;
}): PrActivityItem {
  return {
    kind: "review",
    id: args.id,
    author: { login: args.login, avatarUrl: null },
    body: args.body,
    state: args.state,
    createdAt: args.createdAt,
  };
}

describe("countPrChecks", () => {
  it("buckets by tone and counts cancelled/stale toward the total only", () => {
    const counts = countPrChecks(
      checks(
        [
          check("compile", "completed", "success"),
          check("lint", "completed", "skipped"),
          check("test", "completed", "failure"),
          check("e2e", "in_progress", null),
          check("deploy", "completed", "cancelled"),
        ],
        false,
      ),
    );
    expect(counts).toEqual({ passed: 2, failing: 1, pending: 1, total: 5 });
  });
});

describe("derivePrAttentionQueue", () => {
  it("queues failing checks and ignores passing and pending ones", () => {
    const queue = derivePrAttentionQueue({
      core: core({}),
      checks: checks(
        [
          check("compile", "completed", "success"),
          check("test", "completed", "failure"),
          check("e2e", "in_progress", null),
        ],
        false,
      ),
      activity: activity([], false),
    });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      kind: "check-failure",
      title: "test",
      detail: "Failure",
      detailsUrl: "https://ci/test",
    });
  });

  it("lets a later review from the same login supersede an earlier one", () => {
    const queue = derivePrAttentionQueue({
      core: core({}),
      checks: checks([], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "coderabbitai",
            state: "changes_requested",
            createdAt: 10,
            body: "Fix this",
          }),
          review({
            id: "r2",
            login: "coderabbitai",
            state: "approved",
            createdAt: 20,
            body: "Looks good",
          }),
        ],
        false,
      ),
    });
    expect(queue.items).toEqual([]);
  });

  it("keeps a standing objection when the later review is from someone else", () => {
    const queue = derivePrAttentionQueue({
      core: core({}),
      checks: checks([], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "coderabbitai",
            state: "changes_requested",
            createdAt: 10,
            body: "Fix this",
          }),
          review({
            id: "r2",
            login: "tgill",
            state: "approved",
            createdAt: 20,
            body: "Fine by me",
          }),
        ],
        false,
      ),
    });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      kind: "changes-requested",
      title: "coderabbitai",
      detail: "Fix this",
    });
  });

  it("clears an objection that has been re-requested", () => {
    const queue = derivePrAttentionQueue({
      core: core({
        reviewRequests: [
          { login: "coderabbitai", avatarUrl: null, kind: "user" },
        ],
      }),
      checks: checks([], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "coderabbitai",
            state: "changes_requested",
            createdAt: 10,
            body: "Fix this",
          }),
        ],
        false,
      ),
    });
    expect(queue.items).toEqual([]);
  });

  it("uses the first non-blank line of a review body as the row's evidence", () => {
    const queue = derivePrAttentionQueue({
      core: core({}),
      checks: checks([], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "coderabbitai",
            state: "changes_requested",
            createdAt: 10,
            body: "\n\n  The exp cap is not enforced offline.\nMore detail follows.",
          }),
        ],
        false,
      ),
    });
    expect(queue.items[0].detail).toBe("The exp cap is not enforced offline.");
  });

  it("surfaces review-required only when nothing concrete blocks", () => {
    const blocked = derivePrAttentionQueue({
      core: core({ reviewDecision: "review_required" }),
      checks: checks([], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "coderabbitai",
            state: "changes_requested",
            createdAt: 10,
            body: "Fix this",
          }),
        ],
        false,
      ),
    });
    expect(blocked.items.map((item) => item.kind)).toEqual([
      "changes-requested",
    ]);

    const bare = derivePrAttentionQueue({
      core: core({ reviewDecision: "review_required" }),
      checks: checks([], false),
      activity: activity([], false),
    });
    expect(bare.items.map((item) => item.kind)).toEqual(["review-required"]);
  });

  it("ranks failing checks above objections above review-required", () => {
    const queue = derivePrAttentionQueue({
      core: core({ reviewDecision: "review_required" }),
      checks: checks([check("test", "completed", "failure")], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "coderabbitai",
            state: "changes_requested",
            createdAt: 10,
            body: "Fix this",
          }),
        ],
        false,
      ),
    });
    expect(queue.items.map((item) => item.kind)).toEqual([
      "check-failure",
      "changes-requested",
    ]);
  });

  it("orders objections newest first", () => {
    const queue = derivePrAttentionQueue({
      core: core({}),
      checks: checks([], false),
      activity: activity(
        [
          review({
            id: "r1",
            login: "alice",
            state: "changes_requested",
            createdAt: 10,
            body: "older",
          }),
          review({
            id: "r2",
            login: "bob",
            state: "changes_requested",
            createdAt: 30,
            body: "newer",
          }),
        ],
        false,
      ),
    });
    expect(queue.items.map((item) => item.title)).toEqual(["bob", "alice"]);
  });

  it("produces no items for a merged or closed PR but keeps its counts", () => {
    for (const state of ["merged", "closed"] as const) {
      const queue = derivePrAttentionQueue({
        core: core({ state, reviewDecision: "review_required" }),
        checks: checks([check("test", "completed", "failure")], false),
        activity: activity(
          [
            review({
              id: "r1",
              login: "coderabbitai",
              state: "changes_requested",
              createdAt: 10,
              body: "Fix",
            }),
          ],
          false,
        ),
      });
      expect(queue.items).toEqual([]);
      expect(queue.checkCounts.failing).toBe(1);
      expect(queue.reviewDecision).toBe("review_required");
    }
  });

  it("reports truncation from either window", () => {
    expect(
      derivePrAttentionQueue({
        core: core({}),
        checks: checks([], true),
        activity: activity([], false),
      }).isWindowTruncated,
    ).toBe(true);
    expect(
      derivePrAttentionQueue({
        core: core({}),
        checks: checks([], false),
        activity: activity([], true),
      }).isWindowTruncated,
    ).toBe(true);
    expect(
      derivePrAttentionQueue({
        core: core({}),
        checks: checks([], false),
        activity: activity([], false),
      }).isWindowTruncated,
    ).toBe(false);
  });
});

describe("queue hero copy", () => {
  it("agrees in number", () => {
    const one = derivePrAttentionQueue({
      core: core({}),
      checks: checks([check("test", "completed", "failure")], false),
      activity: activity([], false),
    });
    expect(formatPrAttentionHeadline(one)).toBe("1 thing needs you");
    expect(formatPrAttentionSubline(one)).toBe("1 failing check");

    const two = derivePrAttentionQueue({
      core: core({}),
      checks: checks(
        [
          check("test", "completed", "failure"),
          check("compile", "completed", "failure"),
        ],
        false,
      ),
      activity: activity([], false),
    });
    expect(formatPrAttentionHeadline(two)).toBe("2 things need you");
    expect(formatPrAttentionSubline(two)).toBe("2 failing checks");
  });

  it("describes the calm state from what actually passed", () => {
    const calm = derivePrAttentionQueue({
      core: core({ reviewDecision: "approved" }),
      checks: checks(
        [
          check("test", "completed", "success"),
          check("compile", "completed", "success"),
          check("e2e", "in_progress", null),
        ],
        false,
      ),
      activity: activity([], false),
    });
    expect(formatPrAttentionHeadline(calm)).toBe("Nothing blocking");
    expect(formatPrAttentionSubline(calm)).toBe(
      "2 checks passed · 1 still running · approved",
    );
  });

  it("has no subline when there is nothing to describe", () => {
    const empty = derivePrAttentionQueue({
      core: core({}),
      checks: checks([], false),
      activity: activity([], false),
    });
    expect(formatPrAttentionSubline(empty)).toBeNull();
  });
});

describe("stripInlineMarkdown", () => {
  it("removes the emphasis markers CodeRabbit wraps its headline in", () => {
    // The queue draws this line as plain text, so the markdown arrived intact
    // and rendered as literal asterisks around the only sentence on the card.
    expect(stripInlineMarkdown("**Actionable comments posted: 1**")).toBe(
      "Actionable comments posted: 1",
    );
  });

  it("handles the other inline forms a first line actually carries", () => {
    expect(stripInlineMarkdown("__bold__ and _em_ and ~~gone~~")).toBe(
      "bold and em and gone",
    );
    expect(stripInlineMarkdown("`useState` is wrong here")).toBe(
      "useState is wrong here",
    );
    expect(stripInlineMarkdown("See [the docs](https://x.dev/a) for why")).toBe(
      "See the docs for why",
    );
    expect(stripInlineMarkdown("## Summary")).toBe("Summary");
    expect(stripInlineMarkdown("> quoted objection")).toBe("quoted objection");
    expect(stripInlineMarkdown("- a bullet")).toBe("a bullet");
  });

  it("leaves ordinary prose - and intra-word punctuation - alone", () => {
    expect(stripInlineMarkdown("The cap is not enforced offline.")).toBe(
      "The cap is not enforced offline.",
    );
    // An underscore inside an identifier is not emphasis.
    expect(stripInlineMarkdown("check build_prod before merging")).toBe(
      "check build_prod before merging",
    );
    // A lone marker with nothing to close it is left as written rather than
    // half-stripped, which reads worse than not parsing at all.
    expect(stripInlineMarkdown("2 * 3 is 6")).toBe("2 * 3 is 6");
  });
});

describe("prAttentionRowText", () => {
  const base = {
    key: "k",
    detail: null,
    actor: null,
    iconUrl: null,
    detailsUrl: null,
    createdAt: 1,
  } as const;

  it("leads a check with its name and follows with its verdict", () => {
    expect(
      prAttentionRowText({
        ...base,
        kind: "check-failure",
        title: "pre-commit",
        detail: "Failure",
      }),
    ).toEqual({
      headline: "pre-commit",
      meta: "Failure",
      isIdentifier: true,
    });
  });

  it("leads a review with what it SAID, and attributes it underneath", () => {
    // The two kinds put different things in `title`: for a review it is the
    // reviewer, so rendering both alike put a login where the work should be.
    expect(
      prAttentionRowText({
        ...base,
        kind: "changes-requested",
        title: "coderabbitai",
        detail: "Actionable comments posted: 1",
      }),
    ).toEqual({
      headline: "Actionable comments posted: 1",
      meta: "coderabbitai",
      isIdentifier: false,
    });
  });

  it("falls back to the title when a review left no body", () => {
    expect(
      prAttentionRowText({
        ...base,
        kind: "changes-requested",
        title: "coderabbitai",
        detail: null,
      }),
    ).toEqual({ headline: "coderabbitai", meta: null, isIdentifier: false });
  });
});
