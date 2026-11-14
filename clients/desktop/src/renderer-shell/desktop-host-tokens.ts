import type { HostTokenSource } from "@traycer-clients/shared/auth/host-token-source";
import type {
  HostToken,
  HostTokenChange,
} from "@traycer-clients/shared/auth/host-token-store";
import type { HostTokensBridgeSurface } from "../ipc-contracts/host-token-types";

/**
 * The renderer's view of main's host-only tokens: every read is answered from
 * a copy main keeps current through its change events, and every mint
 * happens in main, with the verified sign-in main already holds.
 */
export function createDesktopHostTokenSource(
  bridge: HostTokensBridgeSurface,
): HostTokenSource {
  const copy = new Map<string, HostToken>();
  const listeners = new Set<(change: HostTokenChange) => void>();
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;
  const apply = (
    userId: string,
    hostId: string,
    token: HostToken | null,
  ): void => {
    if (token === null) copy.delete(keyOf(userId, hostId));
    else copy.set(keyOf(userId, hostId), token);
    for (const listener of Array.from(listeners)) listener({ userId, hostId });
  };
  bridge.subscribe((change) => {
    apply(change.userId, change.hostId, change.token);
  });
  return {
    current: (userId, hostId) => copy.get(keyOf(userId, hostId)) ?? null,
    obtain: async (userId, hostId, fresh) => {
      const outcome = await bridge.obtain(userId, hostId, fresh);
      if (outcome.kind === "ok") apply(userId, hostId, outcome.token);
      return outcome;
    },
    renew: (userId, hostIds) => bridge.renew(userId, hostIds),
    adopt: async (userId, hostId, token) => {
      apply(userId, hostId, token);
      await bridge.adopt(userId, hostId, token);
    },
    forgetUser: (userId) => bridge.forgetUser(userId),
    // Main mints with its own verified sign-in.
    bindSignIn: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
