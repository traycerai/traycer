import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  LoginImportBlocked,
  LoginImportRequest,
  LoginImportResult,
  LoginImportScan,
  LoginImportSource,
  LoginImportUnlock,
} from "@traycer-clients/shared/platform/browser-view";
import { log } from "../../../app/logger";
import {
  removeBrowserSiteCookies,
  toCookieSetDetails,
  toElectronCookieSetDetails,
} from "../browser-storage-state";
import type { ChromiumImportBrowser } from "./chromium-browsers";
import { readChromiumCookieDatabase } from "./chromium-cookies";
import {
  CHROMIUM_HASH_PREFIX_META_VERSION,
  CHROMIUM_LINUX_BASIC_PASSPHRASE,
  CHROMIUM_PBKDF2_ITERATIONS,
  chromiumCbcKeyMaterial,
  decryptChromiumValue,
  type ChromiumKeyMaterial,
} from "./chromium-crypto";
import { parseCookieFile } from "./cookie-file";
import type { ImportCookieRow } from "./cookie-rows";
import { errnoCode } from "./errno-code";
import { readFirefoxCookieRows } from "./firefox-cookies";
import { isGoogleDeviceBoundDomain } from "./google-exclusion";
import {
  classifyImportCookie,
  normalizeImportCookie,
  type ImportCookieScope,
  type NormalizedImportCookie,
} from "./normalize";
import { parseSafariBinaryCookies } from "./safari-binarycookies";
import type { SecretReadResult } from "./secret-providers/secret-read-result";
import {
  describeCookieFileSource,
  discoverLoginImportSources,
  type DiscoveredLoginImportSource,
  type LoginImportDiscoveryEnvironment,
  type LoginImportSourceLocation,
} from "./sources";
import {
  sweepSqliteSnapshots,
  withSqliteSnapshot,
  type SqliteSnapshotFailure,
} from "./sqlite-snapshot";

/**
 * Orchestration of "Import logins from another browser": list, scan, import.
 *
 * Three rules hold everything below together:
 *
 * 1. **The scan never touches a keystore.** Every fact the Choose-sites step
 *    shows is plaintext in every source, so the only OS prompt fires on the
 *    Import click, after the dialog has said which one to expect.
 * 2. **Every failure is a result value.** A rejected invoke has its message
 *    logged at WARN and forwarded to Sentry, and a decrypted cookie, a
 *    profile path, or a keychain's answer must never travel that way. The
 *    service catches everything and reports a closed enum; the only thing it
 *    logs is an errno code.
 * 3. **The jar is written with the delta observer muted, per site, then
 *    flushed once.** Replacing a site removes its old cookies, and a removal
 *    the host heard about as `removedKeys` would evict that site from every
 *    live session. The one whole-jar capture main pushes afterwards says
 *    everything a dropped delta would have.
 */

/**
 * What the import wrote, which is everything except who took it afterwards.
 *
 * `notifiedHosts` is missing on purpose: the push to the hosts is a jar frame,
 * and those are sent from main - never from this service, which knows nothing
 * about streams, and never from a renderer. The IPC handler adds the count.
 * Derived from the renderer-facing result so the two cannot drift.
 */
export type LoginImportOutcome =
  | Omit<Extract<LoginImportResult, { status: "imported" }>, "notifiedHosts">
  | Extract<LoginImportResult, { status: "blocked" }>;

export interface LoginImportJarCookies {
  get(filter: CookiesGetFilter): Promise<Cookie[]>;
  set(details: CookiesSetDetails): Promise<void>;
  remove(url: string, name: string): Promise<void>;
  flushStore(): Promise<void>;
}

export interface LoginImportJarSession {
  readonly cookies: LoginImportJarCookies;
}

/** Each reaches an OS keystore; injected so the suites reach none. */
export interface LoginImportSecretProviders {
  readonly macosKeychain: (
    browser: ChromiumImportBrowser,
  ) => Promise<SecretReadResult>;
  readonly linuxSecretService: (
    browser: ChromiumImportBrowser,
  ) => Promise<SecretReadResult>;
  /** `Local State`'s `os_crypt.encrypted_key`, base64 as written. */
  readonly windowsDpapi: (encryptedKeyBase64: string) => Promise<Buffer | null>;
}

export interface LoginImportServiceDependencies extends LoginImportDiscoveryEnvironment {
  /** Private `0700` directory for SQLite snapshots; swept on every use. */
  readonly snapshotRoot: string;
  readonly readSaveLogins: () => boolean;
  /** The durable `persist:` jar, whatever the saved-logins pref says today. */
  readonly getDurableSession: () => LoginImportJarSession;
  readonly suppressDeltas: <T>(action: () => Promise<T>) => Promise<T>;
  /**
   * How long to keep the observer muted after the last write. Chromium can
   * deliver a `removed` event on the listener pipe after `remove()` has
   * resolved on the manager pipe; a key the import did not re-set would
   * otherwise survive the coalescer and evict the site.
   */
  readonly settleWindowMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly secrets: LoginImportSecretProviders;
  readonly now: () => number;
}

/**
 * A source id is a digest of its location: stable across re-listings and
 * windows (see `LoginImportService.register`), opaque to the renderer, and
 * different the moment a profile's jar moves (Chrome's `Cookies` →
 * `Network/Cookies`), which is exactly when an old scan must not be trusted.
 */
function sourceIdFor(location: LoginImportSourceLocation): string {
  let key: string;
  if (location.kind === "chromium") {
    key = `${location.kind}:${location.browser}:${location.cookiesPath}`;
  } else if (location.kind === "file") {
    key = `${location.kind}:${location.path}`;
  } else {
    key = `${location.kind}:${location.cookiesPath}`;
  }
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

type SourceRead =
  | {
      readonly ok: true;
      readonly rows: readonly ImportCookieRow[];
      readonly chromium: {
        readonly browser: ChromiumImportBrowser;
        readonly metaVersion: number;
        readonly localStatePath: string;
      } | null;
    }
  | { readonly ok: false; readonly blocked: LoginImportBlocked };

type ChromiumKeys =
  | {
      readonly ok: true;
      readonly v10: ChromiumKeyMaterial | null;
      readonly v11: ChromiumKeyMaterial | null;
    }
  | {
      readonly ok: false;
      readonly reason: "keychain-denied" | "keyring-unavailable";
    };

interface ImportCandidate {
  readonly row: ImportCookieRow;
  readonly scope: ImportCookieScope;
}

const localStateKeySchema = z.object({
  os_crypt: z.object({ encrypted_key: z.string() }),
});

/** What one successful scan listed, as the sets an import is checked against. */
interface ScannedSites {
  readonly sites: ReadonlySet<string>;
  /** The Google rows, importable only with `includeDeviceBound`. */
  readonly excluded: ReadonlySet<string>;
}

export class LoginImportService {
  private readonly sources = new Map<string, DiscoveredLoginImportSource>();
  /**
   * The sites each source's LAST successful scan listed, keyed by source id.
   * An import honours only domains in these sets: the renderer chooses from
   * what it was shown, never from the jar at large, and a site that appears
   * in the file between scan and import is not imported unseen. The
   * `excluded` (Google) set is honoured only with the request's explicit
   * opt-in. Dropped on a failed scan, and with its source when a re-listing
   * no longer finds it; a re-listing that still finds it keeps it.
   */
  private readonly scanned = new Map<string, ScannedSites>();
  /**
   * Scans and imports run one at a time: each takes a snapshot under the
   * same root and sweeps that root first, so two in flight would read each
   * other's files out from under them.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LoginImportServiceDependencies) {}

  async listSources(): Promise<readonly LoginImportSource[]> {
    return this.serialized(async () => {
      let discovered: readonly DiscoveredLoginImportSource[];
      try {
        discovered = await discoverLoginImportSources(this.deps);
      } catch (error) {
        this.warn("list", error);
        discovered = [];
      }
      // Picked files survive a re-listing: the user chose them in this
      // dialog, and the list re-runs whenever the sources query refetches.
      const files = [...this.sources.values()].filter(
        (source) => source.location.kind === "file",
      );
      const listed = [...discovered, ...files].map((source) =>
        this.register(source),
      );
      // Only a source that is no longer there is retired, with its scan: a
      // re-listing from another window must not invalidate a choice this
      // one is still making (see `register`).
      const live = new Set(listed.map((source) => source.id));
      for (const id of [...this.sources.keys()]) {
        if (live.has(id)) continue;
        this.sources.delete(id);
        this.scanned.delete(id);
      }
      return listed;
    });
  }

  /** A file the user just picked in the native dialog. */
  async registerFile(path: string): Promise<LoginImportSource> {
    return this.register(await describeCookieFileSource(path));
  }

  async scan(sourceId: string): Promise<LoginImportScan> {
    return this.serialized(async () => {
      this.scanned.delete(sourceId);
      try {
        const source = this.sources.get(sourceId);
        if (source === undefined) return blockedScan(sourceId, "unreadable");
        const read = await this.readSource(source.location);
        if (!read.ok) return blockedScan(sourceId, read.blocked);
        const scan = this.buildScan(sourceId, read);
        this.scanned.set(sourceId, {
          sites: new Set(scan.sites.map((site) => site.domain)),
          excluded: new Set(scan.excluded.map((site) => site.domain)),
        });
        return scan;
      } catch (error) {
        this.warn("scan", error);
        return blockedScan(sourceId, "unreadable");
      }
    });
  }

  async import(request: LoginImportRequest): Promise<LoginImportOutcome> {
    return this.serialized(async () => {
      try {
        return await this.importInner(request);
      } catch (error) {
        this.warn("import", error);
        return { status: "blocked", reason: "unreadable" };
      }
    });
  }

  private async importInner(
    request: LoginImportRequest,
  ): Promise<LoginImportOutcome> {
    // The import writes only the durable partition; with saving off that jar
    // is not the one the tiles are on, and its contents die at quit.
    if (!this.deps.readSaveLogins()) {
      return { status: "blocked", reason: "saved-logins-off" };
    }
    const source = this.sources.get(request.sourceId);
    // No scan on record means the renderer is asking for sites nobody was
    // shown; the dialog's Try again re-scans, which is the way back in.
    const allowed = this.scanned.get(request.sourceId);
    if (source === undefined || allowed === undefined) {
      return { status: "blocked", reason: "unreadable" };
    }
    // The renderer can name only what its scan listed. A Google domain is
    // listed under `excluded`, and is honoured only with the request's
    // explicit opt-in - so a renderer that constructed the request itself
    // still cannot import one behind a toggle the user left off.
    const chosen = new Set(
      request.domains
        .map((domain) => domain.trim().toLowerCase())
        .filter(
          (domain) =>
            allowed.sites.has(domain) ||
            (request.includeDeviceBound && allowed.excluded.has(domain)),
        ),
    );
    if (chosen.size === 0) {
      return {
        status: "imported",
        importedSites: 0,
        importedCookies: 0,
        replacedSites: 0,
        skippedInvalid: 0,
      };
    }
    const read = await this.readSource(source.location);
    if (!read.ok) return { status: "blocked", reason: read.blocked };
    const nowSeconds = Math.floor(this.deps.now() / 1000);
    const candidates: ImportCandidate[] = [];
    for (const row of read.rows) {
      if (row.partitioned || row.secret.kind === "protected") continue;
      const scope = classifyImportCookie(row, nowSeconds);
      if (scope === null || !chosen.has(scope.site)) continue;
      candidates.push({ row, scope });
    }
    const keys = await this.resolveKeys(read, candidates);
    if (!keys.ok) return { status: "blocked", reason: keys.reason };

    let skippedInvalid = 0;
    const bySite = new Map<string, NormalizedImportCookie[]>();
    for (const candidate of candidates) {
      const value = this.readValue(candidate.row, read, keys);
      const normalized =
        value === null
          ? null
          : normalizeImportCookie(candidate.row, value, nowSeconds);
      if (normalized === null) {
        skippedInvalid += 1;
        continue;
      }
      const siteCookies = bySite.get(normalized.site) ?? [];
      siteCookies.push(normalized);
      bySite.set(normalized.site, siteCookies);
    }

    const session = this.deps.getDurableSession();
    const written = await this.deps.suppressDeltas(async () => {
      let importedSites = 0;
      let importedCookies = 0;
      let replacedSites = 0;
      // Only a site with something to write is replaced: clearing a chosen
      // site whose every cookie failed would sign the user out of it with
      // nothing to show for it.
      for (const [site, siteCookies] of bySite) {
        const removed = await removeBrowserSiteCookies(site, session.cookies);
        if (removed > 0) replacedSites += 1;
        let siteWritten = 0;
        for (const entry of siteCookies) {
          try {
            await session.cookies.set(
              toElectronCookieSetDetails(toCookieSetDetails(entry.cookie)),
            );
            siteWritten += 1;
          } catch {
            // The rejection names the cookie; it is counted and dropped.
            skippedInvalid += 1;
          }
        }
        if (siteWritten > 0) importedSites += 1;
        importedCookies += siteWritten;
      }
      await session.cookies.flushStore();
      await this.deps.sleep(this.deps.settleWindowMs);
      return { importedSites, importedCookies, replacedSites };
    });
    log.info("[browser-view] imported browser logins", {
      browser: source.browser,
      sites: written.importedSites,
      cookies: written.importedCookies,
      replaced: written.replacedSites,
      skipped: skippedInvalid,
    });
    return { status: "imported", ...written, skippedInvalid };
  }

  private buildScan(
    sourceId: string,
    read: SourceRead & { ok: true },
  ): LoginImportScan {
    const nowSeconds = Math.floor(this.deps.now() / 1000);
    const sites = new Map<string, number>();
    const excluded = new Map<string, number>();
    let protectedCookieCount = 0;
    let partitionedCookieCount = 0;
    let needsV10 = false;
    let needsV11 = false;
    for (const row of read.rows) {
      if (row.partitioned) {
        partitionedCookieCount += 1;
        continue;
      }
      if (row.secret.kind === "protected") {
        protectedCookieCount += 1;
        continue;
      }
      const scope = classifyImportCookie(row, nowSeconds);
      if (scope === null) continue;
      // Counted before the Google split: an import of Google rows alone,
      // opted into, opens the same keystore, so `unlock` must say so.
      if (row.secret.kind === "encrypted") {
        if (row.secret.version === "v10") needsV10 = true;
        else needsV11 = true;
      }
      if (isGoogleDeviceBoundDomain(scope.site)) {
        excluded.set(scope.site, (excluded.get(scope.site) ?? 0) + 1);
        continue;
      }
      sites.set(scope.site, (sites.get(scope.site) ?? 0) + 1);
    }
    return {
      sourceId,
      sites: [...sites]
        .map(([domain, cookieCount]) => ({ domain, cookieCount }))
        .sort((left, right) => left.domain.localeCompare(right.domain)),
      excluded: [...excluded]
        .map(([domain, cookieCount]) => ({
          domain,
          cookieCount,
          reason: "google-device-bound" as const,
        }))
        .sort((left, right) => left.domain.localeCompare(right.domain)),
      protectedCookieCount,
      partitionedCookieCount,
      unlock: this.unlockFor(needsV10, needsV11),
      blocked: null,
    };
  }

  /** Which keystore Import will open, from the rows' prefixes alone. */
  private unlockFor(
    needsV10: boolean,
    needsV11: boolean,
  ): LoginImportUnlock | null {
    if (!needsV10 && !needsV11) return null;
    if (this.deps.platform === "darwin") return "macos-keychain";
    if (this.deps.platform === "win32") return "windows-dpapi";
    // Linux `v10` is the built-in `peanuts` key: no keyring is opened for it.
    return needsV11 ? "linux-keyring" : null;
  }

  private async readSource(
    location: LoginImportSourceLocation,
  ): Promise<SourceRead> {
    switch (location.kind) {
      case "chromium": {
        await sweepSqliteSnapshots(this.deps.snapshotRoot);
        const snapshot = await withSqliteSnapshot(
          {
            sourcePath: location.cookiesPath,
            snapshotRoot: this.deps.snapshotRoot,
            platform: this.deps.platform,
          },
          readChromiumCookieDatabase,
        );
        if (!snapshot.ok)
          return { ok: false, blocked: blockedFor(snapshot.reason) };
        return {
          ok: true,
          rows: snapshot.value.rows,
          chromium: {
            browser: location.browser,
            metaVersion: snapshot.value.metaVersion,
            localStatePath: location.localStatePath,
          },
        };
      }
      case "firefox": {
        await sweepSqliteSnapshots(this.deps.snapshotRoot);
        const snapshot = await withSqliteSnapshot(
          {
            sourcePath: location.cookiesPath,
            snapshotRoot: this.deps.snapshotRoot,
            platform: this.deps.platform,
          },
          readFirefoxCookieRows,
        );
        if (!snapshot.ok)
          return { ok: false, blocked: blockedFor(snapshot.reason) };
        return { ok: true, rows: snapshot.value, chromium: null };
      }
      case "safari": {
        let bytes: Buffer;
        try {
          bytes = await readFile(location.cookiesPath);
        } catch (error) {
          const code = errnoCode(error);
          return {
            ok: false,
            blocked:
              code === "EPERM" || code === "EACCES"
                ? "needs-full-disk-access"
                : "unreadable",
          };
        }
        return {
          ok: true,
          rows: parseSafariBinaryCookies(bytes).rows,
          chromium: null,
        };
      }
      case "file": {
        let text: string;
        try {
          text = await readFile(location.path, "utf8");
        } catch {
          return { ok: false, blocked: "unreadable" };
        }
        const parsed = parseCookieFile(text);
        if (!parsed.ok) return { ok: false, blocked: "unreadable" };
        return { ok: true, rows: parsed.rows, chromium: null };
      }
    }
  }

  /**
   * The keystore reads, and only the ones this selection needs: a jar whose
   * chosen rows are all plaintext raises no prompt at all.
   */
  private async resolveKeys(
    read: SourceRead & { ok: true },
    candidates: readonly ImportCandidate[],
  ): Promise<ChromiumKeys> {
    let needsV10 = false;
    let needsV11 = false;
    for (const candidate of candidates) {
      if (candidate.row.secret.kind !== "encrypted") continue;
      if (candidate.row.secret.version === "v10") needsV10 = true;
      else needsV11 = true;
    }
    if (!needsV10 && !needsV11) return { ok: true, v10: null, v11: null };
    if (read.chromium === null) return { ok: true, v10: null, v11: null };
    const browser = read.chromium.browser;
    switch (this.deps.platform) {
      case "darwin": {
        const secret = await this.deps.secrets.macosKeychain(browser);
        if (!secret.ok) {
          return {
            ok: false,
            reason:
              secret.reason === "denied"
                ? "keychain-denied"
                : "keyring-unavailable",
          };
        }
        const material = chromiumCbcKeyMaterial(
          secret.secret,
          CHROMIUM_PBKDF2_ITERATIONS.darwin,
        );
        return { ok: true, v10: material, v11: material };
      }
      case "linux": {
        const v10 = chromiumCbcKeyMaterial(
          CHROMIUM_LINUX_BASIC_PASSPHRASE,
          CHROMIUM_PBKDF2_ITERATIONS.linux,
        );
        if (!needsV11) return { ok: true, v10, v11: null };
        const secret = await this.deps.secrets.linuxSecretService(browser);
        if (!secret.ok) return { ok: false, reason: "keyring-unavailable" };
        return {
          ok: true,
          v10,
          v11: chromiumCbcKeyMaterial(
            secret.secret,
            CHROMIUM_PBKDF2_ITERATIONS.linux,
          ),
        };
      }
      case "win32": {
        const encryptedKey = await this.readWindowsEncryptedKey(
          read.chromium.localStatePath,
        );
        if (encryptedKey === null) {
          return { ok: false, reason: "keyring-unavailable" };
        }
        const key = await this.deps.secrets.windowsDpapi(encryptedKey);
        if (key === null) return { ok: false, reason: "keyring-unavailable" };
        return { ok: true, v10: { kind: "gcm", key }, v11: null };
      }
      default:
        return { ok: false, reason: "keyring-unavailable" };
    }
  }

  private async readWindowsEncryptedKey(
    localStatePath: string,
  ): Promise<string | null> {
    try {
      const parsed = localStateKeySchema.safeParse(
        JSON.parse(await readFile(localStatePath, "utf8")),
      );
      return parsed.success ? parsed.data.os_crypt.encrypted_key : null;
    } catch {
      return null;
    }
  }

  private readValue(
    row: ImportCookieRow,
    read: SourceRead & { ok: true },
    keys: ChromiumKeys & { ok: true },
  ): string | null {
    const secret = row.secret;
    if (secret.kind === "plain") return secret.value;
    if (secret.kind === "protected" || read.chromium === null) return null;
    const material = secret.version === "v10" ? keys.v10 : keys.v11;
    if (material === null) return null;
    return decryptChromiumValue(secret.bytes, material, {
      hashPrefix:
        read.chromium.metaVersion >= CHROMIUM_HASH_PREFIX_META_VERSION,
      hostKey: row.domain,
    });
  }

  /**
   * Registers under an id derived from WHERE the source is, so re-listing
   * hands every window the same id for the same profile and a scan on record
   * survives. The service is one per main process and Settings can be open
   * in two windows at once: with minted ids, the second window's listing
   * would have retired the first window's ids and its scan mid-choice. The
   * id is a digest, not the path, so the renderer still never learns one.
   */
  private register(source: DiscoveredLoginImportSource): LoginImportSource {
    const id = sourceIdFor(source.location);
    this.sources.set(id, source);
    return {
      id,
      browser: source.browser,
      profileLabel: source.profileLabel,
      lastUsedAt: source.lastUsedAt,
    };
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** An errno code and the stage, nothing else: no path, no message. */
  private warn(stage: "list" | "scan" | "import", error: unknown): void {
    log.warn("[browser-view] login import failed", {
      stage,
      code:
        errnoCode(error) ?? (error instanceof Error ? error.name : "unknown"),
    });
  }
}

function blockedFor(reason: SqliteSnapshotFailure): LoginImportBlocked {
  if (reason === "locked") return "browser-locked";
  return "unreadable";
}

function blockedScan(
  sourceId: string,
  blocked: LoginImportBlocked,
): LoginImportScan {
  return {
    sourceId,
    sites: [],
    excluded: [],
    protectedCookieCount: 0,
    partitionedCookieCount: 0,
    unlock: null,
    blocked,
  };
}
