import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WireframeIframe } from "@/editor-core/nodes/wireframe/wireframe-iframe";

// The frame's link opener is a mutation hook; nothing here opens a link.
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

const ARTIFACT_HTML =
  '<!doctype html><html><body><button id="demo">Demo</button><script>window.artifactScript = true;</script></body></html>';
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

const PROXY_READY = {
  jsonrpc: "2.0",
  method: "ui/notifications/sandbox-proxy-ready",
  params: {},
};

function renderWireframeIframe(mode: "auto" | "fill"): HTMLIFrameElement {
  render(
    <WireframeIframe
      htmlContent={ARTIFACT_HTML}
      title="Wireframe preview"
      className="test-wireframe"
      mode={mode}
    />,
  );
  return currentIframe();
}

/** The frame as it is now: a new document is a new element. */
function currentIframe(): HTMLIFrameElement {
  const iframe = screen.getByTitle("Wireframe preview");
  if (!(iframe instanceof HTMLIFrameElement)) {
    throw new Error("Wireframe preview did not render as an iframe");
  }
  return iframe;
}

function windowOf(iframe: HTMLIFrameElement): Window {
  const win = iframe.contentWindow;
  if (win === null) throw new Error("Expected iframe contentWindow");
  return win;
}

function fromSource(source: MessageEventSource | null, data: unknown): void {
  fireEvent(window, new MessageEvent("message", { data, source }));
}

// A second proxy-ready from a frame disposes its bridge, so each frame says it
// once, the way the loader does.
const loaderAnnounced = new WeakSet<object>();

/** The page's bootstrap reporting its document height, as it does on resize. */
function reportHeight(source: Window, height: number): void {
  if (!loaderAnnounced.has(source)) {
    loaderAnnounced.add(source);
    fromSource(source, PROXY_READY);
  }
  fromSource(source, {
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height },
  });
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
  it("renders on the sandbox loader, opaque, and never writes the document into the frame", () => {
    for (const mode of ["auto", "fill"] as const) {
      const iframe = renderWireframeIframe(mode);

      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(iframe.getAttribute("src")).toContain("/sandbox/index.html");
      // The artifact (peer-editable text) travels over the bridge, not as
      // `srcdoc`, which would run it on the app's own terms.
      expect(iframe.getAttribute("srcdoc")).toBeNull();
      cleanup();
    }
  });

  it("sizes the frame only in auto mode", () => {
    const iframe = renderWireframeIframe("auto");
    expect(iframe.style.height).toBe("240px");
    cleanup();
    expect(renderWireframeIframe("fill").style.height).toBe("");
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

    reportHeight(source, 100);
    expect(iframe.style.height).toBe("240px");

    reportHeight(source, Number.MAX_SAFE_INTEGER);
    expect(iframe.style.height).toBe(`${window.innerHeight * 3}px`);
  });

  it("shrinks an automatically sized preview when content contracts", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");

    reportHeight(source, 900);
    expect(iframe.style.height).toBe("900px");

    reportHeight(source, 500);
    expect(iframe.style.height).toBe("500px");
  });

  it("ignores reports from another window and anything but a size report", () => {
    const iframe = renderWireframeIframe("auto");
    const source = windowOf(iframe);

    reportHeight(window, 600);
    expect(iframe.style.height).toBe("240px");

    // Announce the loader so only the message shape is in question.
    fromSource(source, PROXY_READY);
    fromSource(source, { height: 600 });
    fromSource(source, {
      marker: "traycer:wireframe:height:v1",
      height: 600,
    });
    fromSource(source, {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: "600" },
    });
    expect(iframe.style.height).toBe("240px");
  });

  it("uses a pointer-captured drag shield and ignores auto heights after manual resize", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });
    const setPointerCapture = vi.spyOn(handle, "setPointerCapture");

    reportHeight(source, 500);
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(screen.getByTestId("wireframe-resize-shield")).toBeTruthy();

    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    expect(iframe.style.height).toBe("800px");

    reportHeight(source, 650);
    expect(iframe.style.height).toBe("800px");

    fireEvent(handle, pointerEvent("pointerup", 7, 800));
    expect(screen.queryByTestId("wireframe-resize-shield")).toBeNull();
    expect(iframe.style.height).toBe("800px");
  });

  it("resets to the content's auto height on double-click, whatever the manual drag did", () => {
    const iframe = renderWireframeIframe("auto");
    const source = windowOf(iframe);
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(source, 500);
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    fireEvent(handle, pointerEvent("pointerup", 7, 800));
    // The bigger frame makes the page report again, with the same content.
    reportHeight(source, 500);
    expect(iframe.style.height).toBe("800px");

    fireEvent(handle, pointerEvent("pointerdown", 8, 800));
    fireEvent(handle, pointerEvent("pointerup", 8, 800));
    fireEvent(handle, pointerEvent("pointerdown", 9, 800));
    fireEvent(handle, pointerEvent("pointerup", 9, 800));
    fireEvent.doubleClick(handle);
    expect(iframe.style.height).toBe("500px");
  });

  it("applies an auto measurement retained during a no-movement click", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(source, 500);
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    reportHeight(source, 650);
    expect(iframe.style.height).toBe("500px");

    fireEvent(handle, pointerEvent("pointerup", 7, 500));
    expect(iframe.style.height).toBe("650px");

    reportHeight(source, 700);
    expect(iframe.style.height).toBe("700px");
  });

  it("keeps sub-threshold pointer jitter in auto mode", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(source, 500);
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 503));
    reportHeight(source, 650);
    fireEvent(handle, pointerEvent("pointerup", 7, 503));
    expect(iframe.style.height).toBe("650px");

    reportHeight(source, 700);
    expect(iframe.style.height).toBe("700px");
  });

  it("treats lost pointer capture as cancellation and removes the shield", () => {
    const iframe = renderWireframeIframe("auto");
    const source = iframe.contentWindow;
    if (source === null) throw new Error("Expected iframe contentWindow");
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(source, 500);
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

    reportHeight(source, 500);
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

    reportHeight(source, 500);
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

    reportHeight(source, 10_000);
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

    reportHeight(source, 500);
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
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(windowOf(currentIframe()), 700);
    fireEvent(handle, pointerEvent("pointerdown", 7, 700));
    fireEvent(handle, pointerEvent("pointermove", 7, 900));
    fireEvent(handle, pointerEvent("pointerup", 7, 900));
    expect(currentIframe().style.height).toBe("900px");

    view.rerender(
      <WireframeIframe
        htmlContent={"<html><body><textarea>unterminated"}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    expect(currentIframe().style.height).toBe("900px");

    // The old document's 700 is gone with its frame: nothing to go back to.
    fireEvent.doubleClick(handle);
    expect(currentIframe().style.height).toBe("240px");
  });

  it("takes the new document's own report as the baseline while a manual height holds", () => {
    const view = render(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(windowOf(currentIframe()), 700);
    fireEvent(handle, pointerEvent("pointerdown", 7, 700));
    fireEvent(handle, pointerEvent("pointermove", 7, 240));
    fireEvent(handle, pointerEvent("pointerup", 7, 240));
    expect(currentIframe().style.height).toBe("240px");

    view.rerender(
      <WireframeIframe
        htmlContent={"<html><body style='height:700px'>B</body></html>"}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    reportHeight(windowOf(currentIframe()), 700);
    expect(currentIframe().style.height).toBe("240px");

    fireEvent.doubleClick(handle);
    expect(currentIframe().style.height).toBe("700px");
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
    reportHeight(windowOf(currentIframe()), 900);
    expect(currentIframe().style.height).toBe("900px");

    view.rerender(
      <WireframeIframe
        htmlContent={"<html><body><textarea>silent"}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    expect(currentIframe().style.height).toBe("240px");

    view.rerender(
      <WireframeIframe
        htmlContent={ARTIFACT_HTML}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    expect(currentIframe().style.height).toBe("240px");
    const handle = screen.getByRole("slider", { name: "Resize preview" });
    fireEvent(handle, pointerEvent("pointerdown", 7, 240));
    fireEvent(handle, pointerEvent("pointermove", 7, 250));
    expect(currentIframe().style.height).toBe("250px");
    fireEvent(handle, pointerEvent("pointercancel", 7, 250));
    expect(currentIframe().style.height).toBe("240px");

    reportHeight(windowOf(currentIframe()), 700);
    expect(currentIframe().style.height).toBe("700px");
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
    const oldSource = windowOf(currentIframe());
    reportHeight(oldSource, 900);
    expect(currentIframe().style.height).toBe("900px");

    view.rerender(
      <WireframeIframe
        htmlContent={"<html><body style='height:700px'>B</body></html>"}
        title="Wireframe preview"
        className="test-wireframe"
        mode="auto"
      />,
    );
    const next = currentIframe();
    expect(windowOf(next)).not.toBe(oldSource);
    expect(next.style.height).toBe("240px");

    // The old frame's bridge went with it.
    reportHeight(oldSource, 900);
    expect(next.style.height).toBe("240px");

    reportHeight(windowOf(next), 700);
    expect(next.style.height).toBe("700px");
  });

  it("keeps the latest report while a manual height holds, and returns to it on double-click", () => {
    const iframe = renderWireframeIframe("auto");
    const source = windowOf(iframe);
    const handle = screen.getByRole("slider", { name: "Resize preview" });

    reportHeight(source, 500);
    fireEvent(handle, pointerEvent("pointerdown", 7, 500));
    fireEvent(handle, pointerEvent("pointermove", 7, 800));
    fireEvent(handle, pointerEvent("pointerup", 7, 800));
    // The content grows while the reader's height holds.
    reportHeight(source, 950);
    expect(iframe.style.height).toBe("800px");

    fireEvent.doubleClick(handle);
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
