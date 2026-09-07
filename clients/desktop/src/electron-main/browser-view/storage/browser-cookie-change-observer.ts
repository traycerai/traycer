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

/** An isolated or ephemeral jar has nothing to contribute to the shared identity, and its cookies must never reach the store. */

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
  readonly onLocalCookieWrite: (key: BrowserCookieKey) => void;
  /** Wall clock. It stamps `issuedAt`, which the host orders captures by. */
  readonly now: () => number;
  /** Wall clock cannot measure that elapsed time: an NTP correction or a manual change that steps the clock BACKWARD would hold the window open, and the one thing the window must not. */
  readonly monotonicNow: () => number;
  readonly coalesceWindowMs: number;
}

/** Spec §6.3: ~2 s from the first change of a burst to the delta. */
export const BROWSER_COOKIE_DELTA_WINDOW_MS = 2_000;

const HOUSEKEEPING_REMOVAL_CAUSES: ReadonlySet<string> = new Set([
  "expired",
  "evicted",
]);

/**
 * How long after the observer attaches no removal is witnessed at all.
 * The cause strings of those four events were never recorded, so it is UNVERIFIED whether the cause filter alone would have caught them.
 */
export const BROWSER_COOKIE_REMOVAL_GRACE_MS = 60_000;

const MAX_AWAITED_APPLIER_WRITES = 1_024;

/** Why a removal the jar really performed was not witnessed as a logout. */
export type BrowserCookieRemovalSuppressionReason =
  /** Chromium's own housekeeping - see {@link HOUSEKEEPING_REMOVAL_CAUSES}. */
  | "housekeeping-cause"
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
  readonly suppressedRemovals: Map<string, SuppressedRemoval>;
  readonly timer: NodeJS.Timeout;
}

export class BrowserCookieChangeObserver {
  private readonly options: BrowserCookieChangeObserverOptions;
  private readonly windows = new Map<string, CoalescingWindow>();
  /** Reference-counted whole-jar suppression (`suppressAll`). */
  private suppressedGlobally = 0;
  private readonly awaitedApplierWrites = new Map<string, number>();
  /** The epoch is what makes that window visible, and disposal is the same hazard with no exit: an observer torn down mid-read must not emit once the read lands. */
  private suppressionEpoch = 0;
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

  /** The caller attaches on the first `ensureBrowserViewSession` for the durable partition, which is LAZY: it is the user's first browser tile of the run, not app start, and it can. */
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

  /** The jar refused those writes, so the marks announced for them will never be answered by an insert. */
  forgetAppliedKeys(keys: readonly BrowserCookieKey[]): void {
    for (const key of keys) this.awaitedApplierWrites.delete(cookieKeyId(key));
  }

  /** Per-domain suppression cannot express this: the domains are exactly the ones being destroyed, so there is no list to take. */
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
      if (this.suppressionEpoch !== epoch) return;
      this.options.emit(delta);
    } catch (error) {
      log.warn("[browser-view] cookie delta capture failed", {
        error: describeLogError(error),
      });
    }
  }

  /** The complete picture of one scope: every cookie it holds, right now, plus the keys that are still missing from it after the window closed. */
  private async readSlice(
    domain: string,
    removedKeys: ReadonlyMap<string, BrowserCookieKey>,
    issuedAt: number,
  ): Promise<BrowserPrimaryProfileDelta> {
    // A cookie the shell cannot normalise is skipped by `browserStorageCookies` rather than thrown on: this whole delta - the removedKeys that carry the logout evidence included.
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

/** A key the flushed slice still holds was re-set before the window closed - a refresh, not a sign-out. */
function removedKeysNotPresent(
  removed: ReadonlyMap<string, BrowserCookieKey>,
  present: readonly BrowserStorageCookie[],
): readonly BrowserCookieKey[] {
  const presentIds = new Set(present.map((cookie) => cookieKeyId(cookie)));
  return [...removed.entries()].flatMap(([id, key]) =>
    presentIds.has(id) ? [] : [key],
  );
}

/** One line per (reason, cause) pair per flushed delta - never one per cookie. */
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

/** The change event's cookie through the same normalisation the capture path uses, so a removed key is byte-identical to the key the store holds. */
function normalizedCookieOf(cookie: Cookie): BrowserStorageCookie | null {
  // `browserStorageCookies` is the guard as well as the normalisation: a
  // cookie it cannot represent comes back as an empty batch, which is the same
  // `null` this used to build its own `try` to produce.
  const [normalized] = browserStorageCookies([cookie]);
  return normalized ?? null;
}
