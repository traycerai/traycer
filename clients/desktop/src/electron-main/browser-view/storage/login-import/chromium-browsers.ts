import type { LoginImportBrowser } from "@traycer-clients/shared/platform/browser-view";

/** The browsers whose jar is a Chromium `Cookies` database. */
export type ChromiumImportBrowser = Exclude<
  LoginImportBrowser,
  "firefox" | "safari" | "file"
>;

export function isChromiumImportBrowser(
  browser: LoginImportBrowser,
): browser is ChromiumImportBrowser {
  return browser !== "firefox" && browser !== "safari" && browser !== "file";
}
