import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PDF_FILE_DIFF_COPY } from "@/lib/chat/file-edit-reason-copy";
import { SnapshotHashInlineDiff } from "@/components/chat/segments/snapshot-hash-inline-diff";

const state = vi.hoisted(() => ({
  query: vi.fn(),
}));

// This suite's contract is only the seam the PDF gate crosses - which query
// args the component issues, not the diff pipeline itself (patch building,
// `@pierre/diffs` rendering). Mocking it out mirrors how
// `snapshot-diff-tile-body.test.tsx` isolates the same hook.
vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: (args: unknown) => {
    state.query(args);
    return { data: undefined, isLoading: false };
  },
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

afterEach(() => {
  cleanup();
});

describe("<SnapshotHashInlineDiff />", () => {
  it("renders the PDF copy and disables the snapshot query for a PDF file path", () => {
    state.query.mockClear();
    render(
      <SnapshotHashInlineDiff
        filePath="docs/report.pdf"
        beforeHash="h0"
        afterHash="h1"
        cacheScope="scope-1"
      />,
    );

    expect(screen.getByText(PDF_FILE_DIFF_COPY)).toBeTruthy();
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("keeps the query enabled for a non-PDF file path", () => {
    state.query.mockClear();
    render(
      <SnapshotHashInlineDiff
        filePath="src/app.ts"
        beforeHash="h0"
        afterHash="h1"
        cacheScope="scope-1"
      />,
    );

    expect(screen.queryByText(PDF_FILE_DIFF_COPY)).toBeNull();
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});
