import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  PrDetailCore,
  PrFilesSection,
} from "@traycer/protocol/host/pr-schemas";
import { PrDetailFilesTab } from "@/components/epic-canvas/pr/pr-detail-files-tab";
import { prDiffTileId } from "@/lib/pr/pr-diff-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { RunnerHostContext } from "@/providers/runner-host-context";

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
 * Drives the REAL canvas store (a real tab, opened via `openEpicTab`) rather
 * than mocking it, so these assertions exercise the same content-id dedupe
 * `openTile` uses for every other tile kind - only the nested-focus-navigation
 * hook is faked, since its own async scroll/focus behavior is unrelated to
 * whether the diff tile actually landed in the canvas.
 */

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

/** Opens a real tab in the real canvas store and returns its id. */
function openRealTab(): string {
  return useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
}

function renderTab(args: {
  readonly core: PrDetailCore;
  readonly hostId: string;
  readonly viewTabId: string;
  readonly runnerHost?: MockRunnerHost | null;
}): void {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <RunnerHostContext.Provider value={args.runnerHost ?? null}>
        <PrDetailFilesTab
          core={args.core}
          files={FILES}
          epicId="epic-1"
          viewTabId={args.viewTabId}
          hostId={args.hostId}
          onQuoteFile={null}
        />
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/** Every tile currently open on `tabId`, regardless of pane position. */
function openTileIdsOnTab(tabId: string): readonly string[] {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return Object.values(canvas.tilesByInstanceId)
    .filter((tile) => tile !== undefined)
    .map((tile) => tile.id);
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("PrDetailFilesTab", () => {
  it("renders the changed-file list", () => {
    const viewTabId = openRealTab();
    renderTab({ core: core({}), hostId: "host-1", viewTabId });

    expect(screen.getAllByTestId("pr-detail-file-row")).toHaveLength(2);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("opens the PR's diff tile on the tab it was clicked from", () => {
    const viewTabId = openRealTab();
    renderTab({ core: core({}), hostId: "host-1", viewTabId });

    fireEvent.click(screen.getByTestId("pr-detail-open-diff"));

    const expectedTileId = prDiffTileId({
      hostId: "host-1",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    });
    expect(openTileIdsOnTab(viewTabId)).toEqual([expectedTileId]);
  });

  it("opens the SAME tile id twice, so a second click refocuses (no duplicate tile)", () => {
    const viewTabId = openRealTab();
    renderTab({ core: core({}), hostId: "host-1", viewTabId });
    const button = screen.getByTestId("pr-detail-open-diff");

    fireEvent.click(button);
    fireEvent.click(button);

    // Content-id dedupe (`findPaneTabByContentId`) means a second open of the
    // same PR's diff refocuses the existing tile rather than adding another.
    expect(openTileIdsOnTab(viewTabId)).toHaveLength(1);
  });

  it("opens the diff even for a PR with no local checkout", () => {
    // Whether a checkout exists costs a host round-trip; the TILE reports it.
    // Disabling here would make "no checkout" indistinguishable from a bug.
    const viewTabId = openRealTab();
    renderTab({
      core: core({ linkGroupKey: null }),
      hostId: "host-1",
      viewTabId,
    });

    const button = screen.getByTestId("pr-detail-open-diff");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(openTileIdsOnTab(viewTabId)).toHaveLength(1);
  });

  it("says where the diff comes from, and offers GitHub as the alternative", () => {
    const viewTabId = openRealTab();
    renderTab({ core: core({}), hostId: "host-1", viewTabId });

    expect(screen.getByText(/read from your local checkout/u)).toBeTruthy();
    const link = screen.getByText("View it on GitHub instead");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7/files",
    );
  });

  it("routes the GitHub footer link through the RunnerHost bridge instead of a bare new-tab anchor", async () => {
    // A plain `target="_blank"` anchor opens a second, unmanaged browser
    // surface in the desktop shell; every other GitHub link on this tile
    // goes through `useRunnerOpenExternalLink` instead, and this one used to
    // be the one exception.
    const host = createRunnerHost();
    const openExternalLink = vi
      .spyOn(host, "openExternalLink")
      .mockResolvedValue(undefined);
    const viewTabId = openRealTab();
    renderTab({
      core: core({}),
      hostId: "host-1",
      viewTabId,
      runnerHost: host,
    });

    const link = screen.getByTestId("pr-detail-files-github-footer-link");
    fireEvent.click(link);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(openExternalLink).toHaveBeenCalledTimes(1);
    expect(openExternalLink).toHaveBeenCalledWith(
      "https://github.com/acme/widgets/pull/7/files",
    );
  });

  it("leaves the footer link's native new-tab navigation alone with no RunnerHost bound", () => {
    const viewTabId = openRealTab();
    renderTab({
      core: core({}),
      hostId: "host-1",
      viewTabId,
      runnerHost: null,
    });

    const link = screen.getByTestId("pr-detail-files-github-footer-link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7/files",
    );
  });

  it("renders the empty state without an opener when nothing changed", () => {
    const viewTabId = openRealTab();
    render(
      <QueryClientProvider client={newQueryClient()}>
        <RunnerHostContext.Provider value={null}>
          <PrDetailFilesTab
            core={core({})}
            files={{
              observedAt: 1_000,
              files: [],
              totalCount: 0,
              isTruncated: false,
            }}
            epicId="epic-1"
            viewTabId={viewTabId}
            hostId="host-1"
            onQuoteFile={null}
          />
        </RunnerHostContext.Provider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("pr-detail-files-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-detail-open-diff")).toBeNull();
  });
});
