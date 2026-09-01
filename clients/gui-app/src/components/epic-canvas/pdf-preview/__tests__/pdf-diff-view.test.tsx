/**
 * The compact PDF diff block (diff-surface redesign, 2026-09-03): one
 * centered summary - path, status · size - with a single Open action that
 * opens the CURRENT version as a workspace file tile (latest-only by
 * decision; deleted files therefore have no open affordance). No modal, no
 * Open Externally, no fetching from the block itself.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(
  (): {
    prepareOpenTileInTabFocusTarget: Mock;
    navigateNested: Mock;
  } => ({
    prepareOpenTileInTabFocusTarget: vi.fn(),
    navigateNested: vi.fn(
      (_epicId: string, _viewTabId: string, fn: () => unknown) => fn(),
    ),
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => state.navigateNested,
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: <T,>(
    selector: (store: { readonly prepareOpenTileInTabFocusTarget: Mock }) => T,
  ): T =>
    selector({
      prepareOpenTileInTabFocusTarget: state.prepareOpenTileInTabFocusTarget,
    }),
}));

import { PdfDiffView } from "../pdf-diff-view";

function renderView(overrides: {
  readonly filePath?: string;
  readonly previousPath?: string | null;
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

    expect(state.prepareOpenTileInTabFocusTarget).toHaveBeenCalledWith(
      "view-1",
      expect.objectContaining({
        type: "workspace-file",
        hostId: "host-A",
        workspacePath: "/work/repo",
        filePath: "docs/report.pdf",
      }),
    );
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
    renderView({ previousPath: "docs/old-report.pdf" });

    expect(screen.getByText("Renamed · 2.0 KiB")).toBeTruthy();
    expect(screen.getByText("from docs/old-report.pdf")).toBeTruthy();
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
