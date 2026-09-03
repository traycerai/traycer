import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  CHROMIUM_LINUX_BASIC_PASSPHRASE,
  CHROMIUM_PBKDF2_ITERATIONS,
} from "../chromium-crypto";
import type { ChromiumImportBrowser } from "../chromium-browsers";
import {
  LoginImportService,
  RETAINED_SCAN_LIMIT,
  type LoginImportJarCookies,
  type LoginImportJarSession,
  type LoginImportOutcome,
  type LoginImportSecretProviders,
  type LoginImportServiceDependencies,
  type LoginImportSummary,
} from "../import-logins";
import type { SecretReadResult } from "../secret-providers/secret-read-result";
import {
  BROWSER_FORGET_LEDGER_MAX_DOMAINS,
  type BrowserCookieKey,
} from "@traycer/protocol/host/browser/contracts";
import type { LoginImportScan } from "@traycer-clients/shared/platform/browser-view";
import { matchesDomainFilter } from "../../__tests__/cookie-jar-fixture";
import { MAX_LOGIN_IMPORT_FILE_BYTES } from "../bounded-file";

/**
 * `LoginImportService` orchestration suite. Every dependency is faked: no
 * live browser, no OS keystore, no real cookie jar. The Chromium `Cookies`
 * SQLite fixtures are built with `node:sqlite` (the same driver the
 * production reader uses) so the snapshot-copy-and-read path in
 * `import-logins.ts` runs for real; only the keystore reads and the durable
 * jar are injected.
 *
 * `import()` only ever honours a domain that the LAST successful `scan()` of
 * that sourceId listed under `sites` (`LoginImportService`'s private
 * `scanned` map): every happy-path test below scans before it imports, and a
 * dedicated section covers the no-scan / stale-scan / filtered-to-nothing
 * outcomes that guard depends on.
 */

vi.mock("../../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

import { log } from "../../../../app/logger";

// --- Chromium SQLite fixture -------------------------------------------------

const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600n;
const FIXED_NOW_MS = Date.UTC(2026, 0, 1);
const CBC_IV = Buffer.alloc(16, 0x20);

function futureExpiresUtc(daysFromNow: number): bigint {
  const nowSeconds = Math.floor(FIXED_NOW_MS / 1000);
  return (
    (BigInt(nowSeconds + daysFromNow * 86_400) + WINDOWS_EPOCH_OFFSET_SECONDS) *
    1_000_000n
  );
}

function encryptCbc(
  prefix: "v10" | "v11",
  passphrase: string,
  iterations: number,
  plaintext: string,
): Buffer {
  const key = pbkdf2Sync(passphrase, "saltysalt", iterations, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, CBC_IV);
  const body = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from(prefix, "ascii"), body]);
}

function encryptGcm(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("v10", "ascii"), nonce, ciphertext, tag]);
}

function protectedBytes(): Buffer {
  return Buffer.concat([Buffer.from("v20", "ascii"), randomBytes(20)]);
}

type FixtureSecret =
  | { readonly kind: "plain"; readonly value: string }
  | { readonly kind: "encrypted"; readonly bytes: Buffer }
  | { readonly kind: "protected" };

interface FixtureCookieRow {
  /** RFC 6265 wire form: leading dot for a domain cookie. */
  readonly hostKey: string;
  readonly name: string;
  readonly path: string;
  readonly expiresUtc: bigint;
  readonly isSecure: boolean;
  readonly isHttponly: boolean;
  readonly topFrameSiteKey: string;
  readonly hasExpires: boolean;
  readonly sameSite: number;
  readonly secret: FixtureSecret;
}

function domainCookieRow(
  hostKey: string,
  name: string,
  secret: FixtureSecret,
): FixtureCookieRow {
  return {
    hostKey,
    name,
    path: "/",
    expiresUtc: futureExpiresUtc(365),
    isSecure: true,
    isHttponly: false,
    topFrameSiteKey: "",
    hasExpires: true,
    sameSite: 1,
    secret,
  };
}

function partitionedCookieRow(hostKey: string, name: string): FixtureCookieRow {
  return {
    ...domainCookieRow(hostKey, name, { kind: "plain", value: "chips-value" }),
    topFrameSiteKey: "https://top-level.example.com",
  };
}

const INSERT_COOKIE_SQL =
  "INSERT INTO cookies (host_key, name, path, value, encrypted_value, " +
  "expires_utc, is_secure, is_httponly, top_frame_site_key, has_expires, " +
  "samesite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function bindCookieRow(row: FixtureCookieRow): readonly SQLInputValue[] {
  const value = row.secret.kind === "plain" ? row.secret.value : "";
  let encryptedValue: Buffer | null = null;
  if (row.secret.kind === "encrypted") encryptedValue = row.secret.bytes;
  else if (row.secret.kind === "protected") encryptedValue = protectedBytes();
  return [
    row.hostKey,
    row.name,
    row.path,
    value,
    encryptedValue,
    row.expiresUtc,
    row.isSecure ? 1 : 0,
    row.isHttponly ? 1 : 0,
    row.topFrameSiteKey,
    row.hasExpires ? 1 : 0,
    row.sameSite,
  ];
}

function writeChromiumCookiesDb(
  path: string,
  rows: readonly FixtureCookieRow[],
  metaVersion: number,
): void {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE meta (key TEXT, value TEXT)");
  database
    .prepare("INSERT INTO meta (key, value) VALUES ('version', ?)")
    .run(String(metaVersion));
  database.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT, value TEXT, " +
      "encrypted_value BLOB, expires_utc INTEGER, is_secure INTEGER, " +
      "is_httponly INTEGER, top_frame_site_key TEXT, has_expires INTEGER, " +
      "samesite INTEGER)",
  );
  const insert = database.prepare(INSERT_COOKIE_SQL);
  for (const row of rows) {
    insert.run(...bindCookieRow(row));
  }
  database.close();
}

/** Opens an existing fixture DB and appends one more row, simulating a site
 * writing a new cookie to the live jar between a scan and the import. */
function appendChromiumCookieRow(path: string, row: FixtureCookieRow): void {
  const database = new DatabaseSync(path);
  database.prepare(INSERT_COOKIE_SQL).run(...bindCookieRow(row));
  database.close();
}

async function createDarwinChromeSource(
  homeDir: string,
  rows: readonly FixtureCookieRow[],
  metaVersion: number,
): Promise<string> {
  const profileDir = join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
  );
  await mkdir(profileDir, { recursive: true });
  const cookiesPath = join(profileDir, "Cookies");
  writeChromiumCookiesDb(cookiesPath, rows, metaVersion);
  return cookiesPath;
}

async function createLinuxChromeSource(
  homeDir: string,
  rows: readonly FixtureCookieRow[],
  metaVersion: number,
): Promise<void> {
  const profileDir = join(homeDir, ".config", "google-chrome", "Default");
  await mkdir(profileDir, { recursive: true });
  writeChromiumCookiesDb(join(profileDir, "Cookies"), rows, metaVersion);
}

async function createWin32ChromeSource(
  homeDir: string,
  rows: readonly FixtureCookieRow[],
  metaVersion: number,
  encryptedKeyBase64: string,
): Promise<void> {
  const userDataDir = join(
    homeDir,
    "AppData",
    "Local",
    "Google",
    "Chrome",
    "User Data",
  );
  const profileDir = join(userDataDir, "Default");
  await mkdir(profileDir, { recursive: true });
  writeChromiumCookiesDb(join(profileDir, "Cookies"), rows, metaVersion);
  await writeFile(
    join(userDataDir, "Local State"),
    JSON.stringify({ os_crypt: { encrypted_key: encryptedKeyBase64 } }),
  );
}

async function writeGarbageChromeSource(homeDir: string): Promise<void> {
  const profileDir = join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
  );
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "Cookies"), "not a sqlite database");
}

// --- Fake durable jar session -------------------------------------------------

function cookieFixture(name: string, domain: string): Cookie {
  return {
    name,
    value: `${name}-value`,
    domain,
    hostOnly: !domain.startsWith("."),
    path: "/",
    secure: true,
    httpOnly: false,
    session: true,
    sameSite: "lax",
    expirationDate: 4_102_444_800,
  };
}

class FakeLoginImportSession implements LoginImportJarSession {
  private readonly jar: Cookie[] = [];
  readonly setCalls: CookiesSetDetails[] = [];
  flushes = 0;
  private readonly rejectSetNames = new Set<string>();
  private readonly rejectSetValuesByName = new Map<string, Set<string>>();
  private readonly rejectSetValueAfterCounters = new Map<
    string,
    { readonly allowed: number; calls: number }
  >();
  private readonly rejectRemoveNames = new Set<string>();

  constructor(initial: readonly Cookie[]) {
    this.jar.push(...initial);
  }

  /** Callable more than once to reject several names; existing single-name
   * callers are unaffected. */
  rejectSet(name: string): void {
    this.rejectSetNames.add(name);
  }

  /** Rejects `cookies.set` for this name only when the incoming VALUE
   * matches - unlike {@link rejectSet}, which rejects every call for the
   * name. Lets a test fail one specific write (a source row) while a LATER
   * `set` for the same name but a different value (a restore of the jar's
   * original cookie) still succeeds. */
  rejectSetValue(name: string, value: string): void {
    const values = this.rejectSetValuesByName.get(name) ?? new Set<string>();
    values.add(value);
    this.rejectSetValuesByName.set(name, values);
  }

  /** Like {@link rejectSetValue}, but lets the first `successfulCalls` calls
   * for this exact name+value succeed before every later one is rejected.
   * `writeSite`'s re-write pass calls `cookies.set` a second time with the
   * SAME name and value as the first, successful write - so a plain
   * `rejectSetValue` cannot fail only the re-write without also failing the
   * first attempt. */
  rejectSetValueAfter(
    name: string,
    value: string,
    successfulCalls: number,
  ): void {
    this.rejectSetValueAfterCounters.set(`${name} ${value}`, {
      allowed: successfulCalls,
      calls: 0,
    });
  }

  /** Rejects `cookies.remove` for this name: the call throws and the jar is
   * left untouched, as if the OS removal never completed - unlike
   * `writeSite`'s recovery passes, which only see a name after its removal
   * was ATTEMPTED (see `removedNames`), whether or not it actually took. */
  rejectRemove(name: string): void {
    this.rejectRemoveNames.add(name);
  }

  private rejectFlushOnce = false;

  /** Rejects the NEXT `flushStore()` call once - the call still counts
   * (`flushes` still increments) and the settle `sleep` after it in
   * `writeSite`'s `finally` still runs; only the promise it returns rejects. */
  rejectFlush(): void {
    this.rejectFlushOnce = true;
  }

  readonly cookies: LoginImportJarCookies = {
    get: (filter: CookiesGetFilter): Promise<Cookie[]> => {
      const domain = filter.domain;
      return Promise.resolve(
        domain === undefined
          ? [...this.jar]
          : this.jar.filter((cookie) =>
              matchesDomainFilter(cookie.domain ?? "", domain),
            ),
      );
    },
    set: (details: CookiesSetDetails): Promise<void> => {
      this.setCalls.push(details);
      if (details.name !== undefined && this.rejectSetNames.has(details.name)) {
        return Promise.reject(new Error("cookies.set rejected"));
      }
      if (
        details.name !== undefined &&
        details.value !== undefined &&
        this.rejectSetValuesByName.get(details.name)?.has(details.value) ===
          true
      ) {
        return Promise.reject(new Error("cookies.set rejected"));
      }
      if (details.name !== undefined && details.value !== undefined) {
        const counter = this.rejectSetValueAfterCounters.get(
          `${details.name} ${details.value}`,
        );
        if (counter !== undefined) {
          counter.calls += 1;
          if (counter.calls > counter.allowed) {
            return Promise.reject(new Error("cookies.set rejected"));
          }
        }
      }
      const host = new URL(details.url).hostname;
      const cookie: Cookie = {
        name: details.name ?? "",
        value: details.value ?? "",
        domain: details.domain ?? host,
        hostOnly: details.domain === undefined,
        path: details.path ?? "/",
        secure: details.secure === true,
        httpOnly: details.httpOnly === true,
        session: details.expirationDate === undefined,
        sameSite: details.sameSite ?? "lax",
        expirationDate: details.expirationDate,
      };
      const index = this.jar.findIndex(
        (existing) =>
          existing.name === cookie.name &&
          (existing.domain ?? "") === (cookie.domain ?? "") &&
          existing.path === cookie.path,
      );
      if (index === -1) this.jar.push(cookie);
      else this.jar[index] = cookie;
      return Promise.resolve();
    },
    remove: (url: string, name: string): Promise<void> => {
      if (this.rejectRemoveNames.has(name)) {
        return Promise.reject(new Error("cookies.remove rejected"));
      }
      // Electron removes by {url, name}, which is WIDER than one cookie:
      // every cookie of that name whose domain matches the URL's host is
      // caught, not just the first one found - a domain cookie and a
      // host-only cookie of the same name both match. Removing only the
      // first match would hide exactly the collision `writeSite` is written
      // to recover from (see `import-logins.ts`'s point 4), so this mimics
      // Electron's wider removal rather than a single-item delete.
      const host = new URL(url).hostname;
      for (let index = this.jar.length - 1; index >= 0; index -= 1) {
        const cookie = this.jar[index];
        if (
          cookie !== undefined &&
          cookie.name === name &&
          matchesDomainFilter(cookie.domain ?? "", host)
        ) {
          this.jar.splice(index, 1);
        }
      }
      return Promise.resolve();
    },
    flushStore: (): Promise<void> => {
      this.flushes += 1;
      if (this.rejectFlushOnce) {
        this.rejectFlushOnce = false;
        return Promise.reject(new Error("flushStore rejected"));
      }
      return Promise.resolve();
    },
  };

  names(): readonly string[] {
    return this.jar.map((cookie) => cookie.name).sort();
  }

  namesUnderDomain(domain: string): readonly string[] {
    return this.jar
      .filter((cookie) => matchesDomainFilter(cookie.domain ?? "", domain))
      .map((cookie) => cookie.name)
      .sort();
  }

  /** The whole Cookie objects under a domain, so a caller can check more
   * than the name - e.g. which scope (host-only vs domain) survived. */
  cookiesUnderDomain(domain: string): readonly Cookie[] {
    return this.jar.filter((cookie) =>
      matchesDomainFilter(cookie.domain ?? "", domain),
    );
  }
}

// --- Secret provider fakes -----------------------------------------------------

function alwaysUnavailable(): (
  browser: ChromiumImportBrowser,
) => Promise<SecretReadResult> {
  return () => Promise.resolve({ ok: false, reason: "unavailable" });
}

// --- Service wiring ------------------------------------------------------------

interface ServiceHarness {
  readonly service: LoginImportService;
  readonly session: FakeLoginImportSession;
  readonly secrets: {
    readonly macosKeychain: Mock<LoginImportSecretProviders["macosKeychain"]>;
    readonly linuxSecretService: Mock<
      LoginImportSecretProviders["linuxSecretService"]
    >;
    readonly windowsDpapi: Mock<LoginImportSecretProviders["windowsDpapi"]>;
  };
  /** Every site `clearSiteLocalStorage` was called with, in call order. */
  readonly clearedSites: string[];
  /** Every summary the default `confirmImport` was called with, in call
   * order. Unpopulated when a test overrides `confirmImport` itself. */
  readonly confirmations: LoginImportSummary[];
}

// A per-suite temp dir rather than a bogus path: every test that never
// overrides `snapshotRoot` still gets somewhere real and writable, instead
// of a path this process may have no permission to create ("/unused-…").
// `buildHarness` stays synchronous - `join`/`randomUUID` are, and the
// directory itself is created lazily by `withSqliteSnapshot`/
// `sweepSqliteSnapshots` on first use, never by this module.
const DEFAULT_SNAPSHOT_ROOT = join(
  tmpdir(),
  `login-import-default-snap-${randomUUID()}`,
);

afterAll(async () => {
  await rm(DEFAULT_SNAPSHOT_ROOT, { recursive: true, force: true });
});

function buildHarness(
  overrides: Partial<LoginImportServiceDependencies>,
  session: FakeLoginImportSession,
): ServiceHarness {
  const macosKeychain = vi.fn(alwaysUnavailable());
  const linuxSecretService = vi.fn(alwaysUnavailable());
  const windowsDpapi = vi.fn((): Promise<Buffer | null> =>
    Promise.resolve(null),
  );
  const secrets: LoginImportSecretProviders = {
    macosKeychain,
    linuxSecretService,
    windowsDpapi,
  };
  const clearedSites: string[] = [];
  const confirmations: LoginImportSummary[] = [];
  const deps: LoginImportServiceDependencies = {
    platform: "darwin",
    homeDir: "/unused-home",
    env: {},
    snapshotRoot: DEFAULT_SNAPSHOT_ROOT,
    readSaveLogins: () => true,
    getDurableSession: () => session,
    serializeJarWrite: async (action) => action(new AbortController().signal),
    suppressDeltas: async (action) => action(),
    clearSiteLocalStorage: (site: string) => {
      clearedSites.push(site);
      return Promise.resolve();
    },
    confirmImport: (summary: LoginImportSummary): Promise<boolean> => {
      confirmations.push(summary);
      return Promise.resolve(true);
    },
    releaseHostOwnedKeys: async () => undefined,
    recordReplacedSites: async () => 1,
    markReplacementCleared: async () => undefined,
    pushJarToHosts: async () => 0,
    settleWindowMs: 5,
    sleep: () => Promise.resolve(),
    secrets,
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
  return {
    service: new LoginImportService(deps),
    session,
    secrets: { macosKeychain, linuxSecretService, windowsDpapi },
    clearedSites,
    confirmations,
  };
}

// --- Test lifecycle: temp dirs --------------------------------------------------

let tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempRoots = [];
  vi.clearAllMocks();
});

async function chromeSourceId(service: LoginImportService): Promise<string> {
  const sources = await service.listSources();
  const chrome = sources.find((source) => source.browser === "chrome");
  if (chrome === undefined) throw new Error("expected a chrome source");
  return chrome.id;
}

/** Lists, finds the chrome source, and scans it - the precondition every
 * successful `import()` below depends on. */
async function scanChromeSource(
  service: LoginImportService,
): Promise<{ sourceId: string; scan: LoginImportScan }> {
  const sourceId = await chromeSourceId(service);
  const scan = await service.scan(sourceId);
  return { sourceId, scan };
}

// =================================================================================
// 1. listSources mints opaque ids, exposes no filesystem paths
// =================================================================================

describe("listSources", () => {
  it("mints opaque ids and never exposes a filesystem path", async () => {
    const homeDir = await makeTempDir("login-import-list-");
    await createDarwinChromeSource(
      homeDir,
      [domainCookieRow(".list-site.com", "sid", { kind: "plain", value: "v" })],
      23,
    );
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      new FakeLoginImportSession([]),
    );

    const sources = await service.listSources();

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.id).toMatch(/^[0-9a-f]{32}$/);
      expect(source.id).not.toContain(homeDir);
      expect(source.id).not.toContain("Cookies");
      expect(Object.keys(source).sort()).toEqual(
        ["browser", "id", "lastUsedAt", "profileLabel"].sort(),
      );
    }
    const chrome = sources.find((source) => source.browser === "chrome");
    expect(chrome).toBeDefined();
  });
});

// =================================================================================
// 2. scan: grouping, counts, exclusion, unlock hint, no keystore touch
// =================================================================================

describe("scan", () => {
  async function scanFirstSource(
    homeDir: string,
    platform: NodeJS.Platform,
  ): Promise<{
    scan: LoginImportScan;
    harness: ServiceHarness;
  }> {
    const harness = buildHarness(
      { platform, homeDir, snapshotRoot: await makeTempDir("snap-") },
      new FakeLoginImportSession([]),
    );
    const { scan } = await scanChromeSource(harness.service);
    return { scan, harness };
  }

  it("groups by registrable domain, counts partitioned/protected, excludes Google, and hints macos-keychain for a v10 jar", async () => {
    const homeDir = await makeTempDir("login-import-scan-darwin-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".site-one.com", "sid", { kind: "plain", value: "a" }),
        domainCookieRow(".site-one.com", "pref", { kind: "plain", value: "b" }),
        domainCookieRow(".secure-site.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "macos-keychain-secret",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "secret-value",
          ),
        }),
        partitionedCookieRow(".chips-site.com", "part"),
        domainCookieRow(".protected-site.com", "abe", { kind: "protected" }),
        domainCookieRow(".accounts.google.com", "gsid", {
          kind: "plain",
          value: "g",
        }),
      ],
      23,
    );

    const { scan, harness } = await scanFirstSource(homeDir, "darwin");

    expect(scan.blocked).toBeNull();
    expect(scan.sites).toEqual([
      { domain: "secure-site.com", cookieCount: 1, unlock: "macos-keychain" },
      { domain: "site-one.com", cookieCount: 2, unlock: null },
    ]);
    expect(scan.excluded).toEqual([
      {
        domain: "google.com",
        cookieCount: 1,
        unlock: null,
        reason: "google-device-bound",
      },
    ]);
    expect(scan.protectedCookieCount).toBe(1);
    expect(scan.partitionedCookieCount).toBe(1);
    expect(scan.unlock).toBe("macos-keychain");
    // The scan never opens a keystore: every fact above is read from
    // metadata (the encrypted_value prefix) alone.
    expect(harness.secrets.macosKeychain).not.toHaveBeenCalled();
    expect(harness.secrets.linuxSecretService).not.toHaveBeenCalled();
    expect(harness.secrets.windowsDpapi).not.toHaveBeenCalled();
  });

  it("hints no keystore on Linux when only v10 (peanuts) rows are present", async () => {
    const homeDir = await makeTempDir("login-import-scan-linux-v10-");
    await createLinuxChromeSource(
      homeDir,
      [
        domainCookieRow(".peanuts-site.com", "sid", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            CHROMIUM_LINUX_BASIC_PASSPHRASE,
            CHROMIUM_PBKDF2_ITERATIONS.linux,
            "linux-v10-value",
          ),
        }),
      ],
      23,
    );

    const { scan, harness } = await scanFirstSource(homeDir, "linux");

    expect(scan.unlock).toBeNull();
    expect(harness.secrets.linuxSecretService).not.toHaveBeenCalled();
  });

  it("hints linux-keyring on Linux when v11 rows are present", async () => {
    const homeDir = await makeTempDir("login-import-scan-linux-v11-");
    await createLinuxChromeSource(
      homeDir,
      [
        domainCookieRow(".keyring-site.com", "sid", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v11",
            "gnome-keyring-secret",
            CHROMIUM_PBKDF2_ITERATIONS.linux,
            "linux-v11-value",
          ),
        }),
      ],
      23,
    );

    const { scan, harness } = await scanFirstSource(homeDir, "linux");

    expect(scan.unlock).toBe("linux-keyring");
    expect(harness.secrets.linuxSecretService).not.toHaveBeenCalled();
  });

  it("hints windows-dpapi on Windows for a v10 GCM jar", async () => {
    const homeDir = await makeTempDir("login-import-scan-win-");
    const gcmKey = randomBytes(32);
    await createWin32ChromeSource(
      homeDir,
      [
        domainCookieRow(".dpapi-site.com", "sid", {
          kind: "encrypted",
          bytes: encryptGcm(gcmKey, "windows-v10-value"),
        }),
      ],
      23,
      Buffer.from("irrelevant-encrypted-key").toString("base64"),
    );

    const { scan, harness } = await scanFirstSource(homeDir, "win32");

    expect(scan.unlock).toBe("windows-dpapi");
    expect(harness.secrets.windowsDpapi).not.toHaveBeenCalled();
  });

  it("hints macos-keychain when the ONLY encrypted rows are Google's own", async () => {
    const homeDir = await makeTempDir(
      "login-import-scan-google-only-encrypted-",
    );
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".accounts.google.com", "gsid", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "macos-keychain-secret",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "google-secret-value",
          ),
        }),
      ],
      23,
    );

    const { scan, harness } = await scanFirstSource(homeDir, "darwin");

    // Counted before the Google split: opting into the excluded row still
    // opens the same keystore, so `unlock` must not be null just because
    // every non-excluded site is empty.
    expect(scan.sites).toEqual([]);
    expect(scan.excluded).toEqual([
      {
        domain: "google.com",
        cookieCount: 1,
        unlock: "macos-keychain",
        reason: "google-device-bound",
      },
    ]);
    expect(scan.unlock).toBe("macos-keychain");
    expect(harness.secrets.macosKeychain).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 3. import: saved-logins-off is checked before any read
// =================================================================================

describe("import - saved logins off", () => {
  it("blocks before the source is even looked up", async () => {
    const { service, secrets } = buildHarness(
      { readSaveLogins: () => false },
      new FakeLoginImportSession([]),
    );

    // No listSources()/scan() call was ever made, so this id is not
    // registered and has no recorded scan either. If the service checked
    // the source or the scanned set before the saved-logins pref, this
    // would come back "unreadable" (see below) instead - the exact reason
    // proves the ordering.
    const result = await service.import({
      sourceId: "never-registered",
      scanId: "unused-scan-id",
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "saved-logins-off" });
    expect(secrets.macosKeychain).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 4. import: unknown/stale sourceId, no scan on record, and re-list invalidation
// =================================================================================

describe("import - source and scan bookkeeping", () => {
  it("blocks as unreadable for a sourceId the service never minted", async () => {
    const { service } = buildHarness({}, new FakeLoginImportSession([]));

    const result = await service.import({
      sourceId: "stale-id-from-an-old-list",
      scanId: "unused-scan-id",
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "unreadable" });
  });

  it("blocks as unreadable when the source is registered but was never scanned", async () => {
    const homeDir = await makeTempDir("login-import-no-scan-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".never-scanned.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const { service, secrets } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      new FakeLoginImportSession([]),
    );
    const sourceId = await chromeSourceId(service); // listed, but not scanned

    const result = await service.import({
      sourceId,
      scanId: "unused-scan-id",
      domains: ["never-scanned.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "unreadable" });
    expect(secrets.macosKeychain).not.toHaveBeenCalled();
  });

  it("keeps a source's id and recorded scan across a re-listing that still finds it", async () => {
    const homeDir = await makeTempDir("login-import-relist-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".relist-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    expect(scan.sites).toEqual([
      { domain: "relist-site.com", cookieCount: 1, unlock: null },
    ]);

    // The service is one per main process: a second window opening Settings
    // re-lists while this window is still choosing. The profile is still
    // there, so it keeps its id and the scan on record, and the import the
    // first window sends afterwards goes through.
    const relisted = await service.listSources();
    expect(relisted.map((source) => source.id)).toContain(sourceId);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["relist-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    expect(session.names()).toEqual(["sid"]);
  });

  it("retires a source, with its scan, when a re-listing no longer finds it", async () => {
    const homeDir = await makeTempDir("login-import-relist-gone-");
    const cookiesPath = await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".gone-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    // The profile's jar is gone by the time anyone re-lists (the browser was
    // uninstalled, the profile deleted): the id is not handed out again and
    // an import against it is refused rather than served from memory.
    await rm(cookiesPath, { force: true });
    const relisted = await service.listSources();
    expect(relisted.map((source) => source.id)).not.toContain(sourceId);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["gone-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "unreadable" });
    expect(session.setCalls).toEqual([]);
  });
});

// =================================================================================
// 5. Per-domain replace
// =================================================================================

describe("import - per-domain replace", () => {
  it("removes only the chosen domain's existing cookies and reports replacedSites", async () => {
    const homeDir = await makeTempDir("login-import-replace-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".domain-a.com", "sid", { kind: "plain", value: "a1" }),
        domainCookieRow(".domain-a.com", "csrf", {
          kind: "plain",
          value: "a2",
        }),
        domainCookieRow(".domain-b.com", "sid", { kind: "plain", value: "b1" }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("old-a", ".domain-a.com"),
      cookieFixture("legacy-b", ".domain-b.com"),
    ]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["domain-a.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 2,
      replacedSites: 1,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    // domain-b's pre-existing cookie is completely untouched.
    expect(session.namesUnderDomain("domain-b.com")).toEqual(["legacy-b"]);
    // domain-a's old cookie is gone, replaced by the two imported ones.
    expect(session.namesUnderDomain("domain-a.com")).toEqual(["csrf", "sid"]);
  });
});

// =================================================================================
// 6. A domain whose every imported cookie is invalid is not cleared
// =================================================================================

describe("import - a domain with only invalid cookies is not cleared", () => {
  it("leaves the jar's existing cookie for that domain untouched", async () => {
    const homeDir = await makeTempDir("login-import-invalid-domain-");
    await createDarwinChromeSource(
      homeDir,
      [
        // Wrong passphrase at import time: decrypts to garbage / fails.
        // Scan is metadata-only, so this domain still shows up in the scan.
        domainCookieRow(".broken-site.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "the-real-passphrase",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "would-have-been-valid",
          ),
        }),
        domainCookieRow(".good-site.com", "sid", {
          kind: "plain",
          value: "good-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("existing-broken", ".broken-site.com"),
    ]);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        secrets: {
          macosKeychain: () =>
            Promise.resolve({
              ok: true,
              secret: "definitely-not-the-real-one",
            }),
          linuxSecretService: alwaysUnavailable(),
          windowsDpapi: () => Promise.resolve(null),
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["broken-site.com", "good-site.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedSites).toBe(1);
    expect(result.skippedInvalid).toBe(1);
    // The broken domain's pre-existing cookie survives: nothing was written
    // for it, so nothing is removed for that domain either - `writeSite`
    // returns before computing what is stale when `writtenRows` is empty.
    expect(session.namesUnderDomain("broken-site.com")).toEqual([
      "existing-broken",
    ]);
    expect(session.namesUnderDomain("good-site.com")).toEqual(["sid"]);
  });
});

// =================================================================================
// 7. Google domains are ignored even when explicitly requested
// =================================================================================

describe("import - Google domains only with includeDeviceBound", () => {
  it("with includeDeviceBound: false, ignores a Google domain named in the request - neither imported nor replaced", async () => {
    const homeDir = await makeTempDir("login-import-google-off-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".google.com", "gsid", { kind: "plain", value: "g" }),
        domainCookieRow(".normal-site.com", "sid", {
          kind: "plain",
          value: "n",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("old-google", ".google.com"),
    ]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["google.com", "normal-site.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedSites).toBe(1);
    expect(result.importedCookies).toBe(1);
    expect(result.replacedSites).toBe(0);
    expect(session.names()).toEqual(["old-google", "sid"]);
    expect(session.setCalls.some((call) => call.name === "gsid")).toBe(false);
  });

  it("with includeDeviceBound: true, writes the Google cookie alongside a normal site", async () => {
    const homeDir = await makeTempDir("login-import-google-on-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".google.com", "gsid", { kind: "plain", value: "g" }),
        domainCookieRow(".normal-site.com", "sid", {
          kind: "plain",
          value: "n",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["google.com", "normal-site.com"],
      includeDeviceBound: true,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedSites).toBe(2);
    expect(result.importedCookies).toBe(2);
    expect(session.names()).toEqual(["gsid", "sid"]);
    expect(session.setCalls.some((call) => call.name === "gsid")).toBe(true);
  });

  it("with includeDeviceBound: true, still drops a domain absent from BOTH the scanned sites and excluded sets", async () => {
    const homeDir = await makeTempDir("login-import-google-on-unscanned-");
    const cookiesPath = await createDarwinChromeSource(
      homeDir,
      [domainCookieRow(".google.com", "gsid", { kind: "plain", value: "g" })],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    // A brand-new domain lands in the live jar after the scan ran.
    appendChromiumCookieRow(
      cookiesPath,
      domainCookieRow(".unscanned.com", "sid", { kind: "plain", value: "u" }),
    );

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["google.com", "unscanned.com"],
      includeDeviceBound: true,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedSites).toBe(1);
    expect(session.names()).toEqual(["gsid"]);
    expect(session.namesUnderDomain("unscanned.com")).toEqual([]);
  });
});

// =================================================================================
// 8. A cookies.set rejection is counted and does not abort the import
// =================================================================================

describe("import - a cookies.set rejection is counted, not fatal", () => {
  it("counts the rejected cookie as skippedInvalid and still writes the rest", async () => {
    const homeDir = await makeTempDir("login-import-set-reject-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".reject-site.com", "good", {
          kind: "plain",
          value: "ok",
        }),
        domainCookieRow(".reject-site.com", "bad", {
          kind: "plain",
          value: "no",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    session.rejectSet("bad");
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["reject-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 1,
      notifiedHosts: 0,
    });
    expect(session.names()).toEqual(["good"]);
    expect(session.flushes).toBe(1);
  });
});

// =================================================================================
// 8b. Every write for a site is rejected: the site is left untouched
// =================================================================================

describe("import - a site whose every write is rejected is left untouched", () => {
  // Pins: a domain whose every `cookies.set` fails writes nothing and
  // removes nothing - the jar's pre-existing slice for that site survives
  // exactly as it was.
  it("a site whose every cookies.set rejects keeps the cookies the jar already had", async () => {
    const homeDir = await makeTempDir("login-import-all-rejected-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".reject-site.com", "one", {
          kind: "plain",
          value: "1",
        }),
        domainCookieRow(".reject-site.com", "two", {
          kind: "plain",
          value: "2",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("existing", ".reject-site.com"),
    ]);
    session.rejectSet("one");
    session.rejectSet("two");
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["reject-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 2,
      notifiedHosts: 0,
    });
    expect(session.namesUnderDomain("reject-site.com")).toEqual(["existing"]);
  });
});

// =================================================================================
// 8c. A removal that catches a same-name cookie under another scope is undone
// =================================================================================

describe("import - a same-name cookie under another scope is re-written after the removal that caught it", () => {
  // Pins: Electron's `remove(url, name)` also catches a just-written cookie
  // of the same name under a different scope; `writeSite` detects that via
  // `removedNames` and re-writes the row, so the site ends with the SOURCE's
  // scope (a domain cookie), not silently missing it.
  it("ends with exactly one 'sid' cookie, under the domain-cookie scope the source wrote", async () => {
    const homeDir = await makeTempDir("login-import-scope-collision-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".example.com", "sid", {
          kind: "plain",
          value: "new-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      // Host-only: no leading dot, exactly what `cookieFixture` produces for
      // a domain with no leading dot.
      cookieFixture("sid", "example.com"),
    ]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("example.com");
    expect(cookies.map((cookie) => cookie.name)).toEqual(["sid"]);
    expect(cookies[0]?.domain).toBe(".example.com");
  });
});

// =================================================================================
// 8d. The settle window still runs when the write loop throws
// =================================================================================

describe("import - the settle window still runs when the write loop throws", () => {
  async function waitForCondition(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for condition");
  }

  // Pins: the `finally` around the flush+sleep runs on the FAILURE path too
  // (see `import-logins.ts`'s point 3 in the module doc comment) - the
  // settle sleep still has to fire, and still has to fire BEFORE the
  // suppressed action settles, even though the write loop itself threw.
  it("runs the settle sleep before the suppressed action settles, even when the write loop throws", async () => {
    const homeDir = await makeTempDir("login-import-throw-settle-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".throw-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const events: string[] = [];
    const settleWindowMs = 5;
    const session = new FakeLoginImportSession([]);
    // Simulates a jar read failing mid-write: `writeSite` calls
    // `listBrowserSiteCookies`, which calls `cookies.get` before any
    // `cookies.set` - so the write loop throws before writing anything.
    session.cookies.get = (): Promise<Cookie[]> =>
      Promise.reject(new Error("jar read failed"));
    const sleepGate: { release: (() => void) | null } = { release: null };
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        settleWindowMs,
        suppressDeltas: async <T>(action: () => Promise<T>): Promise<T> => {
          events.push("suppress-start");
          try {
            return await action();
          } finally {
            events.push("suppress-end");
          }
        },
        sleep: (ms: number) => {
          expect(ms).toBe(settleWindowMs);
          return new Promise<void>((resolve) => {
            sleepGate.release = () => {
              events.push("sleep-resolved");
              resolve();
            };
          });
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const pending = service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["throw-site.com"],
      includeDeviceBound: false,
    });
    await waitForCondition(() => sleepGate.release !== null);
    // The write loop already threw, but the settle sleep it triggered from
    // `finally` has not resolved yet - the suppressed action is still open.
    expect(events).toEqual(["suppress-start"]);

    const release = sleepGate.release;
    if (release === null) throw new Error("expected a pending sleep");
    release();
    const result = await pending;

    expect(result).toEqual({ status: "blocked", reason: "unreadable" });
    expect(events).toEqual([
      "suppress-start",
      "sleep-resolved",
      "suppress-end",
    ]);
  });
});

// =================================================================================
// 8e. serializeJarWrite wraps suppressDeltas, in that nesting order
// =================================================================================

describe("import - the jar write runs inside serializeJarWrite, and suppressDeltas inside that", () => {
  // Pins: the whole-jar barrier has to be OUTSIDE the delta-mute, not beside
  // it or inside it - a mutation another caller queues behind the barrier
  // must never land while this write's deltas are still suppressed.
  it("nests suppressDeltas inside serializeJarWrite, in that order", async () => {
    const homeDir = await makeTempDir("login-import-nesting-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".nested-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const events: string[] = [];
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          events.push("serialize-start");
          try {
            return await action(new AbortController().signal);
          } finally {
            events.push("serialize-end");
          }
        },
        suppressDeltas: async <T>(action: () => Promise<T>): Promise<T> => {
          events.push("suppress-start");
          try {
            return await action();
          } finally {
            events.push("suppress-end");
          }
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["nested-site.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    // `serialize-start` before `suppress-start`: the barrier is entered
    // first. `suppress-end` before `serialize-end`: the mute lifts before the
    // barrier's own action resolves, so the barrier's queue never sees the
    // write mid-mute.
    expect(events).toEqual([
      "serialize-start",
      "suppress-start",
      "suppress-end",
      "serialize-end",
    ]);
  });
});

// =================================================================================
// 8f. releaseHostOwnedKeys releases exactly the keys that were written
// =================================================================================

describe("import - releases host ownership of exactly the keys it wrote", () => {
  // Pins: only a row that actually landed in the jar is released - a
  // rejected `cookies.set` names no key at all, so a host that owned it stays
  // the owner until a real write supersedes it. And the release runs AFTER
  // the suppressed write has fully resolved, never inside it.
  it("calls releaseHostOwnedKeys once, after the write, with only the written key", async () => {
    const homeDir = await makeTempDir("login-import-release-keys-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".release-site.com", "good", {
          kind: "plain",
          value: "ok",
        }),
        domainCookieRow(".release-site.com", "bad", {
          kind: "plain",
          value: "no",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    session.rejectSet("bad");
    const events: string[] = [];
    const releaseHostOwnedKeys = vi.fn(
      async (_keys: readonly BrowserCookieKey[]): Promise<void> => {
        events.push("release");
      },
    );
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        releaseHostOwnedKeys,
        suppressDeltas: async <T>(action: () => Promise<T>): Promise<T> => {
          events.push("suppress-start");
          try {
            return await action();
          } finally {
            events.push("suppress-end");
          }
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["release-site.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    const releasedKeys = releaseHostOwnedKeys.mock.calls[0]?.[0];
    // The domain keeps its leading dot: this row is a domain cookie, and the
    // key travels exactly as `normalizeImportCookie` spelled it.
    expect(releasedKeys).toEqual([
      { domain: ".release-site.com", name: "good", path: "/" },
    ]);
    expect(events).toEqual(["suppress-start", "suppress-end", "release"]);
  });

  it("never calls releaseHostOwnedKeys for an all-blocked import", async () => {
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const { service } = buildHarness(
      { readSaveLogins: () => false, releaseHostOwnedKeys },
      new FakeLoginImportSession([]),
    );

    const result = await service.import({
      sourceId: "never-registered",
      scanId: "unused-scan-id",
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "saved-logins-off" });
    expect(releaseHostOwnedKeys).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 8g. The barrier's abort signal stops the write loop mid-import
// =================================================================================

describe("import - stops writing when the barrier's signal is aborted", () => {
  // Pins: an abort raised while a site's cookies.set is in flight stops the
  // write loop before the NEXT site starts (throwIfBarrierExpired at the top
  // of writeSite), still runs the flush+settle in the write's `finally`, and
  // answers `blocked`/`incomplete` - the first site's row landed before the
  // abort, so this is an import that stopped part-way, not one that read
  // nothing - and still pushes the jar once, rather than throwing out of
  // `import()`.
  it("stops writing when the barrier's signal is aborted, still flushes and settles, and answers blocked", async () => {
    const homeDir = await makeTempDir("login-import-abort-signal-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".abort-site-a.com", "sid", {
          kind: "plain",
          value: "a",
        }),
        domainCookieRow(".abort-site-b.com", "sid", {
          kind: "plain",
          value: "b",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const controller = new AbortController();
    const originalSet = session.cookies.set;
    let setCallCount = 0;
    session.cookies.set = (details: CookiesSetDetails): Promise<void> => {
      setCallCount += 1;
      const result = originalSet(details);
      // Aborts from INSIDE the first site's write, mimicking the barrier
      // expiring while the import is mid-flight.
      if (setCallCount === 1) controller.abort();
      return result;
    };
    const sleep = vi.fn(() => Promise.resolve());
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => action(controller.signal),
        sleep,
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["abort-site-a.com", "abort-site-b.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    // Only the first site's set() ran; the second site's writeSite call hit
    // throwIfBarrierExpired before it ever reached cookies.get/cookies.set -
    // but that first row DID land in the jar, which is why the result is
    // "incomplete" rather than "unreadable".
    expect(session.setCalls.length).toBe(1);
    expect(session.namesUnderDomain("abort-site-a.com")).toEqual(["sid"]);
    expect(session.flushes).toBe(1);
    expect(sleep).toHaveBeenCalled();
  });
});

// =================================================================================
// 8h. releaseHostOwnedKeys runs inside the barrier, after the mute lifts
// =================================================================================

describe("import - releases host ownership inside the barrier, after the mute lifts", () => {
  // Pins the ordering `LoginImportServiceDependencies.releaseHostOwnedKeys`
  // documents: entered inside serializeJarWrite's action, after
  // suppressDeltas has resolved, and before the barrier's own action
  // resolves - so nothing queued behind the barrier can observe an older
  // value for a key this import just wrote.
  it("releases host ownership inside the barrier, after the mute lifts and before the barrier's action resolves", async () => {
    const homeDir = await makeTempDir("login-import-release-inside-barrier-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".inside-barrier.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const events: string[] = [];
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          events.push("serialize-start");
          try {
            return await action(new AbortController().signal);
          } finally {
            events.push("serialize-end");
          }
        },
        suppressDeltas: async <T>(action: () => Promise<T>): Promise<T> => {
          events.push("suppress-start");
          try {
            return await action();
          } finally {
            events.push("suppress-end");
          }
        },
        releaseHostOwnedKeys: async (
          _keys: readonly BrowserCookieKey[],
        ): Promise<void> => {
          events.push("release");
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["inside-barrier.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(events).toEqual([
      "serialize-start",
      "suppress-start",
      "suppress-end",
      "release",
      "serialize-end",
    ]);
  });
});

// =================================================================================
// 9. Keychain denied / unavailable
// =================================================================================

describe("import - keystore outcomes", () => {
  async function importWithMacosKeychain(
    result: SecretReadResult,
  ): Promise<LoginImportOutcome> {
    const homeDir = await makeTempDir("login-import-keystore-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".locked-site.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "some-passphrase",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "value",
          ),
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        secrets: {
          macosKeychain: () => Promise.resolve(result),
          linuxSecretService: alwaysUnavailable(),
          windowsDpapi: () => Promise.resolve(null),
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    const outcome = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["locked-site.com"],
      includeDeviceBound: false,
    });
    expect(session.setCalls).toEqual([]);
    return outcome;
  }

  it("reports keychain-denied when the user declines the prompt", async () => {
    const result = await importWithMacosKeychain({
      ok: false,
      reason: "denied",
    });

    expect(result).toEqual({ status: "blocked", reason: "keychain-denied" });
  });

  it("reports keyring-unavailable when the keystore item is not there", async () => {
    const result = await importWithMacosKeychain({
      ok: false,
      reason: "unavailable",
    });

    expect(result).toEqual({
      status: "blocked",
      reason: "keyring-unavailable",
    });
  });
});

// =================================================================================
// 10. The secret provider is invoked only when an encrypted row was selected
// =================================================================================

describe("import - the keystore is touched only for a selected encrypted row", () => {
  it("never calls the keychain when only plaintext cookies were chosen", async () => {
    const homeDir = await makeTempDir("login-import-no-keystore-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".plain-only.com", "sid", {
          kind: "plain",
          value: "p",
        }),
        // Present in the source, but NOT selected below.
        domainCookieRow(".encrypted-elsewhere.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "unused-passphrase",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "unused-value",
          ),
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service, secrets } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["plain-only.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedCookies).toBe(1);
    expect(secrets.macosKeychain).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 11. A domain absent from the last scan is silently dropped
// =================================================================================

describe("import - a domain outside the last scan is dropped", () => {
  it("imports only the scanned domain when a new domain appears in the file afterwards", async () => {
    const homeDir = await makeTempDir("login-import-late-domain-");
    const cookiesPath = await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".steady.com", "sid", {
          kind: "plain",
          value: "steady",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    expect(scan.sites).toEqual([
      { domain: "steady.com", cookieCount: 1, unlock: null },
    ]);

    // A cookie for a brand-new site lands in the live jar after the scan
    // ran but before the user clicks Import.
    appendChromiumCookieRow(
      cookiesPath,
      domainCookieRow(".late.com", "sid", { kind: "plain", value: "late" }),
    );

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["steady.com", "late.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedSites).toBe(1);
    expect(result.importedCookies).toBe(1);
    expect(session.names()).toEqual(["sid"]);
    expect(session.namesUnderDomain("late.com")).toEqual([]);
  });
});

// =================================================================================
// 12. Every requested domain filtered out by the scanned-set check
// =================================================================================

describe("import - every requested domain is outside the last scan", () => {
  it("returns the all-zero imported result without reading the source or the keystore", async () => {
    const homeDir = await makeTempDir("login-import-all-filtered-");
    const cookiesPath = await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".scanned-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service, secrets } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    expect(scan.sites).toEqual([
      { domain: "scanned-site.com", cookieCount: 1, unlock: null },
    ]);

    // If the import fell through to reading the source anyway, this would
    // turn the read into a failure (or a thrown error the outer catch would
    // still have to convert to "unreadable") - either way NOT the all-zero
    // "imported" result asserted below. Its absence is the proof that the
    // scanned-set filter short-circuits before any read.
    await rm(cookiesPath, { force: true });

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["not-in-the-scan.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    expect(session.setCalls).toEqual([]);
    expect(secrets.macosKeychain).not.toHaveBeenCalled();
    expect(secrets.linuxSecretService).not.toHaveBeenCalled();
    expect(secrets.windowsDpapi).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 13. Every failure is a result value; the WARN log carries only {stage, code}
// =================================================================================

describe("import - failures never throw, and the log is shape-limited", () => {
  it("a corrupt (non-sqlite) source file blocks as unreadable without throwing or warning", async () => {
    const homeDir = await makeTempDir("login-import-corrupt-db-");
    await writeGarbageChromeSource(homeDir);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      new FakeLoginImportSession([]),
    );
    const sourceId = await chromeSourceId(service);

    const scanResult = await service.scan(sourceId);

    expect(scanResult.blocked).toBe("unreadable");
    expect(scanResult.sites).toEqual([]);
    // A corrupt DB is a handled, expected outcome (caught inside the sqlite
    // snapshot layer) rather than an exception surfacing to the service's
    // own catch block - so nothing is logged for it.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a dependency throwing mid-import is caught, returns a value, and logs only {stage, code}", async () => {
    const thrown: Error & { code: string } = Object.assign(
      new Error("simulated reader failure"),
      { code: "EIO" },
    );
    const { service } = buildHarness(
      {
        readSaveLogins: () => {
          throw thrown;
        },
      },
      new FakeLoginImportSession([]),
    );

    let result: LoginImportOutcome | null = null;
    let rejected = false;
    try {
      result = await service.import({
        sourceId: "any-id",
        scanId: "unused-scan-id",
        domains: ["example.com"],
        includeDeviceBound: false,
      });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(false);
    expect(result).toEqual({ status: "blocked", reason: "unreadable" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(log.warn).mock.calls[0];
    if (call === undefined) throw new Error("expected a warn call");
    expect(call[0]).toBe("[browser-view] login import failed");
    const fields = call[1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["code", "stage"]);
    expect(fields.stage).toBe("import");
    expect(fields.code).toBe("EIO");
  });

  it("a dependency throwing mid-scan is caught, returns blockedScan, and logs only {stage, code}", async () => {
    const homeDir = await makeTempDir("login-import-scan-throw-");
    await createDarwinChromeSource(
      homeDir,
      [domainCookieRow(".site.com", "sid", { kind: "plain", value: "v" })],
      23,
    );
    const thrown: Error & { code: string } = Object.assign(
      new Error("simulated clock failure"),
      { code: "ECLOCK" },
    );
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        now: () => {
          throw thrown;
        },
      },
      new FakeLoginImportSession([]),
    );
    const sourceId = await chromeSourceId(service);

    const result = await service.scan(sourceId);

    expect(result).toEqual({
      sourceId,
      scanId: expect.stringMatching(/^[0-9a-f]{32}$/),
      sites: [],
      excluded: [],
      protectedCookieCount: 0,
      partitionedCookieCount: 0,
      unreadableCookieCount: 0,
      unlock: null,
      blocked: "unreadable",
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(log.warn).mock.calls[0];
    if (call === undefined) throw new Error("expected a warn call");
    const fields = call[1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["code", "stage"]);
    expect(fields.stage).toBe("scan");
    expect(fields.code).toBe("ECLOCK");
  });
});

// =================================================================================
// Suppression wraps the whole write, including the trailing settle sleep
// =================================================================================

describe("import - suppression wraps the whole write including the trailing sleep", () => {
  async function waitForCondition(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for condition");
  }

  it("does not resolve the suppressed action until the settle sleep has fired", async () => {
    const homeDir = await makeTempDir("login-import-suppress-order-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".ordered-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const events: string[] = [];
    const settleWindowMs = 5;
    const session = new FakeLoginImportSession([]);
    const sleepGate: { release: (() => void) | null } = { release: null };
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        settleWindowMs,
        suppressDeltas: async <T>(action: () => Promise<T>): Promise<T> => {
          events.push("suppress-start");
          const value = await action();
          events.push("suppress-end");
          return value;
        },
        // Manually controlled rather than a real timer: proves the ordering
        // by construction instead of racing wall-clock ticks against the
        // fixture's real disk I/O.
        sleep: (ms: number) => {
          expect(ms).toBe(settleWindowMs);
          return new Promise<void>((resolve) => {
            sleepGate.release = () => {
              events.push("sleep-resolved");
              resolve();
            };
          });
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const pending = service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["ordered-site.com"],
      includeDeviceBound: false,
    });
    await waitForCondition(() => sleepGate.release !== null);
    // The write (cookies.set, flushStore) already ran, but the suppressed
    // action has not returned yet - it is still awaiting the settle sleep.
    expect(events).toEqual(["suppress-start"]);
    expect(session.setCalls.map((call) => call.name)).toEqual(["sid"]);

    const release = sleepGate.release;
    if (release === null) throw new Error("expected a pending sleep");
    release();
    const result = await pending;

    expect(result.status).toBe("imported");
    expect(events).toEqual([
      "suppress-start",
      "sleep-resolved",
      "suppress-end",
    ]);
  });
});

// =================================================================================
// 14. Operations are serialized: concurrent calls do not interleave
// =================================================================================

describe("import - operations are serialized", () => {
  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for condition");
  }

  it("does not start the second import's write until the first's settle sleep resolves", async () => {
    const homeDir = await makeTempDir("login-import-serial-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".serial-site.com", "sid", {
          kind: "plain",
          value: "a",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const sleepGate: { release: (() => void) | null } = { release: null };
    const sleepCalls: number[] = [];
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        sleep: (ms: number) => {
          sleepCalls.push(ms);
          return new Promise<void>((resolve) => {
            sleepGate.release = resolve;
          });
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    // Both calls target the SAME source and domain; the two writes are
    // distinguished purely by ordering (this is the same service instance,
    // so both share the internal `queue`).
    const pendingA = service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["serial-site.com"],
      includeDeviceBound: false,
    });
    const pendingB = service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["serial-site.com"],
      includeDeviceBound: false,
    });

    await waitFor(() => sleepCalls.length === 1);
    // Only the first call's write has run: its cookie is set, but the
    // second call has not even started reading the source again, because
    // `serialized()` chains it behind the first call's still-pending
    // promise (the sleep has not resolved yet).
    expect(session.setCalls.map((call) => call.name)).toEqual(["sid"]);
    expect(sleepCalls).toEqual([5]);

    const releaseFirst = sleepGate.release;
    if (releaseFirst === null) throw new Error("expected a pending sleep");
    releaseFirst();
    await pendingA;

    await waitFor(() => sleepCalls.length === 2);
    expect(sleepCalls).toEqual([5, 5]);

    const releaseSecond = sleepGate.release;
    if (releaseSecond === null || releaseSecond === releaseFirst) {
      throw new Error("expected a fresh pending sleep for the second call");
    }
    releaseSecond();
    await pendingB;

    expect(session.setCalls.map((call) => call.name)).toEqual(["sid", "sid"]);
  });
});

// =================================================================================
// 15. source-changed: the prompt the Choose step promised is the only prompt
//     Import may raise
// =================================================================================

describe("import - source-changed: a chosen site gained an encrypted row needing an unscanned keystore", () => {
  // Pins: a chosen site that was all `v10` (peanuts, no keyring) at scan
  // time and gains a `v11` row before Import is clicked would open a
  // keystore prompt the Choose step never promised - `unlockFor` on the
  // fresh candidates now says `linux-keyring`, but no chosen site's
  // RECORDED scan said that, so the import blocks as source-changed and
  // drops the scan. A second import without a re-scan then blocks as
  // unreadable (no scan on record); a re-scan picks up the v11 row and lets
  // the import proceed.
  it("blocks as source-changed when a chosen site gained an encrypted row since the scan, and drops the scan", async () => {
    const homeDir = await makeTempDir("login-import-source-changed-");
    await createLinuxChromeSource(
      homeDir,
      [
        domainCookieRow(".linux-site.com", "sid", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            CHROMIUM_LINUX_BASIC_PASSPHRASE,
            CHROMIUM_PBKDF2_ITERATIONS.linux,
            "linux-v10-value",
          ),
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service, secrets } = buildHarness(
      { platform: "linux", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    // All v10 (peanuts): no keystore prompt at scan time.
    expect(scan.unlock).toBeNull();

    const cookiesPath = join(
      homeDir,
      ".config",
      "google-chrome",
      "Default",
      "Cookies",
    );
    appendChromiumCookieRow(
      cookiesPath,
      domainCookieRow(".linux-site.com", "auth", {
        kind: "encrypted",
        bytes: encryptCbc(
          "v11",
          "gnome-keyring-secret",
          CHROMIUM_PBKDF2_ITERATIONS.linux,
          "linux-v11-value",
        ),
      }),
    );

    const firstResult = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["linux-site.com"],
      includeDeviceBound: false,
    });

    expect(firstResult).toEqual({
      status: "blocked",
      reason: "source-changed",
    });
    expect(secrets.linuxSecretService).not.toHaveBeenCalled();

    // The scan was dropped: a second import without a re-scan blocks as
    // unreadable, the "no scan on record" path.
    const secondResult = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["linux-site.com"],
      includeDeviceBound: false,
    });
    expect(secondResult).toEqual({ status: "blocked", reason: "unreadable" });

    // A fresh scan sees the v11 row and lists linux-keyring; import now
    // proceeds and consults the keyring.
    secrets.linuxSecretService.mockResolvedValue({
      ok: true,
      secret: "gnome-keyring-secret",
    });
    const rescan = await service.scan(sourceId);
    expect(rescan.unlock).toBe("linux-keyring");

    const thirdResult = await service.import({
      sourceId,
      scanId: rescan.scanId,
      domains: ["linux-site.com"],
      includeDeviceBound: false,
    });

    expect(thirdResult.status).toBe("imported");
    expect(secrets.linuxSecretService).toHaveBeenCalledTimes(1);
  });
});

describe("import - source-changed: not raised when a chosen site already needed that keystore", () => {
  // Pins: source-changed is only about a keystore prompt no CHOSEN site was
  // scanned as needing. Here one of the two chosen sites (darwin-encrypted)
  // was already scanned as needing macos-keychain, so the same prompt at
  // Import time is not a surprise and the import proceeds normally.
  it("does not block as source-changed when some chosen site was scanned as needing that keystore", async () => {
    const homeDir = await makeTempDir("login-import-source-changed-ok-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".darwin-encrypted.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "macos-keychain-secret",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "darwin-secret-value",
          ),
        }),
        domainCookieRow(".darwin-plain.com", "sid", {
          kind: "plain",
          value: "plain-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const macosKeychain = vi.fn(() =>
      Promise.resolve({ ok: true as const, secret: "macos-keychain-secret" }),
    );
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        secrets: {
          macosKeychain,
          linuxSecretService: alwaysUnavailable(),
          windowsDpapi: () => Promise.resolve(null),
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    expect(scan.sites).toEqual([
      {
        domain: "darwin-encrypted.com",
        cookieCount: 1,
        unlock: "macos-keychain",
      },
      { domain: "darwin-plain.com", cookieCount: 1, unlock: null },
    ]);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["darwin-encrypted.com", "darwin-plain.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") {
      throw new Error(`expected imported, got ${result.status}`);
    }
    expect(result.importedSites).toBe(2);
    expect(macosKeychain).toHaveBeenCalledTimes(1);
  });
});

// =================================================================================
// 16. An import quotes the scan its window rendered
// =================================================================================

describe("import - quotes the scan its window rendered", () => {
  it("honours the earlier of two scans, refuses an unknown scanId, and refuses the scan's token against a different sourceId", async () => {
    const homeDir = await makeTempDir("login-import-quote-scan-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".quote-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const sourceId = await chromeSourceId(service);

    const first = await service.scan(sourceId);
    const second = await service.scan(sourceId);
    expect(first.scanId).not.toBe(second.scanId);

    // The earlier scan is still retained: quoting it still succeeds.
    const result = await service.import({
      sourceId,
      scanId: first.scanId,
      domains: ["quote-site.com"],
      includeDeviceBound: false,
    });
    expect(result.status).toBe("imported");

    // An unknown scanId names no scan on record.
    const unknownScanResult = await service.import({
      sourceId,
      scanId: "0".repeat(32),
      domains: ["quote-site.com"],
      includeDeviceBound: false,
    });
    expect(unknownScanResult).toEqual({
      status: "blocked",
      reason: "unreadable",
    });

    // A second, distinct registered source: first's scanId names a scan of
    // the FIRST source, so quoting it against this one is refused too.
    const fileSourceDir = await makeTempDir("login-import-quote-scan-file-");
    const filePath = join(fileSourceDir, "cookies.txt");
    await writeFile(
      filePath,
      "other-site.com\tFALSE\t/\tFALSE\t0\tsid\tabc123",
    );
    const fileSource = await service.registerFile(filePath);

    const wrongSourceResult = await service.import({
      sourceId: fileSource.id,
      scanId: first.scanId,
      domains: ["other-site.com"],
      includeDeviceBound: false,
    });
    expect(wrongSourceResult).toEqual({
      status: "blocked",
      reason: "unreadable",
    });
  });
});

// =================================================================================
// 17. Only RETAINED_SCAN_LIMIT scans are kept, oldest first
// =================================================================================

describe("import - keeps at most RETAINED_SCAN_LIMIT scans, oldest first", () => {
  it("evicts the oldest scan once more than RETAINED_SCAN_LIMIT have been taken", async () => {
    const homeDir = await makeTempDir("login-import-scan-limit-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".limit-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const sourceId = await chromeSourceId(service);

    const scans: LoginImportScan[] = [];
    for (let count = 0; count < RETAINED_SCAN_LIMIT + 1; count += 1) {
      scans.push(await service.scan(sourceId));
    }
    const first = scans[0];
    const second = scans[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected at least two scans");
    }

    const firstResult = await service.import({
      sourceId,
      scanId: first.scanId,
      domains: ["limit-site.com"],
      includeDeviceBound: false,
    });
    expect(firstResult).toEqual({ status: "blocked", reason: "unreadable" });

    const secondResult = await service.import({
      sourceId,
      scanId: second.scanId,
      domains: ["limit-site.com"],
      includeDeviceBound: false,
    });
    expect(secondResult.status).toBe("imported");
  });
});

// =================================================================================
// 18. releaseHostOwnedKeys releases exactly the keys written before an abort
// =================================================================================

describe("import - releases ownership of the keys written before the barrier aborts", () => {
  it("releases exactly the keys written before the barrier's signal aborts, and only once", async () => {
    const homeDir = await makeTempDir("login-import-release-abort-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".abort-release-a.com", "sid", {
          kind: "plain",
          value: "a",
        }),
        domainCookieRow(".abort-release-b.com", "sid", {
          kind: "plain",
          value: "b",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const controller = new AbortController();
    const originalSet = session.cookies.set;
    let setCallCount = 0;
    session.cookies.set = (details: CookiesSetDetails): Promise<void> => {
      setCallCount += 1;
      const result = originalSet(details);
      // Aborts after the first successful write, mimicking the barrier
      // expiring mid-import.
      if (setCallCount === 1) controller.abort();
      return result;
    };
    const releaseHostOwnedKeys = vi.fn(
      async (_keys: readonly BrowserCookieKey[]): Promise<void> => undefined,
    );
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => action(controller.signal),
        releaseHostOwnedKeys,
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["abort-release-a.com", "abort-release-b.com"],
      includeDeviceBound: false,
    });

    // The first site's row landed before the abort, so this answers
    // "incomplete" (and pushes once), not "unreadable".
    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    const releasedKeys = releaseHostOwnedKeys.mock.calls[0]?.[0];
    expect(releasedKeys).toEqual([
      { domain: ".abort-release-a.com", name: "sid", path: "/" },
    ]);
  });
});

// =================================================================================
// 19. The barrier is taken before the keystore prompt
// =================================================================================

describe("import - takes the barrier before the keystore prompt", () => {
  it("consults the keychain from inside the barrier, and denies without touching the jar or releasing keys", async () => {
    const homeDir = await makeTempDir("login-import-barrier-before-keystore-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".barrier-keystore.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "macos-keychain-secret",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "secret-value",
          ),
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const barrierState = { insideBarrier: false };
    const keychainCalls: boolean[] = [];
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          barrierState.insideBarrier = true;
          try {
            return await action(new AbortController().signal);
          } finally {
            barrierState.insideBarrier = false;
          }
        },
        secrets: {
          macosKeychain: () => {
            keychainCalls.push(barrierState.insideBarrier);
            return Promise.resolve({ ok: false, reason: "denied" });
          },
          linuxSecretService: alwaysUnavailable(),
          windowsDpapi: () => Promise.resolve(null),
        },
        releaseHostOwnedKeys,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["barrier-keystore.com"],
      includeDeviceBound: false,
    });

    expect(keychainCalls).toEqual([true]);
    expect(result).toEqual({ status: "blocked", reason: "keychain-denied" });
    expect(session.setCalls).toEqual([]);
    expect(releaseHostOwnedKeys).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 20. A jar cookie at a carried key survives a write that could not land
// =================================================================================

describe("import - keeps the jar's cookie at a key the source carries but could not write", () => {
  it("keeps the old cookie at the rejected key, writes the other row, and removes only the uncarried key", async () => {
    const homeDir = await makeTempDir("login-import-carried-key-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".carried-key.com", "sid", {
          kind: "plain",
          value: "new-sid-value",
        }),
        domainCookieRow(".carried-key.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("sid", ".carried-key.com"),
      cookieFixture("legacy", ".carried-key.com"),
    ]);
    session.rejectSet("sid");
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["carried-key.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 1,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("carried-key.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      "fresh",
      "sid",
    ]);
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    // The OLD value survives: the source carried a row for this key, but the
    // write that would have replaced it was rejected.
    expect(sidCookie?.value).toBe("sid-value");
  });
});

// =================================================================================
// 20b. carriedBySite is collected from every classified row, before the
// protected/partitioned skip - not just from the rows that became candidates
// =================================================================================

describe("import - keeps the jar's cookie at a key the source holds only as a protected row", () => {
  it("writes the plain row, removes the genuinely uncarried key, and leaves the protected key's cookie untouched", async () => {
    const homeDir = await makeTempDir("login-import-carried-protected-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".carried-protected.com", "sid", {
          kind: "plain",
          value: "new-sid-value",
        }),
        // Never becomes a candidate - `importInner` skips a protected row
        // before the candidates push - but the source DOES hold a row at
        // this key, so `writeSite` must not treat it as uncarried.
        domainCookieRow(".carried-protected.com", "app", {
          kind: "protected",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("app", ".carried-protected.com"),
      // The source carries no row for this name at all - genuinely stale.
      cookieFixture("old", ".carried-protected.com"),
    ]);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["carried-protected.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("carried-protected.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual(["app", "sid"]);
    // Before the fix, `app` would have been removed as "not carried" -
    // `carriedBySite` was derived from the candidates, which never included
    // the protected row.
    const appCookie = cookies.find((cookie) => cookie.name === "app");
    expect(appCookie?.value).toBe("app-value");
  });
});

// =================================================================================
// 21. clearSiteLocalStorage runs once per written site, never for an unwritten one
// =================================================================================

describe("import - clears a written site's localStorage and leaves an unwritten site's", () => {
  it("clears localStorage only for the site that actually wrote a cookie", async () => {
    const homeDir = await makeTempDir("login-import-clear-storage-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".written-site.com", "good", {
          kind: "plain",
          value: "a",
        }),
        domainCookieRow(".unwritten-site.com", "bad", {
          kind: "plain",
          value: "b",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    session.rejectSet("bad");
    const { service, clearedSites } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["written-site.com", "unwritten-site.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(clearedSites).toEqual(["written-site.com"]);
  });

  it("clears no site's localStorage when the import is blocked before the write", async () => {
    const { service, clearedSites } = buildHarness(
      { readSaveLogins: () => false },
      new FakeLoginImportSession([]),
    );

    const result = await service.import({
      sourceId: "never-registered",
      scanId: "unused-scan-id",
      domains: ["example.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "saved-logins-off" });
    expect(clearedSites).toEqual([]);
  });
});

// =================================================================================
// 22. confirmImport: main confirms the validated selection before any side effect
// =================================================================================

describe("import - confirmImport", () => {
  it("asks main to confirm the validated selection before reading the source", async () => {
    const homeDir = await makeTempDir("login-import-confirm-order-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".confirm-a.com", "sid", { kind: "plain", value: "a" }),
        domainCookieRow(".confirm-b.com", "auth", {
          kind: "encrypted",
          bytes: encryptCbc(
            "v10",
            "macos-keychain-secret",
            CHROMIUM_PBKDF2_ITERATIONS.darwin,
            "secret-value",
          ),
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const order: string[] = [];
    const confirmations: LoginImportSummary[] = [];
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        confirmImport: (summary: LoginImportSummary): Promise<boolean> => {
          order.push("confirm");
          confirmations.push(summary);
          return Promise.resolve(true);
        },
        secrets: {
          macosKeychain: () => {
            order.push("secret-read");
            return Promise.resolve({
              ok: true as const,
              secret: "macos-keychain-secret",
            });
          },
          linuxSecretService: alwaysUnavailable(),
          windowsDpapi: () => Promise.resolve(null),
        },
      },
      session,
    );
    const sources = await service.listSources();
    const chrome = sources.find((source) => source.browser === "chrome");
    if (chrome === undefined) throw new Error("expected a chrome source");
    const scan = await service.scan(chrome.id);

    const result = await service.import({
      sourceId: chrome.id,
      scanId: scan.scanId,
      domains: ["confirm-a.com", "confirm-b.com", "never-listed.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(confirmations).toEqual([
      { browser: "chrome", profileLabel: chrome.profileLabel, siteCount: 2 },
    ]);
    // The keystore is consulted only AFTER the confirmation, inside the
    // barrier - never before main has confirmed the validated selection.
    expect(order).toEqual(["confirm", "secret-read"]);
  });

  it("a declined confirmation imports nothing", async () => {
    const homeDir = await makeTempDir("login-import-confirm-declined-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".declined-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    let serializeJarWriteEntered = false;
    const { service, secrets, clearedSites } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        confirmImport: (): Promise<boolean> => Promise.resolve(false),
        releaseHostOwnedKeys,
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          serializeJarWriteEntered = true;
          return action(new AbortController().signal);
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["declined-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(session.setCalls).toEqual([]);
    expect(secrets.macosKeychain).not.toHaveBeenCalled();
    expect(clearedSites).toEqual([]);
    expect(releaseHostOwnedKeys).not.toHaveBeenCalled();
    expect(serializeJarWriteEntered).toBe(false);
  });

  it("does not ask when nothing chosen validates", async () => {
    const homeDir = await makeTempDir("login-import-confirm-unvalidated-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".scanned-only.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const { service, confirmations } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["not-in-the-scan.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    expect(confirmations).toEqual([]);
  });

  it("puts back a kept cookie that a same-name removal reached", async () => {
    const homeDir = await makeTempDir("login-import-confirm-restore-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".restore-site.com", "sid", {
          kind: "plain",
          value: "new-sid-value",
        }),
        domainCookieRow(".restore-site.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      // K1: a domain cookie - the key the source's "sid" row carries.
      cookieFixture("sid", ".restore-site.com"),
      // K2: a host-only cookie of the SAME name but a DIFFERENT key - the
      // source does not carry this one at all.
      cookieFixture("sid", "restore-site.com"),
    ]);
    // Rejects only the SOURCE's write (the new value); a later restore of
    // K1's original value must still succeed.
    session.rejectSetValue("sid", "new-sid-value");
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["restore-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 1,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("restore-site.com");
    // BOTH K1 and K2 survive, untouched: the source's "sid" row was refused
    // on its FIRST write (not a re-write), so no landed row of the name
    // "sid" ever existed - the name is orphaned from the start, and
    // `writeSite` leaves the jar's cookies of that name alone under ANY
    // scope, never even attempting a removal for them.
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      "fresh",
      "sid",
      "sid",
    ]);
    const sidCookies = cookies.filter((cookie) => cookie.name === "sid");
    expect(sidCookies).toHaveLength(2);
    for (const sidCookie of sidCookies) {
      expect(sidCookie.value).toBe("sid-value");
    }
  });
});

// =================================================================================
// 22b. A same-name re-write refused: the jar's prior cookie is restored anyway
// =================================================================================

describe("import - a same-name re-write refused after removal falls back to the jar's prior cookie", () => {
  // Pins: the first write of "sid" succeeds; the same-name removal that
  // catches the uncarried, differently-scoped "sid" then triggers a re-write
  // of the SAME row (same name, same value), and Chromium refuses THAT one.
  // The refused re-write leaves the key out of `writtenKeyIds`, so no landed
  // row of the name "sid" survives - the name is ORPHANED - and the restore
  // pass puts back every prior cookie of that name the removal reached,
  // carried or not: both K1 (the carried domain cookie, at its PRIOR value)
  // and the uncarried host-only cookie the source never named at all.
  it("puts the prior cookie back when a same-name re-write is refused", async () => {
    const homeDir = await makeTempDir("login-import-rewrite-refused-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".rewrite-refused.com", "sid", {
          kind: "plain",
          value: "new",
        }),
        domainCookieRow(".rewrite-refused.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const domainCookie: Cookie = {
      name: "sid",
      value: "old",
      domain: ".rewrite-refused.com",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    };
    const uncarriedHostOnlyCookie: Cookie = {
      name: "sid",
      value: "uncarried-value",
      domain: "rewrite-refused.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    };
    const session = new FakeLoginImportSession([
      // K1: a domain cookie - the key the source's "sid" row carries.
      domainCookie,
      // An uncarried "sid" under another scope (host-only) - the source does
      // not carry this key at all.
      uncarriedHostOnlyCookie,
    ]);
    // The first `cookies.set("sid", "new")` succeeds; the SECOND call for the
    // same name+value - the re-write `writeSite` retries after the same-name
    // removal catches K1 - is refused.
    session.rejectSetValueAfter("sid", "new", 1);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["rewrite-refused.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 1,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("rewrite-refused.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      "fresh",
      "sid",
      "sid",
    ]);
    const sidCookies = cookies.filter((cookie) => cookie.name === "sid");
    // BOTH prior "sid" cookies are back: no landed row of the name "sid"
    // survives its re-write, so the name is orphaned and every prior cookie
    // of that name the removal reached is restored, carried or not.
    expect(sidCookies).toHaveLength(2);
    // K1 - the carried domain cookie - is back at its PRIOR value.
    const domainSid = sidCookies.find(
      (cookie) => cookie.domain === ".rewrite-refused.com",
    );
    expect(domainSid?.value).toBe("old");
    expect(domainSid?.hostOnly).toBe(false);
    // The uncarried host-only "sid" the source never named is ALSO back, at
    // its own prior value.
    const hostOnlySid = sidCookies.find((cookie) => cookie.hostOnly);
    expect(hostOnlySid?.value).toBe("uncarried-value");
    expect(hostOnlySid?.domain).toBe("rewrite-refused.com");
  });
});

// =================================================================================
// 23. saved-logins-off, re-checked inside the barrier
// =================================================================================

describe("import - refuses to write when saving is turned off during the prompt", () => {
  // Pins: `readSaveLogins` is re-read INSIDE the barrier, after `resolveKeys`
  // and the signal check - a window that turns saving off while this import
  // sat on the keystore prompt (or, here, simply while the barrier is being
  // entered) must not have its write land on the ephemeral jar's replacement.
  it("blocks with saved-logins-off, writes nothing, and releases no keys", async () => {
    const homeDir = await makeTempDir("login-import-off-during-prompt-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".off-during-prompt.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    let saveLoginsOn = true;
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const { service, clearedSites } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        readSaveLogins: () => saveLoginsOn,
        // Turned off once the barrier is entered - AFTER the outer
        // saved-logins check that ran before confirmation and the read, but
        // before the inner re-check the barrier action takes.
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          saveLoginsOn = false;
          return action(new AbortController().signal);
        },
        releaseHostOwnedKeys,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["off-during-prompt.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "saved-logins-off" });
    expect(session.setCalls).toEqual([]);
    expect(releaseHostOwnedKeys).not.toHaveBeenCalled();
    expect(clearedSites).toEqual([]);
  });
});

// =================================================================================
// 24. clearSiteLocalStorage runs LAST; a rejection leaves the cookies whole
// =================================================================================

describe("import - a localStorage clear that fails leaves the site's cookies whole", () => {
  // Pins: `clearSiteLocalStorage` runs after every stale removal, kept-cookie
  // restore and same-name re-write - so a rejection there finds the site's
  // cookie slice already fully recovered, and the outer catch answers
  // blocked/incomplete (the "fresh" row landed before the clear failed) and
  // still pushes the jar once, without undoing any of that recovery.
  it("keeps the restored kept cookie and the written row when the clear rejects", async () => {
    const homeDir = await makeTempDir("login-import-clear-fails-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".clear-fails.com", "sid", {
          kind: "plain",
          value: "new-sid-value",
        }),
        domainCookieRow(".clear-fails.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      // K1: a domain cookie - the key the source's "sid" row carries.
      cookieFixture("sid", ".clear-fails.com"),
      // K2: a host-only cookie of the SAME name but a DIFFERENT key - the
      // source does not carry this one at all.
      cookieFixture("sid", "clear-fails.com"),
    ]);
    // Rejects the SOURCE's "sid" write outright, on every call - so the row
    // never lands, "sid" is orphaned from the start, and K1/K2 are both left
    // untouched rather than removed-and-restored.
    session.rejectSetValue("sid", "new-sid-value");
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        clearSiteLocalStorage: () => Promise.reject(new Error("clear failed")),
        releaseHostOwnedKeys,
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["clear-fails.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    const cookies = session.cookiesUnderDomain("clear-fails.com");
    // BOTH K1 and K2 survive, untouched: the source's "sid" row was refused
    // on its FIRST write (not a re-write), so no landed row of the name
    // "sid" ever existed - the name is orphaned from the start, and
    // `writeSite` leaves the jar's cookies of that name alone under ANY
    // scope, never even attempting a removal for them.
    const sidCookies = cookies.filter((cookie) => cookie.name === "sid");
    expect(sidCookies).toHaveLength(2);
    for (const sidCookie of sidCookies) {
      expect(sidCookie.value).toBe("sid-value");
    }
    // The written row is untouched by the later failure.
    const freshCookie = cookies.find((cookie) => cookie.name === "fresh");
    expect(freshCookie?.value).toBe("fresh-value");
    // releaseHostOwnedKeys still ran, inside the barrier, with the key that
    // actually landed.
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledWith([
      { domain: ".clear-fails.com", name: "fresh", path: "/" },
    ]);
  });
});

// =================================================================================
// 25. The saved-logins pref is re-read as the FIRST thing inside the barrier,
//     before the source is ever opened.
// =================================================================================

describe("import - the saved-logins pref is re-checked inside the barrier, before the source is read", () => {
  // Pins: `readSaveLogins` is the first thing `serializeJarWrite`'s action
  // does. Flipping it false only once the barrier is entered - never before,
  // so the outer pre-barrier check and `confirmImport` both still see it on -
  // means a source that cannot be read is never even opened: the pref wins
  // before any read is attempted. Under the pre-fix code (the source read
  // outside the barrier, before it was ever called) this same corrupted
  // source would fail the read first, answering "unreadable" with
  // `serializeJarWrite` never called at all - not "saved-logins-off" with it
  // called exactly once.
  it("reads the source inside the barrier, after the confirmation", async () => {
    const homeDir = await makeTempDir("login-import-barrier-pref-order-");
    const cookiesPath = await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".pref-order-site.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    let saveLoginsOn = true;
    let serializeJarWriteCalls = 0;
    const { service, confirmations } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        readSaveLogins: () => saveLoginsOn,
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          serializeJarWriteCalls += 1;
          saveLoginsOn = false;
          return action(new AbortController().signal);
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    expect(scan.sites).toEqual([
      { domain: "pref-order-site.com", cookieCount: 1, unlock: null },
    ]);
    // Corrupted AFTER the scan: if the pref check inside the barrier did not
    // run before the read, this read would surface as "unreadable" instead.
    await writeFile(cookiesPath, "not a sqlite database");

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["pref-order-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "saved-logins-off" });
    expect(confirmations.length).toBe(1);
    expect(serializeJarWriteCalls).toBe(1);
  });
});

// =================================================================================
// 26. A source that cannot be read is discovered from INSIDE the barrier
// =================================================================================

describe("import - a source that cannot be read answers blocked from inside the barrier", () => {
  it("a source that cannot be read answers blocked from inside the barrier", async () => {
    const homeDir = await makeTempDir("login-import-barrier-read-fails-");
    const cookiesPath = await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".barrier-read-fails.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    let serializeJarWriteCalls = 0;
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          serializeJarWriteCalls += 1;
          return action(new AbortController().signal);
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    // Corrupted after the scan, so the IMPORT's read is the one that fails.
    await writeFile(cookiesPath, "not a sqlite database");

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["barrier-read-fails.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "unreadable" });
    // The barrier was entered even though the read inside it failed. Under
    // the pre-fix code (read outside the barrier) this would never be
    // called at all - the failed read would have answered "unreadable"
    // before `serializeJarWrite` was ever reached.
    expect(serializeJarWriteCalls).toBe(1);
  });
});

// =================================================================================
// 27. A failed stale-cookie removal no longer skips the recovery passes
// =================================================================================

describe("import - a failed stale-cookie removal still runs the recovery passes", () => {
  it("rewrites the imported cookie and restores the kept one when a later stale removal rejects", async () => {
    const homeDir = await makeTempDir("login-import-stale-removal-fails-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".stale-removal-fails.com", "sid", {
          kind: "plain",
          value: "new-sid-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      // A stale "sid" at an UNCARRIED scope (host-only): the source carries
      // "sid" as a domain cookie, a different key, so this one is genuinely
      // stale and due for removal - but Electron's {url, name} removal is
      // wider than one cookie and also catches the just-written domain
      // "sid".
      cookieFixture("sid", "stale-removal-fails.com"),
      // A second, unrelated stale cookie the source does not carry at all.
      cookieFixture("other", ".stale-removal-fails.com"),
    ]);
    // The "other" removal rejects; the fake jar leaves it in place, as if
    // the OS removal never completed.
    session.rejectRemove("other");
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service, clearedSites } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        releaseHostOwnedKeys,
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["stale-removal-fails.com"],
      includeDeviceBound: false,
    });

    // The "sid" row landed before the "other" removal rejected, so this
    // answers "incomplete" - with the jar still pushed once - rather than
    // "unreadable".
    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    const cookies = session.cookiesUnderDomain("stale-removal-fails.com");
    // The imported "sid" is back: the same-name removal that caught it (via
    // the stale host-only "sid") triggered a re-write, which still ran even
    // though the LATER "other" removal failed.
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.value).toBe("new-sid-value");
    expect(sidCookie?.domain).toBe(".stale-removal-fails.com");
    // "other" is still in the jar: its own removal rejected and never took.
    const otherCookie = cookies.find((cookie) => cookie.name === "other");
    expect(otherCookie).toBeDefined();
    // A site whose write is answered blocked never gets its localStorage
    // cleared.
    expect(clearedSites).not.toContain("stale-removal-fails.com");
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledWith([
      { domain: ".stale-removal-fails.com", name: "sid", path: "/" },
    ]);
  });

  it("puts reached cookies back when the barrier gives up between two removals", async () => {
    const homeDir = await makeTempDir("login-import-abort-mid-removal-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".abort-mid-removal.com", "sid", {
          kind: "plain",
          value: "new-sid-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("sid", "abort-mid-removal.com"),
      cookieFixture("other", ".abort-mid-removal.com"),
    ]);
    const controller = new AbortController();
    const originalRemove = session.cookies.remove;
    let removeCallCount = 0;
    session.cookies.remove = (url: string, name: string): Promise<void> => {
      removeCallCount += 1;
      const result = originalRemove(url, name);
      // Aborts once the first stale removal has gone through, mimicking the
      // barrier giving the import up between two removals.
      if (removeCallCount === 1) controller.abort();
      return result;
    };
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => action(controller.signal),
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["abort-mid-removal.com"],
      includeDeviceBound: false,
    });

    // The "sid" row landed before the barrier gave up mid-removal, so this
    // answers "incomplete" - with the jar still pushed once.
    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    const cookies = session.cookiesUnderDomain("abort-mid-removal.com");
    // The same-name recovery still ran even though the second stale removal
    // never happened: the first removal caught the just-written cookie too,
    // and the re-write put it back.
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.value).toBe("new-sid-value");
    expect(sidCookie?.domain).toBe(".abort-mid-removal.com");
    // Two `set` calls for "sid" - the first write and the recovery re-write
    // - prove the recovery pass actually ran.
    const sidSetCalls = session.setCalls.filter((call) => call.name === "sid");
    expect(sidSetCalls).toHaveLength(2);
    // "other" was never reached: the loop broke before its turn, so it was
    // never even attempted.
    const otherCookie = cookies.find((cookie) => cookie.name === "other");
    expect(otherCookie).toBeDefined();
  });
});

// =================================================================================
// 29. A re-write refused at an UNCARRIED key restores the jar's prior cookie
// =================================================================================

describe("import - a re-write refused restores the prior cookie at an UNCARRIED key", () => {
  // Pins: the source carries only a domain "sid" row; the jar's PRIOR cookie
  // at that name is host-only (a different key, one the source does not
  // carry). The removal that catches it triggers a re-write of the source's
  // row, which is refused - so the restore pass puts the jar's ORIGINAL
  // host-only cookie back, and nothing else survives at that name.
  it("restores an uncarried prior cookie of the same name when its re-write is refused", async () => {
    const homeDir = await makeTempDir("login-import-restore-uncarried-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".restore-uncarried.com", "sid", {
          kind: "plain",
          value: "new-value",
        }),
        domainCookieRow(".restore-uncarried.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const uncarriedHostOnlyCookie: Cookie = {
      name: "sid",
      value: "uncarried-value",
      domain: "restore-uncarried.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    };
    const session = new FakeLoginImportSession([uncarriedHostOnlyCookie]);
    session.rejectSetValueAfter("sid", "new-value", 1);
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        releaseHostOwnedKeys,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["restore-uncarried.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 1,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("restore-uncarried.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      "fresh",
      "sid",
    ]);
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.hostOnly).toBe(true);
    expect(sidCookie?.value).toBe("uncarried-value");
    // The refused "sid" re-write drops that key from `releaseHostOwnedKeys`'s
    // list too - only "fresh", which actually stayed written, is released.
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledWith([
      { domain: ".restore-uncarried.com", name: "fresh", path: "/" },
    ]);
  });
});

// =================================================================================
// 30. A source row that fails its FIRST write keeps a prior cookie of that name
// =================================================================================

describe("import - keeps a prior cookie of a name whose source row failed its first write", () => {
  it("keeps a prior cookie of a name whose source row failed its first write", async () => {
    const homeDir = await makeTempDir("login-import-keep-failed-first-write-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".keep-failed-first-write.com", "sid", {
          kind: "plain",
          value: "new-value",
        }),
        domainCookieRow(".keep-failed-first-write.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const uncarriedHostOnlyCookie: Cookie = {
      name: "sid",
      value: "uncarried-value",
      domain: "keep-failed-first-write.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    };
    const session = new FakeLoginImportSession([
      uncarriedHostOnlyCookie,
      cookieFixture("old", ".keep-failed-first-write.com"),
    ]);
    session.rejectSet("sid");
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["keep-failed-first-write.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.skippedInvalid).toBe(1);
    const cookies = session.cookiesUnderDomain("keep-failed-first-write.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      "fresh",
      "sid",
    ]);
    // "sid" is untouched - orphaned from the start, since the source's row
    // never landed and no OTHER row of that name did either.
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.hostOnly).toBe(true);
    expect(sidCookie?.value).toBe("uncarried-value");
    const freshCookie = cookies.find((cookie) => cookie.name === "fresh");
    expect(freshCookie?.value).toBe("fresh-value");
  });
});

// =================================================================================
// 31. A site with nothing landed after every re-write is refused ends up
//     exactly as it started
// =================================================================================

describe("import - a site with nothing landed after every re-write is refused", () => {
  it("puts the site back as it was when every re-write is refused", async () => {
    const homeDir = await makeTempDir("login-import-nothing-landed-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".nothing-landed.com", "sid", {
          kind: "plain",
          value: "new-value",
        }),
      ],
      23,
    );
    const uncarriedHostOnlyCookie: Cookie = {
      name: "sid",
      value: "uncarried-value",
      domain: "nothing-landed.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    };
    const session = new FakeLoginImportSession([
      uncarriedHostOnlyCookie,
      cookieFixture("old", ".nothing-landed.com"),
    ]);
    session.rejectSetValueAfter("sid", "new-value", 1);
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const { service, clearedSites } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        pushJarToHosts,
        releaseHostOwnedKeys,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["nothing-landed.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 1,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("nothing-landed.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual(["old", "sid"]);
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.hostOnly).toBe(true);
    expect(sidCookie?.value).toBe("uncarried-value");
    const oldCookie = cookies.find((cookie) => cookie.name === "old");
    expect(oldCookie?.value).toBe("old-value");
    // Nothing landed: `writeSite` returns before the localStorage clear.
    expect(clearedSites).not.toContain("nothing-landed.com");
    // The refused re-write also drops the key from `tally.writtenKeys` (not
    // only `writtenKeyIds`), so nothing of the import's remains written - the
    // jar is still pushed once, but only because the "old" removal recorded
    // the forget ledger, never because a key survived.
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledWith([]);
  });
});

// =================================================================================
// 32. The forget ledger is recorded lazily, once, before the first removal -
//     never for a site that has nothing to remove
// =================================================================================

describe("import - the forget ledger is recorded lazily, once, before the first removal", () => {
  it("records every written site in the ledger under one revision before the first removal and marks it cleared after", async () => {
    const homeDir = await makeTempDir("login-import-ledger-order-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".ledger-site-one.com", "keep1", {
          kind: "plain",
          value: "v1",
        }),
        domainCookieRow(".ledger-site-two.com", "keep2", {
          kind: "plain",
          value: "v2",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("old1", ".ledger-site-one.com"),
      cookieFixture("old2", ".ledger-site-two.com"),
    ]);
    const order: string[] = [];
    const originalSet = session.cookies.set;
    session.cookies.set = (details: CookiesSetDetails): Promise<void> => {
      order.push(`set:${details.name}`);
      return originalSet(details);
    };
    const originalRemove = session.cookies.remove;
    session.cookies.remove = (url: string, name: string): Promise<void> => {
      order.push(`remove:${name}`);
      return originalRemove(url, name);
    };
    const recordReplacedSites = vi.fn(
      async (sites: readonly string[]): Promise<number> => {
        order.push("record");
        expect([...sites].sort()).toEqual([
          "ledger-site-one.com",
          "ledger-site-two.com",
        ]);
        return 7;
      },
    );
    const markReplacementCleared = vi.fn(
      async (revision: number): Promise<void> => {
        order.push("mark-cleared");
        expect(revision).toBe(7);
      },
    );
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => {
      order.push("release");
    });
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        recordReplacedSites,
        markReplacementCleared,
        releaseHostOwnedKeys,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["ledger-site-one.com", "ledger-site-two.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(recordReplacedSites).toHaveBeenCalledTimes(1);
    expect(markReplacementCleared).toHaveBeenCalledTimes(1);
    expect(markReplacementCleared).toHaveBeenCalledWith(7);
    const recordIndex = order.indexOf("record");
    // Recorded after the first site's write, before its first removal.
    expect(recordIndex).toBeGreaterThan(order.indexOf("set:keep1"));
    expect(recordIndex).toBeLessThan(order.indexOf("remove:old1"));
    // Marked cleared after the last write and before the keys are released.
    const lastSetIndex = Math.max(
      order.indexOf("set:keep1"),
      order.indexOf("set:keep2"),
    );
    expect(order.indexOf("mark-cleared")).toBeGreaterThan(lastSetIndex);
    expect(order.indexOf("mark-cleared")).toBeLessThan(
      order.indexOf("release"),
    );
  });

  it("does not touch the ledger when no site has anything to remove", async () => {
    const homeDir = await makeTempDir("login-import-ledger-nothing-to-remove-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".ledger-nothing-one.com", "keep1", {
          kind: "plain",
          value: "v1",
        }),
        domainCookieRow(".ledger-nothing-two.com", "keep2", {
          kind: "plain",
          value: "v2",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const recordReplacedSites = vi.fn(async (): Promise<number> => 7);
    const markReplacementCleared = vi.fn(async (): Promise<void> => undefined);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        recordReplacedSites,
        markReplacementCleared,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["ledger-nothing-one.com", "ledger-nothing-two.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(recordReplacedSites).not.toHaveBeenCalled();
    expect(markReplacementCleared).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 33. The ledger is still marked cleared, and the jar still pushed, when the
//     write stops part-way
// =================================================================================

describe("import - the ledger is marked cleared and the jar is pushed even when the write stops part-way", () => {
  it("marks the ledger cleared and pushes even when the write stops part-way", async () => {
    const homeDir = await makeTempDir("login-import-ledger-incomplete-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".ledger-incomplete.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([
      cookieFixture("stale", ".ledger-incomplete.com"),
    ]);
    const markReplacementCleared = vi.fn(async (): Promise<void> => undefined);
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        clearSiteLocalStorage: () => Promise.reject(new Error("clear failed")),
        markReplacementCleared,
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["ledger-incomplete.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    expect(markReplacementCleared).toHaveBeenCalledTimes(1);
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
  });
});

// =================================================================================
// 34. The jar is pushed from INSIDE the barrier
// =================================================================================

describe("import - pushes the jar inside the barrier", () => {
  it("pushes the jar inside the barrier", async () => {
    const homeDir = await makeTempDir("login-import-push-inside-barrier-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".push-inside-barrier.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    const barrierState = { insideBarrier: false };
    const pushCalls: boolean[] = [];
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        serializeJarWrite: async <T>(
          action: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          barrierState.insideBarrier = true;
          try {
            return await action(new AbortController().signal);
          } finally {
            barrierState.insideBarrier = false;
          }
        },
        pushJarToHosts: async (): Promise<number> => {
          pushCalls.push(barrierState.insideBarrier);
          return 0;
        },
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["push-inside-barrier.com"],
      includeDeviceBound: false,
    });

    expect(result.status).toBe("imported");
    expect(pushCalls).toEqual([true]);
  });
});

// =================================================================================
// 35. Nothing is pushed when nothing was written
// =================================================================================

describe("import - does not push when nothing was written", () => {
  it("does not push when nothing was written", async () => {
    const homeDir = await makeTempDir("login-import-no-write-no-push-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".no-write-no-push.com", "one", {
          kind: "plain",
          value: "1",
        }),
        domainCookieRow(".no-write-no-push.com", "two", {
          kind: "plain",
          value: "2",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    session.rejectSet("one");
    session.rejectSet("two");
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const recordReplacedSites = vi.fn(async (): Promise<number> => 1);
    const markReplacementCleared = vi.fn(async (): Promise<void> => undefined);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        pushJarToHosts,
        recordReplacedSites,
        markReplacementCleared,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["no-write-no-push.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 2,
      notifiedHosts: 0,
    });
    expect(pushJarToHosts).not.toHaveBeenCalled();
    expect(recordReplacedSites).not.toHaveBeenCalled();
    expect(markReplacementCleared).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 28. A picked cookie-file source enforces the bounded-read limit
// =================================================================================

describe("import - a picked cookie-file source enforces the read bound", () => {
  it("answers file-too-large for a picked export over the bound", async () => {
    const fileDir = await makeTempDir("login-import-picked-file-large-");
    const filePath = join(fileDir, "cookies.txt");
    await writeFile(
      filePath,
      "file-too-large-site.com\tFALSE\t/\tFALSE\t0\tsid\tabc123\n",
    );
    const { service } = buildHarness({}, new FakeLoginImportSession([]));
    const source = await service.registerFile(filePath);
    const scan = await service.scan(source.id);
    expect(scan.sites).toEqual([
      { domain: "file-too-large-site.com", cookieCount: 1, unlock: null },
    ]);

    // Grown past the bound AFTER the scan, so it is the IMPORT's read that
    // fails. Sparse and instant via `truncate`: no need to actually write
    // MAX_LOGIN_IMPORT_FILE_BYTES to disk.
    await truncate(filePath, MAX_LOGIN_IMPORT_FILE_BYTES + 1);

    const result = await service.import({
      sourceId: source.id,
      scanId: scan.scanId,
      domains: ["file-too-large-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "file-too-large" });
  });

  it("answers unreadable for a picked path that is a directory", async () => {
    const parentDir = await makeTempDir("login-import-picked-dir-");
    const pickedDir = join(parentDir, "picked-as-a-file");
    await mkdir(pickedDir, { recursive: true });
    const { service } = buildHarness({}, new FakeLoginImportSession([]));
    const source = await service.registerFile(pickedDir);

    const scan = await service.scan(source.id);

    expect(scan.blocked).toBe("unreadable");
    expect(scan.sites).toEqual([]);
  });
});

// =================================================================================
// 36. An import naming more sites than the forget ledger can record is
//     refused before the keystore prompt or the first write
// =================================================================================

describe("import - refuses an import past the forget ledger's domain cap", () => {
  // Pins: `bySite.size > BROWSER_FORGET_LEDGER_MAX_DOMAINS` is checked right
  // after grouping the source's candidates by site and BEFORE `resolveKeys` -
  // so an import naming more sites than the forget ledger can record for one
  // revision never opens a keystore and never writes a cookie. `too-many-sites`
  // is a distinct reason from `source-changed`: the source read fine and the
  // scan stays on record, so a smaller re-selection can retry without a
  // fresh scan.
  it("refuses more sites than the forget ledger keeps, before the keystore or a write", async () => {
    const homeDir = await makeTempDir("login-import-too-many-sites-");
    const siteCount = BROWSER_FORGET_LEDGER_MAX_DOMAINS + 1;
    const rows: FixtureCookieRow[] = [];
    for (let index = 0; index < siteCount; index += 1) {
      rows.push(
        domainCookieRow(`.s${index}.com`, "sid", { kind: "plain", value: "v" }),
      );
    }
    await createDarwinChromeSource(homeDir, rows, 23);
    const session = new FakeLoginImportSession([]);
    const macosKeychain = vi.fn((): Promise<SecretReadResult> => {
      throw new Error("macOS keychain must not be consulted");
    });
    const recordReplacedSites = vi.fn(async (): Promise<number | null> => 1);
    const markReplacementCleared = vi.fn(async (): Promise<void> => undefined);
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        secrets: {
          macosKeychain,
          linuxSecretService: alwaysUnavailable(),
          windowsDpapi: () => Promise.resolve(null),
        },
        recordReplacedSites,
        markReplacementCleared,
        pushJarToHosts,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);
    expect(scan.sites.length).toBe(siteCount);
    const domains = scan.sites.map((site) => site.domain);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains,
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "too-many-sites" });
    expect(session.setCalls).toEqual([]);
    expect(recordReplacedSites).not.toHaveBeenCalled();
    expect(pushJarToHosts).not.toHaveBeenCalled();
    expect(markReplacementCleared).not.toHaveBeenCalled();
    expect(macosKeychain).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 37. `writeSite`'s by-name keep also covers a name the source holds only as
//     a row that never becomes a candidate (protected/partitioned)
// =================================================================================

describe("import - keeps a prior cookie of a name the source holds only as a protected row", () => {
  // Pins: `namesBySite` (importInner) is built from EVERY classified row for
  // a chosen site, including a protected one that never reaches `candidates`
  // - so `writeSite`'s `sourceNames` parameter carries that name too, and the
  // jar's cookie of that name under another scope is treated as orphaned
  // (kept), not stale (removed), even though no row of that name was ever
  // attempted.
  it("keeps a prior cookie of a name the source holds only as a protected row", async () => {
    const homeDir = await makeTempDir("login-import-protected-name-kept-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".protected-name-kept.com", "fresh", {
          kind: "plain",
          value: "fresh-value",
        }),
        domainCookieRow(".protected-name-kept.com", "sid", {
          kind: "protected",
        }),
      ],
      23,
    );
    const uncarriedHostOnlyCookie: Cookie = {
      name: "sid",
      value: "uncarried-value",
      domain: "protected-name-kept.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      expirationDate: 4_102_444_800,
    };
    const session = new FakeLoginImportSession([
      uncarriedHostOnlyCookie,
      cookieFixture("old", ".protected-name-kept.com"),
    ]);
    const { service } = buildHarness(
      { platform: "darwin", homeDir, snapshotRoot: await makeTempDir("snap-") },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["protected-name-kept.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 1,
      skippedInvalid: 0,
      notifiedHosts: 0,
    });
    const cookies = session.cookiesUnderDomain("protected-name-kept.com");
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      "fresh",
      "sid",
    ]);
    const freshCookie = cookies.find((cookie) => cookie.name === "fresh");
    expect(freshCookie?.value).toBe("fresh-value");
    // "old" was not carried and not orphaned (the source has no row named
    // "old" at all) - genuinely stale, so it was removed.
    // The host-only "sid" survives untouched at its prior value: the source
    // DOES hold a "sid" (the protected row), so the name is not stale even
    // though no "sid" row ever attempted a write.
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.hostOnly).toBe(true);
    expect(sidCookie?.value).toBe("uncarried-value");
  });
});

// =================================================================================
// 38. A `flushStore()` rejection after a successful write is folded into the
//     incomplete path, like any other ending that leaves cookies written
// =================================================================================

describe("import - a flush that rejects after a write still answers incomplete and pushes", () => {
  it("answers incomplete and pushes when the store flush rejects after a write", async () => {
    const homeDir = await makeTempDir("login-import-flush-rejects-");
    await createDarwinChromeSource(
      homeDir,
      [
        domainCookieRow(".flush-rejects.com", "sid", {
          kind: "plain",
          value: "v",
        }),
      ],
      23,
    );
    const session = new FakeLoginImportSession([]);
    session.rejectFlush();
    const releaseHostOwnedKeys = vi.fn(async (): Promise<void> => undefined);
    const pushJarToHosts = vi.fn(async (): Promise<number> => 0);
    const sleep = vi.fn(async (): Promise<void> => undefined);
    const { service } = buildHarness(
      {
        platform: "darwin",
        homeDir,
        snapshotRoot: await makeTempDir("snap-"),
        releaseHostOwnedKeys,
        pushJarToHosts,
        sleep,
      },
      session,
    );
    const { sourceId, scan } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      scanId: scan.scanId,
      domains: ["flush-rejects.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({ status: "blocked", reason: "incomplete" });
    const cookies = session.cookiesUnderDomain("flush-rejects.com");
    const sidCookie = cookies.find((cookie) => cookie.name === "sid");
    expect(sidCookie?.value).toBe("v");
    expect(pushJarToHosts).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledTimes(1);
    expect(releaseHostOwnedKeys).toHaveBeenCalledWith([
      { domain: ".flush-rejects.com", name: "sid", path: "/" },
    ]);
    // The settle sleep after the flush still runs, even though the flush
    // itself rejected.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(session.flushes).toBe(1);
  });
});
