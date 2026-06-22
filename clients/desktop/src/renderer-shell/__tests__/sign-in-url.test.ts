import { describe, expect, it } from "vitest";
import { composeDesktopSignInUrl, DESKTOP_REDIRECT_URI } from "../sign-in-url";
import { DESKTOP_SIGN_IN_BASE_URL } from "../../config";

/**
 * `composeDesktopSignInUrl` reads `DESKTOP_SIGN_IN_BASE_URL` (the Cloud UI
 * base from `config`), decided at compile time by the `environment` field.
 * The OSS build ships production endpoints in source, so the base URL is the
 * production Cloud UI; the deep-link callback still uses the dev
 * `traycer-dev://` scheme because an unpackaged source build runs the dev shell.
 */
describe("composeDesktopSignInUrl", () => {
  it("appends the deep-link redirect to the source-controlled Cloud UI base URL", () => {
    expect(composeDesktopSignInUrl(DESKTOP_REDIRECT_URI)).toBe(
      `${DESKTOP_SIGN_IN_BASE_URL}?redirect_uri=traycer-dev%3A%2F%2Fauth%2Fcallback`,
    );
  });

  it("uses the production Cloud UI base URL in source", () => {
    expect(DESKTOP_SIGN_IN_BASE_URL).toBe("https://platform.traycer.ai");
  });
});
