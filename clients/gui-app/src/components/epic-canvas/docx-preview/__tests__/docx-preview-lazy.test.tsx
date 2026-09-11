/**
 * `DocxPreviewLazy`'s loading contract (docx-preview-lazy.tsx, built on
 * `createLazyDocumentViewer`): a spinner while the chunk import is pending,
 * the resolved viewer once it loads, and `onUnavailable` when the chunk
 * fails to load. `../docx-preview-loader` is mocked directly so this stays
 * independent of docx-preview/JSZip and the chunk-load contract that
 * `docx-preview-loader.test.ts` already covers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DocumentViewerProps } from "@/components/epic-canvas/document-preview/lazy-document-viewer";

type DocxPreviewComponentForMock = (props: DocumentViewerProps) => ReactNode;

const state = vi.hoisted(() => ({
  loadDocxPreview:
    vi.fn<() => Promise<{ readonly default: DocxPreviewComponentForMock }>>(),
  // Hoisted (not reached through the mocked module's `appLogger` object) so
  // assertions hold a plain mock, not a method reference off an object.
  errorSummary:
    vi.fn<
      (
        message: string,
        fields: Readonly<Record<string, unknown>>,
        error: unknown,
      ) => void
    >(),
}));

vi.mock("../docx-preview-loader", () => ({
  loadDocxPreview: state.loadDocxPreview,
}));

vi.mock("@/lib/logger", () => ({
  appLogger: { errorSummary: state.errorSummary, info: vi.fn(), warn: vi.fn() },
}));

import {
  DocxPreviewLazy,
  DOCX_VIEWER_UNAVAILABLE_REASON,
} from "../docx-preview-lazy";

function FakeViewer(props: DocumentViewerProps): ReactNode {
  return <div data-testid="fake-docx-viewer" data-url={props.url} />;
}

const VIEWER_PROPS: DocumentViewerProps = {
  url: "blob:docx-bytes",
  fileName: "report.docx",
  compact: false,
  toolbarActions: null,
  onRenderFailure: vi.fn(),
};

describe("<DocxPreviewLazy />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the loading spinner while the chunk import is pending", () => {
    state.loadDocxPreview.mockReturnValue(new Promise(() => undefined));
    const onUnavailable = vi.fn();

    const { container } = render(
      <DocxPreviewLazy {...VIEWER_PROPS} onUnavailable={onUnavailable} />,
    );

    expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="fake-docx-viewer"]'),
    ).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("renders the resolved viewer with the viewer props once the chunk loads", async () => {
    state.loadDocxPreview.mockReturnValue(
      Promise.resolve({ default: FakeViewer }),
    );
    const onUnavailable = vi.fn();

    render(<DocxPreviewLazy {...VIEWER_PROPS} onUnavailable={onUnavailable} />);

    const viewer = await screen.findByTestId("fake-docx-viewer");
    expect(viewer.getAttribute("data-url")).toBe("blob:docx-bytes");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("reports onUnavailable once when the chunk fails to load", async () => {
    state.loadDocxPreview.mockReturnValue(
      Promise.reject(new Error("chunk failed to load")),
    );
    const onUnavailable = vi.fn();

    const { container } = render(
      <DocxPreviewLazy {...VIEWER_PROPS} onUnavailable={onUnavailable} />,
    );

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));

    expect(
      container.querySelector('[data-testid="fake-docx-viewer"]'),
    ).toBeNull();
    expect(state.errorSummary).toHaveBeenCalledWith(
      "[docx-preview] viewer chunk failed to load",
      {},
      expect.any(Error),
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("exposes non-empty placeholder copy for a viewer that could not start", () => {
    expect(DOCX_VIEWER_UNAVAILABLE_REASON.length).toBeGreaterThan(0);
  });
});
