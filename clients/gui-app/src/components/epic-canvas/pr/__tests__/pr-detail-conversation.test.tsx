import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PrActivitySection,
  PrDetailCore,
  PrReviewThread,
  PrReviewThreadsSection,
} from "@traycer/protocol/host/pr-schemas";
import { PrDetailConversation } from "@/components/epic-canvas/pr/pr-detail-conversation";

/**
 * The Feedback tab, over the case that motivated review threads: a bot review
 * whose body only COUNTS its findings while the findings themselves live in
 * inline threads. Before they were carried, this tab rendered "Actionable
 * comments posted: 5" and nothing else.
 *
 * The markdown renderer is stubbed - it mounts a full pipeline that has no
 * bearing on which branch was taken - but it still proves the body text
 * reached a renderer.
 */
vi.mock("@/markdown/traycer-markdown", () => ({
  TraycerMarkdown: (props: { readonly children: string }) => (
    <div data-testid="markdown">{props.children}</div>
  ),
}));

/**
 * The diff renderer mounts the `@pierre/diffs` worker pipeline, which needs a
 * pool and a theme provider and settles asynchronously. What this file is
 * about is WHICH patch it is handed and whether the gutter is on, so the
 * pipeline is stubbed and both are read straight off the props.
 */
vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: { readonly children: ReactNode }) => (
    <div data-testid="diff-frame">{props.children}</div>
  ),
  DiffContentPrimitive: (props: {
    readonly patch: string;
    readonly lineNumbers: boolean;
  }) => (
    <pre data-testid="diff-patch" data-line-numbers={props.lineNumbers}>
      {props.patch}
    </pre>
  ),
}));

function core(): PrDetailCore {
  return {
    observedAt: 1_000,
    githubHost: "github.com",
    base: { owner: "acme", repo: "widgets", prNumber: 7 },
    prUrl: "https://github.com/acme/widgets/pull/7",
    state: "open",
    isDraft: false,
    title: "Add the cap",
    body: "",
    author: null,
    baseRefName: "main",
    headRefName: "feature/cap",
    headRefOid: "a".repeat(40),
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
    linkGroupKey: "/tmp/w",
    owners: [],
  };
}

function activity(items: PrActivitySection["items"]): PrActivitySection {
  return { observedAt: 1_000, items, isTruncated: false };
}

function botReview(
  id: string,
  body: string,
): PrActivitySection["items"][number] {
  return {
    kind: "review",
    id,
    author: { login: "coderabbitai", avatarUrl: null },
    body,
    state: "changes_requested",
    createdAt: 1_000,
  };
}

function thread(args: {
  readonly id: string;
  readonly reviewId: string | null;
  readonly isResolved: boolean;
  readonly line: number | null;
  readonly body: string;
  readonly totalCommentCount: number;
}): PrReviewThread {
  return {
    id: args.id,
    reviewId: args.reviewId,
    path: "src/domain/git/git-service.ts",
    line: args.line,
    originalLine: 1120,
    side: "right",
    subject: "line",
    isResolved: args.isResolved,
    isOutdated: args.line === null,
    diffHunk: "@@ -1139,3 +1139,4 @@\n+  const cap = 5;",
    comments: [
      {
        id: `${args.id}-c1`,
        author: { login: "coderabbitai", avatarUrl: null },
        body: args.body,
        createdAt: 1_000,
        url: null,
      },
    ],
    totalCommentCount: args.totalCommentCount,
  };
}

function threads(list: readonly PrReviewThread[]): PrReviewThreadsSection {
  return { observedAt: 1_000, threads: [...list], isTruncated: false };
}

function renderTab(args: {
  readonly activity: PrActivitySection;
  readonly reviewThreads: PrReviewThreadsSection;
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): void {
  render(
    <PrDetailConversation
      core={core()}
      activity={args.activity}
      reviewThreads={args.reviewThreads}
      onQuoteItem={null}
      onQuoteThread={args.onQuoteThread}
    />,
  );
}

afterEach(cleanup);

describe("PrDetailConversation review threads", () => {
  it("shows a bot review's findings under the card that counts them", () => {
    renderTab({
      activity: activity([
        botReview("PRR_1", "**Actionable comments posted: 2**"),
      ]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 1141,
          body: "The cap is not enforced offline.",
          totalCommentCount: 1,
        }),
        thread({
          id: "t2",
          reviewId: "PRR_1",
          isResolved: false,
          line: 1205,
          body: "This branch is unreachable.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    // The review card is still one card...
    expect(screen.getAllByTestId("pr-detail-activity-item")).toHaveLength(1);
    // ...and both findings render inside it, rather than the count alone.
    const rendered = screen.getAllByTestId("pr-detail-review-thread");
    expect(rendered).toHaveLength(2);
    expect(screen.getByText(/not enforced offline/u)).toBeTruthy();
    expect(screen.getByText(/branch is unreachable/u)).toBeTruthy();
    expect(screen.getByText("src/domain/git/git-service.ts:1141")).toBeTruthy();
  });

  it("renders resolved findings as collapsed rows, keeping open ones in view", () => {
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 3")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 10,
          body: "Still open.",
          totalCommentCount: 1,
        }),
        thread({
          id: "t2",
          reviewId: "PRR_1",
          isResolved: true,
          line: 20,
          body: "Already handled.",
          totalCommentCount: 1,
        }),
        thread({
          id: "t3",
          reviewId: "PRR_1",
          isResolved: true,
          line: 30,
          body: "Also handled.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    // The open one renders in full - the tab is about what is still blocking.
    const open = screen.getAllByTestId("pr-detail-review-thread");
    expect(open).toHaveLength(1);
    expect(open[0]?.getAttribute("data-resolved")).toBe("false");
    expect(screen.getByText("Still open.")).toBeTruthy();
    // Each resolved one is a collapsed row naming its file, body unmounted.
    const rows = screen.getAllByTestId("pr-detail-resolved-thread");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("src/domain/git/git-service.ts:20")).toBeTruthy();
    expect(screen.getByText("src/domain/git/git-service.ts:30")).toBeTruthy();
    expect(screen.queryByText("Already handled.")).toBeNull();
  });

  it("gives a body-less review its findings instead of 'No content.'", () => {
    // A review that posts findings without a summary is the common bot shape.
    // Folding it to an event, or printing "No content." over five real
    // objections, both hide the thing the reader came for.
    renderTab({
      activity: activity([botReview("PRR_1", "")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 10,
          body: "A real objection.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    expect(screen.queryByTestId("pr-detail-activity-event")).toBeNull();
    expect(screen.queryByText("No content.")).toBeNull();
    expect(screen.getByText("A real objection.")).toBeTruthy();
  });

  it("anchors an outdated finding to its original line and says so", () => {
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: null,
          body: "This moved.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    expect(screen.getByText("src/domain/git/git-service.ts:1120")).toBeTruthy();
    expect(screen.getByText("Outdated")).toBeTruthy();
  });

  it("says how many replies it is not showing", () => {
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 10,
          body: "First word.",
          totalCommentCount: 4,
        }),
      ]),
      onQuoteThread: null,
    });

    expect(screen.getByText(/3 more replies on GitHub/u)).toBeTruthy();
  });

  it("groups findings whose review is outside the window rather than dropping them", () => {
    renderTab({
      activity: activity([]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_gone",
          isResolved: false,
          line: 10,
          body: "Orphaned but unresolved.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    expect(screen.getByTestId("pr-detail-orphan-threads")).toBeTruthy();
    expect(screen.getByText("Orphaned but unresolved.")).toBeTruthy();
    expect(screen.queryByTestId("pr-detail-conversation-empty")).toBeNull();
  });

  it("gives the thread quote button a hover-reveal ancestor, so it isn't permanently invisible", () => {
    // `PrQuoteAction` only turns visible via `group-hover/header`; without a
    // `group/header` ancestor the button never leaves its transparent resting
    // state no matter how the row is hovered or focused.
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 10,
          body: "Note.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: () => {},
    });

    const button = screen.getByTestId("pr-detail-thread-quote");
    let ancestor: HTMLElement | null = button.parentElement;
    let found = false;
    while (ancestor !== null) {
      if (ancestor.className.split(/\s+/).includes("group/header")) {
        found = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    expect(found).toBe(true);
  });

  it("quotes one finding, not the whole review", () => {
    const quoted: PrReviewThread[] = [];
    const only = thread({
      id: "t1",
      reviewId: "PRR_1",
      isResolved: false,
      line: 10,
      body: "Quote me.",
      totalCommentCount: 1,
    });
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([only]),
      onQuoteThread: (each) => quoted.push(each),
    });

    fireEvent.click(screen.getByTestId("pr-detail-thread-quote"));
    expect(quoted).toEqual([only]);
  });

  it("renders the anchoring hunk as a diff, not as a grey block of text", () => {
    // It used to be a `<pre>` in one flat colour: no gutter, and added,
    // removed, and context all looked alike, so the reader had to decode the
    // `+`/`-` prefixes by eye to see what the comment was even about.
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 1141,
          body: "The cap is not enforced offline.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    const patch = screen.getByTestId("diff-patch");
    // Wrapped in the file headers the parser needs, carrying the thread's path.
    expect(patch.textContent).toContain(
      "diff --git a/src/domain/git/git-service.ts b/src/domain/git/git-service.ts",
    );
    expect(patch.textContent).toContain("+  const cap = 5;");
    // The hunk arrived with its header, so the gutter shows real line numbers.
    expect(patch.getAttribute("data-line-numbers")).toBe("true");
  });

  it("hides the gutter when the hunk reached us without its header", () => {
    const headerless = thread({
      id: "t1",
      reviewId: "PRR_1",
      isResolved: false,
      line: 1141,
      body: "Clipped before renumbering was a thing.",
      totalCommentCount: 1,
    });
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        { ...headerless, diffHunk: "+  const cap = 5;" },
      ]),
      onQuoteThread: null,
    });

    expect(
      screen.getByTestId("diff-patch").getAttribute("data-line-numbers"),
    ).toBe("false");
  });

  it("does not mount a diff for a resolved finding nobody has opened", () => {
    // A collapsed row is a real unmount, not `<details>` CSS hiding - each
    // expanded thread mounts a real diff renderer that parses and highlights
    // its hunk, so only the row the reader opens may pay for one.
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 2")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: true,
          line: 10,
          body: "Already handled.",
          totalCommentCount: 1,
        }),
        thread({
          id: "t2",
          reviewId: "PRR_1",
          isResolved: true,
          line: 20,
          body: "Also handled.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    expect(screen.queryAllByTestId("diff-patch")).toHaveLength(0);
    expect(screen.getAllByTestId("pr-detail-resolved-thread")).toHaveLength(2);
    // Opening one row mounts one renderer, not both.
    fireEvent.click(screen.getByText("src/domain/git/git-service.ts:10"));
    expect(screen.queryAllByTestId("diff-patch")).toHaveLength(1);
    // Folding it back unmounts it again.
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse the resolved thread/u }),
    );
    expect(screen.queryAllByTestId("diff-patch")).toHaveLength(0);
    expect(screen.getAllByTestId("pr-detail-resolved-thread")).toHaveLength(2);
  });

  it("hands keyboard focus to the control that replaces the one it unmounts", () => {
    // Expanding swaps the row out for the card, so the focused control stops
    // existing. Without a handover focus falls back to <body> and the next Tab
    // restarts at the top of the page instead of entering the thread.
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: true,
          line: 10,
          body: "Already handled.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    fireEvent.click(screen.getByText("src/domain/git/git-service.ts:10"));
    const collapse = screen.getByRole("button", {
      name: /Collapse the resolved thread/u,
    });
    expect(document.activeElement).toBe(collapse);
    fireEvent.click(collapse);
    expect(document.activeElement).toBe(
      screen.getByTestId("pr-detail-resolved-thread"),
    );
  });

  it("does not steal focus while resolved rows sit collapsed", () => {
    // The handover effect also runs on mount; firing it there would drag focus
    // onto the last resolved row of every review the tab renders.
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 2")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: true,
          line: 10,
          body: "Already handled.",
          totalCommentCount: 1,
        }),
        thread({
          id: "t2",
          reviewId: "PRR_1",
          isResolved: true,
          line: 20,
          body: "Also handled.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    expect(screen.getAllByTestId("pr-detail-resolved-thread")).toHaveLength(2);
    expect(document.activeElement).toBe(document.body);
  });

  it("sizes every date in a card the same, however deep it sits", () => {
    // A comment's timestamp used to inherit from its container, so the same
    // "9 Jul" appeared twice in one card at two different sizes.
    renderTab({
      activity: activity([botReview("PRR_1", "Actionable comments posted: 1")]),
      reviewThreads: threads([
        thread({
          id: "t1",
          reviewId: "PRR_1",
          isResolved: false,
          line: 10,
          body: "A finding.",
          totalCommentCount: 1,
        }),
      ]),
      onQuoteThread: null,
    });

    // The review's own stamp and its finding's stamp.
    const stamps = screen.getAllByTestId("pr-relative-time");
    expect(stamps.length).toBeGreaterThan(1);
    for (const stamp of stamps) {
      // Asserted on the element itself, not on what it inherits: a size that
      // travels with the component is one no ancestor can forget to set.
      expect(stamp.className).toContain("text-ui-xs");
      expect(stamp.className).toContain("text-muted-foreground");
    }
  });
});
