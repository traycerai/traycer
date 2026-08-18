import { describe, expect, it, vi } from "vitest";
import {
  requestFleetRefresh,
  type FleetRefreshCapableShell,
} from "@/lib/host/fleet-refresh";

/**
 * F6, renderer half: deregistering a host refreshes renderer state only, so
 * the selection authority's fleet (desktop main) keeps a host the account no
 * longer has and can derive `effectiveHostId` onto a machine that is gone.
 *
 * The contract is result-free and idempotent, which is what makes calling it
 * fire-and-forget from a success path safe rather than sloppy - so the only
 * things worth pinning are that it is announced at all, and that a rejection
 * cannot escape into the caller's success path.
 */

function shell(
  refreshHostFleet: () => Promise<void>,
): FleetRefreshCapableShell {
  return { refreshHostFleet };
}

describe("fleet refresh seam", () => {
  it("announces the change to the shell", () => {
    const refreshHostFleet = vi.fn(() => Promise.resolve());

    requestFleetRefresh(shell(refreshHostFleet));

    expect(refreshHostFleet).toHaveBeenCalledTimes(1);
    // Result-free by contract: nothing is passed and nothing is read back.
    expect(refreshHostFleet).toHaveBeenCalledWith();
  });

  it("does not surface a rejection to the caller", async () => {
    const refreshHostFleet = vi.fn(() =>
      Promise.reject(new Error("main unreachable")),
    );

    expect(() => {
      requestFleetRefresh(shell(refreshHostFleet));
    }).not.toThrow();

    // A swallowed rejection must also not survive as an unhandled one: a
    // failed refresh leaves main exactly as stale as it already was, and the
    // authority's own evidence kernel is what recovers.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("is safe to call repeatedly - the contract is idempotent", () => {
    const refreshHostFleet = vi.fn(() => Promise.resolve());
    const target = shell(refreshHostFleet);

    requestFleetRefresh(target);
    requestFleetRefresh(target);

    expect(refreshHostFleet).toHaveBeenCalledTimes(2);
  });
});
