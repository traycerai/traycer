import { session, type Cookie } from "electron";
import type {
  BrowserCookieCryptoState,
  BrowserPrimaryProfileCaptureResult,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateApplyResult,
  BrowserViewStorageStateCaptureResult,
} from "../../ipc-contracts/browser-view-types";
import { getBrowserCookieCryptoState } from "./browser-cookie-crypto";
import { BROWSER_VIEW_PARTITION } from "./browser-session";
import { log } from "../app/logger";

type BrowserStorageCookieSameSite = "Strict" | "Lax" | "None";

interface BrowserStorageCookie {
  // Partitioned cookies are intentionally unsupported: this capture shape has
  // no partition key, so callers must not claim CHIPS identity preservation.
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly canonicalDomain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: BrowserStorageCookieSameSite;
}

interface BrowserStorageState {
  readonly cookies: readonly BrowserStorageCookie[];
  readonly origins: readonly BrowserStorageOrigin[];
}

interface BrowserStorageOrigin {
  readonly origin: string;
  readonly localStorage: readonly BrowserStorageLocalStorageEntry[];
}

export interface BrowserStorageLocalStorageEntry {
  readonly name: string;
  readonly value: string;
}

interface BrowserCookieSetDetails {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly expirationDate: number | undefined;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "strict" | "lax" | "no_restriction";
}

interface BrowserCookieStore {
  set(details: BrowserCookieSetDetails): Promise<void>;
  get(filter: { readonly url?: string }): Promise<Cookie[]>;
  flushStore(): Promise<void>;
}

interface BrowserCookieApplyStore extends BrowserCookieStore {
  remove(url: string, name: string): Promise<void>;
}

interface BrowserStorageSession {
  readonly cookies: BrowserCookieStore;
}

interface BrowserStorageApplySession {
  readonly cookies: BrowserCookieApplyStore;
}

export interface BrowserStorageCaptureWebContents {
  getURL(): string;
  executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
}

export interface BrowserPrimaryProfileOriginSnapshot {
  readonly origin: string;
  readonly localStorage: readonly BrowserStorageLocalStorageEntry[];
}

export interface BrowserStorageStateApplyDependencies {
  readonly readCryptoState: () => BrowserCookieCryptoState;
  readonly fromPartition: (
    partition: string,
    options: { readonly cache: boolean },
  ) => BrowserStorageApplySession;
}

export interface BrowserStorageStateCaptureDependencies {
  readonly fromPartition: (
    partition: string,
    options: { readonly cache: boolean },
  ) => BrowserStorageSession;
}

export interface BrowserPrimaryProfileCaptureDependencies extends BrowserStorageStateCaptureDependencies {
  readonly readCryptoState: () => BrowserCookieCryptoState;
}

export async function captureBrowserPrimaryProfile(
  origins: readonly BrowserPrimaryProfileOriginSnapshot[],
): Promise<BrowserPrimaryProfileCaptureResult> {
  return captureBrowserPrimaryProfileWithDependencies(origins, {
    readCryptoState: getBrowserCookieCryptoState,
    fromPartition: (partition, options) =>
      session.fromPartition(partition, options),
  });
}

export async function captureBrowserPrimaryProfileWithDependencies(
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
  const browserSession = dependencies.fromPartition(BROWSER_VIEW_PARTITION, {
    cache: true,
  });
  await browserSession.cookies.flushStore();
  const cookies = (await browserSession.cookies.get({})).map(toStorageCookie);
  return {
    status: "captured",
    storageState: { cookies, origins },
    reason: null,
  };
}

export async function captureBrowserOriginLocalStorage(
  origin: string,
  webContents: BrowserStorageCaptureWebContents,
): Promise<BrowserPrimaryProfileOriginSnapshot | null> {
  const captured = await captureLocalStorageForOrigin(origin, webContents);
  return captured.available ? { origin, localStorage: captured.entries } : null;
}

export function browserLocalStorageSeedScript(
  storageState: unknown,
): string | null {
  if (storageState === undefined || storageState === null) return null;
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

export async function applyBrowserViewStorageState(
  input: BrowserViewStorageStateApply,
): Promise<BrowserViewStorageStateApplyResult> {
  return applyBrowserViewStorageStateWithDependencies(input, {
    readCryptoState: getBrowserCookieCryptoState,
    fromPartition: (partition, options) =>
      session.fromPartition(partition, options),
  });
}

export async function applyBrowserViewStorageStateWithDependencies(
  input: BrowserViewStorageStateApply,
  dependencies: BrowserStorageStateApplyDependencies,
): Promise<BrowserViewStorageStateApplyResult> {
  // Cookies apply live. localStorage is installed only by the create-time seed
  // script, so an already-open native tab stays localStorage-stale until recreated.
  const storageState = parseStorageState(input.storageState);
  const cookieDetails = storageState.cookies.map(toCookieSetDetails);
  const cryptoState = dependencies.readCryptoState();
  if (cryptoState.mode === "degraded") {
    log.info("[browser-view] primary profile storage apply", {
      kind: "primary_profile_storage_apply",
      sessionId: input.sessionId,
      tabId: input.tabId,
      purpose: input.purpose,
      cookieCount: storageState.cookies.length,
      originCount: storageState.origins.length,
      cookiesSet: 0,
      cookiesRemoved: 0,
      outcome: "skipped-degraded",
    });
    return {
      status: "skipped-degraded",
      cookieCount: 0,
      localStorageApplied: false,
      reason: cryptoState.reason,
    };
  }

  const browserSession = dependencies.fromPartition(BROWSER_VIEW_PARTITION, {
    cache: true,
  });
  await browserSession.cookies.flushStore();
  const wantedCookieKeys = new Set(
    storageState.cookies.map((cookie) => cookieKey(cookie)),
  );
  const removedCookies = (await browserSession.cookies.get({})).filter(
    (cookie) => !wantedCookieKeys.has(cookieKey(toStorageCookie(cookie))),
  );
  for (const cookie of removedCookies) {
    const parsed = toStorageCookie(cookie);
    await browserSession.cookies.remove(cookieUrl(parsed), parsed.name);
  }
  for (const details of cookieDetails) {
    await browserSession.cookies.set(details);
  }
  await browserSession.cookies.flushStore();
  log.info("[browser-view] primary profile sync-back applied", {
    kind: "primary_profile_sync_back",
    cookiesSet: cookieDetails.length,
    cookiesRemoved: removedCookies.length,
  });
  log.info("[browser-view] primary profile storage apply", {
    kind: "primary_profile_storage_apply",
    sessionId: input.sessionId,
    tabId: input.tabId,
    purpose: input.purpose,
    cookieCount: storageState.cookies.length,
    originCount: storageState.origins.length,
    cookiesSet: cookieDetails.length,
    cookiesRemoved: removedCookies.length,
    outcome: "applied",
  });
  return {
    status: "applied",
    cookieCount: cookieDetails.length,
    localStorageApplied: false,
    reason: "cookies-only",
  };
}

function cookieKey(cookie: BrowserStorageCookie): string {
  return [cookie.domain, cookie.name, cookie.path].join("\u001f");
}

export async function captureBrowserViewStorageState(
  input: { readonly origin: string; readonly [key: string]: unknown },
  webContents: BrowserStorageCaptureWebContents,
): Promise<BrowserViewStorageStateCaptureResult> {
  return captureBrowserViewStorageStateWithDependencies(input, webContents, {
    fromPartition: (partition, options) =>
      session.fromPartition(partition, options),
  });
}

export async function captureBrowserViewStorageStateWithDependencies(
  input: { readonly origin: string; readonly [key: string]: unknown },
  webContents: BrowserStorageCaptureWebContents,
  dependencies: BrowserStorageStateCaptureDependencies,
): Promise<BrowserViewStorageStateCaptureResult> {
  const origin = parseHttpOrigin(input.origin);
  const browserSession = dependencies.fromPartition(BROWSER_VIEW_PARTITION, {
    cache: true,
  });
  await browserSession.cookies.flushStore();
  const cookies = (await browserSession.cookies.get({ url: origin })).map(
    toStorageCookie,
  );
  const localStorage = await captureLocalStorageForOrigin(origin, webContents);
  // Omit the origin entirely when its localStorage capture was unavailable
  // (e.g. the tile navigated away from `origin` mid-capture) rather than
  // reporting `{origin, localStorage: []}` - an absent entry means "unknown",
  // so a merge downstream cannot mistake it for a genuinely empty origin and
  // erase a good cached value.
  const origins = localStorage.available
    ? [{ origin, localStorage: localStorage.entries }]
    : [];
  return {
    storageState: {
      cookies,
      origins,
    },
    cookieCount: cookies.length,
    cookieDomains: uniqueSorted(cookies.map((cookie) => cookie.domain)),
    localStorageCount: localStorage.entries.length,
    localStorageAvailable: localStorage.available,
    localStorageReason: localStorage.reason,
  };
}

function parseStorageState(value: unknown): BrowserStorageState {
  const record = assertRecord(value, "Browser storageState");
  const cookies = record.cookies;
  const origins = record.origins;
  if (!Array.isArray(cookies)) {
    throw new Error("Browser storageState cookies must be an array");
  }
  if (!Array.isArray(origins)) {
    throw new Error("Browser storageState origins must be an array");
  }
  origins.forEach(parseOriginStorageState);
  return {
    cookies: cookies.map(parseCookie),
    origins: origins.map(parseOriginStorageState),
  };
}

function parseCookie(value: unknown): BrowserStorageCookie {
  const record = assertRecord(value, "Browser storageState cookie");
  const sameSite = record.sameSite;
  if (!isSameSite(sameSite)) {
    throw new Error("Browser storageState cookie sameSite is invalid");
  }
  return {
    name: readNonEmptyString(record.name, "cookie name"),
    value: readString(record.value, "cookie value"),
    ...readCookieDomain(record.domain),
    path: readCookiePath(record.path),
    expires: readFiniteNumber(record.expires, "cookie expires"),
    httpOnly: readBoolean(record.httpOnly, "cookie httpOnly"),
    secure: readBoolean(record.secure, "cookie secure"),
    sameSite,
  };
}

function parseOriginStorageState(value: unknown): BrowserStorageOrigin {
  const record = assertRecord(value, "Browser storageState origin");
  const origin = readNonEmptyString(record.origin, "origin");
  const localStorage = record.localStorage;
  if (!Array.isArray(localStorage)) {
    throw new Error(
      "Browser storageState origin localStorage must be an array",
    );
  }
  return {
    origin,
    localStorage: localStorage.map(parseLocalStorageEntry),
  };
}

function parseLocalStorageEntry(
  value: unknown,
): BrowserStorageLocalStorageEntry {
  const record = assertRecord(value, "localStorage entry");
  return {
    name: readString(record.name, "localStorage name"),
    value: readString(record.value, "localStorage value"),
  };
}

function toCookieSetDetails(
  cookie: BrowserStorageCookie,
): BrowserCookieSetDetails {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path: cookie.path,
    expirationDate: cookie.expires < 0 ? undefined : cookie.expires,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    sameSite: electronSameSite(cookie.sameSite),
  };
}

function cookieUrl(cookie: BrowserStorageCookie): string {
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

function toStorageCookie(cookie: Cookie): BrowserStorageCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    ...readCookieDomain(
      cookie.hostOnly === true && typeof cookie.domain === "string"
        ? cookie.domain.replace(/^\./, "")
        : cookie.domain,
    ),
    path: readCookiePath(cookie.path),
    expires:
      typeof cookie.expirationDate === "number" ? cookie.expirationDate : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: playwrightSameSite(cookie.sameSite),
  };
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
  if (!Array.isArray(result)) {
    return {
      entries: [],
      available: false,
      reason: "localStorage capture returned an invalid result.",
    };
  }
  return {
    entries: result.flatMap((entry): BrowserStorageLocalStorageEntry[] => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.value !== "string") {
        return [];
      }
      return [{ name: record.name, value: record.value }];
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

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} must be an object`);
}

function readString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Browser storageState ${field} must be a string`);
}

function readNonEmptyString(value: unknown, field: string): string {
  const text = readString(value, field);
  if (text.length > 0) return text;
  throw new Error(`Browser storageState ${field} must be non-empty`);
}

function readCookieDomain(value: unknown): {
  readonly domain: string;
  readonly canonicalDomain: string;
} {
  const domain = readNonEmptyString(value, "cookie domain");
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

function readCookiePath(value: unknown): string {
  const path = readNonEmptyString(value, "cookie path");
  if (!path.startsWith("/")) {
    throw new Error("Browser storageState cookie path must start with /");
  }
  if (CONTROL_OR_WHITESPACE_PATTERN.test(path)) {
    throw new Error("Browser storageState cookie path is invalid");
  }
  return path;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Browser storageState ${field} must be a boolean`);
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Browser storageState ${field} must be a finite number`);
}

function isSameSite(value: unknown): value is BrowserStorageCookieSameSite {
  return value === "Strict" || value === "Lax" || value === "None";
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
