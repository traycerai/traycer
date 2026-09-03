import type { Cookie } from "electron";
import type {
  BrowserCookieKey,
  BrowserPrimaryProfileDelta,
  BrowserStorageCookie,
} from "@traycer/protocol/host/browser/contracts";
import {
  cookieDomainInScope,
  registrableDomain,
} from "@traycer/protocol/host/browser/registrable-domain";
import { describeLogError, log, sanitizeLogFields } from "../../app/logger";
import { browserStorageCookies, cookieKeyId } from "./browser-storage-state";

/**
 * Watches one persistent `primary` jar for cookie changes and turns them into
 * domain-scoped deltas (spec §6.3, decision #10).
 *
 * Chromium fires `changed` per cookie, several times for a single sign-in and
 * again for every silent refresh. Sending one frame each would be a flood, so
 * changes coalesce per registrable domain for a short window, and the window
 * closes with the **whole** slice: every cookie the scope holds right now,
 * plus the keys observed disappearing during the window. The slice is what
 * lets the host reconcile its cache by absence; the removal list is separately
 * what lets it tell a **logout** from a cache that merely diverged, because
 * only this jar can witness a cookie being taken out of it (ticket 14).
 *
 * Only a *persistent* `primary` partition is ever observed. An isolated or
 * ephemeral jar has nothing to contribute to the shared identity, and its
 * cookies must never reach the store - the caller enforces that by attaching
 * this only to the durable partition.
 *
 * What counts as WITNESSED is narrower than what counts as changed
 * (universal-sign-in decision 7). A removal reaches `removedKeys` - the one
 * field on this frame that can sign a live remote session out - only when it is
 * a persistent cookie leaving a jar that has been attached long enough for a
 * removal to mean anything. The two suppressions below are the accepted price:
 * a real logout that only drops session cookies no longer propagates, and is
 * served instead by server-side revocation and the explicit forget surface.
 */

/** The slice of Electron's `Session["cookies"]` this observer needs. */
export interface BrowserCookieChangeSource {
  get(filter: { readonly domain: string }): Promise<Cookie[]>;
  on(
    event: "changed",
    listener: (
      event: unknown,
      cookie: Cookie,
      cause: string,
      removed: boolean,
    ) => void,
  ): void;
  off(
    event: "changed",
    listener: (
      event: unknown,
      cookie: Cookie,
      cause: string,
      removed: boolean,
    ) => void,
  ): void;
}

export interface BrowserCookieChangeObserverOptions {
  readonly cookies: BrowserCookieChangeSource;
  readonly emit: (delta: BrowserPrimaryProfileDelta) => void;
  /**
   * This jar's OWN browsing wrote `key` - the desktop owns it from here on,
   * whatever an earlier observed frame contributed (universal-sign-in ticket
   * 08's ownership rule). Fires only for a write that is not one the applier
   * announced through {@link BrowserCookieChangeObserver.noteAppliedKeys}.
   */
  readonly onLocalCookieWrite: (key: BrowserCookieKey) => void;
  /** Wall clock. It stamps `issuedAt`, which the host orders captures by. */
  readonly now: () => number;
  /**
   * A monotonic millisecond clock, for the startup grace window only. Wall
   * clock cannot measure that elapsed time: an NTP correction or a manual
   * change that steps the clock BACKWARD would hold the window open, and the
   * one thing the window must not do is stay shut indefinitely on the field
   * that carries logout evidence.
   */
  readonly monotonicNow: () => number;
  readonly coalesceWindowMs: number;
}

/** Spec §6.3: ~2 s from the first change of a burst to the delta. */
export const BROWSER_COOKIE_DELTA_WINDOW_MS = 2_000;

/**
 * The `cause` values Chromium reports for a removal NOBODY asked for.
 *
 * This is the deterministic half of the hardening, and the primary mechanism:
 * `expired` is the expiry sweep (including the one that runs when the store is
 * loaded at boot) and `evicted` is capacity garbage collection, which is what
 * silently drops a live `user_session` from a jar that has crossed Chromium's
 * per-host cookie cap - minutes or hours into a run, where no startup window
 * would ever see it. Neither is evidence of anything the user or the site did.
 *
 * The witnessable causes are the complement, and they are witnessable on
 * purpose. `explicit` is a consumer's own deletion (the site's script, or a
 * clear), and `expired-overwrite` is a `Set-Cookie` carrying a past date -
 * the canonical shape of a server-side sign-out, and the single most important
 * removal this observer exists to carry. `overwrite` is left witnessable too
 * because it is neutralised more precisely elsewhere: its insert half re-sets
 * the key inside the same window, and {@link removedKeysNotPresent} drops any
 * claim the flushed slice still holds.
 */
const HOUSEKEEPING_REMOVAL_CAUSES: ReadonlySet<string> = new Set([
  "expired",
  "evicted",
]);

/**
 * How long after the observer attaches no removal is witnessed at all.
 *
 * This is the RESIDUAL guard, not the main one - {@link
 * HOUSEKEEPING_REMOVAL_CAUSES} is. The incident it was built for: on
 * 2026-09-01 four persistent keys left the jar 18 seconds after attach, on a
 * jar nobody was browsing, and the resulting `removedKeys` signed the user out
 * of live remote sessions. The cause strings of those four events were never
 * recorded, so it is UNVERIFIED whether the cause filter alone would have
 * caught them; this window covers the residual possibility that boot-time
 * cleanup announces itself under a cause outside `expired`/`evicted`.
 *
 * A timer is defensible only for that residual, and only because the residual
 * is defined by missing evidence: there is no ordering fact to wait on when
 * the question is "does Chromium ever label a boot sweep something else". The
 * fix is evidence, not a better clock - every suppressed removal now traces
 * its `cause`, and ticket 07's live two-machine pass is expected to record
 * what a boot actually emits. **Once those causes confirm the documented
 * semantics, this window and its constant should be deleted**, leaving the
 * deterministic filter alone.
 *
 * Sized with margin over the observed 18 s (3.3x). The cost is bounded but it
 * is not free: see {@link BrowserCookieChangeObserver.attach} for what the
 * blind minute actually covers.
 */
export const BROWSER_COOKIE_REMOVAL_GRACE_MS = 60_000;

/**
 * How many unanswered applier writes this observer will remember at once.
 *
 * A mark lives from the applier's `cookies.set` to the insert event that set
 * fires, which is immediate, so this is a leak bound rather than a working
 * size: one observed frame carries a bounded number of cookies and a host is
 * paced to roughly a frame a second, so a jar that answers normally never
 * approaches it.
 */
const MAX_AWAITED_APPLIER_WRITES = 1_024;

/** Why a removal the jar really performed was not witnessed as a logout. */
export type BrowserCookieRemovalSuppressionReason =
  /** Chromium's own housekeeping - see {@link HOUSEKEEPING_REMOVAL_CAUSES}. */
  | "housekeeping-cause"
  /**
   * A cookie with no expiry. It dies with the browser process, so its removal
   * is what a restart looks like, not what a sign-out looks like.
   */
  | "session-cookie"
  /** Inside {@link BROWSER_COOKIE_REMOVAL_GRACE_MS} of attach. */
  | "grace-window";

/** One removal that was withheld from `removedKeys`, and what withheld it. */
interface SuppressedRemoval {
  readonly reason: BrowserCookieRemovalSuppressionReason;
  /** Chromium's own `cause` string, traced so the live pass can read it. */
  readonly cause: string;
}

interface CoalescingWindow {
  /** When the window opened - the delta's `issuedAt`. */
  readonly issuedAt: number;
  /** Keys seen removed during the window, deduped by their id. */
  readonly removedKeys: Map<string, BrowserCookieKey>;
  /**
   * Removals withheld from `removedKeys`, keyed the same way `removedKeys` is
   * so a re-set retracts a withheld claim exactly as it retracts a witnessed
   * one. Counting events instead would report every ordinary overwrite of a
   * session cookie as a suppression, which is churn, not a suppression.
   */
  readonly suppressedRemovals: Map<string, SuppressedRemoval>;
  readonly timer: NodeJS.Timeout;
}

export class BrowserCookieChangeObserver {
  private readonly options: BrowserCookieChangeObserverOptions;
  private readonly windows = new Map<string, CoalescingWindow>();
  /** Reference-counted whole-jar suppression (`suppressAll`). */
  private suppressedGlobally = 0;
  /**
   * Insert events this observer is still expecting from the observed-sign-in
   * applier, counted per key id.
   *
   * It is what tells a HOST write apart from a LOCAL one, and it has to be
   * per-key rather than per-window because both arrive as ordinary `changed`
   * events on the same jar: the applier announces the keys it is about to
   * write, and the first insert for each one spends the mark instead of
   * transferring ownership to the desktop.
   *
   * Every way a mark can go wrong lands on the SAME side - the desktop keeps
   * the key. A local write that races the applier spends the mark, and the
   * applier's own insert then finds none and hands ownership over; a mark the
   * jar never answers is spent by the next local write to that key, one write
   * late; and an overflowing map (below) drops marks rather than keys. That
   * asymmetry is why no timer is needed to close the window.
   */
  private readonly awaitedApplierWrites = new Map<string, number>();
  /**
   * Bumped on every suppression state change, entry and exit alike, and on
   * {@link dispose}. A flush awaits its slice, and a suppression whose whole
   * lifetime fits inside that await is seen by neither the check before it nor
   * the one after it - so the pre-clear slice would be emitted, re-creating
   * what the host just shredded. The epoch is what makes that window visible,
   * and disposal is the same hazard with no exit: an observer torn down
   * mid-read must not emit once the read lands.
   *
   * Deliberately one counter for the whole jar rather than one per scope: a
   * suppression of ANOTHER domain overlapping this read drops this delta too,
   * which costs one coalesced frame the next change re-sends, while a
   * per-scope counter would have to be kept for scopes no window is open on.
   */
  private suppressionEpoch = 0;
  /**
   * Monotonic reading of when this observer started listening - the instant
   * the grace window opened. `null` until {@link attach}, which
   * {@link removalSuppression} treats as INSIDE the window: the field it
   * gates is destructive, so the unreachable state fails closed.
   */
  private attachedAt: number | null = null;
  private listener:
    | ((
        event: unknown,
        cookie: Cookie,
        cause: string,
        removed: boolean,
      ) => void)
    | null = null;

  constructor(options: BrowserCookieChangeObserverOptions) {
    this.options = options;
  }

  /**
   * Idempotent: a partition is subscribed exactly once per process.
   *
   * This is also where {@link BROWSER_COOKIE_REMOVAL_GRACE_MS} starts, and the
   * anchor is worth being honest about. The caller attaches on the first
   * `ensureBrowserViewSession` for the durable partition, which is LAZY: it is
   * the user's first browser tile of the run, not app start, and it can happen
   * an hour in. So the blind minute is the first minute of BROWSING, and the
   * shape it swallows is real - a restored tab that comes back signed in, and
   * a "sign out" clicked on it straight away, is inside the window. That is
   * the residual cost of a guard kept for a residual risk (see the constant),
   * and it is the second reason to delete the window once ticket 07's live
   * causes confirm the deterministic filter is sufficient.
   */
  attach(): void {
    if (this.listener !== null) return;
    const listener = (
      _event: unknown,
      cookie: Cookie,
      cause: string,
      removed: boolean,
    ): void => {
      this.recordChange(cookie, cause, removed);
    };
    this.listener = listener;
    this.attachedAt = this.options.monotonicNow();
    this.options.cookies.on("changed", listener);
  }

  /**
   * The observed-sign-in applier is about to write these keys into this jar.
   *
   * Their insert events are the applier's own, so they must not be read as the
   * desktop's browsing taking ownership of the key back (universal-sign-in
   * ticket 08). Announced BEFORE the write, and one mark per key per write:
   * Chromium fires one insert per `cookies.set`, and a set that lands on an
   * existing key fires a removal beside it, which this observer already
   * retracts when the insert arrives.
   *
   * The marks are bounded, and overflow drops the OLDEST rather than refusing
   * the newest: a dropped mark costs the sending host its right to update that
   * key later, which is the direction a bound is allowed to fail in.
   */
  noteAppliedKeys(keys: readonly BrowserCookieKey[]): void {
    for (const key of keys) {
      const id = cookieKeyId(key);
      this.awaitedApplierWrites.set(
        id,
        (this.awaitedApplierWrites.get(id) ?? 0) + 1,
      );
    }
    // Insertion-ordered, so the first key is the oldest outstanding mark.
    for (const id of this.awaitedApplierWrites.keys()) {
      if (this.awaitedApplierWrites.size <= MAX_AWAITED_APPLIER_WRITES) break;
      this.awaitedApplierWrites.delete(id);
    }
  }

  /**
   * The jar refused those writes, so the marks announced for them will never
   * be answered by an insert.
   *
   * Left standing they are worse than useless: the next LOCAL write to the
   * same key spends one, and the desktop's own browsing then fails to take the
   * key back. Dropping the whole count for a key rather than one of it is
   * deliberate - a refused write is the applier's last word on that key in
   * this frame, and over-releasing only ever hands ownership to the desktop.
   */
  forgetAppliedKeys(keys: readonly BrowserCookieKey[]): void {
    for (const key of keys) this.awaitedApplierWrites.delete(cookieKeyId(key));
  }

  /**
   * The whole-jar suppression: every domain is muted for the duration
   * of `action`, and every open window is dropped on the way in and on the way
   * out. Ticket 08's "forget all browser logins" is the caller - a
   * `clearStorageData()` fires a removal event for every cookie in the jar at
   * once, and those deltas would reach the host *after* it shredded the slice,
   * re-creating an entry for the identity the user just forgot.
   *
   * Per-domain suppression cannot express this: the domains are exactly the
   * ones being destroyed, so there is no list to take.
   */
  async suppressAll<T>(action: () => Promise<T>): Promise<T> {
    this.suppressedGlobally += 1;
    this.suppressionEpoch += 1;
    this.dropAllWindows();
    try {
      return await action();
    } finally {
      this.suppressedGlobally = Math.max(0, this.suppressedGlobally - 1);
      this.suppressionEpoch += 1;
      this.dropAllWindows();
    }
  }

  /**
   * Detaches for good. The epoch moves here too: dropping the open windows
   * cannot reach a flush that is already awaiting its slice, and that slice
   * landing after disposal would emit a delta from an observer the caller has
   * every reason to believe is silent.
   */
  dispose(): void {
    if (this.listener !== null) {
      this.options.cookies.off("changed", this.listener);
      this.listener = null;
    }
    this.suppressionEpoch += 1;
    this.dropAllWindows();
  }

  private recordChange(cookie: Cookie, cause: string, removed: boolean): void {
    const scope = registrableDomain(cookie.domain ?? "");
    if (scope === null || this.isSuppressed()) return;
    // The window opens even for a cookie whose key cannot be normalised, and
    // for a removal that will not be witnessed: the jar did change either way,
    // so the slice is re-read and the desktop's own view stays current. Only
    // the logout CLAIM is withheld.
    const window = this.windows.get(scope) ?? this.openWindow(scope);
    const normalized = normalizedCookieOf(cookie);
    if (normalized === null) return;
    const keyId = cookieKeyId(normalized);
    if (!removed) {
      // A removal followed by a re-set (Chromium's `overwrite` cause) is not a
      // removal: the key is present in the flushed slice, so drop the claim -
      // whether it was witnessed or withheld.
      window.removedKeys.delete(keyId);
      window.suppressedRemovals.delete(keyId);
      // Whatever the applier did not announce, this jar's own browsing wrote.
      if (!this.spendApplierWrite(keyId)) {
        this.options.onLocalCookieWrite({
          domain: normalized.domain,
          name: normalized.name,
          path: normalized.path,
        });
      }
      return;
    }
    const suppression = this.removalSuppression(normalized, cause);
    if (suppression !== null) {
      window.suppressedRemovals.set(keyId, { reason: suppression, cause });
      return;
    }
    // The maps stay disjoint: Chromium can fire several removal events for one
    // key inside a burst, and the witnessed one wins rather than being counted
    // in both places.
    window.suppressedRemovals.delete(keyId);
    window.removedKeys.set(keyId, {
      domain: normalized.domain,
      name: normalized.name,
      path: normalized.path,
    });
  }

  /** One outstanding applier mark for this key, if there is one to spend. */
  private spendApplierWrite(keyId: string): boolean {
    const awaited = this.awaitedApplierWrites.get(keyId);
    if (awaited === undefined) return false;
    if (awaited <= 1) this.awaitedApplierWrites.delete(keyId);
    else this.awaitedApplierWrites.set(keyId, awaited - 1);
    return true;
  }

  /**
   * Whether this removal is evidence of a sign-out, and if not, why not.
   *
   * The order is deterministic-first: the cause is Chromium's own account of
   * WHY the cookie went, so it outranks both heuristics and is the reason a
   * capacity eviction hours into a run - which no startup window could see -
   * is caught at all.
   *
   * Every answer is decided at EVENT time rather than at flush time: a
   * removal's meaning belongs to the moment the jar performed it, and the
   * coalescing window would otherwise let an event's fate depend on how long
   * the burst it landed in happened to run.
   */
  private removalSuppression(
    cookie: BrowserStorageCookie,
    cause: string,
  ): BrowserCookieRemovalSuppressionReason | null {
    if (HOUSEKEEPING_REMOVAL_CAUSES.has(cause)) return "housekeeping-cause";
    // Negative `expires` is the session-cookie sentinel the capture path
    // normalises Electron's absent `expirationDate` to.
    if (cookie.expires < 0) return "session-cookie";
    const attachedAt = this.attachedAt;
    if (
      attachedAt === null ||
      this.options.monotonicNow() - attachedAt < BROWSER_COOKIE_REMOVAL_GRACE_MS
    ) {
      return "grace-window";
    }
    return null;
  }

  private openWindow(domain: string): CoalescingWindow {
    const window: CoalescingWindow = {
      issuedAt: this.options.now(),
      removedKeys: new Map<string, BrowserCookieKey>(),
      suppressedRemovals: new Map<string, SuppressedRemoval>(),
      timer: setTimeout(() => {
        void this.flushWindow(domain);
      }, this.options.coalesceWindowMs),
    };
    this.windows.set(domain, window);
    return window;
  }

  private isSuppressed(): boolean {
    return this.suppressedGlobally > 0;
  }

  private dropAllWindows(): void {
    for (const domain of [...this.windows.keys()]) this.dropWindow(domain);
  }

  private dropWindow(domain: string): void {
    const window = this.windows.get(domain);
    if (window === undefined) return;
    clearTimeout(window.timer);
    this.windows.delete(domain);
  }

  private async flushWindow(domain: string): Promise<void> {
    const window = this.windows.get(domain);
    if (window === undefined) return;
    this.windows.delete(domain);
    if (this.isSuppressed()) return;
    traceSuppressedRemovals(domain, window.suppressedRemovals);
    const epoch = this.suppressionEpoch;
    try {
      const delta = await this.readSlice(
        domain,
        window.removedKeys,
        window.issuedAt,
      );
      // Any suppression that opened, closed, or did both while the slice was
      // being read moved the epoch. The slice describes the jar from before
      // it, so it is dropped - which subsumes asking whether a suppression
      // happens to be standing right now.
      if (this.suppressionEpoch !== epoch) return;
      this.options.emit(delta);
    } catch (error) {
      log.warn("[browser-view] cookie delta capture failed", {
        error: describeLogError(error),
      });
    }
  }

  /**
   * The complete picture of one scope: every cookie it holds, right now, plus
   * the keys that are still missing from it after the window closed.
   */
  private async readSlice(
    domain: string,
    removedKeys: ReadonlyMap<string, BrowserCookieKey>,
    issuedAt: number,
  ): Promise<BrowserPrimaryProfileDelta> {
    // `get({ domain })` already answers with the domain and its subdomains;
    // the domain-match filter is what proves that to the reader, and drops
    // anything Chromium's looser matching might add. A cookie the shell cannot
    // normalise is skipped by `browserStorageCookies` rather than thrown on:
    // this whole delta - the removedKeys that carry the logout evidence
    // included - would otherwise be lost to one unrepresentable cookie.
    const cookies = browserStorageCookies(
      await this.options.cookies.get({ domain }),
    ).filter((cookie) => cookieDomainInScope(cookie.domain, domain));
    return {
      domain,
      cookies: [...cookies],
      removedKeys: [...removedKeysNotPresent(removedKeys, cookies)],
      issuedAt,
    };
  }
}

/**
 * The removals that survived the window. A key the flushed slice still holds
 * was re-set before the window closed - a refresh, not a sign-out - and
 * claiming it would evict a live login on the strength of a coalescing
 * artifact.
 */
function removedKeysNotPresent(
  removed: ReadonlyMap<string, BrowserCookieKey>,
  present: readonly BrowserStorageCookie[],
): readonly BrowserCookieKey[] {
  const presentIds = new Set(present.map((cookie) => cookieKeyId(cookie)));
  return [...removed.entries()].flatMap(([id, key]) =>
    presentIds.has(id) ? [] : [key],
  );
}

/**
 * One line per (reason, cause) pair per flushed delta - never one per cookie.
 *
 * The `cause` is the point as much as the reason is: it is the evidence
 * ticket 07's live pass needs in order to answer whether boot-time cleanup
 * ever announces itself outside {@link HOUSEKEEPING_REMOVAL_CAUSES}, which is
 * the only question keeping {@link BROWSER_COOKIE_REMOVAL_GRACE_MS} alive.
 *
 * `session-cookie` goes to DEBUG and the other two to INFO. A session cookie
 * dying is ordinary traffic on any site that re-sets one, and at INFO it would
 * write a line per domain per window for the life of the process; a
 * housekeeping eviction and a grace-window suppression are rare or
 * once-per-boot, and are exactly what a support log should carry. No cookie
 * name and no value is ever written; the fields go through the same sanitiser
 * the sibling browser-view traces use.
 */
function traceSuppressedRemovals(
  domain: string,
  suppressed: ReadonlyMap<string, SuppressedRemoval>,
): void {
  const tallies = new Map<string, SuppressedRemoval & { removals: number }>();
  for (const removal of suppressed.values()) {
    const id = `${removal.reason}\0${removal.cause}`;
    const tally = tallies.get(id) ?? { ...removal, removals: 0 };
    tallies.set(id, { ...tally, removals: tally.removals + 1 });
  }
  const message = "[browser-view] withheld cookie removals from a delta";
  for (const { reason, cause, removals } of tallies.values()) {
    // The DOMAIN is browsing history, and this file's log lands in the support
    // bundle: `SENSITIVE_KEY_PATTERN` does not match `domain` and
    // `redactSensitiveText` scrubs credentials rather than host names, so an
    // INFO line naming it persists which sites the user visited. It stays on
    // the debug line, where a forensic pass reads it, and the INFO line
    // carries only the counted reason.
    const fields = sanitizeLogFields({ domain, reason, cause, removals });
    // Called rather than extracted: `log` is electron-log's own object and its
    // methods are not free functions.
    if (reason === "session-cookie") log.debug(message, fields);
    else {
      log.debug(message, fields);
      log.info(message, sanitizeLogFields({ reason, cause, removals }));
    }
  }
}

/**
 * The change event's cookie through the same normalisation the capture path
 * uses, so a removed key is byte-identical to the key the store holds - which
 * is what lets the host match a removal against its own tombstones instead of
 * guessing. It is also what decides session-vs-persistent, from the same
 * `expires` sentinel the store speaks in rather than from Electron's separate
 * `session` flag. `null` when the cookie is not one the capture path could
 * have produced.
 */
function normalizedCookieOf(cookie: Cookie): BrowserStorageCookie | null {
  // `browserStorageCookies` is the guard as well as the normalisation: a
  // cookie it cannot represent comes back as an empty batch, which is the same
  // `null` this used to build its own `try` to produce.
  const [normalized] = browserStorageCookies([cookie]);
  return normalized ?? null;
}
