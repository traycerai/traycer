import { describe, expect, it, vi } from "vitest";
import { forgetAllBrowserLogins } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";

/**
 * "Forget all browser logins" with nothing attached (universal-sign-in
 * decision 6, review finding F5).
 *
 * The premise of the forget ledger is that a forget SURVIVES disconnection: it
 * is recorded on this machine and carried to each host when that host comes
 * back. Making the local half conditional on a live stream deletes that
 * premise - with no host attached nothing would be forgotten anywhere, and the
 * user would be told so by a dialog that simply refused to close.
 *
 * No coordinator is registered here, so there is no live stream by
 * construction: the module registry is empty in a fresh module graph.
 */
describe("forgetAllBrowserLogins with no live stream", () => {
  it("still empties this machine's jar and records the forget", () => {
    const browserView = new FakeBrowserViewBridge();
    const forgetLogins = vi.spyOn(browserView, "forgetLogins");

    const hostCount = forgetAllBrowserLogins(browserView);

    // Zero hosts told, and that is not a failure - it is the case the ledger
    // exists for. The local half ran regardless.
    expect(hostCount).toBe(0);
    expect(forgetLogins).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a shell with no desktop bridge, rather than throwing", () => {
    // A browser tab has no jar to clear and no ledger to write; the action has
    // to degrade, not reject, because Settings renders there too.
    expect(() => forgetAllBrowserLogins(null)).not.toThrow();
  });
});
