import {
  createHostMintRecords,
  hostTokenIssuedLater,
  isIssuedHostTokenEra,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import type {
  HostToken,
  HostTokenChange,
} from "@traycer-clients/shared/auth/host-token-store";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
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
  // How this window's asks ended, for every client in it: `lastFailureOf` is a
  // synchronous read, so it cannot ask main.
  const records = createHostMintRecords();
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;
  const announce = (
    userId: string,
    hostId: string,
    replaced: string | null,
  ): void => {
    for (const listener of Array.from(listeners))
      listener({ userId, hostId, replaced });
  };
  const dropPerson = (userId: string): void => {
    for (const key of Array.from(copy.keys())) {
      if (!key.startsWith(`${userId}\u0000`)) continue;
      copy.delete(key);
      announce(userId, key.slice(userId.length + 1), null);
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
  // The one way a token enters this window's copy: main's change events, its
  // snapshot, and the replies to an obtain or an adoption main kept. Each is
  // what main held when it was sent, and they can arrive out of order, so a
  // token never replaces one this copy holds that was issued later, unless
  // the copy still holds exactly the token it replaces (`replaces`: what
  // main's write replaced, for a change event; what an obtain was sent to
  // replace, for its reply), as main's store does. It is the only place this
  // window announces a token, and it announces only when its copy changed: a
  // change event and a reply carrying the token the copy already holds, in
  // the same era, announce it once between them.
  const apply = (
    userId: string,
    hostId: string,
    token: HostToken | null,
    reportedEra: number,
    replaces: string | null,
  ): void => {
    const era = issued(reportedEra);
    if (era === NO_ISSUED_HOST_TOKEN_ERA) return;
    learn(userId, era);
    if (forgetting.has(userId) || reported.get(userId) !== era) return;
    const key = keyOf(userId, hostId);
    const holding = copy.get(key);
    if (
      token === null
        ? holding === undefined
        : holding?.era === era && holding.token.token === token.token
    )
      return;
    if (
      token !== null &&
      holding !== undefined &&
      holding.era === era &&
      holding.token.token !== replaces &&
      hostTokenIssuedLater(holding.token, token)
    )
      return;
    if (token === null) copy.delete(key);
    else copy.set(key, { token, era });
    announce(userId, hostId, holding?.token.token ?? null);
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
  // the newer of the two. Kept beside `apply`'s order because a change may
  // remove the pair, which no issue second orders.
  const delivered = new Set<string>();
  let isLoaded = false;
  bridge.subscribe((change) => {
    if (!isLoaded) delivered.add(keyOf(change.userId, change.hostId));
    // What main's write replaced: a copy still holding exactly that token
    // drops it as main did, as the window that asked does with its reply.
    apply(
      change.userId,
      change.hostId,
      change.token,
      change.era,
      change.replaced,
    );
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
            apply(userId, hostId, token, reply.era, null);
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
    obtain: async (userId, hostId, fresh, { owner }) => {
      // Its place in the order, before any wait.
      const started = records.start();
      const era = eraOf(userId);
      if (era === NO_ISSUED_HOST_TOKEN_ERA) return { kind: "superseded" };
      // The token this copy held as it asked: the one the ask replaces.
      const replaces = current(userId, hostId)?.token ?? null;
      // Main keeps each observed process's mints apart by this value, read now.
      const reply = await bridge.obtain(
        userId,
        hostId,
        fresh,
        era,
        owner === null ? null : { observed: owner.observed },
      );
      learn(userId, reply.era);
      if (!stillIn(userId, era, reply.era)) return { kind: "superseded" };
      // Only the token main holds now: a mint main declined to write is
      // never taken in.
      if (reply.outcome.kind === "ok" && reply.held)
        apply(userId, hostId, reply.outcome.token, reply.era, replaces);
      // A mint never started for a replaced process says nothing of authn.
      if (owner !== null && reply.outcome.kind !== "process-replaced")
        records.record(owner, userId, era, started, reply.outcome.kind);
      return reply.outcome;
    },
    lastFailureOf: (userId, owner) => {
      const era = reported.get(userId);
      return era === undefined || forgetting.has(userId)
        ? null
        : records.lastFailureOf(owner, userId, era);
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
    adopt: async (userId, hostId, token, era, stillWanted) => {
      if (forgetting.has(userId) || era === NO_ISSUED_HOST_TOKEN_ERA)
        return false;
      // Main writes it: asked in the step that sends it there, the last this
      // window can check before main's write. Main checks the host process
      // this window observes for the host id now against its own, at the write.
      if (!stillWanted()) return false;
      const reply = await bridge.adopt(userId, hostId, token, era, {
        observed: processReleasedHosts.currentInstance(hostId).observed,
      });
      learn(userId, reply.era);
      // Taken in only if main wrote it and this window still wants it.
      const kept = reply.kept && stillIn(userId, era, reply.era);
      if (kept && stillWanted()) apply(userId, hostId, token, era, null);
      return kept;
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
