/**
 * `PdfPreviewLazy`'s two failure surfaces (pdf-preview-lazy.tsx): the chunk
 * load itself rejecting, and the resolved viewer throwing while it mounts.
 * Both must report `onUnavailable` exactly once and leave nothing but the
 * loading spinner or an empty subtree behind - never a half-mounted viewer.
 * `../pdf-preview-loader` is mocked directly so this stays independent of
 * pdf.js and the real chunk-load contract that `pdf-preview-loader.test.ts`
 * already covers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { PdfPreviewProps } from "../pdf-preview";

type PdfPreviewComponentForMock = (props: PdfPreviewProps) => ReactNode;

const state = vi.hoisted(() => ({
  loadPdfPreview:
    vi.fn<() => Promise<{ readonly default: PdfPreviewComponentForMock }>>(),
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

vi.mock("../pdf-preview-loader", () => ({
  loadPdfPreview: state.loadPdfPreview,
}));

vi.mock("@/lib/logger", () => ({
  appLogger: { errorSummary: state.errorSummary, info: vi.fn(), warn: vi.fn() },
}));

import { PdfPreviewLazy } from "../pdf-preview-lazy";

function FakeViewer(props: PdfPreviewProps): ReactNode {
  return <div data-testid="fake-pdf-viewer" data-url={props.url} />;
}

function ThrowingViewer(): ReactNode {
  throw new Error("viewer threw while mounting");
}

const VIEWER_PROPS: PdfPreviewProps = {
  url: "blob:pdf-bytes",
  fileName: "report.pdf",
  compact: false,
  toolbarActions: null,
  onRenderFailure: vi.fn(),
};

describe("<PdfPreviewLazy />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("reports onUnavailable once and renders only the spinner when the chunk fails to load", async () => {
    state.loadPdfPreview.mockReturnValue(
      Promise.reject(new Error("chunk failed to load")),
    );
    const onUnavailable = vi.fn();

    const { container } = render(
      <PdfPreviewLazy {...VIEWER_PROPS} onUnavailable={onUnavailable} />,
    );

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));

    expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="fake-pdf-viewer"]'),
    ).toBeNull();
    expect(state.errorSummary).toHaveBeenCalledWith(
      "[pdf-preview] viewer chunk failed to load",
      {},
      expect.any(Error),
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("renders the resolved viewer with the viewer props once the chunk loads", async () => {
    state.loadPdfPreview.mockReturnValue(
      Promise.resolve({ default: FakeViewer }),
    );
    const onUnavailable = vi.fn();

    render(<PdfPreviewLazy {...VIEWER_PROPS} onUnavailable={onUnavailable} />);

    const viewer = await screen.findByTestId("fake-pdf-viewer");
    expect(viewer.getAttribute("data-url")).toBe("blob:pdf-bytes");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("reports onUnavailable and renders nothing when the viewer throws during render", async () => {
    state.loadPdfPreview.mockReturnValue(
      Promise.resolve({ default: ThrowingViewer }),
    );
    const onUnavailable = vi.fn();
    // React logs the boundary-caught error to the console by default; the
    // boundary itself is the thing under test, not that console noise.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const { container } = render(
      <PdfPreviewLazy {...VIEWER_PROPS} onUnavailable={onUnavailable} />,
    );

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));

    expect(container.textContent).toBe("");
    expect(
      container.querySelector('[data-testid="fake-pdf-viewer"]'),
    ).toBeNull();
    expect(state.errorSummary).toHaveBeenCalledTimes(1);
    const [message, fields, error] = state.errorSummary.mock.calls[0];
    expect(message).toBe("[pdf-preview] viewer threw while mounting");
    expect(typeof fields.componentStack).toBe("string");
    expect(error).toBeInstanceOf(Error);

    consoleErrorSpy.mockRestore();
  });
});
