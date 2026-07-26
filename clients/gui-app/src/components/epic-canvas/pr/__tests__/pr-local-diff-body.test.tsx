import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrGetLocalDiffResponse } from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { PrLocalDiffBody } from "@/components/epic-canvas/pr/pr-local-diff-body";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";

/**
 * The PR diff tile's body: the drift banner, per-file collapse, and the
 * sentence shown when there is no local diff to read.
 *
 * `@pierre/diffs` is stubbed - it renders through a worker-backed highlight
 * pipeline that has no place in a jsdom assertion about which branch was
 * taken. The stub still proves the patch text reached the renderer.
 */

const toggleSpy = vi.hoisted(() => ({
  calls: [] as { readonly tabId: string; readonly filePath: string }[],
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (
    selector: (state: {
      togglePrDiffFileCollapsedInTab: (
        tabId: string,
        tileId: string,
        filePath: string,
      ) => void;
    }) => unknown,
  ) =>
    selector({
      togglePrDiffFileCollapsedInTab: (tabId, _tileId, filePath) => {
        toggleSpy.calls.push({ tabId, filePath });
      },
    }),
}));

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentPrimitive: (props: { readonly patch: string }) => (
    <pre data-testid="diff-content">{props.patch}</pre>
  ),
  DiffContentFrame: null,
}));

function tile(collapsedFilePaths: readonly string[]): PrDiffTileRef {
  const base = makePrDiffTile({
    hostId: "host-1",
    githubHost: "github.com",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  });
  return { ...base, view: { collapsedFilePaths: [...collapsedFilePaths] } };
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
  readonly result: PrGetLocalDiffResponse | null;
  readonly hasTarget: boolean;
  readonly isError: boolean;
  readonly collapsed: readonly string[];
}): void {
  render(
    <PrLocalDiffBody
      node={tile(args.collapsed)}
      viewTabId="tab-1"
      result={args.result}
      hasTarget={args.hasTarget}
      isError={args.isError}
      prUrl="https://github.com/acme/widgets/pull/7"
      preferences={DEFAULT_DIFF_VIEWER_PREFERENCES}
    />,
  );
}

afterEach(() => {
  cleanup();
  toggleSpy.calls = [];
});

describe("PrLocalDiffBody", () => {
  it("renders the patch for each file in the range", () => {
    renderBody({
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    expect(screen.getByTestId("diff-content").textContent).toContain("+new");
    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
  });

  it("warns when the local tip differs from the PR's head, and still shows the diff", () => {
    renderBody({
      result: diffResponse({ isStale: true, localHeadOid: "d".repeat(40) }),
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    expect(screen.getByTestId("pr-diff-stale").textContent).toContain(
      "ddddddd",
    );
    // A checkout one commit behind is right about almost everything; refusing
    // to render would be the worse answer.
    expect(screen.getByTestId("diff-content")).toBeTruthy();
  });

  it("does not warn when the tips agree", () => {
    renderBody({
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    expect(screen.queryByTestId("pr-diff-stale")).toBeNull();
  });

  it("renders no patch for a collapsed file", () => {
    // Not hidden with CSS: a 200-file PR would otherwise parse and mount every
    // patch the moment the tile opens.
    renderBody({
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
      collapsed: ["src/a.ts"],
    });

    expect(screen.queryByTestId("diff-content")).toBeNull();
    expect(screen.getByTestId("pr-diff-file")).toBeTruthy();
  });

  it("toggles collapse on the tile, keyed by path", () => {
    renderBody({
      result: diffResponse({}),
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    fireEvent.click(screen.getByTestId("pr-diff-file"));

    expect(toggleSpy.calls).toEqual([{ tabId: "tab-1", filePath: "src/a.ts" }]);
  });

  it("labels a rename with both endpoints", () => {
    renderBody({
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
      collapsed: [],
    });

    expect(screen.getByTestId("pr-diff-file").textContent).toContain(
      "old/path.ts → new/path.ts",
    );
  });

  it("distinguishes a binary file from one the budget never reached", () => {
    renderBody({
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
      collapsed: [],
    });

    expect(screen.getByText(/Binary file/u)).toBeTruthy();
    expect(screen.getByText(/exceeded this view/u)).toBeTruthy();
    expect(screen.getByTestId("pr-diff-truncated").textContent).toContain(
      "cut off after 0 of 2 files",
    );
  });

  it("names the reason when the host declines", () => {
    renderBody({
      result: { kind: "unavailable", reason: "ref-unavailable" },
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /Fetching the base branch/u,
    );
  });

  it("distinguishes a missing checkout from a mismatched repo", () => {
    renderBody({
      result: { kind: "unavailable", reason: "repo-mismatch" },
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /uninitialized submodule/u,
    );
  });

  it("falls back to the no-checkout line when the host is too old for the method", () => {
    // `pr.getLocalDiff` rides the optional-capability channel, so a released
    // host that predates it answers E_HOST_UNSUPPORTED - an error here, with
    // no reason to name.
    renderBody({
      result: null,
      hasTarget: true,
      isError: true,
      collapsed: [],
    });

    expect(screen.getByTestId("pr-diff-unavailable").textContent).toMatch(
      /no worktree for this pull request/u,
    );
  });

  it("reports an empty range distinctly from an unavailable one", () => {
    renderBody({
      result: diffResponse({ files: [] }),
      hasTarget: true,
      isError: false,
      collapsed: [],
    });

    expect(screen.getByTestId("pr-diff-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-diff-unavailable")).toBeNull();
  });
});
