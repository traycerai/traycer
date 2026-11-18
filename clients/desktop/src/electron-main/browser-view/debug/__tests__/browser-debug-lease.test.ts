import { describe, expect, it } from "vitest";
import { createHarness } from "./browser-debug-session-test-support";

/**
 * The lease is what keeps a guest nobody is driving a plain Chromium tab: no
 * attached debugger, and none of the `Runtime.enable` side effects a page can
 * read. These pin the counting itself - the parts no single consumer's suite
 * can see, because they only go wrong when two holders overlap.
 */
describe("BrowserDebugSession leases", () => {
  it("detaches on the last release, and not on a second release of one holder", async () => {
    const { session, webContents, detachReports } = createHarness();
    const agent = session.acquire();
    await agent.ready();
    const overlay = session.acquire();
    await overlay.ready();
    expect(webContents.debugger.isAttached()).toBe(true);

    agent.release();
    agent.release();

    // A double release must not take the debugger the overlay still holds, nor
    // bank a decrement the overlay's own release would then spend.
    expect(webContents.debugger.isAttached()).toBe(true);
    expect(session.isReady()).toBe(true);

    overlay.release();

    expect(webContents.debugger.isAttached()).toBe(false);
    expect(session.isReady()).toBe(false);
    // The detach is ours, so it must not travel the "we did not ask for this"
    // path - which tears down the annotation overlay and PiP for the tile.
    expect(detachReports).toEqual([]);
  });

  it("does not report its own detach after a failed domain enable", async () => {
    const { session, webContents, detachReports } = createHarness();
    webContents.debugger.failures.set(
      "Page.enable",
      new Error("Page.enable rejected"),
    );

    const lease = session.acquire();
    await expect(lease.ready()).rejects.toThrow("Page.enable rejected");

    expect(webContents.debugger.isAttached()).toBe(false);
    expect(detachReports).toEqual([]);
  });

  it("refuses a lease on a disposed session rather than attaching", () => {
    const { session, webContents } = createHarness();
    session.dispose();

    expect(() => session.acquire()).toThrow("disposed");
    expect(webContents.debugger.isAttached()).toBe(false);
    expect(webContents.debugger.commands).toEqual([]);
  });

  it("leaves a debugger it did not attach alone when the last lease goes", async () => {
    const { session, webContents } = createHarness();
    // Someone else - DevTools, another owner - already holds this debugger.
    webContents.debugger.attach("1.3");

    const lease = session.acquire();
    await lease.ready();
    lease.release();

    expect(webContents.debugger.isAttached()).toBe(true);
    expect(session.isReady()).toBe(false);
  });
});
