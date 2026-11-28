import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The live artifact card (a Tracy reference to a task artifact) is the shared
// card renderer over a reader's lifetime. jsdom proves the object port; this
// reads what only a browser decides: that the page really loads in ONE
// sandboxed iframe, that Expand and lower keep that very iframe element, that
// a save which changes the page bytes replaces the frame exactly once inside
// the surviving raised modal card (and one that changes none keeps the
// element), that revoking the reader withdraws the page and leaves nothing
// reading afterwards, and that a missing entry waits for the provider's Retry. The provider/controller are not here; the fixture
// hands the row what an admitted provider hands it.
//
// Every wait below is for something that HAPPENED (a role, a dialog state, a
// counter the page bumped); none is a frame count or a time window. The probe
// calls that change the card commit synchronously, so what is read after one
// returns is the card after it.

interface LiveCardProbe {
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
  readonly saveHead: () => void;
  readonly saveSameBytes: () => void;
  readonly revoke: () => void;
  readonly admitAgain: () => void;
}
interface ProbeWindow extends Window {
  __liveCardProbe?: LiveCardProbe;
}

/**
 * Holds ONE artifact response, the first one after `arm()`, until `release()`.
 * It records what the page paints while a response is held; it makes no claim
 * about how long a real response takes.
 */
interface ResponseGate {
  readonly arm: () => void;
  /** Resolves once a request has arrived and is being held. */
  readonly held: Promise<void>;
  readonly release: () => void;
  /** Called by the route for each request; true when this one must wait. */
  readonly take: () => boolean;
  readonly released: Promise<void>;
}

function createResponseGate(): ResponseGate {
  let armed = false;
  let notifyHeld: () => void = () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    notifyHeld = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arm: () => {
      armed = true;
    },
    held,
    release,
    released,
    take: () => {
      if (!armed) return false;
      armed = false;
      notifyHeld();
      return true;
    },
  };
}

async function serveArtifactFromPage(
  page: Page,
  gate: ResponseGate,
): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__liveCardProbe?.serve(url),
        route.request().url(),
      );
      if (served === undefined) {
        await route.abort();
        return;
      }
      if (gate.take()) await gate.released;
      await route.fulfill({
        status: served.status,
        contentType: served.mediaType,
        body: Buffer.from(served.base64, "base64"),
      });
    },
  );
}

async function callProbe(
  page: Page,
  call: "saveHead" | "saveSameBytes" | "revoke" | "admitAgain",
): Promise<void> {
  await page.evaluate((name) => {
    const probe = (window as ProbeWindow).__liveCardProbe;
    if (probe === undefined) throw new Error("no live-card probe");
    probe[name]();
  }, call);
}

interface IframeWatchWindow extends Window {
  /** Drains the observer and returns how many iframes were inserted so far. */
  __insertedIframes?: () => number;
}

/** Counts every iframe the document gains from now on, however deep. */
async function watchIframeInsertions(page: Page): Promise<void> {
  await page.evaluate(() => {
    let inserted = 0;
    const count = (records: MutationRecord[]): void => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === "IFRAME") inserted += 1;
          inserted += node.querySelectorAll("iframe").length;
        }
    };
    const observer = new MutationObserver(count);
    observer.observe(document, { childList: true, subtree: true });
    (window as IframeWatchWindow).__insertedIframes = () => {
      count(observer.takeRecords());
      return inserted;
    };
  });
}

async function insertedIframes(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as IframeWatchWindow).__insertedIframes?.() ?? -1,
  );
}

async function focusIsInside(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((element) => element.contains(document.activeElement));
}

type ThemeChoice = "light" | "dark";

/** Dark is captured at the desktop width only: one held capture beside the light ones. */
function themesFor(viewportName: string): readonly ThemeChoice[] {
  return viewportName === "desktop" ? ["light", "dark"] : ["light"];
}

/** Whether the element paints a dark background, read from its computed colour. */
async function isDarkSurface(element: Locator): Promise<boolean> {
  return element.evaluate((node) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    const painted = getComputedStyle(node).backgroundColor;
    // A transparent surface paints nothing of its own, and would read as black.
    if (painted === "rgba(0, 0, 0, 0)" || painted === "transparent")
      throw new Error("the surface has no background of its own");
    context.fillStyle = painted;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.4;
  });
}

function figure(page: Page, name: string): Locator {
  return page.getByRole("figure", { name });
}

function pageFrame(page: Page) {
  return page.frameLocator('iframe[title="Live report"]');
}

function raised(page: Page): Locator {
  return page.getByRole("dialog", { name: "Live report" });
}

/** The raised card is a native dialog that is open AND modal, not merely visible. */
async function expectRaisedAndModal(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("open", true);
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(
    true,
  );
}

async function counter(page: Page, name: string): Promise<number> {
  return Number(await page.evaluate((key) => document.body.dataset[key], name));
}

async function open(page: Page, query: string): Promise<ResponseGate> {
  const gate = createResponseGate();
  await serveArtifactFromPage(page, gate);
  await page.goto(`${fixture("live-artifact-card")}${query}`);
  return gate;
}

/** The inline Expand comes up on focus, as on the captured card. */
async function expand(page: Page): Promise<Locator> {
  await figure(page, "Artifact: Live report")
    .getByRole("button", { name: "Expand" })
    .focus();
  await page.keyboard.press("Enter");
  const dialog = raised(page);
  await expectRaisedAndModal(dialog);
  return dialog;
}

const VIEWPORTS = [
  { name: "desktop", width: 900, height: 700 },
  { name: "390px", width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      actionTimeout: 10_000,
    });

    test("the page loads in one sandboxed frame inside the width, with no Comments or version picker", async ({
      page,
    }) => {
      await open(page, "");

      await expect(pageFrame(page).locator("#known")).toHaveText(
        "Live report version 1",
      );
      await expect(page.locator("iframe")).toHaveCount(1);
      const box = await figure(page, "Artifact: Live report").boundingBox();
      if (box === null) throw new Error("the card has no layout box");
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await expect(page.getByRole("button", { name: "Comments" })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("button", { name: /HTML version history/ }),
      ).toHaveCount(0);
    });

    for (const theme of themesFor(viewport.name)) {
      const themeNote = theme === "dark" ? " (dark theme)" : "";
      const themeFile = theme === "dark" ? "-dark" : "";
      test(`a save that changes the page keeps the raised card modal and replaces its frame exactly once${themeNote}`, async ({
        page,
      }, testInfo) => {
        const gate = await open(page, theme === "dark" ? "?theme=dark" : "");
        if (theme === "dark") {
          // The real theme applier painted dark, and the card shows it.
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        }
        await expect(pageFrame(page).locator("#known")).toBeVisible();
        const dialog = await expand(page);
        if (theme === "dark") {
          // The raised dialog itself is transparent by design; the surface that
          // paints is its first inner box (artifact-expansion.tsx, `bg-popover`).
          expect(await isDarkSurface(dialog.locator("div.bg-popover"))).toBe(
            true,
          );
        }
        const before = await dialog
          .locator("iframe")
          .evaluateHandle((element) => element);
        // The raised surface and the card's figure, held by element identity.
        const dialogBefore = await dialog.elementHandle();
        const figureBefore = await figure(
          page,
          "Artifact: Live report",
        ).elementHandle();
        await watchIframeInsertions(page);

        // Hold the replacement frame's document, so the open dialog can be seen
        // with the new frame inserted and nothing yet loaded in it. This records
        // a held response, not how long a real one takes.
        gate.arm();
        try {
          await callProbe(page, "saveHead");
          await gate.held;
          expect(await insertedIframes(page)).toBe(1);
          // The open dialog is still the raised, modal surface while the
          // replacement document is held, not only once it has loaded.
          await expectRaisedAndModal(dialog);
          // Written to a file in the test's output directory so it survives a
          // passing run, then attached by path (one capture, no duplicate).
          const screenshotPath = testInfo.outputPath(
            `live-card-${viewport.name}${themeFile}-replacement-document-held.png`,
          );
          await dialog.screenshot({ path: screenshotPath });
          await testInfo.attach(
            `live-card-${viewport.name}${themeFile}-replacement-document-held.png`,
            { path: screenshotPath, contentType: "image/png" },
          );
        } finally {
          gate.release();
        }

        // The new page is what loads: a save the card ignored cannot pass.
        await expect(
          dialog.frameLocator('iframe[title="Live report"]').locator("#known"),
        ).toHaveText("Live report version 2");
        // The raised card is the same surface, still open and modal, with the
        // reader's focus still inside it.
        await expectRaisedAndModal(dialog);
        expect(await focusIsInside(dialog)).toBe(true);
        // The frame was replaced, once: the old element is gone and exactly one
        // new one was inserted for this save.
        expect(await before.evaluate((element) => element.isConnected)).toBe(
          false,
        );
        expect(await insertedIframes(page)).toBe(1);
        await expect(page.locator("iframe")).toHaveCount(1);
        // The same dialog and the same figure carried the save: only the frame
        // inside them was replaced.
        expect(
          await dialogBefore.evaluate((element) => element.isConnected),
        ).toBe(true);
        expect(
          await figureBefore.evaluate((element) => element.isConnected),
        ).toBe(true);
        expect(
          await dialog.evaluate(
            (element, held) => element === held,
            dialogBefore,
          ),
        ).toBe(true);

        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(page.locator("iframe")).toHaveCount(1);
        // Lowering after the save returns focus to the Expand control.
        await expect(
          figure(page, "Artifact: Live report").getByRole("button", {
            name: "Expand",
          }),
        ).toBeFocused();
      });
    }

    test("a save that changes no page bytes keeps the very same frame element", async ({
      page,
    }) => {
      await open(page, "");
      await expect(pageFrame(page).locator("#known")).toBeVisible();
      await page
        .locator("iframe")
        .evaluate((element) => element.setAttribute("data-identity", "first"));
      const dialog = await expand(page);
      await expect(dialog.locator('iframe[data-identity="first"]')).toHaveCount(
        1,
      );
      await watchIframeInsertions(page);

      await callProbe(page, "saveSameBytes");

      await expectRaisedAndModal(dialog);
      await expect(dialog.locator('iframe[data-identity="first"]')).toHaveCount(
        1,
      );
      expect(await insertedIframes(page)).toBe(0);
      await expect(
        dialog.frameLocator('iframe[title="Live report"]').locator("#known"),
      ).toHaveText("Live report version 1");

      // Lowering keeps the element too: the frame is promoted in place.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator('iframe[data-identity="first"]')).toHaveCount(
        1,
      );
      await expect(
        figure(page, "Artifact: Live report").getByRole("button", {
          name: "Expand",
        }),
      ).toBeFocused();
    });

    test("revoking the reader while raised withdraws the page and nothing reads afterwards", async ({
      page,
    }) => {
      await open(page, "");
      await expect(pageFrame(page).locator("#known")).toBeVisible();
      const dialog = await expand(page);

      await callProbe(page, "revoke");

      await expect(dialog).toBeHidden();
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect(figure(page, "Artifact")).toBeVisible();
      await expect(page.getByText("Artifact unavailable.")).toBeVisible();
      await expect(page.getByText("Live report")).toHaveCount(0);

      // Recorded AFTER the frame is gone. A head save then commits
      // synchronously; a card still reading would have asked again.
      const readsAfterWithdrawal = await counter(page, "reads");
      await callProbe(page, "saveHead");
      expect(await counter(page, "reads")).toBe(readsAfterWithdrawal);
      await expect(page.locator("iframe")).toHaveCount(0);
    });

    test("a missing entry stops at Retry, which asks the provider and reads nothing until it admits again", async ({
      page,
    }) => {
      await open(page, "?entry=missing");
      await expect(page.getByText("Artifact unavailable.")).toBeVisible();
      // The entry read that found it missing has happened by now.
      const readsBefore = await counter(page, "reads");
      expect(readsBefore).toBeGreaterThan(0);

      await page.getByRole("button", { name: "Retry" }).click();

      await expect.poll(() => counter(page, "retries")).toBe(1);
      expect(await counter(page, "reads")).toBe(readsBefore);
      await expect(page.locator("iframe")).toHaveCount(0);

      await callProbe(page, "admitAgain");
      await expect(pageFrame(page).locator("#known")).toHaveText(
        "Live report version 1",
      );
    });
  });
}
