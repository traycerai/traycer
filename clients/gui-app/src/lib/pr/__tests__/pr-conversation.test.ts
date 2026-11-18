import { describe, it, expect } from "vitest";
import type {
  PrActivityItem,
  PrReviewThread,
} from "@traycer/protocol/host/pr-schemas";
import {
  countPrConversationCards,
  groupPrConversation,
  partitionThreadsByResolution,
  prReviewThreadAnchor,
} from "../pr-conversation";

function review(args: {
  readonly id: string;
  readonly login: string | null;
  readonly state: Extract<PrActivityItem, { kind: "review" }>["state"];
  readonly body: string;
}): PrActivityItem {
  return {
    kind: "review",
    id: args.id,
    author: args.login === null ? null : { login: args.login, avatarUrl: null },
    body: args.body,
    state: args.state,
    createdAt: 1_000,
  };
}

function comment(args: {
  readonly id: string;
  readonly body: string;
}): PrActivityItem {
  return {
    kind: "comment",
    id: args.id,
    author: { login: "octocat", avatarUrl: null },
    body: args.body,
    createdAt: 1_000,
  };
}

function thread(args: {
  readonly id: string;
  readonly reviewId: string | null;
  readonly isResolved: boolean;
  readonly line: number | null;
  readonly originalLine: number | null;
}): PrReviewThread {
  return {
    id: args.id,
    reviewId: args.reviewId,
    path: "src/a.ts",
    line: args.line,
    originalLine: args.originalLine,
    side: "right",
    subject: "line",
    isResolved: args.isResolved,
    isOutdated: args.line === null,
    diffHunk: "@@ -1 +1 @@\n-old\n+new",
    comments: [
      {
        id: `${args.id}-c1`,
        author: { login: "coderabbitai", avatarUrl: null },
        body: "This cap is not enforced offline.",
        createdAt: 1_000,
        url: null,
      },
    ],
    totalCommentCount: 1,
  };
}

describe("groupPrConversation", () => {
  it("folds consecutive body-less reviews from the same login and verdict into one counted event", () => {
    const { entries } = groupPrConversation(
      [
        review({
          id: "r1",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
        review({
          id: "r2",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
        review({
          id: "r3",
          login: "coderabbitai",
          state: "commented",
          body: " ",
        }),
      ],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "event",
      key: "review:r1",
      repeats: 3,
    });
  });

  it("does not fold across a change of verdict or of author", () => {
    const { entries } = groupPrConversation(
      [
        review({
          id: "r1",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
        review({
          id: "r2",
          login: "coderabbitai",
          state: "approved",
          body: "",
        }),
        review({ id: "r3", login: "tgill", state: "approved", body: "" }),
      ],
      [],
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      "review:r1",
      "review:r2",
      "review:r3",
    ]);
    expect(entries.every((entry) => entry.kind === "event")).toBe(true);
  });

  it("does not fold across an intervening card", () => {
    const { entries } = groupPrConversation(
      [
        review({
          id: "r1",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
        comment({ id: "c1", body: "a human says something" }),
        review({
          id: "r2",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
      ],
      [],
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "event",
      "card",
      "event",
    ]);
  });

  it("treats two unknown authors as the same actor rather than two nulls", () => {
    const { entries } = groupPrConversation(
      [
        review({ id: "r1", login: null, state: "commented", body: "" }),
        review({ id: "r2", login: null, state: "commented", body: "" }),
      ],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ repeats: 2 });
  });

  it("gives a review with a body a card, never an event", () => {
    const { entries } = groupPrConversation(
      [
        review({
          id: "r1",
          login: "coderabbitai",
          state: "changes_requested",
          body: "The exp cap is not enforced offline.",
        }),
      ],
      [],
    );
    expect(entries[0]).toMatchObject({ kind: "card", key: "review:r1" });
  });

  it("keeps a body-less comment as a card - dropping it would hide a fact", () => {
    const { entries } = groupPrConversation(
      [comment({ id: "c1", body: "" })],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "card", key: "comment:c1" });
  });

  it("counts only the entries that carry text", () => {
    const { entries } = groupPrConversation(
      [
        review({
          id: "r1",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
        comment({ id: "c1", body: "hello" }),
        review({
          id: "r2",
          login: "tgill",
          state: "approved",
          body: "ship it",
        }),
      ],
      [],
    );
    expect(countPrConversationCards(entries)).toBe(2);
  });

  it("attaches a thread to the review that submitted it", () => {
    const { entries, orphanThreads } = groupPrConversation(
      [
        review({
          id: "PRR_1",
          login: "coderabbitai",
          state: "changes_requested",
          body: "Actionable comments posted: 2",
        }),
      ],
      [
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 22,
          originalLine: 22,
        }),
        thread({
          id: "t2",
          reviewId: "PRR_1",
          isResolved: true,
          line: 40,
          originalLine: 40,
        }),
      ],
    );
    expect(orphanThreads).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "card", key: "review:PRR_1" });
    const entry = entries[0];
    if (entry.kind !== "card") throw new Error("expected a card entry");
    expect(entry.threads.map((each) => each.id)).toEqual(["t1", "t2"]);
  });

  it("gives a body-less review a CARD when it submitted findings", () => {
    // This is the whole feature: folding it into a one-line event would take
    // its findings with it, which is the bug the threads exist to fix.
    const { entries } = groupPrConversation(
      [
        review({
          id: "PRR_1",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
      ],
      [
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 22,
          originalLine: 22,
        }),
      ],
    );
    expect(entries[0]).toMatchObject({ kind: "card", key: "review:PRR_1" });
  });

  it("still folds a body-less review that submitted NO findings", () => {
    const { entries } = groupPrConversation(
      [
        review({
          id: "r1",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
        review({
          id: "r2",
          login: "coderabbitai",
          state: "commented",
          body: "",
        }),
      ],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "event", repeats: 2 });
  });

  it("reports a thread whose review is outside the window as an orphan", () => {
    // The review fell out of the 20-item activity window, or the cached fact
    // predates review ids. Dropping it would hide an unresolved finding.
    const { entries, orphanThreads } = groupPrConversation(
      [comment({ id: "c1", body: "unrelated" })],
      [
        thread({
          id: "t1",
          reviewId: "PRR_gone",
          isResolved: false,
          line: 22,
          originalLine: 22,
        }),
        thread({
          id: "t2",
          reviewId: null,
          isResolved: false,
          line: 30,
          originalLine: 30,
        }),
      ],
    );
    expect(entries).toHaveLength(1);
    expect(orphanThreads.map((each) => each.id)).toEqual(["t1", "t2"]);
  });
});

describe("partitionThreadsByResolution", () => {
  it("puts open findings first and keeps resolved ones reachable", () => {
    const open = thread({
      id: "t1",
      reviewId: "r",
      isResolved: false,
      line: 1,
      originalLine: 1,
    });
    const resolved = thread({
      id: "t2",
      reviewId: "r",
      isResolved: true,
      line: 2,
      originalLine: 2,
    });
    const split = partitionThreadsByResolution([resolved, open]);
    expect(split.open.map((each) => each.id)).toEqual(["t1"]);
    expect(split.resolved.map((each) => each.id)).toEqual(["t2"]);
  });
});

describe("prReviewThreadAnchor", () => {
  it("uses the current line when the thread is live", () => {
    expect(
      prReviewThreadAnchor(
        thread({
          id: "t",
          reviewId: "r",
          isResolved: false,
          line: 128,
          originalLine: 120,
        }),
      ),
    ).toEqual({ label: "src/a.ts:128", isOriginal: false });
  });

  it("falls back to the original line for an outdated thread, and says so", () => {
    // GitHub returns `line: null` once the code has moved or gone. Rendering
    // just the path would drop the only anchor the reader has left.
    expect(
      prReviewThreadAnchor(
        thread({
          id: "t",
          reviewId: "r",
          isResolved: false,
          line: null,
          originalLine: 191,
        }),
      ),
    ).toEqual({ label: "src/a.ts:191", isOriginal: true });
  });

  it("names only the file for a file-level thread", () => {
    const base = thread({
      id: "t",
      reviewId: "r",
      isResolved: false,
      line: null,
      originalLine: null,
    });
    expect(prReviewThreadAnchor({ ...base, subject: "file" })).toEqual({
      label: "src/a.ts",
      isOriginal: false,
    });
  });
});
