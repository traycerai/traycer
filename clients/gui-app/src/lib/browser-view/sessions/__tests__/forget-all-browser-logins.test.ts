import { describe, expect, it, vi } from "vitest";
import { forgetAllBrowserLogins } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";

/**
 * "Forget all browser logins" (universal-sign-in decision 6, review finding
 * F5, browser-security-hardening H10).
 *
 * The renderer no longer does any of the work: main raises the native
 * dialog, clears the jars, records the forget ledger, and fans it out to
 * every connected host. This is a one-call pass-through now - what remains
 * to test here is only whether the renderer reports the confirmation
 * correctly.
 */
describe("forgetAllBrowserLogins", () => {
  it("reports confirmed when the bridge confirms", async () => {
    const browserView = new FakeBrowserViewBridge();
    const forgetLogins = vi.spyOn(browserView, "forgetLogins");

    await expect(forgetAllBrowserLogins(browserView)).resolves.toBe(true);
    expect(forgetLogins).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a shell with no desktop bridge, rather than throwing", async () => {
    // A browser tab has no jar to clear and no ledger to write; the action has
    // to degrade, not reject, because Settings renders there too.
    await expect(forgetAllBrowserLogins(null)).resolves.toBe(false);
  });

  it("reports not-confirmed when the main-process confirmation was declined", async () => {
    const browserView = new FakeBrowserViewBridge();
    vi.spyOn(browserView, "forgetLogins").mockResolvedValue(false);

    await expect(forgetAllBrowserLogins(browserView)).resolves.toBe(false);
  });

  it("reports not-confirmed when the local half rejected", async () => {
    const browserView = new FakeBrowserViewBridge();
    vi.spyOn(browserView, "forgetLogins").mockRejectedValue(
      new Error("jar clear failed"),
    );

    await expect(forgetAllBrowserLogins(browserView)).resolves.toBe(false);
  });
});
