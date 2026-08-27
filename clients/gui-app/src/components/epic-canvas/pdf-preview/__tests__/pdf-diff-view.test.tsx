/**
 * The PDF diff summary cards and their View dialog (PDF preview design, Q7
 * follow-up): per-side cards in the old|new spatial grammar, View opening
 * the full-size viewer pointed at THAT side's git stream request, Old/New
 * toggle re-pointing the same mounted dialog, and rename sides that are not
 * PDFs degrading to the compact placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FileAssetRequest } from "@/hooks/assets/use-file-asset";

const state = vi.hoisted(() => ({
  asset: {
    status: "ready",
    url: "blob:pdf",
    meta: null,
    reason: null,
    totalBytes: null,
    servedFromCache: false,
  },
  assetRequests: [] as Array<FileAssetRequest | null>,
}));

vi.mock("@/hooks/assets/use-file-asset", () => ({
  useFileAsset: (request: FileAssetRequest | null) => {
    state.assetRequests.push(request);
    return { ...state.asset, reportDecodeFailure: vi.fn() };
  },
}));

// The real viewer imports pdf.js; the contract under test is only "the
// dialog mounts the shared viewer with the active side's blob URL".
vi.mock("@/components/epic-canvas/pdf-preview/pdf-preview-lazy", () => ({
  PdfPreviewLazy: (props: { readonly url: string }) => (
    <div data-testid="dialog-pdf-preview" data-url={props.url} />
  ),
}));

import { PdfDiffView } from "../pdf-diff-view";

function lastRequest(): FileAssetRequest | null {
  return state.assetRequests[state.assetRequests.length - 1] ?? null;
}

function renderView(overrides: {
  readonly previousPath?: string | null;
  readonly oldStage?: "staged" | "unstaged" | null;
  readonly newStage?: "staged" | "unstaged" | null;
  readonly filePath?: string;
}) {
  return render(
    <PdfDiffView
      runningDir="/work/repo"
      filePath={overrides.filePath ?? "docs/report.pdf"}
      previousPath={overrides.previousPath ?? null}
      revisionKey="rev-1"
      oldStage={
        overrides.oldStage === undefined ? "unstaged" : overrides.oldStage
      }
      newStage={
        overrides.newStage === undefined ? "unstaged" : overrides.newStage
      }
      sizeBytes={2_202_009}
      onOpenExternally={null}
      openExternallyOpening={false}
    />,
  );
}

describe("PdfDiffView", () => {
  beforeEach(() => {
    state.asset = {
      status: "ready",
      url: "blob:pdf",
      meta: null,
      reason: null,
      totalBytes: null,
      servedFromCache: false,
    };
    state.assetRequests.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders both side cards with the new side's size, no streams opened", () => {
    renderView({});

    expect(screen.getByTestId("pdf-diff-side-old")).toBeTruthy();
    expect(screen.getByTestId("pdf-diff-side-new")).toBeTruthy();
    expect(screen.getByText("New version · 2.1 MB")).toBeTruthy();
    expect(screen.getByText("Old version")).toBeTruthy();
    // Cards are metadata-only - the closed dialog must not fetch either side.
    expect(state.assetRequests.every((request) => request === null)).toBe(true);
  });

  it("shows Added for a file with no old side", () => {
    renderView({ oldStage: null });
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.queryByTestId("pdf-diff-side-old")).toBeNull();
  });

  it("shows Deleted for a file with no new side", () => {
    renderView({ newStage: null });
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.queryByTestId("pdf-diff-side-new")).toBeNull();
  });

  it("opens the dialog on the clicked side's git request and toggles sides", () => {
    renderView({ previousPath: "docs/old-report.pdf" });

    fireEvent.click(screen.getAllByRole("button", { name: /View/u })[0]);

    expect(screen.getByTestId("dialog-pdf-preview")).toBeTruthy();
    expect(lastRequest()).toEqual({
      method: "git",
      runningDir: "/work/repo",
      filePath: "docs/report.pdf",
      previousPath: "docs/old-report.pdf",
      side: "old",
      stage: "unstaged",
      coalesceRevision: "rev-1",
    });

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(lastRequest()).toEqual(
      expect.objectContaining({ side: "new", stage: "unstaged" }),
    );
  });

  it("degrades a non-PDF rename side to the compact placeholder with no View", () => {
    renderView({ previousPath: "docs/data.bin" });

    // Old side is not a PDF: placeholder, and only ONE View button (new side).
    expect(screen.queryByTestId("pdf-diff-side-old")).toBeNull();
    expect(screen.getAllByRole("button", { name: /View/u })).toHaveLength(1);
  });
});
