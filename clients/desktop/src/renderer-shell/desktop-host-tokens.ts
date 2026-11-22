import {
  isIssuedHostTokenEra,
  type HostTokenMintFailure,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type {
  HostToken,
  HostTokenChange,
} from "@traycer-clients/shared/auth/host-token-store";
import {
  NO_ISSUED_HOST_TOKEN_ERA,
  type HostTokensBridgeSurface,
} from "../ipc-contracts/host-token-types";

/**
 * Reads come from a copy main keeps current; every mint happens in main. An entry
 * is read only in the era main last reported for its person, and an answer from an
 * era this window has left is dropped. A forget takes nothing in until main answers it.
 * The copy counts as loaded once main's snapshot of the signed-in person's tokens
 * is taken in, or could not be had (then it is loaded empty).
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
  // How this window's asks ended, for every client in it: `lastFailure` is a
  // synchronous read, so it cannot ask main.
  const failures = new Map<string, HostTokenMintFailure>();
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;
  const announce = (userId: string, hostId: string): void => {
    for (const listener of Array.from(listeners)) listener({ userId, hostId });
  };
  const dropPerson = (userId: string): void => {
    for (const key of Array.from(failures.keys()))
      if (key.startsWith(`${userId}\u0000`)) failures.delete(key);
    for (const key of Array.from(copy.keys())) {
      if (!key.startsWith(`${userId}\u0000`)) continue;
      copy.delete(key);
      announce(userId, key.slice(userId.length + 1));
    }
  };
  // Every era that crosses the bridge, whichever way it came: anything that
  // is not an era main issues reads as none, and is never taken in.
  const issued = (era: number): number =>
    isIssuedHostTokenEra(era) ? era : NO_ISSUED_HOST_TOKEN_ERA;
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
  const stillIn = (userId: string, began: number, answered: number): boolean =>
    !forgetting.has(userId) &&
    issued(answered) === began &&
    reported.get(userId) === began;
  // Pairs a change reached before the snapshot was taken in: the change is
  // the newer of the two.
  const delivered = new Set<string>();
  let isLoaded = false;
  bridge.subscribe((change) => {
    if (!isLoaded) delivered.add(keyOf(change.userId, change.hostId));
    apply(change.userId, change.hostId, change.token, change.era);
  });
  // Asked after subscribing, so no change falls between the two. An entry of
  // an era older than one this window already took in is dropped by `apply`.
  const loaded = Promise.resolve()
    .then(() => bridge.snapshot())
    .then(
      (reply) => {
        const userId = reply.userId;
        if (userId === null) return;
        for (const { hostId, token } of reply.tokens)
          if (!delivered.has(keyOf(userId, hostId)))
            apply(userId, hostId, token, reply.era);
      },
      () => undefined,
    )
    .then(() => {
      isLoaded = true;
      delivered.clear();
    });
  const current = (userId: string, hostId: string): HostToken | null => {
    const entry = copy.get(keyOf(userId, hostId));
    if (entry === undefined || forgetting.has(userId)) return null;
    return entry.era === reported.get(userId) ? entry.token : null;
  };
  return {
    current,
    loaded: () => isLoaded,
    whenLoaded: () => loaded,
    heldFor: (userId) => {
      const held = new Map<string, HostToken>();
      for (const key of copy.keys()) {
        if (!key.startsWith(`${userId}\u0000`)) continue;
        const hostId = key.slice(userId.length + 1);
        const token = current(userId, hostId);
        if (token !== null) held.set(hostId, token);
      }
      return held;
    },
    obtain: async (userId, hostId, fresh) => {
      const era = eraOf(userId);
      if (era === NO_ISSUED_HOST_TOKEN_ERA) return { kind: "superseded" };
      const reply = await bridge.obtain(userId, hostId, fresh, era);
      learn(userId, reply.era);
      if (!stillIn(userId, era, reply.era)) return { kind: "superseded" };
      if (reply.outcome.kind === "ok") {
        failures.delete(keyOf(userId, hostId));
        apply(userId, hostId, reply.outcome.token, reply.era);
      } else failures.set(keyOf(userId, hostId), reply.outcome.kind);
      return reply.outcome;
    },
    lastFailure: (userId, hostId) =>
      failures.get(keyOf(userId, hostId)) ?? null,
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
