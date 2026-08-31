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
  type BrowserStorageCookie as ProtocolStorageCookie,
  type BrowserStorageLocalStorageEntry,
  type BrowserStorageOrigin,
  type BrowserStorageState as ProtocolStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserPrimaryProfileCaptureResult } from "@traycer-clients/shared/platform/browser-view";
import { cookieDomainInScope } from "@traycer-clients/shared/platform/registrable-domain";

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

type DesktopStorageCookie = z.infer<typeof desktopStorageCookieSchema>;
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
 * the whole-partition form of the same call is how "forget all logins" works
 * (ticket 08), and one site's clear must never widen into it.
 */
export interface BrowserSiteClearSession {
  readonly cookies: {
    get(filter: CookiesGetFilter): Promise<Cookie[]>;
    remove(url: string, name: string): Promise<void>;
    flushStore(): Promise<void>;
  };
  clearStorageData(options: ClearStorageDataOptions): Promise<void>;
}

export interface BrowserSiteClearDependencies {
  readonly getSession: (partition: string) => BrowserSiteClearSession;
  /**
   * Origins whose localStorage this process has seen (the capture
   * coordinator's memory). Cookies are enumerable from the jar; localStorage
   * is not, so these are the only origins a clear can name.
   */
  readonly rememberedOrigins: () => readonly string[];
}

export interface BrowserSiteClearOutcome {
  readonly cookiesRemoved: number;
  readonly originsCleared: number;
}

export interface BrowserStorageSeedWebContents {
  readonly session: BrowserStorageSession;
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
  private readonly observations = new Set<Promise<void>>();
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
    let observation: Promise<void>;
    observation = this.captureOrigin(origin, webContents)
      .then((snapshot) => {
        if (snapshot === null || era !== this.era) return;
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
        this.observations.delete(observation);
      });
    this.observations.add(observation);
  }

  /**
   * Forgets every remembered origin ("forget all browser logins", ticket 08).
   * Both tiers go: the origins observed this run AND the ones carried over
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
    await Promise.all([...this.observations]);
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
 * One jar's cookies as the protocol storage shape the seed path validates.
 * `origins` is empty: cookies are session-wide, localStorage never is.
 */
export function browserStorageStateFromCookies(
  cookies: readonly Cookie[],
): ProtocolStorageState {
  return { cookies: [...browserStorageCookies(cookies)], origins: [] };
}

/**
 * Electron cookies as the protocol shape, with the one normalisation the whole
 * store depends on: a host-only cookie loses its leading dot, so `{domain,
 * name, path}` is the same identity here, in a delta's `removedKeys`, and in
 * the host's tombstone keys.
 */
export function browserStorageCookies(
  cookies: readonly Cookie[],
): readonly ProtocolStorageCookie[] {
  return cookies.map(toStorageCookie).map(toProtocolStorageCookie);
}

export async function seedBrowserViewCookies(
  storageState: ProtocolStorageState | null,
  webContents: BrowserStorageSeedWebContents,
): Promise<void> {
  if (storageState === null) return;
  const cookieDetails = parseStorageState(storageState)
    // Electron's cookies API has no partition key, so setting a partitioned
    // cookie here would land it in the UNPARTITIONED jar - readable from
    // top-level sites CHIPS scoped it out of. Skipping it costs a re-login in
    // that embedded context; restoring it merged is a cross-site leak.
    .cookies.filter((cookie) => cookie.partitionKey === null)
    .map(toCookieSetDetails);
  for (const details of cookieDetails) {
    await webContents.session.cookies.set(toElectronCookieSetDetails(details));
  }
  await webContents.session.cookies.flushStore();
}

/**
 * "Clear cookies for this site" (spec §6.5, decision #13): every cookie the
 * registrable domain's subtree holds, plus the localStorage of every remembered
 * origin under it, gone from one partition.
 *
 * The scope is the registrable domain, matched with the same RFC 6265 predicate
 * the delta and the host's merge use - so what this removes is exactly the
 * slice the delta afterwards reports as empty, and exactly what the host is
 * allowed to tombstone. A cookie on `example.org` is untouched by a clear of
 * `example.com`, and so is `notexample.com`.
 *
 * The caller owns the delta: this runs inside
 * `suppressBrowserPrimaryProfileDelta` so the removals cannot echo back as a
 * burst of windows, and the one delta that follows is issued explicitly.
 */
export async function clearBrowserSite(
  input: { readonly partition: string; readonly domain: string },
  dependencies: BrowserSiteClearDependencies,
): Promise<BrowserSiteClearOutcome> {
  const domain = input.domain;
  const browserSession = dependencies.getSession(input.partition);
  const cookies = (await browserSession.cookies.get({ domain })).filter(
    (cookie) => cookieDomainInScope(cookie.domain ?? "", domain),
  );
  let cookiesRemoved = 0;
  for (const cookie of cookies) {
    // Through the same normalisation the capture path uses, so the URL names
    // the cookie's own scope (host-only vs domain, path, secure) rather than a
    // guess - Electron removes by {url, name}.
    const scoped = toStorageCookie(cookie);
    await browserSession.cookies.remove(cookieUrl(scoped), scoped.name);
    cookiesRemoved += 1;
  }
  let originsCleared = 0;
  for (const origin of dependencies.rememberedOrigins()) {
    const host = originHost(origin);
    if (host === null || !cookieDomainInScope(host, domain)) continue;
    await browserSession.clearStorageData({
      origin,
      storages: ["localstorage"],
    });
    originsCleared += 1;
  }
  // Cookie removals are held in memory until the store is flushed; without
  // this, a quit right after the clear could resurrect the site's logins.
  await browserSession.cookies.flushStore();
  return { cookiesRemoved, originsCleared };
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
    domain: cookie.domain.startsWith(".") ? cookie.domain : null,
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

function readCookieDomain(value: string | undefined): BrowserCookieDomain {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    throw new Error("Browser storageState cookie domain must be a string");
  }
  const domain = readNonEmptyString(parsed.data, "cookie domain");
  const canonicalDomain = domain.startsWith(".") ? domain.slice(1) : domain;
  if (
    canonicalDomain.length === 0 ||
    URL_SCOPE_SYNTAX_PATTERN.test(canonicalDomain)
  ) {
    throw new Error("Browser storageState cookie domain is invalid");
  }
  const url = new URL("https://traycer.invalid/");
  url.hostname = canonicalDomain;
  if (url.hostname !== canonicalDomain) {
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

const URL_SCOPE_SYNTAX_PATTERN = /[@:/\\\s\x00-\x1F\x7F]/u;
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
