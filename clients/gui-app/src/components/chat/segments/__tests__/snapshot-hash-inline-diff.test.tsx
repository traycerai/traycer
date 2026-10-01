import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { documentFileDiffCopy } from "@/lib/chat/file-edit-reason-copy";
import { SnapshotHashInlineDiff } from "@/components/chat/segments/snapshot-hash-inline-diff";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  queryResult: {
    data: undefined as
      | {
          readonly beforeContent: string | null;
          readonly afterContent: string | null;
          readonly reason: "snapshot";
        }
      | undefined,
    isLoading: false,
  },
}));

// This suite's contract is only the seam the document gate crosses - which
// query args the component issues, not the diff pipeline itself (patch
// building, `@pierre/diffs` rendering). Mocking it out mirrors how
// `snapshot-diff-tile-body.test.tsx` isolates the same hook.
vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: (args: unknown) => {
    state.query(args);
    return state.queryResult;
  },
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: {
    readonly sizing: string;
    readonly children: ReactNode;
  }) => (
    <div data-testid="inline-diff-frame" data-sizing={props.sizing}>
      {props.children}
    </div>
  ),
  DiffContentPrimitive: (props: {
    readonly mode: string;
    readonly backgrounds: boolean;
    readonly lineNumbers: boolean;
    readonly indicatorStyle: string;
  }) => (
    <div
      data-testid="inline-diff"
      data-mode={props.mode}
      data-backgrounds={String(props.backgrounds)}
      data-line-numbers={String(props.lineNumbers)}
      data-indicator-style={props.indicatorStyle}
    />
  ),
}));

afterEach(() => {
  cleanup();
  state.queryResult = { data: undefined, isLoading: false };
  useSettingsStore.setState({
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
  });
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

    expect(screen.getByText(documentFileDiffCopy("pdf"))).toBeTruthy();
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("renders the Word document copy and disables the snapshot query for a .docx file path", () => {
    state.query.mockClear();
    render(
      <SnapshotHashInlineDiff
        filePath="docs/report.docx"
        beforeHash="h0"
        afterHash="h1"
        cacheScope="scope-1"
      />,
    );

    expect(screen.getByText(documentFileDiffCopy("docx"))).toBeTruthy();
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("keeps the query enabled for a non-document file path", () => {
    state.query.mockClear();
    render(
      <SnapshotHashInlineDiff
        filePath="src/app.ts"
        beforeHash="h0"
        afterHash="h1"
        cacheScope="scope-1"
      />,
    );

    expect(screen.queryByText(documentFileDiffCopy("pdf"))).toBeNull();
    expect(screen.queryByText(documentFileDiffCopy("docx"))).toBeNull();
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("threads diff viewer preferences into the rendered diff, mode staying unified", () => {
    useSettingsStore.setState({
      diffViewerPreferences: {
        ...DEFAULT_DIFF_VIEWER_PREFERENCES,
        lineNumbers: true,
        backgrounds: false,
        indicatorStyle: "classic",
      },
    });
    state.queryResult = {
      data: {
        beforeContent: "old();\n",
        afterContent: "const a = 1;\n",
        reason: "snapshot",
      },
      isLoading: false,
    };

    render(
      <SnapshotHashInlineDiff
        filePath="src/app.ts"
        beforeHash="h0"
        afterHash="h1"
        cacheScope="scope-1"
      />,
    );

    const diff = screen.getByTestId("inline-diff");
    expect(diff.getAttribute("data-line-numbers")).toBe("true");
    expect(diff.getAttribute("data-backgrounds")).toBe("false");
    expect(diff.getAttribute("data-indicator-style")).toBe("classic");
    expect(diff.getAttribute("data-mode")).toBe("unified");
  });
});
