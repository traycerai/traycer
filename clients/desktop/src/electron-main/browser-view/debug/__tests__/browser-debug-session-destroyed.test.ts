import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./browser-debug-session-test-support";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

/**
 * Electron's `webContents.debugger` is a native getter that THROWS "Object
 * has been destroyed" once the WebContents is destroyed - it does not hand
 * back an inert debugger. The `destroyed` event fires AFTER the WebContents
 * is destroyed, so any teardown path that runs from it (or later, off a
 * stale reference) reads the debugger through `liveDebugger()` instead of
 * `this.webContents.debugger` directly. These pin that: a destroyed
 * WebContents must not make dispose, isAttached, or a late lease release
 * throw.
 */
describe("BrowserDebugSession on a destroyed WebContents", () => {
  it("dispose on a destroyed WebContents does not touch the debugger and does not throw", async () => {
    const harness = createHarness();
    const lease = harness.session.acquire();
    await lease.ready();
    expect(harness.session.isAttached()).toBe(true);

    // Captured before destruction: Electron's `debugger` getter throws once
    // the WebContents is destroyed, so this is the only way to observe the
    // debugger's state afterward.
    const debug = harness.webContents.debugger;
    harness.webContents.destroyed = true;

    expect(() => harness.session.dispose()).not.toThrow();
    // No detach was attempted on a dead object - the debugger's own
    // "attached" bookkeeping never moved.
    expect(debug.attached).toBe(true);
  });

  it("isAttached reports false once the WebContents is destroyed", async () => {
    const harness = createHarness();
    const lease = harness.session.acquire();
    await lease.ready();
    expect(harness.session.isAttached()).toBe(true);

    harness.webContents.destroyed = true;

    expect(harness.session.isAttached()).toBe(false);
  });

  it("a late lease release on a destroyed WebContents does not throw", async () => {
    const harness = createHarness();
    const lease = harness.session.acquire();
    await lease.ready();
    expect(harness.session.isAttached()).toBe(true);

    harness.webContents.destroyed = true;

    expect(() => lease.release()).not.toThrow();
  });
});
