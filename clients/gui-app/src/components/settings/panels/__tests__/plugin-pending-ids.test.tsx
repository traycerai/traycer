import { describe, expect, it } from "vitest";

/**
 * Unit-level regression for the pending-ids Set pattern used by plugins tab.
 * Mirrors markPending add/remove without mounting HostRuntime/QueryClient.
 */
function createPendingIdsTracker() {
  let pendingIds: ReadonlySet<string> = new Set();

  function markPending(trackId: string, pending: boolean): void {
    const next = new Set(pendingIds);
    if (pending) next.add(trackId);
    else next.delete(trackId);
    pendingIds = next;
  }

  function snapshot(): ReadonlySet<string> {
    return pendingIds;
  }

  return { markPending, snapshot };
}

describe("plugin pending-ids set pattern", () => {
  it("locks two rows independently without cross-clear", () => {
    const tracker = createPendingIdsTracker();

    tracker.markPending("plugin-a", true);
    tracker.markPending("plugin-b", true);
    expect(tracker.snapshot().has("plugin-a")).toBe(true);
    expect(tracker.snapshot().has("plugin-b")).toBe(true);

    // Settling A must not unlock B.
    tracker.markPending("plugin-a", false);
    expect(tracker.snapshot().has("plugin-a")).toBe(false);
    expect(tracker.snapshot().has("plugin-b")).toBe(true);

    tracker.markPending("plugin-b", false);
    expect(tracker.snapshot().size).toBe(0);
  });
});
