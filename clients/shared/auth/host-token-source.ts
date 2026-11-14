import { readAccessTokenExpiryMs } from "./jwt-exp";
import {
  isUsableHostToken,
  type HostToken,
  type HostTokenChange,
  type HostTokenTable,
} from "./host-token-store";

/**
 * authn's answer to one mint, as the app acts on it. `not-a-member` is the only
 * answer that says the computer is a team's.
 */
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
  /**
   * Nothing was asked: this person holds no verified sign-in here (signed
   * out, or not yet confirmed by authn). Raises no state.
   */
  | { readonly kind: "no-sign-in" };

/**
 * What one renewal did. `delayed` names the hosts whose mint could not reach
 * authn: each keeps the token it holds until authn answers again.
 */
export type HostTokenRenewal =
  | { readonly kind: "renewed"; readonly delayed: readonly string[] }
  | { readonly kind: "already-current" }
  | { readonly kind: "no-sign-in" };

export type HostTokenMint = (
  hostId: string,
  signInToken: string,
  signal: AbortSignal | null,
) => Promise<HostTokenMintOutcome>;

/**
 * The sign-in token this app may spend at authn for `userId`: present only
 * while that person's session is verified, `null` otherwise.
 */
export type VerifiedSignIn = (userId: string) => string | null;

/** Where the table lives: a file under the credentials lock, or secure storage. */
export interface HostTokenPersistence {
  load(): Promise<HostTokenTable>;
  /** Applies `change` to the latest persisted table and returns the result, atomically. */
  update(
    change: (table: HostTokenTable) => HostTokenTable,
  ): Promise<HostTokenTable>;
}

export interface HostTokenSource {
  /** The token this process last knew for the pair, read synchronously at open. */
  current(userId: string, hostId: string): HostToken | null;
  /**
   * An unexpired token for the pair: the one on disk, else a fresh mint.
   * `fresh` skips the one on disk, after a host refused it. Concurrent asks for
   * one pair share one mint.
   */
  obtain(
    userId: string,
    hostId: string,
    fresh: boolean,
    signal: AbortSignal | null,
  ): Promise<HostTokenMintOutcome>;
  /**
   * Fresh tokens for `hostIds`, asked for right after the sign-in token was
   * refreshed. One refresh buys at most one token per host, however many
   * windows ask. `already-current` when every host's token was already minted
   * with the sign-in this source holds now, so nothing was asked of authn.
   */
  renew(userId: string, hostIds: readonly string[]): Promise<HostTokenRenewal>;
  /** Keeps a token authn returned beside a relay pass. */
  adopt(userId: string, hostId: string, token: HostToken): Promise<void>;
  /** Signing out: every token of that person goes. */
  forgetUser(userId: string): Promise<void>;
  /**
   * Where this source's mints take their sign-in token from, for a shell whose
   * sign-in is known only once the app is up. A shell that mints elsewhere
   * ignores it.
   */
  bindSignIn(signIn: VerifiedSignIn): void;
  subscribe(listener: (change: HostTokenChange) => void): () => void;
}

export function createHostTokenSource(deps: {
  readonly persistence: HostTokenPersistence;
  readonly mint: HostTokenMint;
  /** `null` until {@link HostTokenSource.bindSignIn}: no mint before then. */
  readonly signIn: VerifiedSignIn | null;
  readonly now: () => number;
}): HostTokenSource {
  let signIn = deps.signIn;
  let table: HostTokenTable = new Map();
  const loaded = deps.persistence.load().then(
    (persisted) => {
      table = persisted;
    },
    () => undefined,
  );
  const listeners = new Set<(change: HostTokenChange) => void>();
  const inFlight = new Map<string, Promise<HostTokenMintOutcome>>();
  // Which refresh of the sign-in token each pair was last minted with (that
  // token's own end, never the token), so one refresh mints once per host.
  // Process memory only: a restart mints once more at most.
  const mintedWith = new Map<string, number>();
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;

  const announce = (change: HostTokenChange): void => {
    for (const listener of Array.from(listeners)) listener(change);
  };

  const store = async (
    userId: string,
    hostId: string,
    token: HostToken,
  ): Promise<void> => {
    table = await deps.persistence.update((latest) => {
      const next = new Map(latest);
      const forUser = new Map(latest.get(userId) ?? []);
      forUser.set(hostId, token);
      next.set(userId, forUser);
      return next;
    });
    announce({ userId, hostId });
  };

  const mintOnce = (
    userId: string,
    hostId: string,
    signal: AbortSignal | null,
  ): Promise<HostTokenMintOutcome> => {
    const signInToken = signIn?.(userId) ?? null;
    if (signInToken === null) return Promise.resolve({ kind: "no-sign-in" });
    const key = keyOf(userId, hostId);
    const mark = readAccessTokenExpiryMs(signInToken);
    // Keyed by the refresh too: a mint started before a refresh must not
    // stand in for the one the refresh asks for.
    const flightKey = `${key}\u0000${mark ?? "unknown"}`;
    const running = inFlight.get(flightKey);
    if (running !== undefined) return running;
    const attempt = (async (): Promise<HostTokenMintOutcome> => {
      const outcome = await deps.mint(hostId, signInToken, signal);
      if (outcome.kind === "ok") {
        if (mark === null) mintedWith.delete(key);
        else mintedWith.set(key, mark);
        await store(userId, hostId, outcome.token);
      }
      return outcome;
    })().finally(() => {
      inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, attempt);
    return attempt;
  };

  return {
    current: (userId, hostId) => table.get(userId)?.get(hostId) ?? null,

    obtain: async (userId, hostId, fresh, signal) => {
      await loaded;
      const held = table.get(userId)?.get(hostId) ?? null;
      if (!fresh && isUsableHostToken(held, deps.now()))
        return { kind: "ok", token: held };
      return mintOnce(userId, hostId, signal);
    },

    renew: async (userId, hostIds) => {
      await loaded;
      const signInToken = signIn?.(userId) ?? null;
      if (signInToken === null) return { kind: "no-sign-in" };
      const mark = readAccessTokenExpiryMs(signInToken);
      const due = Array.from(new Set(hostIds)).filter(
        (hostId) =>
          mark === null || mintedWith.get(keyOf(userId, hostId)) !== mark,
      );
      if (due.length === 0) return { kind: "already-current" };
      const outcomes = await Promise.all(
        due.map((hostId) => mintOnce(userId, hostId, null)),
      );
      return {
        kind: "renewed",
        delayed: due.filter(
          (_, index) => outcomes[index]?.kind === "unavailable",
        ),
      };
    },

    adopt: async (userId, hostId, token) => {
      await loaded;
      await store(userId, hostId, token);
    },

    forgetUser: async (userId) => {
      await loaded;
      const hostIds = Array.from(table.get(userId)?.keys() ?? []);
      table = await deps.persistence.update((latest) => {
        if (!latest.has(userId)) return latest;
        const next = new Map(latest);
        next.delete(userId);
        return next;
      });
      for (const key of Array.from(mintedWith.keys()))
        if (key.startsWith(`${userId}\u0000`)) mintedWith.delete(key);
      for (const hostId of hostIds) announce({ userId, hostId });
    },

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

/** A table that lives only as long as the process: dev runners and tests. */
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
