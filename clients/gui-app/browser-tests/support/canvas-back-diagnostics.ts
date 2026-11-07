import type { Page, TestInfo } from "@playwright/test";

// NEVER MERGE: bounded capture, no waits or application state writes.
export async function captureCanvasBack(
  page: Page,
  testInfo: TestInfo,
): Promise<() => Promise<void>> {
  const entries: object[] = [];
  const record = (value: object): void => {
    if (entries.length < 5000) entries.push(value);
  };
  page.on("console", (message) => {
    if (message.text().startsWith("[DEBUG-canvasback]")) {
      record({
        kind: "console",
        received: Date.now(),
        text: message.text(),
        location: message.location(),
      });
    }
  });
  page.on("pageerror", (error) =>
    record({ kind: "pageerror", message: error.message, stack: error.stack }),
  );
  page.on("framenavigated", (frame) =>
    record({
      kind: "navigation",
      received: Date.now(),
      name: frame.name(),
      url: frame.url(),
      parent: frame.parentFrame()?.url(),
    }),
  );
  const cdp = await page.context().newCDPSession(page);
  record({
    kind: "runtime",
    browser: await cdp.send("Browser.getVersion"),
    node: process.version,
    repeat: testInfo.repeatEachIndex,
    worker: testInfo.workerIndex,
  });
  await cdp.detach();
  await page.addInitScript(() => {
    const report = (kind: string, target: EventTarget | null): void => {
      const element =
        target instanceof Element ? target : document.documentElement;
      const ancestors = [];
      for (
        let node: Element | null = element;
        node !== null;
        node = node.parentElement
      ) {
        ancestors.push({
          tag: node.tagName,
          cls: node.getAttribute("class"),
          left: node.scrollLeft,
          top: node.scrollTop,
        });
      }
      console.warn(
        "[DEBUG-canvasback]",
        JSON.stringify({
          kind,
          at: performance.now(),
          origin: performance.timeOrigin,
          href: location.href,
          frame: window.name,
          ancestors,
          x: scrollX,
          y: scrollY,
        }),
      );
    };
    window.addEventListener(
      "scroll",
      (event) => report("scroll", event.target),
      true,
    );
    window.addEventListener(
      "focusin",
      (event) => report("focus", event.target),
      true,
    );
    window.addEventListener("pageshow", () => report("pageshow", document));
  });
  return async () => {
    try {
      record({
        kind: "final-geometry",
        value: await page.evaluate(() => ({
          href: location.href,
          active: document.activeElement?.outerHTML.slice(0, 500),
          viewport: document
            .querySelector(".react-flow__viewport")
            ?.getAttribute("style"),
          frames: Array.from(document.querySelectorAll("iframe"), (frame) => ({
            title: frame.title,
            src: frame.src,
            box: {
              x: frame.getBoundingClientRect().x,
              y: frame.getBoundingClientRect().y,
              width: frame.getBoundingClientRect().width,
              height: frame.getBoundingClientRect().height,
            },
          })),
          stage: Array.from(
            document.querySelectorAll(
              '[role="application"][aria-label="Canvas workspace"]',
            ),
            (stage) => {
              const box = stage.getBoundingClientRect();
              return {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
              };
            },
          ),
          userAgent: navigator.userAgent,
        })),
      });
    } catch (error) {
      record({ kind: "capture-error", message: String(error) });
    }
    await testInfo.attach("canvas-back-diagnostics", {
      body: JSON.stringify(entries, null, 2),
      contentType: "application/json",
    });
  };
}
