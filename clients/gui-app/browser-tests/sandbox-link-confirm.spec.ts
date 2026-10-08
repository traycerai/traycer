import { expect, test } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The sandbox link confirm with the longest URL the bridge allows (8 KiB), in
// real Chrome: the dialog never outgrows the viewport, the URL scrolls inside
// it, and Cancel and Open stay fully in view. The fixture is
// `src/__tests__/browser/sandbox-link-confirm.tsx`; the decision logic is in
// `sandbox-link-confirm.test.tsx` and `bridge-host.test.ts` (jsdom).

for (const viewport of [
  { name: "phone", size: { width: 390, height: 520 } },
  { name: "desktop", size: { width: 1280, height: 800 } },
]) {
  test(`a long URL scrolls and the actions stay in view (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport.size);
    await page.goto(fixture("sandbox-link-confirm"));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await nextFrames(page, 3);

    const box = await dialog.boundingBox();
    if (box === null) throw new Error("no dialog box");
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.size.height);

    for (const name of ["Cancel", "Open"]) {
      await expect(page.getByRole("button", { name })).toBeInViewport({
        ratio: 1,
      });
    }

    const url = page.getByTestId("sandbox-link-url");
    const scrolls = await url.evaluate(
      (node) => node.scrollHeight > node.clientHeight,
    );
    expect(scrolls).toBe(true);
  });
}
