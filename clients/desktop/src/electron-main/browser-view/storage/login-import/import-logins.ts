import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BrowserCookieKey } from "@traycer/protocol/host/browser/contracts";
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
  cookieKeyId,
  listBrowserSiteCookies,
  removeBrowserCookie,
  storageCookieKeyId,
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
 *    flushed once.** Replacing a site writes the source's cookies first and
 *    only then removes what the source did not carry (never the other way
 *    round, so a site whose every write fails is left as it was), and a
 *    removal the host heard about as `removedKeys` would evict that site
 *    from every live session. The one whole-jar capture main pushes
 *    afterwards says everything a dropped delta would have.
 *
 * And one boundary: a decrypted value exists between the `readValue` inside
 * the write loop and the `cookies.set` it feeds, never in a list.
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
  /**
   * The jar serializer's whole-jar barrier: no host-observed merge, per-site
   * clear or forget-all runs while the import writes, and a forget confirmed
   * mid-import waits for it rather than being marked complete under a write
   * that then puts the logins back. The signal is aborted when the barrier
   * gives the import up (its budget ran out) and is about to admit the work
   * queued behind it; the write loop reads it between rows and stops.
   */
  readonly serializeJarWrite: <T>(
    action: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly suppressDeltas: <T>(action: () => Promise<T>) => Promise<T>;
  /**
   * Hands the desktop ownership of the keys the import wrote. Ordinarily the
   * change observer does this on any local write (`onLocalCookieWrite`), but
   * the import writes under `suppressDeltas`, where the observer returns
   * before it gets there - so a key a host had seeded would stay host-owned
   * and that host's next observation could overwrite the value the user just
   * imported. Called INSIDE the barrier, after the mute lifts: a merge queued
   * behind the barrier runs the moment it opens, and it must find the keys
   * already the desktop's.
   */
  readonly releaseHostOwnedKeys: (
    keys: readonly BrowserCookieKey[],
  ) => Promise<void>;
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
      /** Records the reader could not make a row of; Safari's parser counts them. */
      readonly unreadable: number;
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

/** The import's tallies, mutated per site inside the suppressed write. */
interface WriteOutcome {
  importedSites: number;
  importedCookies: number;
  replacedSites: number;
  skippedInvalid: number;
  /** Every key written, for the ownership release that follows the write. */
  readonly writtenKeys: BrowserCookieKey[];
}

const localStateKeySchema = z.object({
  os_crypt: z.object({ encrypted_key: z.string() }),
});

/** One site's scan tally: its rows, and which key prefixes they carry. */
interface SiteTally {
  cookieCount: number;
  needsV10: boolean;
  needsV11: boolean;
}

/** What one successful scan listed, as the sets an import is checked against. */
interface ScannedSites {
  readonly sites: ReadonlySet<string>;
  /** The Google rows, importable only with `includeDeviceBound`. */
  readonly excluded: ReadonlySet<string>;
  /**
   * The keystore each listed site was shown to need. An import may open only
   * a keystore some chosen site was scanned as needing: the Choose step
   * promised that prompt, and a site that gained an encrypted row since is a
   * source that changed under the user, not a prompt to spring on them.
   */
  readonly unlockBySite: ReadonlyMap<string, LoginImportUnlock | null>;
}

/** Which key prefixes a set of rows carries, for `unlockFor`. */
interface KeyNeeds {
  readonly needsV10: boolean;
  readonly needsV11: boolean;
}

function keyNeedsOf(candidates: readonly ImportCandidate[]): KeyNeeds {
  let needsV10 = false;
  let needsV11 = false;
  for (const candidate of candidates) {
    if (candidate.row.secret.kind !== "encrypted") continue;
    if (candidate.row.secret.version === "v10") needsV10 = true;
    else needsV11 = true;
  }
  return { needsV10, needsV11 };
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
          unlockBySite: new Map(
            [...scan.sites, ...scan.excluded].map((site) => [
              site.domain,
              site.unlock,
            ]),
          ),
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
    // The prompt the Choose step announced is the only prompt Import may
    // raise. A keystore no chosen site was scanned as needing means the
    // source changed since (a Linux site that was all `v10` gained a `v11`
    // row); the scan is dropped so the way back in is a fresh one. DPAPI is
    // exempt: it unseals silently, so there was nothing to announce.
    const needed = this.unlockFor(keyNeedsOf(candidates));
    if (
      needed !== null &&
      needed !== "windows-dpapi" &&
      ![...chosen].some((site) => allowed.unlockBySite.get(site) === needed)
    ) {
      this.scanned.delete(request.sourceId);
      return { status: "blocked", reason: "source-changed" };
    }
    const keys = await this.resolveKeys(read, candidates);
    if (!keys.ok) return { status: "blocked", reason: keys.reason };

    // Grouped as ROWS, still ciphertext: a value is decrypted inside the
    // write loop, immediately before its `cookies.set`, and is unreferenced
    // once that call returns. Materialising the plaintext jar up front would
    // keep every value alive through the other sites' writes, the flush and
    // the settle window.
    const bySite = new Map<string, ImportCandidate[]>();
    for (const candidate of candidates) {
      const siteRows = bySite.get(candidate.scope.site) ?? [];
      siteRows.push(candidate);
      bySite.set(candidate.scope.site, siteRows);
    }

    const session = this.deps.getDurableSession();
    // Under the serializer's barrier and, inside it, with the observer muted:
    // the barrier orders this write against every other jar mutation, and
    // the mute is what keeps the per-site removals from reaching the hosts.
    const written = await this.deps.serializeJarWrite(async (signal) => {
      const outcome = await this.deps.suppressDeltas(async () => {
        const tally: WriteOutcome = {
          importedSites: 0,
          importedCookies: 0,
          replacedSites: 0,
          skippedInvalid: 0,
          writtenKeys: [],
        };
        try {
          for (const [site, siteRows] of bySite) {
            await this.writeSite(
              site,
              siteRows,
              read,
              keys,
              nowSeconds,
              session,
              signal,
              tally,
            );
          }
        } finally {
          // On the failure path too: a removal Chromium reports on the
          // listener pipe after `remove()` resolved is what the settle window
          // absorbs, and a throw mid-site must not let the observer wake
          // before it has passed. The outer catch answers `blocked` and no
          // capture follows, so a removal that escaped here would reach the
          // host as `removedKeys` with nothing to reconcile it.
          try {
            await session.cookies.flushStore();
          } finally {
            await this.deps.sleep(this.deps.settleWindowMs);
          }
        }
        return tally;
      });
      // Still inside the barrier, so nothing queued behind it - a host's
      // observation of an OLDER value for one of these keys - can run before
      // the keys are the desktop's. Then the caller pushes the jar.
      await this.deps.releaseHostOwnedKeys(outcome.writtenKeys);
      return outcome;
    });
    log.info("[browser-view] imported browser logins", {
      browser: source.browser,
      sites: written.importedSites,
      cookies: written.importedCookies,
      replaced: written.replacedSites,
      skipped: written.skippedInvalid,
    });
    return {
      status: "imported",
      importedSites: written.importedSites,
      importedCookies: written.importedCookies,
      replacedSites: written.replacedSites,
      skippedInvalid: written.skippedInvalid,
    };
  }

  /**
   * One site's replacement, in the order that never leaves the site empty:
   *
   * 1. WRITE every row, decrypting each immediately before its `set`. Same
   *    key (name, domain scope, path) overwrites in place, which is what
   *    Chromium does for a sign-in.
   * 2. Nothing written means nothing touched: the slice the jar already held
   *    stays as it was, so a source whose every row Electron rejects (a
   *    hand-edited file with an invalid value) cannot sign the user out.
   * 3. Otherwise REMOVE what the source did not carry - the jar's cookies for
   *    the site whose key no written row re-set - so the slice is the
   *    source's, not a union of two sign-ins.
   * 4. Electron removes by `{url, name}`, which also catches a just-written
   *    cookie of the same NAME under a different scope or path. Any written
   *    row whose name a removal named is written once more, decrypted again
   *    rather than held.
   */
  private async writeSite(
    site: string,
    siteRows: readonly ImportCandidate[],
    read: SourceRead & { ok: true },
    keys: ChromiumKeys & { ok: true },
    nowSeconds: number,
    session: LoginImportJarSession,
    signal: AbortSignal,
    outcome: WriteOutcome,
  ): Promise<void> {
    throwIfBarrierExpired(signal);
    const previous = await listBrowserSiteCookies(site, session.cookies);
    const writtenKeyIds = new Set<string>();
    const writtenRows: ImportCandidate[] = [];
    for (const candidate of siteRows) {
      throwIfBarrierExpired(signal);
      const key = await this.writeRow(
        candidate,
        read,
        keys,
        nowSeconds,
        session,
      );
      if (key === null) {
        outcome.skippedInvalid += 1;
        continue;
      }
      writtenKeyIds.add(cookieKeyId(key));
      outcome.writtenKeys.push(key);
      writtenRows.push(candidate);
    }
    if (writtenRows.length === 0) return;
    outcome.importedSites += 1;
    outcome.importedCookies += writtenRows.length;
    if (previous.length > 0) outcome.replacedSites += 1;

    const stale = previous.filter(
      (cookie) => !writtenKeyIds.has(storageCookieKeyId(cookie)),
    );
    const removedNames = new Set(stale.map((cookie) => cookie.name));
    for (const cookie of stale) {
      throwIfBarrierExpired(signal);
      await removeBrowserCookie(cookie, session.cookies);
    }
    for (const candidate of writtenRows) {
      if (!removedNames.has(candidate.row.name)) continue;
      throwIfBarrierExpired(signal);
      const key = await this.writeRow(
        candidate,
        read,
        keys,
        nowSeconds,
        session,
      );
      if (key === null) {
        // Accepted a moment ago and refused now: counted as it stands.
        outcome.importedCookies -= 1;
        outcome.skippedInvalid += 1;
      }
    }
  }

  /**
   * Decrypt, normalise and `set` one row; answers the cookie's key. The
   * plaintext lives in this frame only. `null` is a row that could not be
   * read, would not normalise, or that Electron rejected - the rejection
   * names the cookie, so it is counted by the caller and dropped.
   */
  private async writeRow(
    candidate: ImportCandidate,
    read: SourceRead & { ok: true },
    keys: ChromiumKeys & { ok: true },
    nowSeconds: number,
    session: LoginImportJarSession,
  ): Promise<BrowserCookieKey | null> {
    const value = this.readValue(candidate.row, read, keys);
    const normalized =
      value === null
        ? null
        : normalizeImportCookie(candidate.row, value, nowSeconds);
    if (normalized === null) return null;
    try {
      await session.cookies.set(
        toElectronCookieSetDetails(toCookieSetDetails(normalized.cookie)),
      );
    } catch {
      return null;
    }
    return {
      domain: normalized.cookie.domain,
      name: normalized.cookie.name,
      path: normalized.cookie.path,
    };
  }

  private buildScan(
    sourceId: string,
    read: SourceRead & { ok: true },
  ): LoginImportScan {
    const nowSeconds = Math.floor(this.deps.now() / 1000);
    const sites = new Map<string, SiteTally>();
    const excluded = new Map<string, SiteTally>();
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
      // Tallied per SITE as well as for the whole scan: the prompt the Import
      // click raises depends on which sites are chosen - a plaintext-only
      // selection opens nothing, and the Google rows sit behind an opt-in -
      // so the dialog derives its explainer from the selection's sites.
      const group = isGoogleDeviceBoundDomain(scope.site) ? excluded : sites;
      const tally = group.get(scope.site) ?? {
        cookieCount: 0,
        needsV10: false,
        needsV11: false,
      };
      tally.cookieCount += 1;
      if (row.secret.kind === "encrypted") {
        if (row.secret.version === "v10") tally.needsV10 = true;
        else tally.needsV11 = true;
        needsV10 ||= tally.needsV10;
        needsV11 ||= tally.needsV11;
      }
      group.set(scope.site, tally);
    }
    return {
      sourceId,
      sites: [...sites]
        .map(([domain, tally]) => ({
          domain,
          cookieCount: tally.cookieCount,
          unlock: this.unlockFor(tally),
        }))
        .sort((left, right) => left.domain.localeCompare(right.domain)),
      excluded: [...excluded]
        .map(([domain, tally]) => ({
          domain,
          cookieCount: tally.cookieCount,
          unlock: this.unlockFor(tally),
          reason: "google-device-bound" as const,
        }))
        .sort((left, right) => left.domain.localeCompare(right.domain)),
      protectedCookieCount,
      partitionedCookieCount,
      unreadableCookieCount: read.unreadable,
      unlock: this.unlockFor({ needsV10, needsV11 }),
      blocked: null,
    };
  }

  /** Which keystore Import will open, from the rows' prefixes alone. */
  private unlockFor(needs: KeyNeeds): LoginImportUnlock | null {
    if (!needs.needsV10 && !needs.needsV11) return null;
    if (this.deps.platform === "darwin") return "macos-keychain";
    if (this.deps.platform === "win32") return "windows-dpapi";
    // Linux `v10` is the built-in `peanuts` key: no keyring is opened for it.
    return needs.needsV11 ? "linux-keyring" : null;
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
          unreadable: 0,
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
        return {
          ok: true,
          rows: snapshot.value,
          unreadable: 0,
          chromium: null,
        };
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
        const parsed = parseSafariBinaryCookies(bytes);
        return {
          ok: true,
          rows: parsed.rows,
          unreadable: parsed.malformed,
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
        return { ok: true, rows: parsed.rows, unreadable: 0, chromium: null };
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
    const { needsV10, needsV11 } = keyNeedsOf(candidates);
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

/**
 * The barrier gave this import up and is admitting the jar work queued
 * behind it: stop before the next mutation. The flush and settle window still
 * run (the write's `finally`), and the outer catch answers `blocked` for a
 * jar that was only partly written - the message never leaves this process,
 * `warn` logs only the error's name.
 */
function throwIfBarrierExpired(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("The jar barrier expired before the import finished");
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
    unreadableCookieCount: 0,
    unlock: null,
    blocked,
  };
}
