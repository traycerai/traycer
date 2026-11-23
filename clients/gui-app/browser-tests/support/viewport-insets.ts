import type { Page } from "@playwright/test";

export interface Insets {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

/**
 * The property `index.css` reads each inset by, set on the root as the notch
 * would. The shell reads its insets once and asks again on a `resize`, as a
 * rotation delivers them, so a case that needs the form to follow them
 * dispatches one after this.
 */
export async function setInsets(page: Page, insets: Insets): Promise<void> {
  await page.evaluate((value: Insets) => {
    const style = document.documentElement.style;
    style.setProperty("--safe-area-inset-top", `${String(value.top)}px`);
    style.setProperty("--safe-area-inset-left", `${String(value.left)}px`);
    style.setProperty("--safe-area-inset-right", `${String(value.right)}px`);
  }, insets);
}
