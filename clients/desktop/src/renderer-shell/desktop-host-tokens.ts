import type { HostTokenSource } from "@traycer-clients/shared/auth/host-token-source";
import type {
  HostToken,
  HostTokenChange,
} from "@traycer-clients/shared/auth/host-token-store";
import {
  NO_ISSUED_HOST_TOKEN_ERA,
  type HostTokensBridgeSurface,
} from "../ipc-contracts/host-token-types";

/**
 * The renderer's view of main's host-only tokens: every read is answered from
 * a copy main keeps current through its change events, and every mint
 * happens in main, with the verified sign-in main already holds.
 *
 * The era is main's alone. `era` reads it from main, each entry of the copy
 * carries the era main stored it in, and a read returns an entry only in the
 * era main last reported for that person. Every request names the era its
 * work began in, and an answer from an era this window has left is dropped.
 * Forgetting a person empties their copy at once, and nothing of theirs is
 * taken in again until main has answered that forget.
 */
export function createDesktopHostTokenSource(
  bridge: HostTokensBridgeSurface,
): HostTokenSource {
  const copy = new Map<
    string,
    { readonly token: HostToken; readonly era: number }
  >();
  const listeners = new Set<(change: HostTokenChange) => void>();
  const reported = new Map<string, number>();
  const forgetting = new Map<string, number>();
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;
  const announce = (userId: string, hostId: string): void => {
    for (const listener of Array.from(listeners)) listener({ userId, hostId });
  };
  const dropPerson = (userId: string): void => {
    for (const key of Array.from(copy.keys())) {
      if (!key.startsWith(`${userId}\u0000`)) continue;
      copy.delete(key);
      announce(userId, key.slice(userId.length + 1));
    }
  };
  // Every era that crosses the bridge, whichever way it came: anything that
  // is not an era main issues reads as none, and is never taken in.
  const issued = (era: number): number =>
    Number.isSafeInteger(era) && era >= 0 ? era : NO_ISSUED_HOST_TOKEN_ERA;
  // Takes in an era main reported. A newer one means another window signed
  // this person out: what this window held of theirs goes with it.
  const learn = (userId: string, reportedEra: number): void => {
    const era = issued(reportedEra);
    if (era === NO_ISSUED_HOST_TOKEN_ERA || forgetting.has(userId)) return;
    const known = reported.get(userId);
    if (known !== undefined && era <= known) return;
    if (known !== undefined) dropPerson(userId);
    reported.set(userId, era);
  };
  const apply = (
    userId: string,
    hostId: string,
    token: HostToken | null,
    reportedEra: number,
  ): void => {
    const era = issued(reportedEra);
    if (era === NO_ISSUED_HOST_TOKEN_ERA) return;
    learn(userId, era);
    if (forgetting.has(userId) || reported.get(userId) !== era) return;
    if (token === null) copy.delete(keyOf(userId, hostId));
    else copy.set(keyOf(userId, hostId), { token, era });
    announce(userId, hostId);
  };
  // Main's era, read now. Anything that is not an era main issues reads as
  // none, and the work that asked for it keeps nothing.
  const eraOf = (userId: string): number => {
    const era = issued(bridge.era(userId));
    if (era === NO_ISSUED_HOST_TOKEN_ERA) return era;
    learn(userId, era);
    return era;
  };
  // The answer belongs to the era the work began in, and this window is
  // still in it.
  const stillIn = (userId: string, began: number, answered: number): boolean =>
    !forgetting.has(userId) && issued(answered) === began;
  bridge.subscribe((change) => {
    apply(change.userId, change.hostId, change.token, change.era);
  });
  return {
    current: (userId, hostId) => {
      const entry = copy.get(keyOf(userId, hostId));
      if (entry === undefined || forgetting.has(userId)) return null;
      return entry.era === reported.get(userId) ? entry.token : null;
    },
    obtain: async (userId, hostId, fresh) => {
      const era = eraOf(userId);
      if (era === NO_ISSUED_HOST_TOKEN_ERA) return { kind: "superseded" };
      const reply = await bridge.obtain(userId, hostId, fresh, era);
      learn(userId, reply.era);
      if (!stillIn(userId, era, reply.era)) return { kind: "superseded" };
      if (reply.outcome.kind === "ok")
        apply(userId, hostId, reply.outcome.token, reply.era);
      return reply.outcome;
    },
    renew: async (userId, hostIds) => {
      const era = eraOf(userId);
      if (era === NO_ISSUED_HOST_TOKEN_ERA) return { kind: "superseded" };
      const reply = await bridge.renew(userId, hostIds, era);
      learn(userId, reply.era);
      return stillIn(userId, era, reply.era)
        ? reply.renewal
        : { kind: "superseded" };
    },
    adopt: async (userId, hostId, token, era) => {
      if (forgetting.has(userId) || era === NO_ISSUED_HOST_TOKEN_ERA) return;
      const reply = await bridge.adopt(userId, hostId, token, era);
      learn(userId, reply.era);
      // Main kept it only if the era it began in had not moved.
      if (stillIn(userId, era, reply.era)) apply(userId, hostId, token, era);
    },
    forgetUser: async (userId) => {
      forgetting.set(userId, (forgetting.get(userId) ?? 0) + 1);
      dropPerson(userId);
      try {
        const reply = await bridge.forgetUser(userId);
        // A malformed answer leaves no era known, so nothing reads until
        // main reports one again.
        const era = issued(reply.era);
        if (era === NO_ISSUED_HOST_TOKEN_ERA) reported.delete(userId);
        else reported.set(userId, era);
      } finally {
        const left = (forgetting.get(userId) ?? 1) - 1;
        if (left === 0) forgetting.delete(userId);
        else forgetting.set(userId, left);
      }
    },
    era: eraOf,
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
