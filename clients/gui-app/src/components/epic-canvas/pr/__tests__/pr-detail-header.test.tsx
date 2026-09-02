import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PrDetailCore,
  PrSourceNotice,
} from "@traycer/protocol/host/pr-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrDetailHeader } from "@/components/epic-canvas/pr/pr-detail-header";

/**
 * `PrDetailHeader`'s "Open on GitHub" action - a plain `<a>` whose click
 * routes through {@link useOpenLink} (`"github"` kind) instead of navigating
 * natively.
 */

const openLink = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));

function buildPrDetailCore(overrides: Partial<PrDetailCore>): PrDetailCore {
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
    checksRollup: { success: 1, failure: 0, pending: 0, total: 1 },
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

function renderHeader(
  notice: PrSourceNotice | null,
  observedAt: number | null,
) {
  return render(
    <TooltipProvider>
      <PrDetailHeader
        core={buildPrDetailCore({})}
        epicId="epic-1"
        notLive={false}
        observedAt={observedAt}
        notice={notice}
        refreshing={false}
        onRefresh={() => undefined}
      />
    </TooltipProvider>,
  );
}

describe("PrDetailHeader source notice", () => {
  afterEach(() => {
    cleanup();
  });

  it("says nothing when the fetch layer is running normally", () => {
    // The absence of a notice is the common case, and an always-present ⓘ
    // would train the eye to ignore the one that means something.
    renderHeader(null, 1_000);
    expect(screen.queryByTestId("pr-source-notice")).toBeNull();
  });

  it("shows the pause on the tile header, not just in the panel", () => {
    // A PR opened straight from a deep link never renders the panel, so the
    // tile has to carry the explanation itself.
    renderHeader(
      {
        kind: "rate-limited",
        retryAt: null,
      },
      1_000,
    );
    expect(
      screen.getByTestId("pr-source-notice").getAttribute("data-notice-kind"),
    ).toBe("rate-limited");
  });
});

describe("PrDetailHeader staleness", () => {
  afterEach(() => {
    cleanup();
  });

  it("says 'Not yet fetched' when no PR has ever been observed - the card's own gauge is gone, this is the only freshness stamp on screen", () => {
    renderHeader(null, null);
    expect(screen.getByTestId("pr-detail-staleness").textContent).toBe(
      "Not yet fetched",
    );
  });

  it("says 'Updated …' once a real observedAt is known", () => {
    renderHeader(null, 1_000);
    const staleness = screen.getByTestId("pr-detail-staleness");
    expect(staleness.textContent).not.toBe("Not yet fetched");
    expect(staleness.textContent).toMatch(/^Updated /);
  });
});

describe("PrDetailHeader GitHub link", () => {
  afterEach(() => {
    cleanup();
    openLink.mockReset();
  });

  it("prevents native navigation and routes the click through openLink", () => {
    renderHeader(null, 1_000);

    // By role + accessible name: this also pins the anchor semantics the
    // action depends on, which a test-id query would silently let regress.
    const link = screen.getByRole("link", { name: /GitHub/i });
    fireEvent.click(link);

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith(
      "https://github.com/acme/widgets/pull/7",
      "github",
      expect.anything(),
    );
  });
});
