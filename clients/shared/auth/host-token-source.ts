import { readAccessTokenExpiryMs, readTokenIssuedAtSeconds } from "./jwt-exp";
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
  | { readonly kind: "superseded" }
  /**
   * The host process the ask was for was replaced before its mint could
   * start, and no token is held: no mint started. Nothing to show the
   * person; the caller asks again for the process observed now.
   */
  | { readonly kind: "process-replaced" };

/**
 * The host process an ask is for: its host id and the observer's identity for
 * that process (`null` until one is observed). A `HostInstance` is one; across
 * the desktop bridge it is the value the window read when it asked.
 */
export interface HostMintOwner {
  readonly hostId: string;
  readonly observed: string | null;
}

/**
 * What an `obtain` is asked with: the signal that cancels its mint, and the
 * host process it is for (`null`: none). An owned ask also says which process
 * its caller observes for the host id NOW: a mint for an observed process is
 * written only while that is still the one observed, read in the same step as
 * the write.
 */
export type HostTokenAsk =
  | { readonly signal: AbortSignal | null; readonly owner: null }
  | {
      readonly signal: AbortSignal | null;
      readonly owner: HostMintOwner;
      readonly observedNow: () => string | null;
    };

/** How a pair's `obtain` can end without a token. */
export type HostTokenMintFailure = Exclude<
  HostTokenMintOutcome,
  { readonly kind: "ok" }
>["kind"];

/**
 * How each host instance's asks for a person ended. Each ask takes its place
 * in the order as it starts, before any wait; a result is recorded only if no
 * ask that started later has already recorded one in the same era, so a late
 * refusal never replaces a newer success. Keyed by the instance itself: a
 * replaced process starts with no record. Process memory only.
 */
export interface HostMintRecords {
  readonly start: () => number;
  readonly record: (
    owner: HostMintOwner,
    userId: string,
    era: number,
    started: number,
    kind: HostTokenMintOutcome["kind"],
  ) => void;
  readonly lastFailureOf: (
    owner: HostMintOwner,
    userId: string,
    era: number,
  ) => HostTokenMintFailure | null;
}

// A token write: the era it began in, the writer's own check, and the token
// the writer asked to replace (`null`: none). All three, and the order, are
// read in the same step as the write.
interface TableWrite {
  readonly era: number;
  readonly mayWrite: () => boolean;
  readonly replaces: string | null;
}

// How a write ended: kept (`written`: false when the identical token was
// already held, so nothing was written or announced again); dropped because
// the era moved, or because the writer's own check failed; or declined
// because the token held for the pair was issued later (`held`).
type TableWriteResult =
  | {
      readonly kind: "kept";
      readonly replaced: string | null;
      readonly written: boolean;
    }
  | { readonly kind: "era-moved" }
  | { readonly kind: "not-wanted" }
  | { readonly kind: "older"; readonly held: HostToken };

/**
 * Whether `held` was issued after `writing`, by authn's issue second (`iat`,
 * read unverified). Every write of a token orders by it: none replaces a held
 * token issued later (in this source, unless it is the very token the writer
 * asked to replace). Equal may replace, and a token with no readable `iat` on
 * either side is written as before. Order is authn's issue second: two tokens
 * issued within the same second, or within authn's clock skew of each other,
 * may be written in either order; both are valid for the same person and host.
 */
export function hostTokenIssuedLater(
  held: HostToken,
  writing: HostToken,
): boolean {
  const heldAt = readTokenIssuedAtSeconds(held.token);
  const writingAt = readTokenIssuedAtSeconds(writing.token);
  return heldAt !== null && writingAt !== null && heldAt > writingAt;
}

// An observed process's own flight key: the pair's flight key and that process.
function ownerKey(flightKey: string, observed: string): string {
  return `${flightKey}\u0000${observed}`;
}

// Whose ask starts or joins a mint: none (a renewal), an owner not yet
// observed, or an observed process, with its caller's read of the process
// observed now.
type MintAsker =
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "known";
      readonly observed: string;
      readonly observedNow: () => string | null;
    };

const NO_ASKER: MintAsker = { kind: "none" };

// Read once, as the ask starts.
function askerOf(ask: HostTokenAsk): MintAsker {
  if (ask.owner === null) return NO_ASKER;
  const observed = ask.owner.observed;
  return observed === null
    ? { kind: "unknown" }
    : { kind: "known", observed, observedNow: ask.observedNow };
}

// A mint's write check: a renewal, and an owner not yet observed, are no
// attempt for a known host process, so era and order are their only checks.
function mayWriteFor(asker: MintAsker): () => boolean {
  if (asker.kind !== "known") return () => true;
  return () => asker.observedNow() === asker.observed;
}

// What a mint is asked with, beyond the pair and era.
interface MintAsk {
  readonly signal: AbortSignal | null;
  readonly asker: MintAsker;
  readonly replaces: string | null;
}

export function createHostMintRecords(): HostMintRecords {
  let order = 0;
  const records = new WeakMap<
    HostMintOwner,
    Map<
      string,
      {
        readonly era: number;
        readonly started: number;
        readonly failure: HostTokenMintFailure | null;
      }
    >
  >();
  return {
    start: () => ++order,
    record: (owner, userId, era, started, kind) => {
      let byUser = records.get(owner);
      if (byUser === undefined) {
        byUser = new Map();
        records.set(owner, byUser);
      }
      const recorded = byUser.get(userId);
      if (
        recorded !== undefined &&
        recorded.era === era &&
        recorded.started > started
      )
        return;
      byUser.set(userId, {
        era,
        started,
        failure: kind === "ok" ? null : kind,
      });
    },
    lastFailureOf: (owner, userId, era) => {
      const recorded = records.get(owner)?.get(userId);
      return recorded !== undefined && recorded.era === era
        ? recorded.failure
        : null;
    },
  };
}

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
  /**
   * Concurrent asks for one pair share a mint only within one owner: an ask
   * for an observed process joins that process's mint, an ask for an owner
   * not yet observed joins another such ask's, and either joins a running
   * renewal; neither joins the other's. An ask with no owner joins the pair's
   * latest mint and records nothing.
   */
  obtain(
    userId: string,
    hostId: string,
    fresh: boolean,
    ask: HostTokenAsk,
  ): Promise<HostTokenMintOutcome>;
  /**
   * How `owner`'s last {@link obtain} for the person ended without a token
   * (see {@link HostMintRecords}): `null` until one failed, and again once one
   * started later succeeds or the person's era moves.
   */
  lastFailureOf(
    userId: string,
    owner: HostMintOwner,
  ): HostTokenMintFailure | null;
  /** One refresh buys at most one token per host, however many windows ask. */
  renew(userId: string, hostIds: readonly string[]): Promise<HostTokenRenewal>;
  /**
   * Whether the token was kept. Dropped if the person signed out or was
   * replaced since `era`, if the token held for the pair was issued later, or
   * if `stillWanted` is false when the token would be written: it is read in
   * the same step as the write.
   */
  adopt(
    userId: string,
    hostId: string,
    token: HostToken,
    era: number,
    stillWanted: () => boolean,
  ): Promise<boolean>;
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
  // Per flight key: the latest mint, which an ask with no owner joins; the
  // mint an ask with no owner started (a renewal), which every ask joins; the
  // mint an owner not yet observed started, which only such owners join; and
  // each observed process's own, under `ownerKey`. An observed owner never
  // joins a mint started for an owner not yet observed, nor the reverse.
  const latestFlight = new Map<string, Promise<HostTokenMintOutcome>>();
  const renewFlights = new Map<string, Promise<HostTokenMintOutcome>>();
  const unknownFlights = new Map<string, Promise<HostTokenMintOutcome>>();
  const observedFlights = new Map<string, Promise<HostTokenMintOutcome>>();
  // Each pair's minting refresh (its end, never the token), so a refresh mints once per
  // host. Process memory only: a restart mints once more at most.
  const mintedWith = new Map<string, number>();
  const records = createHostMintRecords();
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

  // Every token write. Checked inside the atomic update, against what the
  // file holds then (another process may have written it), so it is ordered
  // against the update that forgets this person and against every other
  // writer of the file.
  const store = async (
    userId: string,
    hostId: string,
    token: HostToken,
    write: TableWrite,
  ): Promise<TableWriteResult> => {
    // Set inside the update's step; a holder, so the read after it is not
    // narrowed to the value before it.
    const decided: { result: TableWriteResult } = {
      result: { kind: "era-moved" },
    };
    const key = keyOf(userId, hostId);
    // Decided here, in the step that writes. A process replaced while the
    // file is written is not fenced: a wait after the decision cannot be
    // fenced by re-checking forever, and the token is this person's for this
    // host id whichever process answers; R1 drops a retired owner's effects
    // at the caller.
    table = await deps.persistence.update((latest) => {
      if (eraOf(userId) !== write.era) {
        decided.result = { kind: "era-moved" };
        return latest;
      }
      if (!write.mayWrite()) {
        decided.result = { kind: "not-wanted" };
        return latest;
      }
      const inFile = latest.get(userId)?.get(hostId) ?? null;
      // One token, one broadcast: the identical token already held is kept
      // as it stands, with no second write or announce.
      if (inFile !== null && inFile.token === token.token) {
        decided.result = { kind: "kept", replaced: null, written: false };
        return latest;
      }
      if (
        inFile !== null &&
        inFile.token !== write.replaces &&
        hostTokenIssuedLater(inFile, token)
      ) {
        decided.result = { kind: "older", held: inFile };
        return latest;
      }
      decided.result = {
        kind: "kept",
        replaced: inFile?.token ?? null,
        written: true,
      };
      const next = new Map(latest);
      const forUser = new Map(latest.get(userId) ?? []);
      forUser.set(hostId, token);
      next.set(userId, forUser);
      return next;
    });
    // Marked only once the file write has landed: a failed write marks
    // nothing. The token held now, written or later-issued, is this era's.
    const { result } = decided;
    if (result.kind === "kept" || result.kind === "older")
      storedIn.set(key, write.era);
    if (result.kind === "kept" && result.written && eraOf(userId) === write.era)
      announce({ userId, hostId, replaced: result.replaced });
    return result;
  };

  // What a mint hands back once its write has ended, decided after the
  // announce, since a listener may have moved the era meanwhile: the token
  // held for the pair now, a later-issued one included. A mint its own
  // process check declined answers as a retired attempt always has, with its
  // own token, which nothing stored.
  const answerAfter = (
    userId: string,
    hostId: string,
    era: number,
    written: TableWriteResult,
    minted: HostToken,
  ): HostTokenMintOutcome => {
    if (written.kind === "era-moved" || eraOf(userId) !== era)
      return { kind: "superseded" };
    if (written.kind === "not-wanted") return { kind: "ok", token: minted };
    return { kind: "ok", token: held(userId, hostId) ?? minted };
  };

  const mintOnce = (
    userId: string,
    hostId: string,
    era: number,
    { signal, asker, replaces }: MintAsk,
  ): Promise<HostTokenMintOutcome> => {
    if (eraOf(userId) !== era) return Promise.resolve({ kind: "superseded" });
    const signInToken = signIn?.(userId) ?? null;
    if (signInToken === null) return Promise.resolve({ kind: "no-sign-in" });
    const key = keyOf(userId, hostId);
    const mark = readAccessTokenExpiryMs(signInToken);
    // Keyed by refresh and era too: a mint begun before a refresh or a sign-out must
    // not stand in for a later ask.
    const flightKey = `${key}\u0000${mark ?? "unknown"}\u0000${era}`;
    const running =
      asker.kind === "none"
        ? latestFlight.get(flightKey)
        : asker.kind === "unknown"
          ? (unknownFlights.get(flightKey) ?? renewFlights.get(flightKey))
          : (observedFlights.get(ownerKey(flightKey, asker.observed)) ??
            renewFlights.get(flightKey));
    // Only a kept write moves the pair's refresh, and never back to an
    // earlier one: a late older flight leaves the newer refresh standing.
    const refreshMoved = (written: TableWriteResult): void => {
      if (written.kind !== "kept") return;
      const before = mintedWith.get(key);
      if (mark === null) mintedWith.delete(key);
      else if (before === undefined || before < mark) mintedWith.set(key, mark);
    };
    // A flight shares the request, never the write: authn's answer is shared,
    // and every asker, starter and joiner alike, writes the token itself under
    // its own rule (its era, its own check, its own `replaces`) and is answered
    // from its own write. A second write of the same token changes nothing.
    const answerFor = async (
      outcome: HostTokenMintOutcome,
    ): Promise<HostTokenMintOutcome> => {
      if (outcome.kind !== "ok") return outcome;
      const written = await store(userId, hostId, outcome.token, {
        era,
        mayWrite: mayWriteFor(asker),
        replaces,
      });
      refreshMoved(written);
      return answerAfter(userId, hostId, era, written, outcome.token);
    };
    if (running !== undefined) return running.then(answerFor);
    const attempt = (async (): Promise<HostTokenMintOutcome> => {
      const outcome = await deps.mint(hostId, signInToken, signal);
      return eraOf(userId) !== era ? { kind: "superseded" } : outcome;
    })();
    const starterAnswer = attempt.then(answerFor);
    // The flight stays joinable until its starter's own write has settled, so
    // an ask in between joins authn's answer instead of minting again. Each
    // map entry is removed only while it is still this flight.
    const leave = (): void => {
      if (asker.kind === "none") {
        if (renewFlights.get(flightKey) === attempt)
          renewFlights.delete(flightKey);
      } else if (asker.kind === "unknown") {
        if (unknownFlights.get(flightKey) === attempt)
          unknownFlights.delete(flightKey);
      } else if (
        observedFlights.get(ownerKey(flightKey, asker.observed)) === attempt
      )
        observedFlights.delete(ownerKey(flightKey, asker.observed));
      if (latestFlight.get(flightKey) === attempt)
        latestFlight.delete(flightKey);
    };
    void starterAnswer.then(leave, leave);
    if (asker.kind === "none") renewFlights.set(flightKey, attempt);
    else if (asker.kind === "unknown") unknownFlights.set(flightKey, attempt);
    else observedFlights.set(ownerKey(flightKey, asker.observed), attempt);
    latestFlight.set(flightKey, attempt);
    return starterAnswer;
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

    obtain: async (userId, hostId, fresh, ask) => {
      const { signal, owner } = ask;
      const era = eraOf(userId);
      // The process the ask is for, as observed when it was asked.
      const asker = askerOf(ask);
      // Its place in the order, before the load wait: two asks in one load
      // window never tie.
      const started = records.start();
      await loaded;
      if (eraOf(userId) !== era) return { kind: "superseded" };
      const token = held(userId, hostId);
      // An answer from an era the person has left says nothing of the new one.
      const record = (kind: HostTokenMintOutcome["kind"]): void => {
        if (owner === null || eraOf(userId) !== era) return;
        records.record(owner, userId, era, started, kind);
      };
      if (!fresh && isUsableHostToken(token, deps.now())) {
        record("ok");
        return { kind: "ok", token };
      }
      // No mint starts for a process no longer the one observed, as none
      // starts in an era the person has left: the same comparison as the
      // write's. It answers as a retired attempt does, with what is held.
      if (asker.kind === "known" && asker.observedNow() !== asker.observed)
        return token === null
          ? { kind: "process-replaced" }
          : { kind: "ok", token };
      let outcome: HostTokenMintOutcome;
      try {
        // The token this ask was sent to replace, refused or unusable: a
        // mint for it replaces it whatever its issue second.
        outcome = await mintOnce(userId, hostId, era, {
          signal,
          asker,
          replaces: token?.token ?? null,
        });
      } catch (cause) {
        // A token that could not be saved leaves none to present, like an
        // unreachable authn: an earlier refusal no longer stands.
        record("unavailable");
        throw cause;
      }
      record(outcome.kind);
      return outcome;
    },

    lastFailureOf: (userId, owner) =>
      records.lastFailureOf(owner, userId, eraOf(userId)),

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
        // A renewal is for a person and host id, not an attempt for a host
        // process: era and order are its write's only checks.
        due.map((hostId) =>
          mintOnce(userId, hostId, era, {
            signal: null,
            asker: NO_ASKER,
            replaces: null,
          }),
        ),
      );
      if (eraOf(userId) !== era) return { kind: "superseded" };
      return {
        kind: "renewed",
        // Delayed only where authn could not be reached. A renewal never
        // meets `process-replaced`: that answer comes only from an owned
        // obtain, before any mint starts.
        delayed: due.filter(
          (_, index) => outcomes[index]?.kind === "unavailable",
        ),
      };
    },

    adopt: async (userId, hostId, token, era, stillWanted) => {
      if (eraOf(userId) !== era) return false;
      await loaded;
      const written = await store(userId, hostId, token, {
        era,
        mayWrite: stillWanted,
        replaces: null,
      });
      return written.kind === "kept" && eraOf(userId) === era;
    },

    forgetUser: async (userId) => {
      eras.set(userId, eraOf(userId) + 1);
      for (const key of Array.from(mintedWith.keys()))
        if (key.startsWith(`${userId}\u0000`)) mintedWith.delete(key);
      for (const key of Array.from(storedIn.keys()))
        if (key.startsWith(`${userId}\u0000`)) storedIn.delete(key);
      await loaded;
      const hostIds = Array.from(table.get(userId)?.keys() ?? []);
      table = await deps.persistence.update((latest) => {
        if (!latest.has(userId)) return latest;
        const next = new Map(latest);
        next.delete(userId);
        return next;
      });
      for (const hostId of hostIds)
        announce({ userId, hostId, replaced: null });
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
