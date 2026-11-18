import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The chat list reorders row elements after its data changes (Legend List's
// `useDOMOrder`, 500 ms after the last position update). Moving an ancestor
// with `insertBefore` resets the iframe inside it, which made a sandboxed
// page go blank. The fixture is
// `src/__tests__/browser/legend-list-iframe-reorder.tsx`: the real list and
// the real `SandboxFrame`, two rows, data reversed on demand. The status
// logic is covered in `sandbox-frame.test.tsx` (jsdom).

const MARKERS = ["page alpha", "page beta"];

async function renderedMarkers(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const text = await frame
      .evaluate(() => document.querySelector("body")?.textContent ?? "")
      .catch(() => "");
    for (const marker of MARKERS) {
      if (text.includes(marker)) found.push(marker);
    }
  }
  return found.sort();
}

// The fixture's probes hang off `window`; strings keep the spec free of casts.
function rowOrder(page: Page): Promise<string[]> {
  return page.evaluate("window.__rowOrder()") as Promise<string[]>;
}

function frameChecksOf(page: Page): Promise<number> {
  return page.evaluate("window.__frameChecks ?? 0") as Promise<number>;
}

async function openFixture(page: Page): Promise<void> {
  await page.goto(fixture("legend-list-iframe-reorder"));
  await expect.poll(() => renderedMarkers(page)).toEqual(MARKERS);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.statuses ?? ""))
    .toContain("beta:ready");
  expect(await rowOrder(page)).toEqual(["alpha", "beta"]);
}

test("reordered rows keep their sandboxed pages when moveBefore exists", async ({
  page,
}) => {
  await openFixture(page);
  // The claim needs the API: a Chrome without it fails here, not skips.
  expect(await page.evaluate(() => typeof Element.prototype.moveBefore)).toBe(
    "function",
  );

  await page.evaluate("window.__reverseRows()");
  await expect.poll(() => rowOrder(page)).toEqual(["beta", "alpha"]);

  expect(await renderedMarkers(page)).toEqual(MARKERS);
  const statuses = await page.evaluate(() => document.body.dataset.statuses);
  expect(statuses).not.toMatch(/disposed|crashed/);
});

// Older runtimes: the list must skip sorting a container that holds an
// iframe, so the order stays put and no frame is reset.
test("without moveBefore the reorder leaves frames alone", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Element.prototype, "moveBefore");
    // The list's frame check (`container.querySelector("iframe")`) runs only
    // when it is about to sort, so a count on the list's own container is the
    // positive evidence that the sort pass ran and chose to skip.
    const original: unknown = Reflect.get(Element.prototype, "querySelector");
    if (typeof original !== "function") throw new Error("no querySelector");
    let checks = 0;
    Reflect.set(window, "__frameChecks", checks);
    Reflect.defineProperty(Element.prototype, "querySelector", {
      configurable: true,
      writable: true,
      value: function (this: Element, selector: string): unknown {
        if (
          selector === "iframe" &&
          Reflect.apply(original, this, ["[data-row]"]) !== null
        ) {
          checks += 1;
          Reflect.set(window, "__frameChecks", checks);
        }
        return Reflect.apply(original, this, [selector]);
      },
    });
  });
  await openFixture(page);
  const before = await frameChecksOf(page);
  await page.evaluate("window.__reverseRows()");
  await expect.poll(() => frameChecksOf(page)).toBeGreaterThan(before);

  expect(await rowOrder(page)).toEqual(["alpha", "beta"]);
  expect(await renderedMarkers(page)).toEqual(MARKERS);
  const statuses = await page.evaluate(() => document.body.dataset.statuses);
  expect(statuses).not.toMatch(/disposed|crashed/);
});
