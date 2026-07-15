import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WireframeIframe } from "@/editor-core/nodes/wireframe/wireframe-iframe";

const HEIGHT_MESSAGE_MARKER = "traycer:wireframe:height:v1";
const MEASURE_REQUEST_MARKER = "traycer:wireframe:measure-request:v1";
const ARTIFACT_HTML =
  '<!doctype html><html><body><button id="demo">Demo</button><script>window.artifactScript = true;</script></body></html>';
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

interface MeasureRequestPayload {
  readonly marker: string;
  readonly documentGeneration: number;
  readonly requestId: number;
}

function renderWireframeIframe(mode: "auto" | "fill"): HTMLIFrameElement {
  render(
    <WireframeIframe
      htmlContent={ARTIFACT_HTML}
      title="Wireframe preview"
      className="test-wireframe"
      mode={mode}
    />,
  );
  const iframe = screen.getByTitle("Wireframe preview");
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error("Wireframe preview did not render as an iframe");
  }
  return iframe;
}

function dispatchHeightMessage(
  source: MessageEventSource | null,
  data: unknown,
): void {
  let payload = data;
  if (
    typeof data === "object" &&
    data !== null &&
    "marker" in data &&
    data.marker === HEIGHT_MESSAGE_MARKER &&
    !("documentGeneration" in data)
  ) {
    const iframe = Array.from(document.querySelectorAll("iframe")).find(
      (candidate) => candidate.contentWindow === source,
    );
    if (iframe !== undefined) {
      payload = {
        ...data,
        documentGeneration: readDocumentGeneration(iframe),
        requestId: "requestId" in data ? data.requestId : null,
      };
    }
  }
  fireEvent(window, new MessageEvent("message", { data: payload, source }));
}

function readDocumentGeneration(iframe: HTMLIFrameElement): number {
  const srcDoc = iframe.getAttribute("srcdoc");
  if (srcDoc === null) throw new Error("Expected iframe srcdoc content");
  const match = /const documentGeneration = (\d+);/.exec(srcDoc);
  if (match === null) throw new Error("Expected reporter document generation");
  return Number(match[1]);
}

function readLastMeasureRequest(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): MeasureRequestPayload {
  if (calls.length === 0) throw new Error("Expected measurement request call");
  const lastCall = calls[calls.length - 1];
  const payload = lastCall[0];
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Expected measurement request payload");
  }
  if (!("marker" in payload) || payload.marker !== MEASURE_REQUEST_MARKER) {
    throw new Error("Expected measurement request marker");
  }
  if (
    !("documentGeneration" in payload) ||
    typeof payload.documentGeneration !== "number"
  ) {
    throw new Error("Expected measurement request generation");
  }
  if (!("requestId" in payload) || typeof payload.requestId !== "number") {
    throw new Error("Expected measurement request id");
  }
  return {
    marker: payload.marker,
    documentGeneration: payload.documentGeneration,
    requestId: payload.requestId,
  };
}

function setWindowInnerHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

function pointerEvent(
  type:
    | "pointerdown"
    | "pointermove"
    | "pointerup"
    | "pointercancel"
    | "lostpointercapture",
  pointerId: number,
  clientY: number,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setWindowInnerHeight(ORIGINAL_INNER_HEIGHT);
});

describe("WireframeIframe", () => {
  it("allows scripts while preserving opaque-origin isolation", () => {
    const iframe = renderWireframeIframe("auto");

    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("injects the reporter before artifact markup only in auto mode", () => {
    const iframe = renderWireframeIframe("auto");
    const srcDoc = iframe.getAttribute("srcdoc");
    if (srcDoc === null) throw new Error("Expected iframe srcdoc content");

    expect(srcDoc.startsWith("<!doctype html>")).toBe(true);
    expect(srcDoc.endsWith(ARTIFACT_HTML.slice("<!doctype html>".length))).toBe(
      true,
    );
    expect(srcDoc.indexOf(HEIGHT_MESSAGE_MARKER)).toBeLessThan(
      srcDoc.indexOf('<html><body><button id="demo">'),
    );
    expect(srcDoc).toContain("<script>");
    expect(srcDoc).toContain("ResizeObserver");
    expect(srcDoc).toContain("getBoundingClientRect");
    expect(srcDoc).toContain("documentElement.scrollHeight > viewportHeight");
    expect(srcDoc).toContain(HEIGHT_MESSAGE_MARKER);
    expect(srcDoc).toContain(MEASURE_REQUEST_MARKER);
    expect(srcDoc).toContain("event.source !== window.parent");
    expect(srcDoc).toContain("documentGeneration");
    expect(srcDoc).toContain("requestId");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Resize preview" }), {
      key: "ArrowDown",
    });
    expect(iframe.getAttribute("srcdoc")).toBe(srcDoc);

    cleanup();
    const fillIframe = renderWireframeIframe("fill");
    expect(fillIframe.getAttribute("srcdoc")).toBe(ARTIFACT_HTML);
  });

  it("places the reporter before malformed raw-text artifact content", () => {
    const malformedHtml =
      "<html><body><textarea>unterminated<script>artifact text";
    render(
      <WireframeIframe
        htmlContent={malformedHtml}
        title="Malformed wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const iframe = screen.getByTitle("Malformed wireframe preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error(
        "Malformed wireframe preview did not render as an iframe",
      );
    }
    const srcDoc = iframe.getAttribute("srcdoc");
    if (srcDoc === null) throw new Error("Expected iframe srcdoc content");

    expect(srcDoc.endsWith(malformedHtml)).toBe(true);
    expect(srcDoc.indexOf(HEIGHT_MESSAGE_MARKER)).toBeLessThan(
      srcDoc.indexOf(malformedHtml),
    );
  });

  it("renders the accessible resize handle only for auto mode", () => {
    renderWireframeIframe("auto");
    const handle = screen.getByRole("slider", { name: "Resize preview" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuenow")).toBe("240");

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("256");

    cleanup();
    renderWireframeIframe("fill");
    expect(screen.queryByRole("slider", { name: "Resize preview" })).toBeNull();
  });

  it("accepts height messages from its own frame and clamps both bounds", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 100,
    });
    expect(iframe.style.height).toBe("240px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: Number.MAX_SAFE_INTEGER,
    });
    expect(iframe.style.height).toBe(`${window.innerHeight * 3}px`);
  });

  it("shrinks an automatically sized preview when content contracts", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 900,
    });
    expect(iframe.style.height).toBe("900px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    expect(iframe.style.height).toBe("500px");
  });

  it("requests a measurement on load only while the current document has no baseline", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const postMessage = vi.spyOn(source, "postMessage");

    fireEvent.load(iframe);
    const request = readLastMeasureRequest(postMessage.mock.calls);
    expect(request.documentGeneration).toBe(readDocumentGeneration(iframe));

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
      documentGeneration: request.documentGeneration,
      requestId: request.requestId,
    });
    postMessage.mockClear();
    fireEvent.load(iframe);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("ignores messages with the wrong source or without the marker", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");

    dispatchHeightMessage(window, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 600,
    });
    expect(iframe.style.height).toBe("240px");

    dispatchHeightMessage(source, { height: 600 });
    expect(iframe.style.height).toBe("240px");
  });

  it("uses a pointer-captured drag shield and ignores auto heights after manual resize", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });
    const setPointerCapture = vi.spyOn(handle, "setPointerCapture");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(screen.getByTestId("wireframe-resize-shield")).toBeTruthy();

    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    expect(iframe.style.height).toBe("800px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 650,
    });
    expect(iframe.style.height).toBe("800px");

    fireEvent(handle, pointerEvent("pointerup", 7, 800));
    expect(screen.queryByTestId("wireframe-resize-shield")).toBeNull();
    expect(iframe.style.height).toBe("800px");
  });

  it("resets to the true auto baseline after manual reporter feedback and native-like double-click events", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    fireEvent(handle, pointerEvent("pointerup", 7, 800));
    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 800,
    });
    expect(iframe.style.height).toBe("800px");

    fireEvent(handle, pointerEvent("pointerdown", 8, 800));
    fireEvent(handle, pointerEvent("pointerup", 8, 800));
    fireEvent(handle, pointerEvent("pointerdown", 9, 800));
    fireEvent(handle, pointerEvent("pointerup", 9, 800));
    fireEvent.doubleClick(handle);
    expect(iframe.style.height).toBe("500px");
  });

  it("ignores stale manual feedback while awaiting the correlated reset reply", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 773,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 773));
    fireEvent(handle, pointerEvent("pointermove", 7, 923));
    fireEvent(handle, pointerEvent("pointerup", 7, 923));
    const postMessage = vi.spyOn(source, "postMessage");

    fireEvent.doubleClick(handle);
    expect(iframe.style.height).toBe("773px");
    const request = readLastMeasureRequest(postMessage.mock.calls);

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 923,
      documentGeneration: request.documentGeneration,
      requestId: null,
    });
    expect(iframe.style.height).toBe("773px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 829,
      documentGeneration: request.documentGeneration,
      requestId: request.requestId,
    });
    expect(iframe.style.height).toBe("829px");
  });

  it("accepts only a correlated current-generation reply during a pre-threshold drag", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    const postMessage = vi.spyOn(source, "postMessage");
    fireEvent.doubleClick(handle);
    const request = readLastMeasureRequest(postMessage.mock.calls);
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 900,
      documentGeneration: request.documentGeneration,
      requestId: request.requestId + 1,
    });
    expect(iframe.style.height).toBe("500px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 650,
      documentGeneration: request.documentGeneration,
      requestId: request.requestId,
    });
    expect(iframe.style.height).toBe("500px");
    fireEvent(handle, pointerEvent("pointerup", 7, 500));
    expect(iframe.style.height).toBe("650px");
  });

  it("accepts unsolicited current-generation reports after the request wait times out", () => {
    vi.useFakeTimers();
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent.doubleClick(handle);

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    expect(iframe.style.height).toBe("500px");

    vi.advanceTimersByTime(1_000);
    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    expect(iframe.style.height).toBe("700px");
  });

  it("applies an auto measurement retained during a no-movement click", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 650,
    });
    expect(iframe.style.height).toBe("500px");

    fireEvent(handle, pointerEvent("pointerup", 7, 500));
    expect(iframe.style.height).toBe("650px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    expect(iframe.style.height).toBe("700px");
  });

  it("keeps sub-threshold pointer jitter in auto mode", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 503));
    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 650,
    });
    fireEvent(handle, pointerEvent("pointerup", 7, 503));
    expect(iframe.style.height).toBe("650px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    expect(iframe.style.height).toBe("700px");
  });

  it("treats lost pointer capture as cancellation and removes the shield", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    expect(screen.getByTestId("wireframe-resize-shield")).toBeTruthy();

    fireEvent(handle, pointerEvent("lostpointercapture", 7, 800));
    expect(screen.queryByTestId("wireframe-resize-shield")).toBeNull();
    expect(iframe.style.height).toBe("500px");

    fireEvent(handle, pointerEvent("pointerdown", 8, 500));
    expect(screen.getByTestId("wireframe-resize-shield")).toBeTruthy();
    fireEvent(handle, pointerEvent("pointercancel", 8, 500));
  });

  it("restores auto height and removes the shield on pointer cancel", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    expect(iframe.style.height).toBe("800px");

    fireEvent(handle, pointerEvent("pointercancel", 7, 800));
    expect(screen.queryByTestId("wireframe-resize-shield")).toBeNull();
    expect(iframe.style.height).toBe("500px");
  });

  it("clamps manual resizing to its floor and viewport-aware ceiling", () => {
    setWindowInnerHeight(500);
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 10_000));
    expect(iframe.style.height).toBe("2000px");

    fireEvent(handle, pointerEvent("pointermove", 7, -10_000));
    expect(iframe.style.height).toBe("240px");
    fireEvent(handle, pointerEvent("pointerup", 7, -10_000));
  });

  it("re-clamps auto height on window resize without changing manual height", () => {
    setWindowInnerHeight(1_000);
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 10_000,
    });
    expect(iframe.style.height).toBe("3000px");

    setWindowInnerHeight(500);
    fireEvent(window, new Event("resize"));
    expect(iframe.style.height).toBe("1500px");

    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 700));
    fireEvent(handle, pointerEvent("pointerup", 7, 700));
    expect(iframe.style.height).toBe("1700px");

    setWindowInnerHeight(300);
    fireEvent(window, new Event("resize"));
    expect(iframe.style.height).toBe("1700px");
  });

  it("recomputes the drag ceiling and aria maximum as the viewport changes", () => {
    setWindowInnerHeight(500);
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));

    setWindowInnerHeight(1_000);
    fireEvent(window, new Event("resize"));
    expect(handle.getAttribute("aria-valuemax")).toBe("4000");
    fireEvent(handle, pointerEvent("pointermove", 7, 3_500));
    expect(iframe.style.height).toBe("3500px");
    expect(handle.getAttribute("aria-valuemax")).toBe("4000");

    setWindowInnerHeight(500);
    fireEvent(window, new Event("resize"));
    expect(handle.getAttribute("aria-valuemax")).toBe("3500");
    fireEvent(handle, pointerEvent("pointermove", 7, 4_500));
    expect(iframe.style.height).toBe("3500px");
    expect(handle.getAttribute("aria-valuemax")).toBe("3500");
    fireEvent(handle, pointerEvent("pointerup", 7, 4_500));
  });

  it("clears the auto baseline on document replacement while preserving manual height", () => {
    const view = render(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const iframe = screen.getByTitle("Wireframe preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Wireframe preview did not render as an iframe");
    }
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 700));
    fireEvent(handle, pointerEvent("pointermove", 7, 900));
    fireEvent(handle, pointerEvent("pointerup", 7, 900));
    expect(iframe.style.height).toBe("900px");

    const replacementHtml = "<html><body><textarea>unterminated";
    view.rerender(
      <WireframeIframe
        htmlContent={replacementHtml}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    expect(iframe.style.height).toBe("900px");

    fireEvent.doubleClick(handle);
    expect(iframe.style.height).toBe("240px");
    expect(iframe.getAttribute("srcdoc")?.endsWith(replacementHtml)).toBe(true);
  });

  it("recovers from a manual-floor document replacement through the measurement handshake", () => {
    const view = render(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const iframe = screen.getByTitle("Wireframe preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Wireframe preview did not render as an iframe");
    }
    const originalSource = iframe.contentWindow;
    if (originalSource === null)
      throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(originalSource, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 700));
    fireEvent(handle, pointerEvent("pointermove", 7, 240));
    fireEvent(handle, pointerEvent("pointerup", 7, 240));
    expect(iframe.style.height).toBe("240px");

    const replacementHtml = "<html><body style='height:700px'>B</body></html>";
    view.rerender(
      <WireframeIframe
        htmlContent={replacementHtml}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const replacementSource = iframe.contentWindow;
    if (replacementSource === null) {
      throw new Error("Expected replacement iframe contentWindow");
    }
    dispatchHeightMessage(replacementSource, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    expect(iframe.style.height).toBe("240px");
    const postMessage = vi.spyOn(replacementSource, "postMessage");

    fireEvent.doubleClick(handle);
    expect(iframe.style.height).toBe("240px");
    const request = readLastMeasureRequest(postMessage.mock.calls);

    dispatchHeightMessage(replacementSource, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
      documentGeneration: request.documentGeneration,
      requestId: request.requestId,
    });
    expect(iframe.style.height).toBe("700px");
  });

  it("does not resurrect stale auto state when identical HTML returns", () => {
    const view = render(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const iframe = screen.getByTitle("Wireframe preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Wireframe preview did not render as an iframe");
    }
    const firstSource = iframe.contentWindow;
    if (firstSource === null) throw new Error("Expected iframe contentWindow");

    dispatchHeightMessage(firstSource, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 900,
    });
    expect(iframe.style.height).toBe("900px");

    const silentHtml = "<html><body><textarea>silent";
    view.rerender(
      <WireframeIframe
        htmlContent={silentHtml}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    expect(iframe.style.height).toBe("240px");

    view.rerender(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    expect(iframe.style.height).toBe("240px");
    const handle = screen.getByRole("slider", { name: "Resize preview" });
    fireEvent(handle, pointerEvent("pointerdown", 7, 240));
    fireEvent(handle, pointerEvent("pointermove", 7, 250));
    expect(iframe.style.height).toBe("250px");
    fireEvent(handle, pointerEvent("pointercancel", 7, 250));
    expect(iframe.style.height).toBe("240px");

    const returningSource = iframe.contentWindow;
    if (returningSource === null) {
      throw new Error("Expected returning iframe contentWindow");
    }
    dispatchHeightMessage(returningSource, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
    });
    expect(iframe.style.height).toBe("700px");
  });

  it("rejects old-document reports after an htmlContent transition", () => {
    const view = render(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const iframe = screen.getByTitle("Wireframe preview");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Wireframe preview did not render as an iframe");
    }
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const oldGeneration = readDocumentGeneration(iframe);
    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 900,
      documentGeneration: oldGeneration,
      requestId: null,
    });
    expect(iframe.style.height).toBe("900px");

    const replacementHtml = "<html><body style='height:700px'>B</body></html>";
    view.rerender(
      <WireframeIframe
        htmlContent={replacementHtml}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const newGeneration = readDocumentGeneration(iframe);
    expect(newGeneration).not.toBe(oldGeneration);
    expect(iframe.style.height).toBe("240px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 900,
      documentGeneration: oldGeneration,
      requestId: null,
    });
    expect(iframe.style.height).toBe("240px");

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 700,
      documentGeneration: newGeneration,
      requestId: null,
    });
    expect(iframe.style.height).toBe("700px");
  });

  it("requests and applies a fresh measurement when content grows during manual mode", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 500,
    });
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    fireEvent(handle, pointerEvent("pointerup", 7, 800));
    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 950,
    });
    expect(iframe.style.height).toBe("800px");
    const postMessage = vi.spyOn(source, "postMessage");

    fireEvent.doubleClick(handle);
    expect(iframe.style.height).toBe("500px");
    const request = readLastMeasureRequest(postMessage.mock.calls);

    dispatchHeightMessage(source, {
      marker: HEIGHT_MESSAGE_MARKER,
      height: 950,
      documentGeneration: request.documentGeneration,
      requestId: request.requestId,
    });
    expect(iframe.style.height).toBe("950px");
  });

  it("removes the message listener on unmount", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
  });
});
