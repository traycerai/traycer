import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CHROMIUM_LINUX_BASIC_PASSPHRASE,
  CHROMIUM_PBKDF2_ITERATIONS,
} from "../chromium-crypto";
import type { ChromiumImportBrowser } from "../chromium-browsers";
import {
  LoginImportService,
  type LoginImportJarCookies,
  type LoginImportJarSession,
  type LoginImportOutcome,
  type LoginImportSecretProviders,
  type LoginImportServiceDependencies,
} from "../import-logins";
import type { SecretReadResult } from "../secret-providers/secret-read-result";
import type { LoginImportScan } from "@traycer-clients/shared/platform/browser-view";
import { matchesDomainFilter } from "../../__tests__/cookie-jar-fixture";

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
  private rejectSetName: string | null = null;

  constructor(initial: readonly Cookie[]) {
    this.jar.push(...initial);
  }

  rejectSet(name: string): void {
    this.rejectSetName = name;
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
      if (details.name === this.rejectSetName) {
        return Promise.reject(new Error("cookies.set rejected"));
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
      const host = new URL(url).hostname;
      const index = this.jar.findIndex(
        (cookie) =>
          cookie.name === name &&
          matchesDomainFilter(cookie.domain ?? "", host),
      );
      if (index !== -1) this.jar.splice(index, 1);
      return Promise.resolve();
    },
    flushStore: (): Promise<void> => {
      this.flushes += 1;
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
}

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
  const deps: LoginImportServiceDependencies = {
    platform: "darwin",
    homeDir: "/unused-home",
    env: {},
    snapshotRoot: "/unused-snapshot-root",
    readSaveLogins: () => true,
    getDurableSession: () => session,
    suppressDeltas: async (action) => action(),
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
      { domain: "secure-site.com", cookieCount: 1 },
      { domain: "site-one.com", cookieCount: 2 },
    ]);
    expect(scan.excluded).toEqual([
      { domain: "google.com", cookieCount: 1, reason: "google-device-bound" },
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
      { domain: "google.com", cookieCount: 1, reason: "google-device-bound" },
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
    expect(scan.sites).toEqual([{ domain: "relist-site.com", cookieCount: 1 }]);

    // The service is one per main process: a second window opening Settings
    // re-lists while this window is still choosing. The profile is still
    // there, so it keeps its id and the scan on record, and the import the
    // first window sends afterwards goes through.
    const relisted = await service.listSources();
    expect(relisted.map((source) => source.id)).toContain(sourceId);

    const result = await service.import({
      sourceId,
      domains: ["relist-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 0,
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
    const { sourceId } = await scanChromeSource(service);

    // The profile's jar is gone by the time anyone re-lists (the browser was
    // uninstalled, the profile deleted): the id is not handed out again and
    // an import against it is refused rather than served from memory.
    await rm(cookiesPath, { force: true });
    const relisted = await service.listSources();
    expect(relisted.map((source) => source.id)).not.toContain(sourceId);

    const result = await service.import({
      sourceId,
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
    const { sourceId } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      domains: ["domain-a.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 2,
      replacedSites: 1,
      skippedInvalid: 0,
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
    const { sourceId } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      domains: ["broken-site.com", "good-site.com"],
      includeDeviceBound: false,
    });

    if (result.status !== "imported") throw new Error("expected imported");
    expect(result.importedSites).toBe(1);
    expect(result.skippedInvalid).toBe(1);
    // The broken domain's pre-existing cookie survives: nothing was written
    // for it, so `import-logins.ts` never calls `removeBrowserSiteCookies`.
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
    const { sourceId } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
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
    const { sourceId } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
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
    const { sourceId } = await scanChromeSource(service);

    // A brand-new domain lands in the live jar after the scan ran.
    appendChromiumCookieRow(
      cookiesPath,
      domainCookieRow(".unscanned.com", "sid", { kind: "plain", value: "u" }),
    );

    const result = await service.import({
      sourceId,
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
    const { sourceId } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
      domains: ["reject-site.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 1,
      importedCookies: 1,
      replacedSites: 0,
      skippedInvalid: 1,
    });
    expect(session.names()).toEqual(["good"]);
    expect(session.flushes).toBe(1);
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
    const { sourceId } = await scanChromeSource(service);
    const outcome = await service.import({
      sourceId,
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
    const { sourceId } = await scanChromeSource(service);

    const result = await service.import({
      sourceId,
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
    expect(scan.sites).toEqual([{ domain: "steady.com", cookieCount: 1 }]);

    // A cookie for a brand-new site lands in the live jar after the scan
    // ran but before the user clicks Import.
    appendChromiumCookieRow(
      cookiesPath,
      domainCookieRow(".late.com", "sid", { kind: "plain", value: "late" }),
    );

    const result = await service.import({
      sourceId,
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
      { domain: "scanned-site.com", cookieCount: 1 },
    ]);

    // If the import fell through to reading the source anyway, this would
    // turn the read into a failure (or a thrown error the outer catch would
    // still have to convert to "unreadable") - either way NOT the all-zero
    // "imported" result asserted below. Its absence is the proof that the
    // scanned-set filter short-circuits before any read.
    await rm(cookiesPath, { force: true });

    const result = await service.import({
      sourceId,
      domains: ["not-in-the-scan.com"],
      includeDeviceBound: false,
    });

    expect(result).toEqual({
      status: "imported",
      importedSites: 0,
      importedCookies: 0,
      replacedSites: 0,
      skippedInvalid: 0,
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
      sites: [],
      excluded: [],
      protectedCookieCount: 0,
      partitionedCookieCount: 0,
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
    const { sourceId } = await scanChromeSource(service);

    const pending = service.import({
      sourceId,
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
    const { sourceId } = await scanChromeSource(service);

    // Both calls target the SAME source and domain; the two writes are
    // distinguished purely by ordering (this is the same service instance,
    // so both share the internal `queue`).
    const pendingA = service.import({
      sourceId,
      domains: ["serial-site.com"],
      includeDeviceBound: false,
    });
    const pendingB = service.import({
      sourceId,
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
