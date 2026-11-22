import { readAccessTokenExpiryMs } from "./jwt-exp";
import {
  isUsableHostToken,
  type HostToken,
  type HostTokenChange,
  type HostTokenTable,
} from "./host-token-store";

// `not-a-member` is the only answer that says the computer is a team's.
export type HostTokenMintOutcome =
  | { readonly kind: "ok"; readonly token: HostToken }
  /** 403 `team_membership_required`: a live team computer, and not a member. */
  | { readonly kind: "not-a-member" }
  /** A bare 404: another person's computer, an unknown, deregistered or revoked one. */
  | { readonly kind: "not-admitted" }
  /** 402 `sandbox_frozen`. */
  | { readonly kind: "sandbox-frozen" }
  /** authn refused the sign-in token itself (401): the sign-in recovers, not the host. */
  | { readonly kind: "sign-in-rejected" }
  /** A transport failure or a 5xx: authn could not be reached. */
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "no-sign-in" }
  | { readonly kind: "superseded" };

/** How a pair's `obtain` can end without a token. */
export type HostTokenMintFailure = Exclude<
  HostTokenMintOutcome,
  { readonly kind: "ok" }
>["kind"];

// `delayed`: hosts whose mint could not reach authn; each keeps the token it holds.
export type HostTokenRenewal =
  | { readonly kind: "renewed"; readonly delayed: readonly string[] }
  | { readonly kind: "already-current" }
  | { readonly kind: "no-sign-in" }
  | { readonly kind: "superseded" };

export type HostTokenMint = (
  hostId: string,
  signInToken: string,
  signal: AbortSignal | null,
) => Promise<HostTokenMintOutcome>;

export type VerifiedSignIn = (userId: string) => string | null;

export interface HostTokenPersistence {
  load(): Promise<HostTokenTable>;
  /** Applies `change` to the latest persisted table and returns the result, atomically. */
  update(
    change: (table: HostTokenTable) => HostTokenTable,
  ): Promise<HostTokenTable>;
}

export interface HostTokenSource {
  /** Only a token stored in the person's current era is returned. */
  current(userId: string, hostId: string): HostToken | null;
  /**
   * The stored tokens are read: until then `current` knows none of them, and
   * none is known to be missing. A local read, never the cloud.
   */
  loaded(): boolean;
  /** Settles once {@link loaded}; never rejects. */
  whenLoaded(): Promise<void>;
  /** Every token {@link current} returns for the person, by host id. */
  heldFor(userId: string): ReadonlyMap<string, HostToken>;
  /** Concurrent asks for one pair share one mint. */
  obtain(
    userId: string,
    hostId: string,
    fresh: boolean,
    signal: AbortSignal | null,
  ): Promise<HostTokenMintOutcome>;
  /**
   * How the last {@link obtain} for the pair in this process ended without a
   * token, whichever caller asked: `null` until one failed, and again once one
   * succeeds or the person's era moves. Process memory only.
   */
  lastFailure(userId: string, hostId: string): HostTokenMintFailure | null;
  /** One refresh buys at most one token per host, however many windows ask. */
  renew(userId: string, hostIds: readonly string[]): Promise<HostTokenRenewal>;
  /** Dropped if the person signed out or was replaced since `era`. */
  adopt(
    userId: string,
    hostId: string,
    token: HostToken,
    era: number,
  ): Promise<void>;
  /** Advances their era at once, so anything begun before keeps nothing. */
  forgetUser(userId: string): Promise<void>;
  /** Work begun in an earlier era is dropped; a value `isIssuedHostTokenEra` refuses starts nothing. */
  era(userId: string): number;
  bindSignIn(signIn: VerifiedSignIn): void;
  subscribe(listener: (change: HostTokenChange) => void): () => void;
}

export function isIssuedHostTokenEra(era: number): boolean {
  return Number.isSafeInteger(era) && era >= 0;
}

export function createHostTokenSource(deps: {
  readonly persistence: HostTokenPersistence;
  readonly mint: HostTokenMint;
  readonly signIn: VerifiedSignIn | null;
  readonly now: () => number;
}): HostTokenSource {
  let signIn = deps.signIn;
  let table: HostTokenTable = new Map();
  let isLoaded = false;
  // A table that could not be read is as loaded as an empty one: nothing more
  // will come of waiting.
  const loaded = deps.persistence.load().then(
    (persisted) => {
      table = persisted;
      isLoaded = true;
    },
    () => {
      isLoaded = true;
    },
  );
  const listeners = new Set<(change: HostTokenChange) => void>();
  const inFlight = new Map<string, Promise<HostTokenMintOutcome>>();
  // Each pair's minting refresh (its end, never the token), so a refresh mints once per
  // host. Process memory only: a restart mints once more at most.
  const mintedWith = new Map<string, number>();
  const failures = new Map<string, HostTokenMintFailure>();
  const eras = new Map<string, number>();
  const eraOf = (userId: string): number => eras.get(userId) ?? 0;
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;
  // A token is read back only in the era it was stored in, so advancing an era hides
  // every token of that person at once, before the delete lands.
  const storedIn = new Map<string, number>();
  const held = (userId: string, hostId: string): HostToken | null => {
    const token = table.get(userId)?.get(hostId) ?? null;
    if (token === null) return null;
    return (storedIn.get(keyOf(userId, hostId)) ?? 0) === eraOf(userId)
      ? token
      : null;
  };

  const announce = (change: HostTokenChange): void => {
    for (const listener of Array.from(listeners)) listener(change);
  };

  const store = async (
    userId: string,
    hostId: string,
    token: HostToken,
    era: number,
  ): Promise<boolean> => {
    let kept = false;
    // Checked inside the atomic update, so it is ordered against the update
    // that forgets this person.
    table = await deps.persistence.update((latest) => {
      kept = eraOf(userId) === era;
      if (!kept) return latest;
      storedIn.set(keyOf(userId, hostId), era);
      const next = new Map(latest);
      const forUser = new Map(latest.get(userId) ?? []);
      forUser.set(hostId, token);
      next.set(userId, forUser);
      return next;
    });
    if (!kept || eraOf(userId) !== era) return false;
    announce({ userId, hostId });
    return true;
  };

  const mintOnce = (
    userId: string,
    hostId: string,
    era: number,
    signal: AbortSignal | null,
  ): Promise<HostTokenMintOutcome> => {
    if (eraOf(userId) !== era) return Promise.resolve({ kind: "superseded" });
    const signInToken = signIn?.(userId) ?? null;
    if (signInToken === null) return Promise.resolve({ kind: "no-sign-in" });
    const key = keyOf(userId, hostId);
    const mark = readAccessTokenExpiryMs(signInToken);
    // Keyed by refresh and era too: a mint begun before a refresh or a sign-out must
    // not stand in for a later ask.
    const flightKey = `${key}\u0000${mark ?? "unknown"}\u0000${era}`;
    const running = inFlight.get(flightKey);
    if (running !== undefined) return running;
    const attempt = (async (): Promise<HostTokenMintOutcome> => {
      const outcome = await deps.mint(hostId, signInToken, signal);
      if (eraOf(userId) !== era) return { kind: "superseded" };
      if (outcome.kind === "ok") {
        if (!(await store(userId, hostId, outcome.token, era)))
          return { kind: "superseded" };
        if (mark === null) mintedWith.delete(key);
        else mintedWith.set(key, mark);
      }
      return outcome;
    })().finally(() => {
      inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, attempt);
    return attempt;
  };

  return {
    current: held,
    loaded: () => isLoaded,
    whenLoaded: () => loaded,
    heldFor: (userId) => {
      const tokens = new Map<string, HostToken>();
      for (const hostId of table.get(userId)?.keys() ?? []) {
        const token = held(userId, hostId);
        if (token !== null) tokens.set(hostId, token);
      }
      return tokens;
    },

    obtain: async (userId, hostId, fresh, signal) => {
      const era = eraOf(userId);
      await loaded;
      if (eraOf(userId) !== era) return { kind: "superseded" };
      const token = held(userId, hostId);
      // An answer from an era the person has left says nothing of the new one.
      const record = (kind: HostTokenMintOutcome["kind"]): void => {
        if (eraOf(userId) !== era) return;
        if (kind === "ok") failures.delete(keyOf(userId, hostId));
        else failures.set(keyOf(userId, hostId), kind);
      };
      if (!fresh && isUsableHostToken(token, deps.now())) {
        record("ok");
        return { kind: "ok", token };
      }
      let outcome: HostTokenMintOutcome;
      try {
        outcome = await mintOnce(userId, hostId, era, signal);
      } catch (cause) {
        // A token that could not be saved leaves none to present, like an
        // unreachable authn: an earlier refusal no longer stands.
        record("unavailable");
        throw cause;
      }
      record(outcome.kind);
      return outcome;
    },

    lastFailure: (userId, hostId) =>
      failures.get(keyOf(userId, hostId)) ?? null,

    renew: async (userId, hostIds) => {
      const era = eraOf(userId);
      await loaded;
      if (eraOf(userId) !== era) return { kind: "superseded" };
      const signInToken = signIn?.(userId) ?? null;
      if (signInToken === null) return { kind: "no-sign-in" };
      const mark = readAccessTokenExpiryMs(signInToken);
      const due = Array.from(new Set(hostIds)).filter(
        (hostId) =>
          mark === null || mintedWith.get(keyOf(userId, hostId)) !== mark,
      );
      if (due.length === 0) return { kind: "already-current" };
      const outcomes = await Promise.all(
        due.map((hostId) => mintOnce(userId, hostId, era, null)),
      );
      if (eraOf(userId) !== era) return { kind: "superseded" };
      return {
        kind: "renewed",
        delayed: due.filter(
          (_, index) => outcomes[index]?.kind === "unavailable",
        ),
      };
    },

    adopt: async (userId, hostId, token, era) => {
      if (eraOf(userId) !== era) return;
      await loaded;
      await store(userId, hostId, token, era);
    },

    forgetUser: async (userId) => {
      eras.set(userId, eraOf(userId) + 1);
      for (const key of Array.from(mintedWith.keys()))
        if (key.startsWith(`${userId}\u0000`)) mintedWith.delete(key);
      for (const key of Array.from(storedIn.keys()))
        if (key.startsWith(`${userId}\u0000`)) storedIn.delete(key);
      for (const key of Array.from(failures.keys()))
        if (key.startsWith(`${userId}\u0000`)) failures.delete(key);
      await loaded;
      const hostIds = Array.from(table.get(userId)?.keys() ?? []);
      table = await deps.persistence.update((latest) => {
        if (!latest.has(userId)) return latest;
        const next = new Map(latest);
        next.delete(userId);
        return next;
      });
      for (const hostId of hostIds) announce({ userId, hostId });
    },

    era: eraOf,

    bindSignIn: (next) => {
      signIn = next;
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createMemoryHostTokenPersistence(): HostTokenPersistence {
  let table: HostTokenTable = new Map();
  return {
    load: () => Promise.resolve(table),
    update: (change) => {
      table = change(table);
      return Promise.resolve(table);
    },
  };
}
