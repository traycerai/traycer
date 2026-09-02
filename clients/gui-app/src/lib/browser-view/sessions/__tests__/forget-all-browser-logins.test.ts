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
  it("still empties this machine's jar and records the forget", async () => {
    const browserView = new FakeBrowserViewBridge();
    const forgetLogins = vi.spyOn(browserView, "forgetLogins");

    const hostCount = await forgetAllBrowserLogins(browserView);

    // Zero hosts told, and that is not a failure - it is the case the ledger
    // exists for. The local half ran regardless.
    expect(hostCount).toBe(0);
    expect(forgetLogins).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a shell with no desktop bridge, rather than throwing", async () => {
    // A browser tab has no jar to clear and no ledger to write; the action has
    // to degrade, not reject, because Settings renders there too.
    await expect(forgetAllBrowserLogins(null)).resolves.toBe(0);
  });

  // Browser security review, root cause C: main raises the native dialog and
  // is the authority on the answer, so a cancelled dialog must leave the hosts
  // alone too. The old fire-and-forget `void` could not tell a cancel from a
  // completion and fanned `forgetLogins` out either way; the local half is now
  // awaited and its verdict gates the fan-out.
  it("answers no-hosts-told when the main-process confirmation was declined", async () => {
    const browserView = new FakeBrowserViewBridge();
    const forgetLogins = vi
      .spyOn(browserView, "forgetLogins")
      .mockResolvedValue(false);

    expect(await forgetAllBrowserLogins(browserView)).toBe(0);
    expect(forgetLogins).toHaveBeenCalledTimes(1);
  });

  it("answers no-hosts-told when the local half rejected", async () => {
    const browserView = new FakeBrowserViewBridge();
    vi.spyOn(browserView, "forgetLogins").mockRejectedValue(
      new Error("jar clear failed"),
    );

    // A rejection is not a confirmation either: the hosts must not shred their
    // slices for a forget this machine could not perform.
    await expect(forgetAllBrowserLogins(browserView)).resolves.toBe(0);
  });
});
