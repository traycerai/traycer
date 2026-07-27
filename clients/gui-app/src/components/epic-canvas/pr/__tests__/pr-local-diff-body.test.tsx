import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrGetLocalDiffResponse } from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { PrLocalDiffBody } from "@/components/epic-canvas/pr/pr-local-diff-body";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";

/**
 * The PR diff tile's body: the drift banner, per-file collapse, and the
 * sentence shown when there is no local diff to read.
 *
 * `@pierre/diffs` is stubbed - it renders through a worker-backed highlight
 * pipeline that has no place in a jsdom assertion about which branch was
 * taken. The stub still proves the patch text reached the renderer.
 *
 * Drives the REAL canvas store (a real tab, with the tile actually inserted
 * into it) rather than mocking `useEpicCanvasStore`: the collapse toggle is
 * dispatched by the tile's deterministic `id`, matched against every tile in
 * the tab's canvas, and a hand-rolled mock that ignores the id argument
 * cannot tell a correctly-keyed toggle from one that hits the wrong tile.
 */

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentPrimitive: (props: { readonly patch: string }) => (
    <pre data-testid="diff-content">{props.patch}</pre>
  ),
  DiffContentFrame: null,
}));

function tile(): PrDiffTileRef {
  return makePrDiffTile({
    hostId: "host-1",
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  });
}

/** Inserts `node` into a real tab's canvas and returns the tab id. */
function openRealTabWithTile(node: PrDiffTileRef): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  useEpicCanvasStore.getState().openTileInTab(tabId, node);
  return tabId;
}

/** The tile as currently held by the real store, for the given tab. */
function tileOnTab(tabId: string, instanceId: string): PrDiffTileRef {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  const ref = canvas?.tilesByInstanceId[instanceId];
  if (ref === undefined || ref.type !== "pr-diff") {
    throw new Error("expected a PR diff tile on the tab");
  }
  return ref;
}

function diffResponse(
  overrides: Partial<Extract<PrGetLocalDiffResponse, { kind: "diff" }>>,
): PrGetLocalDiffResponse {
  return {
    kind: "diff",
    runningDir: "/tmp/worktrees/widgets",
    resolvedBaseRef: "origin/main",
    baseOid: "b".repeat(40),
    mergeBaseOid: "c".repeat(40),
    localHeadOid: "a".repeat(40),
    isStale: false,
    isTruncated: false,
    files: [
      {
        path: "src/a.ts",
        previousPath: null,
        status: "modified",
        insertions: 3,
        deletions: 1,
        isBinary: false,
        patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    ],
    ...overrides,
  };
}

function renderBody(args: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly result: PrGetLocalDiffResponse | null;
  readonly hasTarget: boolean;
  readonly isError: boolean;
}): void {
  render(
    <PrLocalDiffBody
      node={args.node}
      viewTabId={args.viewTabId}
      result={args.result}
      hasTarget={args.hasTarget}
      isError={args.isError}
      prUrl="https://github.com/acme/widgets/pull/7"
      preferences={DEFAULT_DIFF_VIEWER_PREFERENCES}
    />,
  );
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("PrLocalDiffBody", () => {
  it("renders the patch for each file in the range", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByTestId("diff-content").textContent).toContain("+new");
    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
  });

  it("warns when the local tip differs from the PR's head, and still shows the diff", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({ isStale: true, localHeadOid: "d".repeat(40) }),
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByTestId("pr-diff-stale").textContent).toContain(
      "ddddddd",
    );
    // A checkout one commit behind is right about almost everything; refusing
    // to render would be the worse answer.
    expect(screen.getByTestId("diff-content")).toBeTruthy();
  });

  it("does not warn when the tips agree", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
    });

    expect(screen.queryByTestId("pr-diff-stale")).toBeNull();
  });

  it("renders no patch for a collapsed file", () => {
    // Not hidden with CSS: a 200-file PR would otherwise parse and mount every
    // patch the moment the tile opens.
    const node: PrDiffTileRef = {
      ...tile(),
      view: { collapsedFilePaths: ["src/a.ts"] },
    };
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
    });

    expect(screen.queryByTestId("diff-content")).toBeNull();
    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
  });

  it("toggles collapse on the tile actually held by the store, keyed by path", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
    });

    // The collapse control is a real `<button aria-expanded>`, so drive it by
    // role and accessible name: that pins the semantics a keyboard/screen
    // reader user depends on, which a test-id click would let regress.
    const toggle = screen.getByRole("button", { name: /src\/a\.ts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    expect(tileOnTab(tabId, node.instanceId).view.collapsedFilePaths).toEqual([
      "src/a.ts",
    ]);
  });

  it("labels a rename with both endpoints", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({
        files: [
          {
            path: "new/path.ts",
            previousPath: "old/path.ts",
            status: "renamed",
            insertions: 1,
            deletions: 1,
            isBinary: false,
            patch:
              "diff --git a/old/path.ts b/new/path.ts\n@@ -1 +1 @@\n-a\n+b",
          },
        ],
      }),
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByTestId("pr-diff-file").textContent).toContain(
      "old/path.ts → new/path.ts",
    );
  });

  it("distinguishes a binary file from one the budget never reached", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({
        isTruncated: true,
        files: [
          {
            path: "logo.png",
            previousPath: null,
            status: "modified",
            insertions: null,
            deletions: null,
            isBinary: true,
            patch: null,
          },
          {
            path: "src/big.ts",
            previousPath: null,
            status: "modified",
            insertions: 9_000,
            deletions: 0,
            isBinary: false,
            patch: null,
          },
        ],
      }),
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByText(/Binary file/u)).toBeTruthy();
    expect(screen.getByText(/exceeded this view/u)).toBeTruthy();
    expect(screen.getByTestId("pr-diff-truncated").textContent).toContain(
      "cut off after 0 of 2 files",
    );
  });

  it("names the reason when the host declines", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: { kind: "unavailable", reason: "ref-unavailable" },
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /Fetching the base branch/u,
    );
  });

  it("distinguishes a missing checkout from a mismatched repo", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: { kind: "unavailable", reason: "repo-mismatch" },
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /uninitialized submodule/u,
    );
  });

  it("falls back to the no-checkout line when the host is too old for the method", () => {
    // `pr.getLocalDiff` rides the optional-capability channel, so a released
    // host that predates it answers E_HOST_UNSUPPORTED - an error here, with
    // no reason to name.
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: null,
      hasTarget: true,
      isError: true,
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /no worktree for this pull request/u,
    );
  });

  it("reports an empty range distinctly from an unavailable one", () => {
    const node = tile();
    const tabId = openRealTabWithTile(node);
    renderBody({
      node,
      viewTabId: tabId,
      result: diffResponse({ files: [] }),
      hasTarget: true,
      isError: false,
    });

    expect(screen.getByTestId("pr-diff-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-diff-unavailable")).toBeNull();
  });
});
