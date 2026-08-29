import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
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
import type {
  BrowserCookieCryptoState,
  BrowserPrimaryProfileCaptureResult,
} from "@traycer-clients/shared/platform/browser-view";

type BrowserStorageCookieSameSite = ProtocolStorageCookie["sameSite"];
const PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT = 8;

// The protocol shape has no partition key, so seed/capture cannot preserve
// CHIPS identity.
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

export interface BrowserStorageSeedWebContents {
  readonly session: BrowserStorageSession;
}

export interface BrowserStorageCaptureWebContents {
  getURL(): string;
  executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
}

export type BrowserPrimaryProfileOriginSnapshot = BrowserStorageOrigin;

export interface BrowserStorageStateCaptureResult {
  readonly storageState: ProtocolStorageState;
  readonly cookieCount: number;
  readonly cookieDomains: readonly string[];
  readonly localStorageCount: number;
  readonly localStorageAvailable: boolean;
  readonly localStorageReason: string | null;
}

export interface BrowserPrimaryProfileCaptureDependencies {
  readonly readCryptoState: () => BrowserCookieCryptoState;
  readonly getSession: () => BrowserStorageSession;
}

export async function captureBrowserPrimaryProfile(
  origins: readonly BrowserPrimaryProfileOriginSnapshot[],
  dependencies: BrowserPrimaryProfileCaptureDependencies,
): Promise<BrowserPrimaryProfileCaptureResult> {
  const cryptoState = dependencies.readCryptoState();
  if (cryptoState.mode === "degraded") {
    return {
      status: "unavailable",
      storageState: null,
      reason: cryptoState.reason,
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
  private readonly observations = new Set<Promise<void>>();
  private sequence = 0;

  constructor(
    private readonly captureProfile: (
      origins: readonly BrowserPrimaryProfileOriginSnapshot[],
    ) => Promise<BrowserPrimaryProfileCaptureResult>,
    private readonly captureOrigin: (
      origin: string,
      webContents: BrowserStorageCaptureWebContents,
    ) => Promise<BrowserPrimaryProfileOriginSnapshot | null>,
  ) {}

  observe(url: string, webContents: BrowserStorageCaptureWebContents): void {
    const origin = parseCurrentOrigin(url);
    if (origin === null) return;
    const sequence = ++this.sequence;
    let observation: Promise<void>;
    observation = this.captureOrigin(origin, webContents)
      .then((snapshot) => {
        if (snapshot === null) return;
        const current = this.origins.get(origin);
        if (current !== undefined && current.sequence > sequence) return;
        this.origins.delete(origin);
        this.origins.set(origin, { ...snapshot, sequence });
        while (this.origins.size > PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT) {
          const oldest = this.origins.keys().next().value;
          if (oldest === undefined) break;
          this.origins.delete(oldest);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.observations.delete(observation);
      });
    this.observations.add(observation);
  }

  async capture(): Promise<BrowserPrimaryProfileCaptureResult> {
    await Promise.all([...this.observations]);
    const origins = [...this.origins.values()]
      .reverse()
      .map(({ origin, localStorage }) => ({ origin, localStorage }));
    return this.captureProfile(origins);
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

export async function seedBrowserViewCookies(
  storageState: ProtocolStorageState | null,
  webContents: BrowserStorageSeedWebContents,
): Promise<void> {
  if (storageState === null) return;
  const cookieDetails =
    parseStorageState(storageState).cookies.map(toCookieSetDetails);
  for (const details of cookieDetails) {
    await webContents.session.cookies.set(toElectronCookieSetDetails(details));
  }
  await webContents.session.cookies.flushStore();
}

export async function captureBrowserViewStorageState(
  input: { readonly origin: string },
  webContents: BrowserStorageCaptureWebContents & BrowserStorageSeedWebContents,
): Promise<BrowserStorageStateCaptureResult> {
  const origin = parseHttpOrigin(input.origin);
  const browserSession = webContents.session;
  await browserSession.cookies.flushStore();
  const cookies = (await browserSession.cookies.get({ url: origin })).map(
    toStorageCookie,
  );
  const capturedCookies = cookies.map(toProtocolStorageCookie);
  const localStorage = await captureLocalStorageForOrigin(origin, webContents);
  // Omit the origin entirely when its localStorage capture was unavailable
  // (e.g. the tile navigated away from `origin` mid-capture) rather than
  // reporting `{origin, localStorage: []}` - an absent entry means "unknown",
  // so a merge downstream cannot mistake it for a genuinely empty origin and
  // erase a good cached value.
  const origins = localStorage.available
    ? [{ origin, localStorage: [...localStorage.entries] }]
    : [];
  return {
    storageState: {
      cookies: capturedCookies,
      origins,
    },
    cookieCount: cookies.length,
    cookieDomains: uniqueSorted(cookies.map((cookie) => cookie.domain)),
    localStorageCount: localStorage.entries.length,
    localStorageAvailable: localStorage.available,
    localStorageReason: localStorage.reason,
  };
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

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
