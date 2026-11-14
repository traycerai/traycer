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
  | { readonly kind: "no-sign-in" }
  /**
   * The person signed out, or another account replaced them, while this was
   * asked: nothing was kept, and it raises no state.
   */
  | { readonly kind: "superseded" };

/**
 * What one renewal did. `delayed` names the hosts whose mint could not reach
 * authn: each keeps the token it holds until authn answers again.
 */
export type HostTokenRenewal =
  | { readonly kind: "renewed"; readonly delayed: readonly string[] }
  | { readonly kind: "already-current" }
  | { readonly kind: "no-sign-in" }
  /** The person signed out or was replaced while it ran: report nothing. */
  | { readonly kind: "superseded" };

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
  /**
   * Keeps a token authn returned beside a relay pass, unless the person
   * signed out or was replaced since this call. The caller compares
   * {@link era} from before its mint with the era now, and calls this in the
   * same tick.
   */
  adopt(userId: string, hostId: string, token: HostToken): Promise<void>;
  /**
   * Signing out, or another account replacing this one: every token of that
   * person goes, and their {@link era} advances at once, so anything begun
   * before it keeps nothing and raises nothing.
   */
  forgetUser(userId: string): Promise<void>;
  /**
   * This person's era here. It advances each time {@link forgetUser} runs for
   * them. A mint, an adoption or a state write that began in an earlier era is
   * dropped.
   */
  era(userId: string): number;
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
  // Each person's era, advanced the moment they are forgotten, so nothing
  // begun before a sign-out or a switch can put their token back.
  const eras = new Map<string, number>();
  const eraOf = (userId: string): number => eras.get(userId) ?? 0;
  const keyOf = (userId: string, hostId: string): string =>
    `${userId}\u0000${hostId}`;

  const announce = (change: HostTokenChange): void => {
    for (const listener of Array.from(listeners)) listener(change);
  };

  /** Writes the token unless `era` has ended; `false` when it was dropped. */
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
    // Keyed by the refresh too: a mint started before a refresh must not
    // stand in for the one the refresh asks for. And by the era, so an ask
    // after a sign-out never joins a mint begun before it.
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
    current: (userId, hostId) => table.get(userId)?.get(hostId) ?? null,

    obtain: async (userId, hostId, fresh, signal) => {
      const era = eraOf(userId);
      await loaded;
      if (eraOf(userId) !== era) return { kind: "superseded" };
      const held = table.get(userId)?.get(hostId) ?? null;
      if (!fresh && isUsableHostToken(held, deps.now()))
        return { kind: "ok", token: held };
      return mintOnce(userId, hostId, era, signal);
    },

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

    adopt: async (userId, hostId, token) => {
      const era = eraOf(userId);
      await loaded;
      await store(userId, hostId, token, era);
    },

    forgetUser: async (userId) => {
      eras.set(userId, eraOf(userId) + 1);
      for (const key of Array.from(mintedWith.keys()))
        if (key.startsWith(`${userId}\u0000`)) mintedWith.delete(key);
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
