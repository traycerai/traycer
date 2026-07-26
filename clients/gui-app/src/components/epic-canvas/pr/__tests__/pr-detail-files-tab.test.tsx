import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  PrDetailCore,
  PrFilesSection,
} from "@traycer/protocol/host/pr-schemas";
import { PrDetailFilesTab } from "@/components/epic-canvas/pr/pr-detail-files-tab";
import { prDiffTileId } from "@/lib/pr/pr-diff-tile";

/**
 * The Files tab keeps the GitHub-sourced file list; the DIFF is a tile the
 * list opens.
 *
 * The list is what is always available (it comes off the `pr.subscribeDetail`
 * sweep), while the diff needs a local checkout - so the tab must render fully
 * without one, and the button must open the tile regardless, because "is there
 * a checkout?" costs a host round-trip and a silently-disabled button reads as
 * a broken one.
 *
 * Only the canvas store's open path is faked; the tile ref itself is built by
 * the real `makePrDiffTile`, so the id these assertions check is the id the
 * canvas would actually dedupe on.
 */

const openSpy = vi.hoisted(() => ({
  calls: [] as { readonly tabId: string; readonly tileId: string }[],
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (
    selector: (state: {
      prepareOpenTileInTabFocusTarget: (
        tabId: string,
        tile: { readonly id: string },
      ) => null;
    }) => unknown,
  ) =>
    selector({
      prepareOpenTileInTabFocusTarget: (tabId, tile) => {
        openSpy.calls.push({ tabId, tileId: tile.id });
        return null;
      },
    }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, run: () => unknown) => {
      run();
    },
}));

const FILES: PrFilesSection = {
  observedAt: 1_000,
  files: [
    { path: "src/a.ts", additions: 3, deletions: 1, changeType: "modified" },
    { path: "src/b.ts", additions: 0, deletions: 9, changeType: "deleted" },
  ],
  totalCount: 2,
  isTruncated: false,
};

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
    author: null,
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: "a".repeat(40),
    additions: 3,
    deletions: 10,
    checksRollup: null,
    reviewDecision: null,
    reviewRequests: [],
    commentCount: null,
    updatedAt: 2_000,
    mergedAt: null,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: "/tmp/worktrees/widgets",
    owners: [],
    ...overrides,
  };
}

function renderTab(args: {
  readonly core: PrDetailCore;
  readonly hostId: string;
}): void {
  render(
    <PrDetailFilesTab
      core={args.core}
      files={FILES}
      epicId="epic-1"
      viewTabId="tab-1"
      hostId={args.hostId}
      onQuoteFile={null}
    />,
  );
}

afterEach(() => {
  cleanup();
  openSpy.calls = [];
});

describe("PrDetailFilesTab", () => {
  it("renders the changed-file list", () => {
    renderTab({ core: core({}), hostId: "host-1" });

    expect(screen.getAllByTestId("pr-detail-file-row")).toHaveLength(2);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("opens the PR's diff tile on the tab it was clicked from", () => {
    renderTab({ core: core({}), hostId: "host-1" });

    fireEvent.click(screen.getByTestId("pr-detail-open-diff"));

    expect(openSpy.calls).toEqual([
      {
        tabId: "tab-1",
        tileId: prDiffTileId({
          hostId: "host-1",
          githubHost: "github.com",
          owner: "acme",
          repo: "widgets",
          prNumber: 7,
        }),
      },
    ]);
  });

  it("opens the SAME tile id twice, so a second click refocuses", () => {
    renderTab({ core: core({}), hostId: "host-1" });
    const button = screen.getByTestId("pr-detail-open-diff");

    fireEvent.click(button);
    fireEvent.click(button);

    expect(openSpy.calls).toHaveLength(2);
    expect(openSpy.calls[0].tileId).toBe(openSpy.calls[1].tileId);
  });

  it("opens the diff even for a PR with no local checkout", () => {
    // Whether a checkout exists costs a host round-trip; the TILE reports it.
    // Disabling here would make "no checkout" indistinguishable from a bug.
    renderTab({ core: core({ linkGroupKey: null }), hostId: "host-1" });

    const button = screen.getByTestId("pr-detail-open-diff");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(openSpy.calls).toHaveLength(1);
  });

  it("says where the diff comes from, and offers GitHub as the alternative", () => {
    renderTab({ core: core({}), hostId: "host-1" });

    expect(screen.getByText(/read from your local checkout/u)).toBeTruthy();
    const link = screen.getByText("View it on GitHub instead");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7/files",
    );
  });

  it("renders the empty state without an opener when nothing changed", () => {
    render(
      <PrDetailFilesTab
        core={core({})}
        files={{
          observedAt: 1_000,
          files: [],
          totalCount: 0,
          isTruncated: false,
        }}
        epicId="epic-1"
        viewTabId="tab-1"
        hostId="host-1"
        onQuoteFile={null}
      />,
    );

    expect(screen.getByTestId("pr-detail-files-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-detail-open-diff")).toBeNull();
  });
});
