import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PipPreviewSurface } from "@/components/epic-canvas/pip/pip-preview-surface";
import type { PipPreview } from "@/lib/browser-view/pip/pip-frame-capture";
import { fakeMediaStream as fakeStream } from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";

const jpegPreview: PipPreview = {
  src: "blob:pip-frame",
  frameSize: { width: 800, height: 600 },
  cursor: null,
};

function previewImage(): HTMLImageElement | null {
  const image = screen.queryByAltText("Browser preview");
  return image instanceof HTMLImageElement ? image : null;
}

function previewVideo(): HTMLVideoElement {
  const video = screen.getByTestId("agent-browser-pip-video");
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("expected a video element");
  }
  return video;
}

afterEach(cleanup);

describe("PipPreviewSurface", () => {
  it("paints the JPEG frame and mounts no video when no track exists", () => {
    render(<PipPreviewSurface preview={jpegPreview} stream={null} />);

    expect(previewImage()?.getAttribute("src")).toBe("blob:pip-frame");
    expect(previewImage()?.hidden).toBe(false);
    expect(screen.queryByTestId("agent-browser-pip-video")).toBeNull();
  });

  it("attaches the shared track and hides the JPEG once it decodes", () => {
    const stream = fakeStream("track-1");
    render(<PipPreviewSurface preview={jpegPreview} stream={stream} />);

    const video = previewVideo();
    expect(video.srcObject).toBe(stream);
    // Mounted to decode, but transparent until it has: the JPEG underneath
    // keeps painting, so there is no black-tile window.
    expect(video.className).toContain("opacity-0");
    expect(previewImage()?.hidden).toBe(false);

    fireEvent.loadedData(video);

    expect(video.className).not.toContain("opacity-0");
    expect(previewImage()?.hidden).toBe(true);
  });

  it("falls back to the JPEG when the track goes away", () => {
    const view = render(
      <PipPreviewSurface
        preview={jpegPreview}
        stream={fakeStream("track-2")}
      />,
    );
    fireEvent.loadedData(previewVideo());
    expect(previewImage()?.hidden).toBe(true);

    view.rerender(<PipPreviewSurface preview={jpegPreview} stream={null} />);

    expect(screen.queryByTestId("agent-browser-pip-video")).toBeNull();
    expect(previewImage()?.hidden).toBe(false);
  });

  it("draws the agent cursor over either plane", () => {
    const preview: PipPreview = {
      ...jpegPreview,
      cursor: {
        type: "move",
        normalizedX: 0.5,
        normalizedY: 0.5,
        label: "Agent",
        id: 1,
      },
    };
    render(<PipPreviewSurface preview={preview} stream={fakeStream("t")} />);

    expect(screen.getByTestId("browser-agent-cursor")).toBeTruthy();
  });

  it("shows the spinner only while neither plane has pixels", () => {
    const view = render(
      <PipPreviewSurface
        preview={{ src: null, frameSize: null, cursor: null }}
        stream={null}
      />,
    );
    expect(screen.getByTestId("agent-browser-pip-loading")).toBeTruthy();

    view.rerender(
      <PipPreviewSurface
        preview={{ src: null, frameSize: null, cursor: null }}
        stream={fakeStream("track-3")}
      />,
    );
    fireEvent.loadedData(previewVideo());

    expect(screen.queryByTestId("agent-browser-pip-loading")).toBeNull();
  });
});
