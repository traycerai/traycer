/**
 * The compact PDF diff block (diff-surface redesign, 2026-09-03): one
 * centered summary - path, status · size - with a single Open action that
 * opens the CURRENT version as a workspace file tile (latest-only by
 * decision; deleted files therefore have no open affordance). No modal, no
 * Open Externally, no fetching from the block itself.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitFileStatus } from "@traycer/protocol/host";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

// Typed to the real signature, so the recorded intent below is a
// `TileOpenIntent` rather than an `any` the assertions would have to cast.
type OpenTileMock = Mock<(intent: TileOpenIntent) => NestedFocusTarget | null>;

const state = vi.hoisted((): { openTile: OpenTileMock } => ({
  openTile: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

// The block opens through the one tile resolver, so that is what the test
// stands in for - placement, grouping, dedupe and the route write are its
// job, not this component's.
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: state.openTile }),
}));

import { PdfDiffView } from "../pdf-diff-view";

function renderView(overrides: {
  readonly filePath?: string;
  readonly previousPath?: string | null;
  readonly status?: GitFileStatus;
  readonly oldStage?: "staged" | "unstaged" | null;
  readonly newStage?: "staged" | "unstaged" | null;
  readonly sizeBytes?: number | null;
}) {
  return render(
    <PdfDiffView
      hostId="host-A"
      viewTabId="view-1"
      runningDir="/work/repo"
      filePath={overrides.filePath ?? "docs/report.pdf"}
      previousPath={overrides.previousPath ?? null}
      status={overrides.status ?? "modified"}
      oldStage={
        overrides.oldStage === undefined ? "unstaged" : overrides.oldStage
      }
      newStage={
        overrides.newStage === undefined ? "unstaged" : overrides.newStage
      }
      sizeBytes={
        overrides.sizeBytes === undefined ? 2_048 : overrides.sizeBytes
      }
    />,
  );
}

/** The intent the block handed the resolver, or a failure if it opened none. */
function lastIntent(): TileOpenIntent {
  const call = state.openTile.mock.calls.at(-1);
  if (call === undefined) throw new Error("expected an openTile call");
  return call[0];
}

describe("PdfDiffView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a modified PDF as one compact block with path, status and size", () => {
    renderView({});

    expect(screen.getByTestId("pdf-diff-block")).toBeTruthy();
    expect(screen.getByText("docs/report.pdf")).toBeTruthy();
    expect(screen.getByText("Modified · 2.0 KiB")).toBeTruthy();
  });

  it("opens the current version as a workspace file tile", () => {
    renderView({});

    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));

    const intent = lastIntent();
    expect(intent.node).toMatchObject({
      type: "workspace-file",
      hostId: "host-A",
      workspacePath: "/work/repo",
      filePath: "docs/report.pdf",
    });
    expect(intent.target).toEqual({ tabId: "view-1" });
    expect(intent.gesture).toBe("single");
    // The click's modifiers reach the resolver, so shift-click splits here
    // the way it does on every other tile-opening surface.
    expect(intent.modifiers).toEqual({
      shift: false,
      alt: false,
      middle: false,
    });
  });

  it("carries a shift-click through to the resolver as a split", () => {
    renderView({});

    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }), {
      shiftKey: true,
    });

    expect(lastIntent().modifiers).toEqual({
      shift: true,
      alt: false,
      middle: false,
    });
  });

  it("labels an added PDF and still offers Open", () => {
    renderView({ oldStage: null });

    expect(screen.getByText("Added · 2.0 KiB")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open report.pdf" }),
    ).toBeTruthy();
  });

  it("labels a deleted PDF with no open affordance (latest-only decision)", () => {
    renderView({ newStage: null, sizeBytes: null });

    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the old path for a rename", () => {
    renderView({ previousPath: "docs/old-report.pdf", status: "renamed" });

    expect(screen.getByText("Renamed · 2.0 KiB")).toBeTruthy();
    expect(screen.getByText("from docs/old-report.pdf")).toBeTruthy();
  });

  // A copy is shaped exactly like a rename here - two live sides and a
  // distinct `previousPath` - so inferring the label from the paths called
  // it "Renamed" and told the reader a file that is still on disk had moved.
  // Git's own status is the only thing that separates the two.
  it("labels a copied PDF Copied, keeping its source path", () => {
    renderView({ previousPath: "docs/template.pdf", status: "copied" });

    expect(screen.getByText("Copied · 2.0 KiB")).toBeTruthy();
    expect(screen.getByText("from docs/template.pdf")).toBeTruthy();
  });

  it("headlines the deleted (old) path when only the old side exists", () => {
    renderView({
      filePath: "docs/report.pdf",
      previousPath: "docs/old-report.pdf",
      newStage: null,
      sizeBytes: null,
    });

    expect(screen.getByText("docs/old-report.pdf")).toBeTruthy();
  });
});
