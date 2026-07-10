import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * Multi-run dev: the redirect URI's scheme must be the slot-suffixed one the
 * main process registers (`electron-main/auth/deep-link.ts`), or the cloud's
 * redirect targets a scheme no running app owns. The slot reaches the
 * renderer as `VITE_DEV_DESKTOP_SLOT` (see `scripts/dev/dev-stack.cjs`), so
 * the module is re-imported with the env stubbed.
 */
describe("DESKTOP_REDIRECT_URI under a dev-desktop slot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the bare dev scheme when no slot is active", () => {
    expect(DESKTOP_REDIRECT_URI).toBe("traycer-dev://auth/callback");
  });

  it("suffixes the scheme with the sanitized slot", async () => {
    vi.stubEnv("VITE_DEV_DESKTOP_SLOT", "My Worktree!!");
    vi.resetModules();
    const slotted = await import("../sign-in-url");
    expect(slotted.DESKTOP_REDIRECT_URI).toBe(
      "traycer-dev-my-worktree://auth/callback",
    );
  });

  it("falls back to the bare scheme when the slot sanitizes to nothing", async () => {
    vi.stubEnv("VITE_DEV_DESKTOP_SLOT", "  !!  ");
    vi.resetModules();
    const slotted = await import("../sign-in-url");
    expect(slotted.DESKTOP_REDIRECT_URI).toBe("traycer-dev://auth/callback");
  });
});
