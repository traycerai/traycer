import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { drawHostMintOrder } from "./host-mint-order";
import { readTokenIssuedAtSeconds } from "./jwt-exp";
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
  | { readonly kind: "signed-out" }
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
 *
 * Each result belongs to the sign-in its mint was sent with (`signIn`: its
 * key, {@link hostSignInKey}): it is read only for that same key, never for
 * an unknown one (`null`), and a result for another sign-in replaces it
 * whatever its place in the order.
 */
export interface HostMintRecords {
  readonly start: () => number;
  readonly record: (
    owner: HostMintOwner,
    userId: string,
    era: number,
    signIn: string | null,
    started: number,
    kind: HostTokenMintOutcome["kind"],
  ) => void;
  readonly lastFailureOf: (
    owner: HostMintOwner,
    userId: string,
    era: number,
    signIn: string | null,
  ) => HostTokenMintFailure | null;
}

// A sign-in is identified by itself: a SHA-256 digest of the whole token
// (lowercase hex), computed in memory. Two sign-ins never share it, whatever
// claims they share.
function signInDigest(signInToken: string): string {
  return bytesToHex(sha256(utf8ToBytes(signInToken)));
}

/**
 * A sign-in's key ({@link signInDigest}): what a mint's flight, its refresh
 * mark and the record of how it ended are kept under; `null` with no sign-in,
 * which matches nothing. Never logged, written to disk or sent off the
 * machine; only this crosses to a window, never the sign-in itself.
 */
export function hostSignInKey(signInToken: string | null): string | null {
  return signInToken === null ? null : signInDigest(signInToken);
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
// the era moved, on a sign-out, or the writer's own check failed; or declined
// because the token held for the pair was issued later (`held`).
type TableWriteResult =
  | {
      readonly kind: "kept";
      readonly replaced: string | null;
      readonly written: boolean;
    }
  | { readonly kind: "era-moved" }
  | { readonly kind: "signed-out" }
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

// An ask's answer, and the order of the request behind it (`null`: none was
// sent), which the source compares with the pair's kept writes.
interface MintAnswer {
  readonly identified: IdentifiedMintOutcome;
  readonly order: number | null;
}

// A mint as asked: the key of the sign-in it was sent with (`null`: none
// sent), and its answer.
interface MintSent {
  readonly sentWith: string | null;
  readonly outcome: Promise<MintAnswer>;
}

// What a mint is asked with, beyond the pair and era: `owner` is whom a
// purchase is evidence for (`null`: a renewal or an ask with no owner).
interface MintAsk {
  readonly signal: AbortSignal | null;
  readonly asker: MintAsker;
  readonly owner: HostMintOwner | null;
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
        readonly signIn: string | null;
        readonly started: number;
        readonly failure: HostTokenMintFailure | null;
      }
    >
  >();
  return {
    start: () => ++order,
    record: (owner, userId, era, signIn, started, kind) => {
      let byUser = records.get(owner);
      if (byUser === undefined) {
        byUser = new Map();
        records.set(owner, byUser);
      }
      const recorded = byUser.get(userId);
      if (
        recorded !== undefined &&
        recorded.era === era &&
        recorded.signIn === signIn &&
        recorded.started > started
      )
        return;
      byUser.set(userId, {
        era,
        signIn,
        started,
        failure: kind === "ok" ? null : kind,
      });
    },
    lastFailureOf: (owner, userId, era, signIn) => {
      const recorded = records.get(owner)?.get(userId);
      return recorded !== undefined &&
        recorded.era === era &&
        signIn !== null &&
        recorded.signIn === signIn
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

/**
 * A mint dependency's answer when it draws the request order itself: `order`
 * is drawn as the actual authn request is sent (a joiner of a request gets
 * that request's; `null` when none was sent). A dependency that answers a
 * bare outcome sent the request for this call: the source draws its order as
 * it sends. Both draw from the one process clock ({@link drawHostMintOrder}),
 * so every order in a process is on the same scale.
 */
export interface OrderedMintAnswer {
  readonly outcome: HostTokenMintOutcome;
  readonly order: number | null;
}

export type HostTokenMint = (
  hostId: string,
  signInToken: string,
  signal: AbortSignal | null,
) => Promise<HostTokenMintOutcome | OrderedMintAnswer>;

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
   * started later succeeds, the person's era moves, or the sign-in they hold
   * is no longer the one that mint was sent with.
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
  /**
   * The key ({@link hostSignInKey}) of the sign-in a mint for the person
   * would be sent with now: {@link lastFailureOf} answers only for it.
   */
  signInKey(userId: string): string | null;
  bindSignIn(signIn: VerifiedSignIn): void;
  /**
   * Brings this process's sign-in up to date with the store it is kept in:
   * awaited before a refused mint is compared with the sign-in held and
   * recorded, so a refusal of a sign-in another process has since replaced
   * is dropped. Bound where the process reads the shared file itself and
   * judges a sign-in from its records (the command line). Unbound (`null`)
   * where the process mints only with a sign-in it is handed: desktop main
   * mints with the verified session its windows push, which they re-read
   * from the shared file when it changes, so a record there names the
   * sign-in main still holds and moves with it. A reader of the record never
   * needs it: a record is written only for the sign-in held after it.
   */
  bindSignInSync(sync: (() => Promise<void>) | null): void;
  subscribe(listener: (change: HostTokenChange) => void): () => void;
}

/**
 * The source KEPT this asker's own write (`written`) of the token that
 * request `order` bought on `signIn`, for `owner`, whose process check still
 * held at the answer. The first write of a token's bytes is the one written,
 * so one request's askers publish it once, starter or joiner, with the
 * request's order. A cache hit, a token read from the file, an unkept write
 * and a retired process's answer are none.
 */
export interface MintPurchase {
  readonly owner: HostMintOwner;
  readonly signIn: string;
  readonly order: number;
}

/**
 * A mint's outcome and what it stands for, by sign-in key ({@link
 * hostSignInKey}). `signIn`: for `sign-in-rejected`, the sign-in the refused
 * request was sent with; for `ok`, the sign-in the token handed back was
 * minted with (`null` when this source did not mint it); `null` for every
 * other kind. `order`: the answered request's order, on `sign-in-rejected`
 * and the host-specific failures (`not-a-member`, `not-admitted`,
 * `sandbox-frozen`) only. `purchase`: see {@link MintPurchase}. All of it
 * travels beside the outcome, never on it, so nothing that receives an
 * outcome (a listener, a log, an error, the desktop bridge) receives any of
 * it.
 */
export interface IdentifiedMintOutcome {
  readonly outcome: HostTokenMintOutcome;
  readonly signIn: string | null;
  readonly order: number | null;
  readonly purchase: MintPurchase | null;
}

/** The shared source, with the one read that carries a mint's sign-in. */
export interface IdentifyingHostTokenSource extends HostTokenSource {
  /** {@link HostTokenSource.obtain}, with the sign-in its outcome stands for. */
  obtainIdentified(
    userId: string,
    hostId: string,
    fresh: boolean,
    ask: HostTokenAsk,
  ): Promise<IdentifiedMintOutcome>;
}

export function isIssuedHostTokenEra(era: number): boolean {
  return Number.isSafeInteger(era) && era >= 0;
}

// Per host process, then pair, the highest order of that process's own
// purchase, shared by every source in this process: a failure that process
// was answered for an earlier request is outlived by it. Orders come from the
// one process clock, so every request sent after a sign-out orders above
// every purchase made before it, and a request sent before a sign-out cannot
// purchase after it (its write is refused as `era-moved`).
const purchasedOrder = new WeakMap<HostMintOwner, Map<string, number>>();
const outlivedBy = (owner: HostMintOwner, key: string): number | null =>
  purchasedOrder.get(owner)?.get(key) ?? null;
// The failures authn answered for this host: each carries its request's order.
const carriesOrder = (kind: HostTokenMintOutcome["kind"]): boolean =>
  kind === "not-a-member" ||
  kind === "not-admitted" ||
  kind === "sandbox-frozen";

export function createHostTokenSource(deps: {
  readonly persistence: HostTokenPersistence;
  readonly mint: HostTokenMint;
  readonly signIn: VerifiedSignIn | null;
  readonly now: () => number;
  /** Read in the step that writes a token: `false` drops it as signed out. */
  readonly mayStore?: (userId: string) => boolean;
}): IdentifyingHostTokenSource {
  let signIn = deps.signIn;
  let syncSignIn: (() => Promise<void>) | null = null;
  // A sync that fails leaves the sign-in as this process holds it: the
  // compare after it reads that.
  const signInUpToDate = async (): Promise<void> => {
    const sync = syncSignIn;
    if (sync === null) return;
    try {
      await sync();
    } catch {
      return;
    }
  };
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
  // Per flight key: every mint still running, in start order, of which an ask
  // with no owner joins the newest; the mint an ask with no owner started (a
  // renewal), which every ask joins; the mint an owner not yet observed
  // started, which only such owners join; and each observed process's own,
  // under `ownerKey`. An observed owner never joins a mint started for an
  // owner not yet observed, nor the reverse.
  const runningFlights = new Map<string, Promise<OrderedMintAnswer>[]>();
  const newestRunning = (
    flightKey: string,
  ): Promise<OrderedMintAnswer> | undefined => {
    const running = runningFlights.get(flightKey);
    return running?.[running.length - 1];
  };
  const renewFlights = new Map<string, Promise<OrderedMintAnswer>>();
  const unknownFlights = new Map<string, Promise<OrderedMintAnswer>>();
  const observedFlights = new Map<string, Promise<OrderedMintAnswer>>();
  // Each pair's minting sign-in (its key, never the token), so a refresh mints
  // once per host; and the sign-in the pair's latest mint was sent with, so a
  // late flight sent with an earlier one never moves it back. Process memory
  // only: a restart mints once more at most.
  const mintedWith = new Map<string, string>();
  const sentLatest = new Map<string, string>();
  // Per pair, the token this source last wrote from a mint and the sign-in
  // that mint was sent with: who a token handed back stands for. A token it
  // did not mint (read at start, adopted) stands for no known sign-in.
  const mintedToken = new Map<
    string,
    { readonly token: string; readonly signIn: string }
  >();
  const mintedBy = (
    userId: string,
    hostId: string,
    token: HostToken,
  ): string | null => {
    const entry = mintedToken.get(keyOf(userId, hostId));
    return entry !== undefined && entry.token === token.token
      ? entry.signIn
      : null;
  };
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
  // The key of the person's sign-in as a mint would be sent with it now: a
  // mint's result is recorded and read only under it.
  const signInKeyOf = (userId: string): string | null =>
    hostSignInKey(signIn?.(userId) ?? null);

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
      if (deps.mayStore?.(userId) === false) {
        decided.result = { kind: "signed-out" };
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
    if (written.kind === "signed-out") return { kind: "signed-out" };
    if (written.kind === "era-moved" || eraOf(userId) !== era)
      return { kind: "superseded" };
    if (written.kind === "not-wanted") return { kind: "ok", token: minted };
    return { kind: "ok", token: held(userId, hostId) ?? minted };
  };

  const mintOnce = (
    userId: string,
    hostId: string,
    era: number,
    { signal, asker, owner, replaces }: MintAsk,
  ): MintSent => {
    if (eraOf(userId) !== era)
      return {
        sentWith: null,
        outcome: Promise.resolve({
          identified: {
            outcome: { kind: "superseded" },
            signIn: null,
            order: null,
            purchase: null,
          },
          order: null,
        }),
      };
    const signInToken = signIn?.(userId) ?? null;
    if (signInToken === null)
      return {
        sentWith: null,
        outcome: Promise.resolve({
          identified: {
            outcome: { kind: "no-sign-in" },
            signIn: null,
            order: null,
            purchase: null,
          },
          order: null,
        }),
      };
    const key = keyOf(userId, hostId);
    const mark = signInDigest(signInToken);
    // Keyed by sign-in and era too: a mint begun before a refresh or a
    // sign-out must not stand in for a later ask.
    const flightKey = `${key}\u0000${mark}\u0000${era}`;
    sentLatest.set(key, mark);
    const running =
      asker.kind === "none"
        ? newestRunning(flightKey)
        : asker.kind === "unknown"
          ? (unknownFlights.get(flightKey) ?? renewFlights.get(flightKey))
          : (observedFlights.get(ownerKey(flightKey, asker.observed)) ??
            renewFlights.get(flightKey));
    // Only a kept write moves the pair's refresh, and only to the sign-in its
    // latest mint was sent with: a late flight sent with an earlier one
    // leaves the newer refresh standing.
    const refreshMoved = (written: TableWriteResult): void => {
      if (written.kind !== "kept" || sentLatest.get(key) !== mark) return;
      mintedWith.set(key, mark);
    };
    // A flight shares the request, never the write: authn's answer is shared,
    // and every asker, starter and joiner alike, writes the token itself under
    // its own rule (its era, its own check, its own `replaces`) and is answered
    // from its own write. A second write of the same token changes nothing.
    // A refusal stands for the sign-in it was sent with; a token handed back
    // for the sign-in it was minted with. A purchase is read from this
    // asker's own write: kept and written, while its process check holds.
    const answerFor = async (
      flight: OrderedMintAnswer,
    ): Promise<MintAnswer> => {
      const { outcome, order } = flight;
      if (outcome.kind === "sign-in-rejected")
        return {
          identified: { outcome, signIn: mark, order, purchase: null },
          order,
        };
      if (outcome.kind !== "ok")
        return {
          identified: {
            outcome,
            signIn: null,
            order: carriesOrder(outcome.kind) ? order : null,
            purchase: null,
          },
          order,
        };
      const written = await store(userId, hostId, outcome.token, {
        era,
        mayWrite: mayWriteFor(asker),
        replaces,
      });
      if (written.kind === "kept")
        mintedToken.set(key, { token: outcome.token.token, signIn: mark });
      refreshMoved(written);
      const answer = answerAfter(userId, hostId, era, written, outcome.token);
      if (answer.kind !== "ok")
        return {
          identified: {
            outcome: answer,
            signIn: null,
            order: null,
            purchase: null,
          },
          order,
        };
      const purchase: MintPurchase | null =
        owner !== null &&
        order !== null &&
        written.kind === "kept" &&
        written.written &&
        mayWriteFor(asker)()
          ? { owner, signIn: mark, order }
          : null;
      if (
        purchase !== null &&
        (outlivedBy(purchase.owner, key) ?? 0) < purchase.order
      ) {
        let byPair = purchasedOrder.get(purchase.owner);
        if (byPair === undefined) {
          byPair = new Map();
          purchasedOrder.set(purchase.owner, byPair);
        }
        byPair.set(key, purchase.order);
      }
      return {
        identified: {
          outcome: answer,
          signIn:
            written.kind === "not-wanted"
              ? mark
              : mintedBy(userId, hostId, answer.token),
          order: null,
          purchase,
        },
        order,
      };
    };
    if (running !== undefined)
      return { sentWith: mark, outcome: running.then(answerFor) };
    const attempt = (async (): Promise<OrderedMintAnswer> => {
      // Drawn as this source sends, used only if the dependency draws none.
      const drawn = drawHostMintOrder();
      const answer = await deps.mint(hostId, signInToken, signal);
      const flight: OrderedMintAnswer =
        "kind" in answer ? { outcome: answer, order: drawn } : answer;
      return eraOf(userId) !== era
        ? { ...flight, outcome: { kind: "superseded" } }
        : flight;
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
      const stillRunning = runningFlights.get(flightKey);
      const at = stillRunning?.indexOf(attempt) ?? -1;
      if (stillRunning === undefined || at === -1) return;
      stillRunning.splice(at, 1);
      if (stillRunning.length === 0) runningFlights.delete(flightKey);
    };
    void starterAnswer.then(leave, leave);
    if (asker.kind === "none") renewFlights.set(flightKey, attempt);
    else if (asker.kind === "unknown") unknownFlights.set(flightKey, attempt);
    else observedFlights.set(ownerKey(flightKey, asker.observed), attempt);
    const startedBefore = runningFlights.get(flightKey);
    if (startedBefore === undefined) runningFlights.set(flightKey, [attempt]);
    else startedBefore.push(attempt);
    return { sentWith: mark, outcome: starterAnswer };
  };

  const obtainIdentified = async (
    userId: string,
    hostId: string,
    fresh: boolean,
    ask: HostTokenAsk,
  ): Promise<IdentifiedMintOutcome> => {
    const { signal, owner } = ask;
    const era = eraOf(userId);
    // The process the ask is for, as observed when it was asked.
    const asker = askerOf(ask);
    // Its place in the order, before the load wait: two asks in one load
    // window never tie.
    const started = records.start();
    await loaded;
    if (eraOf(userId) !== era)
      return {
        outcome: { kind: "superseded" },
        signIn: null,
        order: null,
        purchase: null,
      };
    const token = held(userId, hostId);
    // An answer from an era the person has left, or for a sign-in the
    // person no longer holds, says nothing of the one they hold now:
    // compared as it is written (a refusal after the sign-in is brought up
    // to date, see `bindSignInSync`), and again as it is read. A failure
    // answered for a request is recorded only while no kept write stored a
    // token a later-ordered request bought for the pair.
    const record = (
      kind: HostTokenMintOutcome["kind"],
      sentWith: string | null,
      order: number | null,
    ): void => {
      if (
        owner === null ||
        sentWith === null ||
        eraOf(userId) !== era ||
        signInKeyOf(userId) !== sentWith
      )
        return;
      if (
        kind !== "ok" &&
        order !== null &&
        (outlivedBy(owner, keyOf(userId, hostId)) ?? 0) > order
      )
        return;
      records.record(owner, userId, era, sentWith, started, kind);
    };
    if (!fresh && isUsableHostToken(token, deps.now())) {
      record("ok", signInKeyOf(userId), null);
      return {
        outcome: { kind: "ok", token },
        signIn: mintedBy(userId, hostId, token),
        order: null,
        purchase: null,
      };
    }
    // No mint starts for a process no longer the one observed, as none
    // starts in an era the person has left: the same comparison as the
    // write's. It answers as a retired attempt does, with what is held.
    if (asker.kind === "known" && asker.observedNow() !== asker.observed)
      return token === null
        ? {
            outcome: { kind: "process-replaced" },
            signIn: null,
            order: null,
            purchase: null,
          }
        : {
            outcome: { kind: "ok", token },
            signIn: mintedBy(userId, hostId, token),
            order: null,
            purchase: null,
          };
    // The token this ask was sent to replace, refused or unusable: a mint
    // for it replaces it whatever its issue second.
    const { sentWith, outcome: minting } = mintOnce(userId, hostId, era, {
      signal,
      asker,
      owner,
      replaces: token?.token ?? null,
    });
    let answered: MintAnswer;
    try {
      answered = await minting;
    } catch (cause) {
      // A token that could not be saved leaves none to present, like an
      // unreachable authn: an earlier refusal no longer stands.
      if (owner !== null) await signInUpToDate();
      record("unavailable", sentWith, null);
      throw cause;
    }
    const { identified, order } = answered;
    // Up to date first, then compared, then recorded. A token answers
    // without waiting: recording it only ends a refusal.
    if (owner !== null && identified.outcome.kind !== "ok")
      await signInUpToDate();
    record(identified.outcome.kind, sentWith, order);
    return identified;
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

    obtain: (userId, hostId, fresh, ask) =>
      obtainIdentified(userId, hostId, fresh, ask).then(
        (identified) => identified.outcome,
      ),

    obtainIdentified,

    lastFailureOf: (userId, owner) =>
      records.lastFailureOf(owner, userId, eraOf(userId), signInKeyOf(userId)),

    renew: async (userId, hostIds) => {
      const era = eraOf(userId);
      await loaded;
      if (eraOf(userId) !== era) return { kind: "superseded" };
      const signInToken = signIn?.(userId) ?? null;
      if (signInToken === null) return { kind: "no-sign-in" };
      const mark = signInDigest(signInToken);
      const due = Array.from(new Set(hostIds)).filter(
        (hostId) => mintedWith.get(keyOf(userId, hostId)) !== mark,
      );
      if (due.length === 0) return { kind: "already-current" };
      const outcomes = await Promise.all(
        // A renewal is for a person and host id, not an attempt for a host
        // process: era and order are its write's only checks.
        due.map(
          (hostId) =>
            mintOnce(userId, hostId, era, {
              signal: null,
              asker: NO_ASKER,
              owner: null,
              replaces: null,
            }).outcome,
        ),
      );
      if (eraOf(userId) !== era) return { kind: "superseded" };
      return {
        kind: "renewed",
        // Delayed only where authn could not be reached. A renewal never
        // meets `process-replaced`: that answer comes only from an owned
        // obtain, before any mint starts.
        delayed: due.filter(
          (_, index) =>
            outcomes[index]?.identified.outcome.kind === "unavailable",
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
      // Minted elsewhere: it stands for no sign-in this source knows.
      if (written.kind === "kept") mintedToken.delete(keyOf(userId, hostId));
      return written.kind === "kept" && eraOf(userId) === era;
    },

    forgetUser: async (userId) => {
      eras.set(userId, eraOf(userId) + 1);
      for (const key of Array.from(mintedWith.keys()))
        if (key.startsWith(`${userId}\u0000`)) mintedWith.delete(key);
      for (const key of Array.from(sentLatest.keys()))
        if (key.startsWith(`${userId}\u0000`)) sentLatest.delete(key);
      for (const key of Array.from(mintedToken.keys()))
        if (key.startsWith(`${userId}\u0000`)) mintedToken.delete(key);
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

    signInKey: signInKeyOf,

    bindSignInSync: (next) => {
      syncSignIn = next;
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
