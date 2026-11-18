import { describe, expect, it, vi } from "vitest";
import type { FleetRefreshOutcome } from "@traycer-clients/shared/platform/runner-host";
import {
  requestFleetRefresh,
  type FleetRefreshCapableShell,
} from "@/lib/host/fleet-refresh";

/**
 * F6, renderer half: deregistering a host refreshes renderer state only, so
 * the selection authority's fleet (desktop main) keeps a host the account no
 * longer has and can derive `effectiveHostId` onto a machine that is gone.
 *
 * The call asserts nothing and is idempotent, which is what makes calling it
 * fire-and-forget from a success path safe rather than sloppy - so the thing
 * worth pinning is that it is announced at all.
 */

const published: FleetRefreshOutcome = { kind: "published" };

function shell(
  refreshHostFleet: () => Promise<FleetRefreshOutcome>,
): FleetRefreshCapableShell {
  return { refreshHostFleet };
}

describe("fleet refresh seam", () => {
  it("announces the change to the shell", () => {
    const refreshHostFleet = vi.fn(() => Promise.resolve(published));

    requestFleetRefresh(shell(refreshHostFleet));

    expect(refreshHostFleet).toHaveBeenCalledTimes(1);
    // Nothing is passed: the call asserts no membership of its own.
    expect(refreshHostFleet).toHaveBeenCalledWith();
  });

  it("is safe to call repeatedly - the contract is idempotent", () => {
    const refreshHostFleet = vi.fn(() => Promise.resolve(published));
    const target = shell(refreshHostFleet);

    requestFleetRefresh(target);
    requestFleetRefresh(target);

    expect(refreshHostFleet).toHaveBeenCalledTimes(2);
  });
});
