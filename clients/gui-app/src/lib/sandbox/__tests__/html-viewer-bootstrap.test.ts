import { JSDOM, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildHtmlViewerPrelude } from "../html-viewer-bootstrap";

interface Posted {
  readonly method?: string;
  readonly params?: { readonly scale?: number };
}

interface Page {
  readonly window: DOMWindow;
  readonly posted: Posted[];
  /** The zoom messages the page told its host about, newest last. */
  readonly zoomReports: () => number[];
  /** Delivers a message as if the given source posted it to the page. */
  readonly deliver: (data: unknown, source: unknown) => void;
  /** Dispatches a wheel event on the page and returns it. */
  readonly wheel: (init: WheelEventInit) => WheelEvent;
}

const windows: DOMWindow[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

/**
 * Runs the real viewer prelude in a jsdom window that is its own parent, so
 * what it posts to its host lands in `posted`.
 */
function runViewerPage(): Page {
  const dom = new JSDOM("<!doctype html><html><body><p>hi</p></body></html>", {
    runScripts: "dangerously",
    url: "https://sandbox.test/page.html",
  });
  const { window } = dom;
  windows.push(window);
  window.ResizeObserver = class {
    observe = (): void => undefined;
    unobserve = (): void => undefined;
  };
  // jsdom has no layout or scrolling; the page asks for both.
  window.requestAnimationFrame = () => 1;
  window.scrollTo = () => undefined;
  window.scrollBy = () => undefined;
  const posted: Posted[] = [];
  window.postMessage = (message: Posted) => {
    posted.push(message);
  };
  const prelude = buildHtmlViewerPrelude();
  window.eval(prelude.slice("<script>".length, -"</script>".length));
  return {
    window,
    posted,
    zoomReports: () =>
      posted.flatMap((message) =>
        message.method === "traycer/notifications/html-view" &&
        message.params?.scale !== undefined
          ? [message.params.scale]
          : [],
      ),
    deliver: (data, source) => {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: source });
      window.dispatchEvent(event);
    },
    wheel: (init) => {
      const event = new window.WheelEvent("wheel", {
        cancelable: true,
        bubbles: true,
        ...init,
      });
      window.dispatchEvent(event);
      return event;
    },
  };
}

function viewMessage(enabled: boolean, scale: number) {
  return {
    jsonrpc: "2.0",
    method: "traycer/html/view",
    params: { enabled, scale },
  };
}

describe("the plain-page viewer prelude", () => {
  it("leaves Ctrl-wheel to the browser until the host enables zoom", () => {
    const page = runViewerPage();

    const before = page.wheel({ ctrlKey: true, deltaY: -100 });
    expect(before.defaultPrevented).toBe(false);

    page.deliver(viewMessage(true, 1), page.window);
    page.deliver(viewMessage(false, 1), page.window);
    const after = page.wheel({ ctrlKey: true, deltaY: -100 });

    expect(after.defaultPrevented).toBe(false);
    expect(page.window.document.body.style.zoom).toBe("");
  });

  it("zooms around the pinch on Ctrl-wheel once enabled, and tells the host the new scale", () => {
    const page = runViewerPage();
    page.deliver(viewMessage(true, 1), page.window);

    const event = page.wheel({ ctrlKey: true, deltaY: -100 });

    expect(event.defaultPrevented).toBe(true);
    const [, scale] = page.zoomReports();
    expect(scale).toBeCloseTo(Math.exp(0.5), 5);
    expect(Number(page.window.document.body.style.zoom)).toBeCloseTo(
      Math.exp(0.5),
      5,
    );
  });

  it("does not hijack an ordinary wheel scroll while zoom is enabled", () => {
    const page = runViewerPage();
    page.deliver(viewMessage(true, 1), page.window);

    const event = page.wheel({ ctrlKey: false, deltaY: 120 });

    expect(event.defaultPrevented).toBe(false);
    expect(page.window.document.body.style.zoom).toBe("");
  });

  it("clamps a host-chosen scale to the supported range", () => {
    const page = runViewerPage();

    page.deliver(viewMessage(true, 100), page.window);
    page.deliver(viewMessage(true, 0.001), page.window);

    expect(page.zoomReports()).toEqual([4, 4, 0.25, 0.25]);
  });

  it("ignores view messages that did not come from its host", () => {
    const page = runViewerPage();

    page.deliver(viewMessage(true, 2), { not: "the host" });
    const event = page.wheel({ ctrlKey: true, deltaY: -100 });

    expect(event.defaultPrevented).toBe(false);
    expect(page.zoomReports()).toEqual([]);
  });
});
