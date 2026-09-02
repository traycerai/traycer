import type {
  ClearStorageDataOptions,
  Cookie,
  CookiesGetFilter,
  CookiesSetDetails,
} from "electron";
import { z } from "zod";
import {
  browserStorageCookieSchema as protocolStorageCookieSchema,
  browserStorageLocalStorageEntrySchema,
  browserStorageOriginSchema as protocolStorageOriginSchema,
  browserStorageStateSchema as protocolStorageStateSchema,
  type BrowserCookieKey,
  type BrowserStorageCookie as ProtocolStorageCookie,
  type BrowserStorageLocalStorageEntry,
  type BrowserStorageOrigin,
  type BrowserStorageState as ProtocolStorageState,
} from "@traycer/protocol/host/browser/contracts";
import {
  canonicalCookieHost,
  cookieDomainInScope,
} from "@traycer/protocol/host/browser/registrable-domain";

/**
 * What a whole-jar read answers. Main-side only: the capture is produced and
 * consumed in this process now, and the storage state never crosses to a
 * renderer.
 */
export type BrowserPrimaryProfileCaptureResult =
  | {
      readonly status: "captured";
      readonly storageState: ProtocolStorageState;
      readonly reason: null;
    }
  | {
      readonly status: "unavailable";
      readonly storageState: null;
      readonly reason: string;
    };

type BrowserStorageCookieSameSite = ProtocolStorageCookie["sameSite"];
const PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT = 8;
/**
 * Total origins one captured jar may carry - the origins observed this run
 * plus the ones carried over from the seed.
 *
 * A capture becomes the host's whole jar, and that jar is the next run's seed,
 * so without a ceiling the origin list (and the localStorage blob re-serialized
 * over IPC and the wire on every quit) would grow monotonically with every
 * origin ever visited. Accepted fidelity limit: once the cap is reached the
 * oldest imported origins age out and those sites ask for a fresh sign-in.
 * That is a bounded, explainable loss; unbounded growth is not.
 */
const PRIMARY_PROFILE_SNAPSHOT_ORIGIN_LIMIT = 32;

const desktopStorageCookieSchema = protocolStorageCookieSchema.transform(
  (cookie) => ({
    ...cookie,
    name: readNonEmptyString(cookie.name, "cookie name"),
    ...readCookieDomain(cookie.domain),
    path: readCookiePath(cookie.path),
  }),
);
const desktopStorageOriginSchema = protocolStorageOriginSchema.transform(
  (origin) => ({
    ...origin,
    origin: readNonEmptyString(origin.origin, "origin"),
  }),
);
const desktopStorageStateSchema = protocolStorageStateSchema.extend({
  cookies: z.array(desktopStorageCookieSchema),
  origins: z.array(desktopStorageOriginSchema),
});

export type DesktopStorageCookie = z.infer<typeof desktopStorageCookieSchema>;
type DesktopStorageState = z.infer<typeof desktopStorageStateSchema>;

interface BrowserCookieDomain {
  readonly domain: string;
  readonly canonicalDomain: string;
}

interface BrowserCookieSetDetails {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /** Null is host-only scope; Electron wants the key absent, not null. */
  readonly domain: string | null;
  readonly path: string;
  readonly expirationDate: number | undefined;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "strict" | "lax" | "no_restriction";
}

export interface BrowserCookieStore {
  set(details: CookiesSetDetails): Promise<void>;
  get(filter: CookiesGetFilter): Promise<Cookie[]>;
  flushStore(): Promise<void>;
}

export interface BrowserStorageSession {
  readonly cookies: BrowserCookieStore;
}

/**
 * The slice of Electron's `Session` a site clear needs. It is its own port
 * rather than an extension of the seed/capture one: only this path removes
 * anything. `clearStorageData` is called with an `origin` and nothing else -
 * the whole-partition form of the same call is how "forget all logins" works,
 * and one site's clear must never widen into it.
 */
export interface BrowserSiteClearSession {
  readonly cookies: {
    get(filter: CookiesGetFilter): Promise<Cookie[]>;
    remove(url: string, name: string): Promise<void>;
    flushStore(): Promise<void>;
  };
  clearStorageData(options: ClearStorageDataOptions): Promise<void>;
}

export interface BrowserStorageCaptureWebContents {
  getURL(): string;
  executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
}

export type BrowserPrimaryProfileOriginSnapshot = BrowserStorageOrigin;

export interface BrowserPrimaryProfileCaptureDependencies {
  /** A machine that is not saving logins has no durable jar worth capturing. */
  readonly readSaveLogins: () => boolean;
  readonly getSession: () => BrowserStorageSession;
}

export async function captureBrowserPrimaryProfile(
  origins: readonly BrowserPrimaryProfileOriginSnapshot[],
  dependencies: BrowserPrimaryProfileCaptureDependencies,
): Promise<BrowserPrimaryProfileCaptureResult> {
  if (!dependencies.readSaveLogins()) {
    return {
      status: "unavailable",
      storageState: null,
      reason: "saved-logins-off",
    };
  }
  const browserSession = dependencies.getSession();
  await browserSession.cookies.flushStore();
  const cookies = (await browserSession.cookies.get({}))
    .map(toStorageCookie)
    .map(toProtocolStorageCookie);
  return {
    status: "captured",
    storageState: {
      cookies,
      origins: origins.map((origin) => ({
        origin: origin.origin,
        localStorage: [...origin.localStorage],
      })),
    },
    reason: null,
  };
}

export async function captureBrowserOriginLocalStorage(
  origin: string,
  webContents: BrowserStorageCaptureWebContents,
): Promise<BrowserPrimaryProfileOriginSnapshot | null> {
  const captured = await captureLocalStorageForOrigin(origin, webContents);
  return captured.available
    ? { origin, localStorage: [...captured.entries] }
    : null;
}

type SequencedPrimaryProfileOrigin = BrowserPrimaryProfileOriginSnapshot & {
  readonly sequence: number;
};

/**
 * One `captureOrigin` read still in flight.
 *
 * The origin travels with it because a site clear has to be able to reach it:
 * {@link BrowserPrimaryProfileSnapshotCoordinator.forgetOriginsUnder} runs
 * while a read of the same origin may still be out, and that read landing
 * afterwards would write back the origin the user just cleared - which the next
 * capture uploads to the host and the seed script then restores into a
 * recreated tile.
 */
interface PendingOriginObservation {
  readonly origin: string;
  readonly settled: Promise<void>;
  /**
   * Set by a clear whose scope covers {@link origin}; the completion sees it
   * and drops itself. Per-observation rather than the jar-wide `era`, which
   * would discard the in-flight reads of unrelated origins with it.
   */
  invalidated: boolean;
}

/** Owns recent localStorage observations and the capture barrier over them. */
export class BrowserPrimaryProfileSnapshotCoordinator {
  private readonly origins = new Map<string, SequencedPrimaryProfileOrigin>();
  /**
   * The origins the host's jar was last SEEDED with. `origins` above only ever
   * holds what this process run navigated, capped at
   * {@link PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT} - and the host stores a
   * capture as the WHOLE jar, replacing what it had. Without carrying the seed
   * forward, quitting after visiting one site erases the localStorage of every
   * other origin the host held. Retained rather than re-read: the seed is the
   * host's own authoritative jar, and no live guest is parked on those origins
   * to read them from.
   */
  private seededOrigins: readonly BrowserPrimaryProfileOriginSnapshot[] = [];
  private readonly observations = new Set<PendingOriginObservation>();
  private sequence = 0;
  /** Bumped by `reset()`; observations from an earlier era are discarded. */
  private era = 0;

  constructor(
    private readonly captureProfile: (
      origins: readonly BrowserPrimaryProfileOriginSnapshot[],
    ) => Promise<BrowserPrimaryProfileCaptureResult>,
    private readonly captureOrigin: (
      origin: string,
      webContents: BrowserStorageCaptureWebContents,
    ) => Promise<BrowserPrimaryProfileOriginSnapshot | null>,
  ) {}

  /**
   * Records the origin list of a jar just seeded into this partition. A null
   * or origin-less seed carries no jar and must not retire what is retained.
   *
   * Merged, never replaced: this runs once per PROVISIONED TAB, not once per
   * process run, and {@link retainObservedOrigin} writes LRU-demoted
   * observations into the same field. A wholesale replace on the second tab's
   * seed would drop those demoted values and let the capture ship the stale
   * seeded copy - exactly what the demotion exists to prevent. What is already
   * retained wins: the seed is the host's jar as of this run's start, so a
   * retained entry is never older than the incoming one.
   */
  retainSeededOrigins(storageState: ProtocolStorageState | null): void {
    if (storageState === null || storageState.origins.length === 0) return;
    const retained = new Set(this.seededOrigins.map((entry) => entry.origin));
    this.seededOrigins = [
      ...this.seededOrigins,
      ...storageState.origins
        .filter((origin) => !retained.has(origin.origin))
        .map((origin) => ({
          origin: origin.origin,
          localStorage: [...origin.localStorage],
        })),
    ];
  }

  observe(url: string, webContents: BrowserStorageCaptureWebContents): void {
    const origin = parseCurrentOrigin(url);
    if (origin === null) return;
    const sequence = ++this.sequence;
    const era = this.era;
    let pending: PendingOriginObservation;
    const settled = this.captureOrigin(origin, webContents)
      .then((snapshot) => {
        if (snapshot === null) return;
        // Dropped when the whole jar moved on (`reset`), and when only this
        // origin did (a site clear that ran while the read was out).
        if (era !== this.era || pending.invalidated) return;
        const current = this.origins.get(origin);
        if (current !== undefined && current.sequence > sequence) return;
        this.origins.delete(origin);
        this.origins.set(origin, { ...snapshot, sequence });
        while (this.origins.size > PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT) {
          const oldest = this.origins.entries().next().value;
          if (oldest === undefined) break;
          this.origins.delete(oldest[0]);
          // Demoted, not discarded: this is the freshest value anyone holds
          // for that origin, and dropping it would let the next capture ship
          // the STALE seeded copy - which the seed script then writes back
          // over the newer one on the following run.
          this.retainObservedOrigin(oldest[1]);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.observations.delete(pending);
      });
    pending = { origin, settled, invalidated: false };
    this.observations.add(pending);
  }

  /**
   * Forgets every remembered origin ("forget all browser logins"). Both
   * tiers go: the origins observed this run AND the ones carried over
   * from the seed or demoted out of the LRU - a capture draws on both, so
   * leaving either behind would re-upload the localStorage the user forgot.
   * Observations already in flight are discarded with them: each was read from
   * the jar being cleared, and one landing afterwards would re-seed a recreated
   * tile with the localStorage the user just forgot.
   */
  reset(): void {
    this.origins.clear();
    this.seededOrigins = [];
    this.era += 1;
  }

  /**
   * The same forgetting, narrowed to one site ("clear cookies for this site").
   * Both tiers again, and for the reason {@link reset} gives: a capture merges
   * the observed and the carried-over origins into the host's whole jar, and
   * {@link browserLocalStorageSeedScript} writes them back into a recreated
   * tile - so an origin left in either tier puts back the localStorage the
   * user just cleared.
   *
   * A third tier goes with them: the reads still IN FLIGHT for those origins.
   * Each was taken from the jar being cleared, so one landing afterwards would
   * put the origin straight back - and unlike {@link reset}'s `era` bump, this
   * reaches only the origins in scope, leaving an unrelated site's concurrent
   * read to complete.
   *
   * All three are scoped with {@link originInScope}, which is the predicate
   * {@link clearBrowserSite} selects origins with, so what is pruned here and
   * what Chromium was told to clear cannot drift apart.
   */
  forgetOriginsUnder(domain: string): void {
    for (const origin of [...this.origins.keys()]) {
      if (originInScope(origin, domain)) this.origins.delete(origin);
    }
    this.seededOrigins = this.seededOrigins.filter(
      (entry) => !originInScope(entry.origin, domain),
    );
    for (const pending of this.observations) {
      if (originInScope(pending.origin, domain)) pending.invalidated = true;
    }
  }

  /**
   * Every origin this process knows localStorage for, newest first, without
   * awaiting in-flight observations. Both tiers again: a site clear must reach
   * a demoted or seeded origin too, or the site keeps the localStorage the
   * user just cleared and the next capture ships it back to the host.
   */
  rememberedOrigins(): readonly BrowserPrimaryProfileOriginSnapshot[] {
    const observed = [...this.origins.values()]
      .reverse()
      .map(({ origin, localStorage }) => ({ origin, localStorage }));
    const seen = new Set(observed.map((entry) => entry.origin));
    return [
      ...observed,
      ...this.seededOrigins.filter((entry) => !seen.has(entry.origin)),
    ];
  }

  private retainObservedOrigin(
    evicted: BrowserPrimaryProfileOriginSnapshot,
  ): void {
    this.seededOrigins = [
      { origin: evicted.origin, localStorage: [...evicted.localStorage] },
      ...this.seededOrigins.filter((entry) => entry.origin !== evicted.origin),
    ];
  }

  async capture(): Promise<BrowserPrimaryProfileCaptureResult> {
    await Promise.all([...this.observations].map((pending) => pending.settled));
    const observed = [...this.origins.values()]
      .reverse()
      .map(({ origin, localStorage }) => ({ origin, localStorage }));
    // A freshly observed origin wins over its seeded copy; seeded origins this
    // run never visited fill the remainder in seed order, so the capture is a
    // whole jar rather than "the handful of sites open right now" - bounded by
    // {@link PRIMARY_PROFILE_SNAPSHOT_ORIGIN_LIMIT}.
    const observedOrigins = new Set(observed.map((entry) => entry.origin));
    const origins = [
      ...observed,
      ...this.seededOrigins.filter(
        (entry) => !observedOrigins.has(entry.origin),
      ),
    ].slice(0, PRIMARY_PROFILE_SNAPSHOT_ORIGIN_LIMIT);
    const result = await this.captureProfile(origins);
    // A capture becomes the host's WHOLE jar, so a jar that knows nothing must
    // report itself unavailable rather than erase what the host holds -
    // permanently, since the erased jar is the next seed. "Knows nothing" is a
    // property of the CAPTURED result, not of this coordinator: the cookie jar
    // lives in the Electron session, so a run that never observed an origin can
    // still be carrying every cookie the user has.
    if (
      result.status === "captured" &&
      result.storageState !== null &&
      result.storageState.cookies.length === 0 &&
      result.storageState.origins.length === 0
    ) {
      return {
        status: "unavailable",
        storageState: null,
        reason: "No browser storage has been seeded or observed yet.",
      };
    }
    return result;
  }
}

export function browserLocalStorageSeedScript(
  storageState: ProtocolStorageState | null,
): string | null {
  if (storageState === null) return null;
  const origins = parseStorageState(storageState).origins;
  if (origins.length === 0) return null;
  return [
    "(() => {",
    `  const origins = ${JSON.stringify(origins)};`,
    "  const match = origins.find((entry) => entry.origin === location.origin);",
    "  if (match === undefined) return;",
    "  localStorage.clear();",
    "  for (const entry of match.localStorage) localStorage.setItem(entry.name, entry.value);",
    "})()",
  ].join("\n");
}

/**
 * Electron cookies as the protocol shape, with the one normalisation the whole
 * store depends on: a host-only cookie loses its leading dot, so `{domain,
 * name, path}` is the same identity here as in the host's tombstone keys.
 *
 * A cookie this shell cannot normalise is SKIPPED, not thrown on - see
 * {@link safeStorageCookie}. The callers here are the observers of a jar they
 * do not control, and one unrepresentable cookie must not cost them the batch.
 */
export function browserStorageCookies(
  cookies: readonly Cookie[],
): readonly ProtocolStorageCookie[] {
  return cookies.flatMap((cookie) => {
    const storageCookie = safeStorageCookie(cookie);
    return storageCookie === null
      ? []
      : [toProtocolStorageCookie(storageCookie)];
  });
}

/**
 * {@link toStorageCookie} for a jar that may hold a cookie this shell cannot
 * represent, answering `null` instead of throwing.
 *
 * Still reachable, though narrower now that {@link readCookieDomain}
 * normalises rather than rejects: a domain the URL parser cannot place at all
 * (and a cookie whose name or path this shell refuses) still throws. The
 * delta, the site clear and the removal-key path all want the same thing from
 * such a cookie - skip it and keep going - so they share this one guard rather
 * than each growing a `try`.
 *
 * The CAPTURE path deliberately does not use it: a capture replaces the host's
 * whole jar, so quietly dropping a cookie there would delete that login for
 * good. Failing loudly is the safe direction on that path and the wrong one
 * here.
 */
export function safeStorageCookie(cookie: Cookie): DesktopStorageCookie | null {
  try {
    return toStorageCookie(cookie);
  } catch {
    return null;
  }
}

/** What one host observation did to the jar it was merged into. */
export interface BrowserObservedCookieMergeResult {
  readonly applied: number;
  /**
   * Cookies that reached the jar and did not land: partitioned, unrepresentable
   * by this shell, or refused by Chromium's own `cookies.set` validation. They
   * are counted rather than thrown on: this is untrusted remote input over a
   * jar the user is browsing with, and losing the other twenty cookies of a
   * sign-in to one Chromium refusal would turn a bounded fidelity loss into a
   * failed login with nothing to point at.
   *
   * The KEYS rather than a count, because the applier claimed every one of
   * them as the sending host's before writing: a key the jar refused names a
   * cookie that does not exist, and leaving the claim standing would hand the
   * host an update right over whatever the user's own browsing later puts
   * there.
   */
  readonly refused: readonly BrowserCookieKey[];
}

/**
 * The ONE way a host's cookies reach the `primary` jar: what
 * `applyBrowserObservedProfile` let through, merged in.
 *
 * Both host->jar doors arrive here - the observed frame and the
 * `createElectronTab` seed, which used to have a `seedBrowserViewCookies` loop
 * of its own with none of the checks. Application goes through Chromium's own
 * `cookies.set`, which is what
 * normalises the attributes away from anything the sender chose.
 *
 * Merge-only: it sets and never removes. The caller has already dropped the
 * expired cookies that would otherwise reach `cookies.set` as deletes.
 */
export async function mergeObservedProfileCookies(
  cookies: readonly ProtocolStorageCookie[],
  browserSession: BrowserStorageSession,
): Promise<BrowserObservedCookieMergeResult> {
  let applied = 0;
  const refused: BrowserCookieKey[] = [];
  for (const cookie of cookies) {
    // The key as the CALLER claimed it, not as the schema would normalise it:
    // the claim the applier recorded was spelled this way, so a release has to
    // be spelled the same way to find it.
    const key = { domain: cookie.domain, name: cookie.name, path: cookie.path };
    try {
      // The parse is INSIDE the try, and that placement is the guard rather
      // than a style choice: this schema's transforms THROW on a
      // wire-legal-but-unrepresentable cookie (an empty name, an empty path, a
      // path without a leading slash), and a thrown error escapes `safeParse`
      // itself. Outside the try, one such cookie would abort the loop
      // mid-frame - an attacker-chosen PREFIX of the frame applied, the flush
      // skipped, and no count or trace of any of it.
      const parsed = desktopStorageCookieSchema.parse(cookie);
      if (!isUnpartitionedCookie(parsed)) {
        refused.push(key);
        continue;
      }
      await setStorageCookie(parsed, browserSession);
      applied += 1;
    } catch {
      refused.push(key);
    }
  }
  await browserSession.cookies.flushStore();
  return { applied, refused };
}

/**
 * A cookie's identity, as every path that has to match one across the jar, the
 * wire and the ownership ledger spells it: (name, domain, path), which is what
 * Chromium itself replaces by.
 *
 * The domain is CANONICALISED first. A key is
 * minted from three sources that do not agree on spelling - the jar read
 * (Chromium's own, always lowercase A-labels), the claim the applier records
 * from the wire (a sender's `.Example.COM.`), and the release the observer
 * performs from its own read - and an id that carried the sender's spelling
 * made those three different keys. The consequence was not cosmetic: a claim
 * nothing ever releases leaves the name permanently desktop-owned, and the
 * ownership rule then refuses every later sign-in for it.
 *
 * The leading dot is PRESERVED, because it is not a spelling: it is the RFC
 * 6265 difference between a host-only cookie and a domain cookie, two rows
 * Chromium keeps apart.
 */
export function cookieKeyId(key: BrowserCookieKey): string {
  return `${canonicalKeyDomain(key.domain)}\u0000${key.name}\u0000${key.path}`;
}

/**
 * The shared canonicaliser plus this caller's own two rules: a leading dot is
 * kept (it is the host-only/domain-cookie distinction, not a spelling), and a
 * domain the canonicaliser refuses falls back to a plain lowercase - such a
 * cookie is refused everywhere else, and an id still has to be a total function
 * of its key.
 */
function canonicalKeyDomain(domain: string): string {
  const leadingDot = domain.startsWith(".");
  const host = leadingDot ? domain.slice(1) : domain;
  const canonical = canonicalCookieHost(host) ?? host.toLowerCase();
  return leadingDot ? `.${canonical}` : canonical;
}

/**
 * The keys one registrable scope holds in this jar right now, subdomains
 * included - Chromium's own `cookies.get` domain filter is subdomain-inclusive,
 * which is what makes this the whole scope the ownership rule reasons over.
 *
 * Normalised through {@link browserStorageCookies}, so a key here is spelled
 * exactly as the change observer and the ownership ledger spell it.
 *
 * KNOWN LIMIT, and the only open direction in the ownership rule: a jar cookie
 * this shell cannot represent (a domain the URL parser cannot place at all)
 * is simply absent here, so the rule reads it as a key - and a name - the jar
 * does not hold. It is bounded by the same normalisation refusing to capture
 * that cookie in the first place, so such a cookie never crosses to a host
 * either. Case and IDN forms are no longer in that set: `readCookieDomain`
 * normalises them the way Chromium's own jar does.
 */
export async function browserJarCookieKeys(
  domain: string,
  browserSession: BrowserStorageSession,
): Promise<readonly BrowserCookieKey[]> {
  // PROJECTED, not just narrowed by the return type: `browserStorageCookies`
  // answers whole cookies, and TypeScript accepts the wider object for the
  // three-field key type - so `value`, `expires`, `httpOnly`, `secure` and
  // `sameSite` would reach every caller at runtime while the signature says
  // "keys". This function exists so the ownership rule can ask what the jar
  // HOLDS without reading what it holds.
  return browserStorageCookies(
    await browserSession.cookies.get({ domain }),
  ).map((cookie) => ({
    domain: cookie.domain,
    name: cookie.name,
    path: cookie.path,
  }));
}

/**
 * One parsed cookie into one jar, through Chromium's own `cookies.set`
 * validation. Both application paths go through here - the tab seed and the
 * observed merge - so neither can normalise or scope a cookie differently
 * from the other.
 */
async function setStorageCookie(
  cookie: DesktopStorageCookie,
  browserSession: BrowserStorageSession,
): Promise<void> {
  await browserSession.cookies.set(
    toElectronCookieSetDetails(toCookieSetDetails(cookie)),
  );
}

/**
 * Electron's cookies API has no partition key, so setting a partitioned cookie
 * would land it in the UNPARTITIONED jar - readable from top-level sites CHIPS
 * scoped it out of. Skipping it costs a re-login in that embedded context;
 * restoring it merged is a cross-site leak.
 */
function isUnpartitionedCookie(cookie: DesktopStorageCookie): boolean {
  return cookie.partitionKey === null;
}

/**
 * "Clear cookies for this site" (spec §6.5): every cookie the
 * registrable domain's subtree holds, plus the localStorage of every remembered
 * origin under it, gone from one partition.
 *
 * The scope is the registrable domain, matched with the same RFC 6265 predicate
 * the delta and the host's merge use - so what this removes is exactly the
 * slice the delta afterwards reports as empty, and exactly what the host is
 * allowed to tombstone. A cookie on `example.org` is untouched by a clear of
 * `example.com`, and so is `notexample.com`.
 *
 * The removals fire the jar's own `changed` events, which coalesce into the
 * one delta that tells the host the scope is now empty. Nothing suppresses
 * them: the host-driven evict that once ran this under a per-domain
 * suppression went away with the `primaryProfileEvict` frame, which was
 * retired.
 *
 * `rememberedOrigins` is the capture coordinator's memory: cookies are
 * enumerable from the jar, localStorage is not, so those are the only origins
 * a clear can name. Clearing the jar is only half the work - the caller must
 * follow with {@link BrowserPrimaryProfileSnapshotCoordinator.forgetOriginsUnder},
 * or the coordinator keeps the origins it just cleared and the next capture
 * uploads them back to the host.
 */
export async function clearBrowserSite(
  domain: string,
  browserSession: BrowserSiteClearSession,
  rememberedOrigins: () => readonly string[],
): Promise<void> {
  const cookies = (await browserSession.cookies.get({ domain })).filter(
    (cookie) => cookieDomainInScope(cookie.domain ?? "", domain),
  );
  try {
    for (const cookie of cookies) {
      // Through the same normalisation the capture path uses, so the URL names
      // the cookie's own scope (host-only vs domain, path, secure) rather than
      // a guess - Electron removes by {url, name}. A cookie that will not
      // normalise has no URL to remove it by; skipping it clears the rest of
      // the site instead of abandoning the clear on the first one.
      const scoped = safeStorageCookie(cookie);
      if (scoped === null) continue;
      await browserSession.cookies.remove(cookieUrl(scoped), scoped.name);
    }
    for (const origin of rememberedOrigins()) {
      if (!originInScope(origin, domain)) continue;
      await browserSession.clearStorageData({
        origin,
        storages: ["localstorage"],
      });
    }
  } finally {
    // Cookie removals are held in memory until the store is flushed; without
    // this, a quit right after the clear could resurrect the site's logins.
    // In the `finally` because a clear that aborted part-way is exactly when
    // the removals it did issue most need to be durable.
    await browserSession.cookies.flushStore();
  }
}

/**
 * Whether one remembered origin belongs to the site being cleared. The single
 * definition of that scope: the clear and the coordinator's prune both read it,
 * so neither can reach an origin the other keeps.
 */
function originInScope(origin: string, domain: string): boolean {
  const host = originHost(origin);
  return host !== null && cookieDomainInScope(host, domain);
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function parseStorageState(value: ProtocolStorageState): DesktopStorageState {
  return desktopStorageStateSchema.parse(value);
}

function toCookieSetDetails(
  cookie: DesktopStorageCookie,
): BrowserCookieSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    // The CANONICAL domain attribute, not the sender's spelling: Chromium
    // files the row under its own normalisation, so handing it
    // `.Example.COM.` would have the jar read back a key that no longer
    // matches what the applier claimed. `null` is host-only scope.
    domain: cookie.domain.startsWith(".") ? `.${cookie.canonicalDomain}` : null,
    path: cookie.path,
    expirationDate: cookie.expires < 0 ? undefined : cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: electronSameSite(cookie.sameSite),
  };
}

/** The one place null-as-absence meets Electron's optional `domain`. */
function toElectronCookieSetDetails(
  details: BrowserCookieSetDetails,
): CookiesSetDetails {
  const { domain, ...rest } = details;
  return domain === null ? rest : { ...rest, domain };
}

function cookieUrl(cookie: DesktopStorageCookie): string {
  const url = new URL("https://traycer.invalid/");
  url.protocol = cookie.secure ? "https:" : "http:";
  url.hostname = cookie.canonicalDomain;
  url.pathname = cookie.path;
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    throw new Error("Browser storageState cookie URL scope is invalid");
  }
  if (url.hostname !== cookie.canonicalDomain) {
    throw new Error("Browser storageState cookie URL scope is invalid");
  }
  if (url.pathname !== cookie.path) {
    throw new Error("Browser storageState cookie path is invalid");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Browser storageState cookie URL scope is invalid");
  }
  return url.href;
}

function electronSameSite(
  sameSite: BrowserStorageCookieSameSite,
): "strict" | "lax" | "no_restriction" {
  if (sameSite === "Strict") return "strict";
  if (sameSite === "Lax") return "lax";
  return "no_restriction";
}

function toStorageCookie(cookie: Cookie): DesktopStorageCookie {
  const domain = z.string().safeParse(cookie.domain);
  const expirationDate = z.number().safeParse(cookie.expirationDate);
  return {
    name: cookie.name,
    value: cookie.value,
    ...readCookieDomain(
      cookie.hostOnly === true && domain.success
        ? domain.data.replace(/^\./, "")
        : cookie.domain,
    ),
    path: readCookiePath(cookie.path),
    expires: expirationDate.success ? expirationDate.data : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: playwrightSameSite(cookie.sameSite),
    // Electron's cookies API exposes no partition key, so every cookie this
    // shell captures is unpartitioned by construction. `null` says exactly
    // that; it is not a lost value.
    partitionKey: null,
  };
}

function toProtocolStorageCookie(
  cookie: DesktopStorageCookie,
): ProtocolStorageCookie {
  const { canonicalDomain: _canonicalDomain, ...captured } = cookie;
  return captured;
}

function playwrightSameSite(
  value: Cookie["sameSite"],
): BrowserStorageCookieSameSite {
  if (value === "strict") return "Strict";
  if (value === "no_restriction") return "None";
  return "Lax";
}

async function captureLocalStorageForOrigin(
  origin: string,
  webContents: BrowserStorageCaptureWebContents,
): Promise<{
  readonly entries: readonly BrowserStorageLocalStorageEntry[];
  readonly available: boolean;
  readonly reason: string | null;
}> {
  const currentOrigin = parseCurrentOrigin(webContents.getURL());
  if (currentOrigin !== origin) {
    return {
      entries: [],
      available: false,
      reason: "Selected browser tile is not currently at that origin.",
    };
  }
  const result = await webContents.executeJavaScript(
    LOCAL_STORAGE_SCRIPT,
    false,
  );
  if (parseCurrentOrigin(webContents.getURL()) !== origin) {
    return {
      entries: [],
      available: false,
      reason: "Selected browser tile navigated during localStorage capture.",
    };
  }
  if (!Array.isArray(result)) {
    return {
      entries: [],
      available: false,
      reason: "localStorage capture returned an invalid result.",
    };
  }
  return {
    entries: result.flatMap((entry): BrowserStorageLocalStorageEntry[] => {
      const parsed = browserStorageLocalStorageEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
    available: true,
    reason: null,
  };
}

function parseHttpOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser storage lend origin must be http(s).");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

function parseCurrentOrigin(value: string): string | null {
  try {
    return parseHttpOrigin(value);
  } catch {
    return null;
  }
}

function readNonEmptyString(value: string, field: string): string {
  if (value.length > 0) return value;
  throw new Error(`Browser storageState ${field} must be non-empty`);
}

/**
 * Splits a wire cookie domain into the form it was sent in and the host form
 * this shell builds URLs from.
 *
 * The canonical half is NORMALISED rather than merely checked. It used to
 * demand the input already be the form the URL parser produces, which
 * rejected three spellings a real jar
 * hands out - `Example.COM`, the FQDN `example.com.`, and any Unicode IDN -
 * and every cookie carrying one was silently dropped on the delta, clear and
 * removal-key paths. The three RFC 6265 wire affordances (leading dot, trailing
 * root dot, case) are stripped here and the rest is handed to the URL parser,
 * which lowercases and IDNA-encodes exactly as Chromium's jar does. A domain
 * the parser cannot place at all is still refused.
 */
function readCookieDomain(value: string | undefined): BrowserCookieDomain {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    throw new Error("Browser storageState cookie domain must be a string");
  }
  const domain = readNonEmptyString(parsed.data, "cookie domain");
  const canonicalDomain = canonicalCookieHost(domain);
  if (canonicalDomain === null) {
    throw new Error("Browser storageState cookie domain is invalid");
  }
  return { domain, canonicalDomain };
}

function readCookiePath(value: string | undefined): string {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    throw new Error("Browser storageState cookie path must be a string");
  }
  const path = readNonEmptyString(parsed.data, "cookie path");
  if (!path.startsWith("/")) {
    throw new Error("Browser storageState cookie path must start with /");
  }
  if (CONTROL_OR_WHITESPACE_PATTERN.test(path)) {
    throw new Error("Browser storageState cookie path is invalid");
  }
  return path;
}

const CONTROL_OR_WHITESPACE_PATTERN = /[\s\x00-\x1F\x7F]/u;
const LOCAL_STORAGE_SCRIPT = [
  "(() => {",
  "  const out = [];",
  "  for (let index = 0; index < window.localStorage.length; index += 1) {",
  "    const name = window.localStorage.key(index);",
  "    if (name === null) continue;",
  "    out.push({ name, value: window.localStorage.getItem(name) ?? '' });",
  "  }",
  "  return out;",
  "})()",
].join("\n");
