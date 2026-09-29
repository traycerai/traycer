import { expect, test, type LaunchOptions, type Page } from "@playwright/test";

import { chromeLaunchOptions } from "../fixtures.ts";

/**
 * The layout editor's browser regressions load a fixture ONCE per load-time
 * configuration and switch everything else live through the fixture's probe:
 * the heavy fixtures boot most of the app from unbundled modules, so a page
 * load costs seconds, and the old CDP driver paid it 71 times.
 *
 * `sharedPage` is that arrangement. Called inside a `test.describe` (or at
 * the top of a spec file), it opens one fresh browser context and page before
 * the group's first test, hands every test in the group the same page, and
 * closes the context after the group's last. A fresh CONTEXT rather than a
 * fresh tab in a shared one, because a reused renderer grew to 1-2 GB on these
 * fixtures and then stopped booting; a group's own page is dropped when the
 * group ends, so no renderer outlives the file that used it.
 */

/** The window the driver measured in, which the fixtures' geometry is tuned on. */
export const LAYOUT_EDITOR_VIEWPORT = { width: 1500, height: 1200 } as const;

/**
 * A fine, hovering pointer, whatever input devices the machine has. The
 * layout editor's canvas only decorates a region under `pointerType: "mouse"`,
 * and Tailwind's `hover:` variants only apply under `(hover: hover)`; a CI
 * runner with no input device reports `hover: none`, under which every hover
 * claim below could only fail. (Blink's enums: hover 2 = hover, pointer 4 =
 * fine.)
 */
const MOUSE_INPUT_ARGS = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

/**
 * The mouse premise as launch options. `test.use({ launchOptions })` REPLACES
 * the config's options one level deep, so a run under `CHROME_BIN` would lose
 * its `executablePath`; `chromeLaunchOptions` carries it across.
 */
export function mouseLaunchOptions(): LaunchOptions {
  return chromeLaunchOptions(MOUSE_INPUT_ARGS);
}

/**
 * What every layout editor spec file passes to `test.use`: the mouse premise
 * and NO trace.
 *
 * The config's `trace: "retain-on-failure"` starts a trace chunk on EVERY open
 * browser context around each test and stops it at the test's end, and a
 * context shared by a whole group cannot survive that: the chunk of the first
 * red test finds the recording an earlier test's discard already removed, and
 * Playwright reports `ENOENT ... traces/...recording` on top of the real
 * failure (and again when the group closes the context). The shared page
 * attaches the frame a red test died on instead (`sharedPage`), which is
 * the diagnostic those failures need. A worker-scoped option, like
 * `launchOptions`, so it is applied by each spec file itself rather than here.
 */
export function layoutEditorUse(): {
  readonly launchOptions: LaunchOptions;
  readonly trace: "off";
} {
  return { launchOptions: mouseLaunchOptions(), trace: "off" };
}

/**
 * Page-side tools every page gets before its own scripts run, and again after
 * any reload: the PNG decoder the pixel helpers read screenshots through (the
 * only zlib-and-unfilter a test may add is the browser's own), and a capture
 * listener recording the last `pointermove` the page has DISPATCHED, which is
 * what `awaitPointerAt` waits on.
 */
const PAGE_TOOLS = `(() => {
  const decode = async (base64) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve);
      image.addEventListener("error", () => reject(new Error("screenshot decode failed")));
      image.src = "data:image/png;base64," + base64;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  };
  window.__decodePng = decode;
  const last = { x: Number.NaN, y: Number.NaN };
  window.__lastPointerMove = last;
  window.addEventListener("pointermove", (event) => {
    last.x = event.clientX;
    last.y = event.clientY;
  }, true);
})()`;

/** What a fixture page must say about itself before a test may use it. */
export interface PageLoad {
  /** The fixture's URL path and query, relative to the shared server. */
  readonly path: string;
  /** A page-side expression that is truthy once the fixture's probe is up. */
  readonly ready: string;
  /**
   * The name of the window array the fixture pushes uncaught errors onto, or
   * `null` for a fixture that keeps none.
   */
  readonly errorsGlobal: string | null;
}

/**
 * One page for every test of the enclosing group, with the guards the driver
 * ran around every variant: the pointer premise, no reload mid-test, and no
 * uncaught fixture error. Returns the page getter.
 */
export function sharedPage(load: PageLoad): () => Page {
  let shared: Page | null = null;
  let loadsSeen = 0;
  let loadsAtTestStart = 0;

  test.beforeAll(async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL;
    const context = await browser.newContext({
      baseURL,
      viewport: LAYOUT_EDITOR_VIEWPORT,
      deviceScaleFactor: 1,
    });
    await context.addInitScript(PAGE_TOOLS);
    const page = await context.newPage();
    page.on("load", () => {
      loadsSeen += 1;
    });
    await page.goto(load.path);
    await page.waitForFunction(load.ready, undefined, { timeout: 90_000 });
    // The premise of every mouse claim: a fine, hovering pointer. Asserted
    // positively, so a run whose Chrome ignored the flags fails here rather
    // than as forty unrelated hover failures.
    expect(
      await page.evaluate(
        'matchMedia("(hover: hover) and (pointer: fine)").matches',
      ),
      "Layout editor mouse regressions require a fine, hovering pointer",
    ).toBe(true);
    shared = page;
  });

  test.afterAll(async () => {
    const page = shared;
    shared = null;
    if (page !== null) await page.context().close();
  });

  test.beforeEach(() => {
    loadsAtTestStart = loadsSeen;
  });

  test.afterEach(async () => {
    const page = shared;
    if (page === null) return;
    const info = test.info();
    if (info.status !== info.expectedStatus) {
      // The shared page has no per-test trace, so a red test keeps the frame
      // it died on.
      await info.attach("shared-page.png", {
        body: await page.screenshot({ type: "png" }),
        contentType: "image/png",
      });
    }
    // A document rebuilt under the probes is not the one these numbers
    // describe (Vite answers a source edit with a full reload).
    expect(
      loadsSeen - loadsAtTestStart,
      "the page reloaded during this test, so its measurements describe a rebuilt document; re-run with the tree quiet",
    ).toBe(0);
    if (load.errorsGlobal !== null) {
      const errors = await page.evaluate<readonly string[]>(
        `window.${load.errorsGlobal}`,
      );
      expect(
        errors,
        `the fixture raised ${String(errors.length)} uncaught error(s)`,
      ).toEqual([]);
    }
  });

  return () => {
    if (shared === null) {
      throw new Error("the shared page is only open while its group runs");
    }
    return shared;
  };
}
