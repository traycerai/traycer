import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PrAttentionItem,
  PrAttentionQueue,
} from "@/lib/pr/pr-attention-queue";
import { PrDetailQueue } from "@/components/epic-canvas/pr/pr-detail-queue";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";

/**
 * The Overview hero. Two things it must NOT do: shout its own caveat louder
 * than the work it is listing, and offer a second route to GitHub next to
 * every row when the header already carries one.
 */

function item(overrides: Partial<PrAttentionItem>): PrAttentionItem {
  return {
    key: "k1",
    kind: "changes-requested",
    title: "coderabbitai",
    detail: "Actionable comments posted: 1",
    actor: { login: "coderabbitai", avatarUrl: null },
    iconUrl: null,
    detailsUrl: "https://github.com/acme/widgets/pull/7#review-1",
    createdAt: 1_000,
    ...overrides,
  };
}

function queue(overrides: Partial<PrAttentionQueue>): PrAttentionQueue {
  return {
    items: [item({})],
    isWindowTruncated: false,
    checkCounts: { passed: 2, failing: 0, pending: 0, total: 2 },
    reviewDecision: "changes_requested",
    ...overrides,
  };
}

function renderQueue(
  value: PrAttentionQueue,
  onOpenDetails: (url: string) => void,
): void {
  render(
    <PrDetailQueue
      queue={value}
      target={{
        id: "chat-1",
        kind: "chat",
        title: "Technical Support",
        updatedAt: 1,
      }}
      onSendItem={() => undefined}
      onOpenDetails={onOpenDetails}
    />,
  );
}

afterEach(cleanup);

describe("PrDetailQueue", () => {
  it("keeps the window caveat as an icon rather than a bright banner", () => {
    // It used to be a full-width warning-toned row: the least urgent thing on
    // the page was the first thing the eye reached.
    renderQueue(queue({ isWindowTruncated: true }), () => undefined);

    const note = screen.getByTestId("pr-detail-queue-truncated");
    expect(tooltipTextFor(note)).toMatch(/older feedback may exist/u);
    // The sentence is not rendered as visible body text anywhere.
    expect(
      screen.queryByText(/Derived from the last 20 activity items/u),
    ).toBeNull();
  });

  it("shows the caveat in the header, not below the rows", () => {
    renderQueue(queue({ isWindowTruncated: true }), () => undefined);

    const note = screen.getByTestId("pr-detail-queue-truncated");
    const firstRow = screen.getByTestId("pr-detail-queue-row");
    // `compareDocumentPosition` returns FOLLOWING when `firstRow` comes after.
    expect(
      note.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("omits the caveat entirely when the window was not truncated", () => {
    renderQueue(queue({ isWindowTruncated: false }), () => undefined);
    expect(screen.queryByTestId("pr-detail-queue-truncated")).toBeNull();
  });

  it("offers no per-row GitHub link beside Fix in chat", () => {
    // The header already carries one for the PR; a second external-link glyph
    // on every row competed with the action that matters here.
    renderQueue(queue({}), () => undefined);

    expect(screen.getByTestId("pr-detail-queue-send")).toBeTruthy();
    expect(screen.queryByTestId("pr-detail-queue-details")).toBeNull();
    expect(screen.queryByLabelText("Open on GitHub")).toBeNull();
  });

  it("still renders the calm state with no caveat and no rows", () => {
    renderQueue(
      queue({ items: [], isWindowTruncated: false }),
      () => undefined,
    );

    const section = screen.getByTestId("pr-detail-queue");
    expect(section.getAttribute("data-calm")).toBe("true");
    expect(screen.queryByTestId("pr-detail-queue-row")).toBeNull();
  });

  it("makes the headline itself the link, like the Checks tab", () => {
    const opened: string[] = [];
    renderQueue(queue({}), (url) => opened.push(url));

    fireEvent.click(screen.getByTestId("pr-detail-queue-headline"));
    expect(opened).toEqual(["https://github.com/acme/widgets/pull/7#review-1"]);
  });

  it("renders a headline with no url as plain text, not a dead control", () => {
    renderQueue(
      queue({ items: [item({ detailsUrl: null })] }),
      () => undefined,
    );
    expect(screen.getByTestId("pr-detail-queue-headline").tagName).toBe("P");
  });

  it("shows the reporting app's mark for a check, which has no actor", () => {
    renderQueue(
      queue({
        items: [
          item({
            kind: "check-failure",
            title: "Run Pre-commit / pre-commit (pull_request)",
            detail: "Failure",
            actor: null,
            iconUrl: "https://avatars/actions.png",
          }),
        ],
      }),
      () => undefined,
    );

    expect(
      screen.getByTestId("pr-detail-queue-app-mark").getAttribute("src"),
    ).toBe("https://avatars/actions.png");
    // The FULL composed name, not the bare job name.
    expect(screen.getByTestId("pr-detail-queue-headline").textContent).toBe(
      "Run Pre-commit / pre-commit (pull_request)",
    );
  });
});
