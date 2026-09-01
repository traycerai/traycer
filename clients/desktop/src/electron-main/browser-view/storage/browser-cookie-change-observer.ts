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
import { describeLogError, log } from "../../app/logger";
import { browserStorageCookies } from "./browser-storage-state";

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
  readonly now: () => number;
  readonly coalesceWindowMs: number;
}

/** Spec §6.3: ~2 s from the first change of a burst to the delta. */
export const BROWSER_COOKIE_DELTA_WINDOW_MS = 2_000;

interface CoalescingWindow {
  /** When the window opened - the delta's `issuedAt`. */
  readonly issuedAt: number;
  /** Keys seen removed during the window, deduped by their id. */
  readonly removedKeys: Map<string, BrowserCookieKey>;
  readonly timer: NodeJS.Timeout;
}

export class BrowserCookieChangeObserver {
  private readonly options: BrowserCookieChangeObserverOptions;
  private readonly windows = new Map<string, CoalescingWindow>();
  /** Reference-counted so nested/overlapping suppressions cannot uncork early. */
  private readonly suppressedDomains = new Map<string, number>();
  /** Reference-counted whole-jar suppression (`suppressAll`). */
  private suppressedGlobally = 0;
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

  /** Idempotent: a partition is subscribed exactly once per process. */
  attach(): void {
    if (this.listener !== null) return;
    const listener = (
      _event: unknown,
      cookie: Cookie,
      _cause: string,
      removed: boolean,
    ): void => {
      this.recordChange(cookie, removed);
    };
    this.listener = listener;
    this.options.cookies.on("changed", listener);
  }

  /**
   * Runs `action` with this domain's deltas muted, so a deliberate local change
   * (ticket 07's "clear cookies for this site") does not echo back to the host
   * as a capture of the state it just destroyed. Any window already open for
   * the domain is dropped rather than flushed: it describes a jar that no
   * longer exists.
   */
  async suppress<T>(domain: string, action: () => Promise<T>): Promise<T> {
    const scope = registrableDomain(domain);
    if (scope === null) return await action();
    const depth = this.suppressedDomains.get(scope) ?? 0;
    this.suppressedDomains.set(scope, depth + 1);
    this.suppressionEpoch += 1;
    this.dropWindow(scope);
    try {
      return await action();
    } finally {
      const remaining = (this.suppressedDomains.get(scope) ?? 1) - 1;
      if (remaining <= 0) this.suppressedDomains.delete(scope);
      else this.suppressedDomains.set(scope, remaining);
      this.suppressionEpoch += 1;
      this.dropWindow(scope);
    }
  }

  /**
   * The whole-jar version of `suppress`: every domain is muted for the duration
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

  private recordChange(cookie: Cookie, removed: boolean): void {
    const scope = registrableDomain(cookie.domain ?? "");
    if (scope === null || this.isSuppressed(scope)) return;
    // The window opens even for a cookie whose key cannot be normalised: the
    // jar did change, so the slice is re-read either way.
    const window = this.windows.get(scope) ?? this.openWindow(scope);
    const key = cookieKeyOf(cookie);
    if (key === null) return;
    // A removal followed by a re-set (Chromium's `overwrite` cause) is not a
    // removal: the key is present in the flushed slice, so drop the claim.
    if (removed) window.removedKeys.set(cookieKeyId(key), key);
    else window.removedKeys.delete(cookieKeyId(key));
  }

  private openWindow(domain: string): CoalescingWindow {
    const window: CoalescingWindow = {
      issuedAt: this.options.now(),
      removedKeys: new Map<string, BrowserCookieKey>(),
      timer: setTimeout(() => {
        void this.flushWindow(domain);
      }, this.options.coalesceWindowMs),
    };
    this.windows.set(domain, window);
    return window;
  }

  private isSuppressed(domain: string): boolean {
    return this.suppressedGlobally > 0 || this.suppressedDomains.has(domain);
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
    if (this.isSuppressed(domain)) return;
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
 * The change event's cookie through the same normalisation the capture path
 * uses, so a removed key is byte-identical to the key the store holds - which
 * is what lets the host match a removal against its own tombstones instead of
 * guessing. `null` when the cookie is not one the capture path could have
 * produced.
 */
function cookieKeyOf(cookie: Cookie): BrowserCookieKey | null {
  // `browserStorageCookies` is the guard as well as the normalisation: a
  // cookie it cannot represent comes back as an empty batch, which is the same
  // `null` this used to build its own `try` to produce.
  const [normalized] = browserStorageCookies([cookie]);
  if (normalized === undefined) return null;
  return {
    domain: normalized.domain,
    name: normalized.name,
    path: normalized.path,
  };
}

function cookieKeyId(key: BrowserCookieKey): string {
  return `${key.domain}\u0000${key.name}\u0000${key.path}`;
}
