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

/** Main-side only: the capture is produced and consumed in this process now, and the storage state never crosses to a renderer. */
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

export interface BrowserCookieDomain {
  readonly domain: string;
  readonly canonicalDomain: string;
}

export interface BrowserCookieSetDetails {
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

interface PendingOriginObservation {
  readonly origin: string;
  readonly settled: Promise<void>;
  invalidated: boolean;
}

/** Owns recent localStorage observations and the capture barrier over them. */
export class BrowserPrimaryProfileSnapshotCoordinator {
  private readonly origins = new Map<string, SequencedPrimaryProfileOrigin>();
  /** Retained rather than re-read: the seed is the host's own authoritative jar, and no live guest is parked on those origins to read them from. */
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
   * A null or origin-less seed carries no jar and must not retire what is retained.
   * Merged, never replaced: this runs once per PROVISIONED TAB, not once per process run, and {@link retainObservedOrigin} writes LRU-demoted observations into the same field.
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

  reset(): void {
    this.origins.clear();
    this.seededOrigins = [];
    this.era += 1;
  }

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

  /** Both tiers again: a site clear must reach a demoted or seeded origin too, or the site keeps the localStorage the user just cleared and the next capture ships it back to the host. */
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

  clearableOrigins(): readonly string[] {
    const origins = this.rememberedOrigins().map((entry) => entry.origin);
    const seen = new Set(origins);
    for (const pending of this.observations) {
      if (seen.has(pending.origin)) continue;
      seen.add(pending.origin);
      origins.push(pending.origin);
    }
    return origins;
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
    const observedOrigins = new Set(observed.map((entry) => entry.origin));
    const origins = [
      ...observed,
      ...this.seededOrigins.filter(
        (entry) => !observedOrigins.has(entry.origin),
      ),
    ].slice(0, PRIMARY_PROFILE_SNAPSHOT_ORIGIN_LIMIT);
    const result = await this.captureProfile(origins);
    // A capture becomes the host's WHOLE jar, so a jar that knows nothing must report itself unavailable rather than erase what the host holds.
    // "Knows nothing" is a property of the CAPTURED result, not of this coordinator: the cookie jar lives in the Electron session, so a run that never observed an origin can still be.
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
 * A cookie this shell cannot normalise is SKIPPED, not thrown on - see {@link safeStorageCookie}.
 * The callers here are the observers of a jar they do not control, and one unrepresentable cookie must not cost them the batch.
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
 * {@link toStorageCookie} for a jar that may hold a cookie this shell cannot represent, answering `null` instead of throwing.
 * Still reachable, though narrower now that {@link readCookieDomain} normalises rather than rejects: a domain the URL parser cannot place at all (and a cookie whose name or path.
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
  readonly refused: readonly BrowserCookieKey[];
}

/**
 * Merge-only: it sets and never removes.
 * The caller has already dropped the expired cookies that would otherwise reach `cookies.set` as deletes.
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

/** A key is minted from three sources that do not agree on spelling. */
export function cookieKeyId(key: BrowserCookieKey): string {
  return `${canonicalKeyDomain(key.domain)}\u0000${key.name}\u0000${key.path}`;
}

function canonicalKeyDomain(domain: string): string {
  const leadingDot = domain.startsWith(".");
  const host = leadingDot ? domain.slice(1) : domain;
  const canonical = canonicalCookieHost(host) ?? host.toLowerCase();
  return leadingDot ? `.${canonical}` : canonical;
}

/**
 * KNOWN LIMIT, and the only open direction in the ownership rule: a jar cookie this shell cannot represent (a domain the URL parser cannot place at all) is simply absent here, so.
 * It is bounded by the same normalisation refusing to capture that cookie in the first place, so such a cookie never crosses to a host either.
 */
export async function browserJarCookieKeys(
  domain: string,
  browserSession: BrowserStorageSession,
): Promise<readonly BrowserCookieKey[]> {
  return browserStorageCookies(
    await browserSession.cookies.get({ domain }),
  ).map((cookie) => ({
    domain: cookie.domain,
    name: cookie.name,
    path: cookie.path,
  }));
}

async function setStorageCookie(
  cookie: DesktopStorageCookie,
  browserSession: BrowserStorageSession,
): Promise<void> {
  await browserSession.cookies.set(
    toElectronCookieSetDetails(toCookieSetDetails(cookie)),
  );
}

function isUnpartitionedCookie(cookie: DesktopStorageCookie): boolean {
  return cookie.partitionKey === null;
}

/** Clearing the jar is only half the work - the caller must follow with {@link BrowserPrimaryProfileSnapshotCoordinator.forgetOriginsUnder}, or the coordinator keeps the origins it. */
export async function clearBrowserSite(
  domain: string,
  browserSession: BrowserSiteClearSession,
  rememberedOrigins: () => readonly string[],
): Promise<void> {
  try {
    await removeBrowserSiteCookies(domain, browserSession.cookies);
    await clearBrowserSiteLocalStorage(
      domain,
      browserSession,
      rememberedOrigins,
      null,
    );
  } finally {
    // Cookie removals are held in memory until the store is flushed; without this, a quit right after the clear could resurrect the site's logins.
    await browserSession.cookies.flushStore();
  }
}

/** The localStorage half of a site clear: `clearStorageData`, nothing wider. */
export interface BrowserSiteStorageClearer {
  clearStorageData(options: ClearStorageDataOptions): Promise<void>;
}

/**
 * An origin named only after the first listing would otherwise keep its live localStorage - `forgetOriginsUnder` discards the READ of it, not the storage.
 * Each origin is cleared once, so the loop ends when the listing stops growing.
 */
export async function clearBrowserSiteLocalStorage(
  domain: string,
  browserSession: BrowserSiteStorageClearer,
  rememberedOrigins: () => readonly string[],
  signal: AbortSignal | null,
): Promise<void> {
  const cleared = new Set<string>();
  for (;;) {
    const pending = rememberedOrigins().filter(
      (origin) => originInScope(origin, domain) && !cleared.has(origin),
    );
    if (pending.length === 0) return;
    for (const origin of pending) {
      if (signal?.aborted === true) {
        throw new Error(
          "The jar barrier expired before the site's localStorage was cleared",
        );
      }
      cleared.add(origin);
      await browserSession.clearStorageData({
        origin,
        storages: ["localstorage"],
      });
    }
  }
}

/** The removal half of a site clear: `get` and `remove`, nothing wider. */
export interface BrowserSiteCookieRemover {
  get(filter: CookiesGetFilter): Promise<Cookie[]>;
  remove(url: string, name: string): Promise<void>;
}

export async function removeBrowserSiteCookies(
  domain: string,
  cookies: BrowserSiteCookieRemover,
): Promise<number> {
  const inScope = await listBrowserSiteCookies(domain, cookies);
  for (const cookie of inScope) {
    await removeBrowserCookie(cookie, cookies);
  }
  return inScope.length;
}

export async function listBrowserSiteCookies(
  domain: string,
  cookies: Pick<BrowserSiteCookieRemover, "get">,
): Promise<readonly DesktopStorageCookie[]> {
  const inScope = (await cookies.get({ domain })).filter((cookie) =>
    cookieDomainInScope(cookie.domain ?? "", domain),
  );
  return inScope
    .map((cookie) => safeStorageCookie(cookie))
    .filter((cookie) => cookie !== null);
}

export async function removeBrowserCookie(
  cookie: DesktopStorageCookie,
  cookies: Pick<BrowserSiteCookieRemover, "remove">,
): Promise<void> {
  await cookies.remove(cookieUrl(cookie), cookie.name);
}

/** {@link cookieKeyId} for a cookie the jar or a reader produced. */
export function storageCookieKeyId(cookie: DesktopStorageCookie): string {
  return cookieKeyId({
    domain: cookie.domain,
    name: cookie.name,
    path: cookie.path,
  });
}

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

export function toCookieSetDetails(
  cookie: DesktopStorageCookie,
): BrowserCookieSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.startsWith(".") ? `.${cookie.canonicalDomain}` : null,
    path: cookie.path,
    expirationDate: cookie.expires < 0 ? undefined : cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: electronSameSite(cookie.sameSite),
  };
}

/** The one place null-as-absence meets Electron's optional `domain`. */
export function toElectronCookieSetDetails(
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

/** A domain the parser cannot place at all is still refused. */
export function readCookieDomain(
  value: string | undefined,
): BrowserCookieDomain {
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

export function readCookiePath(value: string | undefined): string {
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
