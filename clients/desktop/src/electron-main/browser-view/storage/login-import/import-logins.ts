import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  BROWSER_FORGET_LEDGER_MAX_DOMAINS,
  type BrowserCookieKey,
} from "@traycer/protocol/host/browser/contracts";
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
import {
  MAX_LOGIN_IMPORT_FILE_BYTES,
  readBoundedFile,
  type BoundedFileRead,
} from "./bounded-file";
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
 * Three rules hold everything below together: 1. The scan never touches a keystore. Every fact the Choose-sites step shows is plaintext in every source, so the only OS prompt fires.
 * 2. Every failure is a result value. A rejected invoke has its message logged at WARN and forwarded to Sentry, and a decrypted cookie, a profile path, or a keychain's answer must.
 */

/** The push to the hosts is a jar frame, sent from main and never from a renderer. */
export type LoginImportOutcome = LoginImportResult;

export interface LoginImportJarCookies {
  get(filter: CookiesGetFilter): Promise<Cookie[]>;
  set(details: CookiesSetDetails): Promise<void>;
  remove(url: string, name: string): Promise<void>;
  flushStore(): Promise<void>;
}

export interface LoginImportJarSession {
  readonly cookies: LoginImportJarCookies;
}

/** What main's confirmation dialog names: the registered source (never the renderer's word for it) and how many sites the request validated to. */
export interface LoginImportSummary {
  readonly browser: LoginImportSource["browser"];
  readonly profileLabel: string;
  readonly siteCount: number;
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
  readonly serializeJarWrite: <T>(
    action: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly suppressDeltas: <T>(action: () => Promise<T>) => Promise<T>;
  readonly clearSiteLocalStorage: (
    site: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * The forget ledger's record that ONE site is being REPLACED, taken immediately before the first cookie that site removes, and answering the ledger revision it made (`null` when it.
   * Per site and at that moment, never for the batch up front: it is the removals it covers, so a site that removes nothing - every row refused, or every jar cookie carried.
   */
  readonly recordReplacedSite: (site: string) => Promise<number | null>;
  readonly markReplacementCleared: (
    revisions: readonly number[],
  ) => Promise<void>;
  /** Ended in the write's `finally`, BEFORE the push, so a host prunes and then takes the capture. */
  readonly deferLedgerDigests: () => { readonly end: () => void };
  /**
   * The push of the jar to every host, INSIDE the barrier, after the mute has lifted and the written keys are the desktop's.
   * Answers how many hosts acked the jar; never rejects.
   */
  readonly pushJarToHosts: () => Promise<number>;
  /** The renderer may ASK; a native dialog it cannot draw over or dismiss is what turns the ask into a decision. */
  readonly confirmImport: (summary: LoginImportSummary) => Promise<boolean>;
  /** Called INSIDE the barrier, after the mute lifts: a merge queued behind the barrier runs the moment it opens, and it must find the keys already the desktop's. */
  readonly releaseHostOwnedKeys: (
    keys: readonly BrowserCookieKey[],
  ) => Promise<void>;
  /** How long to keep the observer muted after the last write. */
  readonly settleWindowMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly secrets: LoginImportSecretProviders;
  readonly now: () => number;
}

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

/** What the barrier hands back: the tallies, or why nothing was written - the source could not be read, changed since the scan, the keystore refused, or saving is off. */
type ImportWrite =
  | {
      readonly ok: true;
      readonly outcome: WriteOutcome;
      readonly notifiedHosts: number;
    }
  | {
      readonly ok: false;
      readonly reason: Extract<
        LoginImportResult,
        { readonly status: "blocked" }
      >["reason"];
    };

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
  readonly sourceId: string;
  readonly sites: ReadonlySet<string>;
  /** The Google rows, importable only with `includeDeviceBound`. */
  readonly excluded: ReadonlySet<string>;
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

export const RETAINED_SCAN_LIMIT = 16;

/** A scan token: random, opaque, and no function of the source or the jar. */
function mintScanId(): string {
  return randomBytes(16).toString("hex");
}

export class LoginImportService {
  private readonly sources = new Map<string, DiscoveredLoginImportSource>();
  /** An import quotes the token of the scan its window rendered and honours only domains in THAT scan's sets: the renderer chooses from what it was shown, never from the jar at large. */
  private readonly scanned = new Map<string, ScannedSites>();
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
        this.dropScansOf(id);
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
      const scanId = mintScanId();
      try {
        const source = this.sources.get(sourceId);
        if (source === undefined) {
          return blockedScan(sourceId, scanId, "unreadable");
        }
        const read = await this.readSource(source.location);
        if (!read.ok) return blockedScan(sourceId, scanId, read.blocked);
        const scan = this.buildScan(sourceId, scanId, read);
        // Another window's scan of the same source stays: it is still the
        // list that window is choosing from. Only the oldest overall goes.
        while (this.scanned.size >= RETAINED_SCAN_LIMIT) {
          const oldest = this.scanned.keys().next();
          if (oldest.done) break;
          this.scanned.delete(oldest.value);
        }
        this.scanned.set(scanId, {
          sourceId,
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
        return blockedScan(sourceId, scanId, "unreadable");
      }
    });
  }

  private dropScansOf(sourceId: string): void {
    for (const [scanId, scan] of [...this.scanned]) {
      if (scan.sourceId === sourceId) this.scanned.delete(scanId);
    }
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
    // No scan on record under this token - or one taken of another source -
    // means the renderer is asking for sites nobody was shown; the dialog's
    // Try again re-scans, which is the way back in.
    const allowed = this.scanned.get(request.scanId);
    if (
      source === undefined ||
      allowed === undefined ||
      allowed.sourceId !== request.sourceId
    ) {
      return { status: "blocked", reason: "unreadable" };
    }
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
        notifiedHosts: 0,
      };
    }
    // Main's decision, after validation and before the first read: the copy
    // names the REGISTERED source and the validated count, never anything
    // the renderer sent.
    const confirmed = await this.deps.confirmImport({
      browser: source.browser,
      profileLabel: source.profileLabel,
      siteCount: chosen.size,
    });
    if (!confirmed) {
      log.info("[browser-view] login import was not confirmed");
      return { status: "cancelled" };
    }
    const session = this.deps.getDurableSession();
    const written = await this.deps.serializeJarWrite(
      async (signal): Promise<ImportWrite> => {
        // The pref first, inside the barrier the toggle itself takes, so it cannot change under anything below: a window that turned saving off while this import sat on the confirmation has.
        if (!this.deps.readSaveLogins()) {
          return { ok: false, reason: "saved-logins-off" };
        }
        const read = await this.readSource(source.location);
        if (!read.ok) return { ok: false, reason: read.blocked };
        const nowSeconds = Math.floor(this.deps.now() / 1000);
        const candidates: ImportCandidate[] = [];
        // Every key the source HOLDS for a chosen site, whether or not this reader can open the row: a row this desktop cannot decrypt (an app-bound `v20`) or must not write (a partitioned.
        const carriedBySite = new Map<string, Set<string>>();
        // And every NAME the source holds for a chosen site, from the same
        // rows: the by-name keep in `writeSite` step 3 is about what the
        // source has a cookie called, whether or not this reader opens it.
        const namesBySite = new Map<string, Set<string>>();
        for (const row of read.rows) {
          const scope = classifyImportCookie(row, nowSeconds);
          if (scope === null || !chosen.has(scope.site)) continue;
          const carried = carriedBySite.get(scope.site) ?? new Set<string>();
          carried.add(
            cookieKeyId({
              domain: scope.domain,
              name: row.name,
              path: scope.path,
            }),
          );
          carriedBySite.set(scope.site, carried);
          const names = namesBySite.get(scope.site) ?? new Set<string>();
          names.add(row.name);
          namesBySite.set(scope.site, names);
          if (row.partitioned || row.secret.kind === "protected") continue;
          candidates.push({ row, scope });
        }
        const needed = this.unlockFor(keyNeedsOf(candidates));
        if (
          needed !== null &&
          needed !== "windows-dpapi" &&
          ![...chosen].some((site) => allowed.unlockBySite.get(site) === needed)
        ) {
          this.scanned.delete(request.scanId);
          return { ok: false, reason: "source-changed" };
        }

        const bySite = new Map<string, ImportCandidate[]>();
        for (const candidate of candidates) {
          const siteRows = bySite.get(candidate.scope.site) ?? [];
          siteRows.push(candidate);
          bySite.set(candidate.scope.site, siteRows);
        }
        // Every site the write touches goes into the forget ledger under one revision, and the ledger keeps that many domains: a batch past it would be TRIMMED, and a trimmed scope never.
        // Refused here, before the keystore is opened or a cookie moves.
        if (bySite.size > BROWSER_FORGET_LEDGER_MAX_DOMAINS) {
          return { ok: false, reason: "too-many-sites" };
        }

        const keys = await this.resolveKeys(read, candidates);
        if (!keys.ok) return { ok: false, reason: keys.reason };
        // A read or a prompt the user sat on past the budget: the barrier
        // has moved on, so not one row is written, and no mute or settle
        // window is spent.
        throwIfBarrierExpired(signal);
        const tally: WriteOutcome = {
          importedSites: 0,
          importedCookies: 0,
          replacedSites: 0,
          skippedInvalid: 0,
          writtenKeys: [],
        };
        // One revision per site, taken by that site as it reaches its removals, so the ledger never names a site the write did not reach - and none at all for an import that removes nothing.
        const ledger: { readonly revisions: number[] } = { revisions: [] };
        const recordReplacement = async (site: string): Promise<void> => {
          const revision = await this.deps.recordReplacedSite(site);
          if (revision !== null) ledger.revisions.push(revision);
        };
        const digests = this.deps.deferLedgerDigests();
        // What ended the write early, if anything: a row past the barrier's
        // budget, a removal Chromium refused, a localStorage clear that
        // failed. Never re-thrown once a key is in the jar - see below.
        const ending: { failure: { readonly error: unknown } | null } = {
          failure: null,
        };
        try {
          await this.deps.suppressDeltas(async () => {
            try {
              for (const [site, siteRows] of bySite) {
                await this.writeSite(
                  site,
                  siteRows,
                  carriedBySite.get(site) ?? new Set<string>(),
                  namesBySite.get(site) ?? new Set<string>(),
                  read,
                  keys,
                  nowSeconds,
                  session,
                  signal,
                  recordReplacement,
                  tally,
                );
              }
            } catch (error) {
              ending.failure = { error };
            } finally {
              try {
                await session.cookies.flushStore();
              } catch (error) {
                // A flush refused is a write that ended after its cookies
                // reached the in-process jar: answered like any other such
                // ending below, and pushed, not thrown past the push.
                if (ending.failure === null) ending.failure = { error };
              } finally {
                await this.deps.sleep(this.deps.settleWindowMs);
              }
            }
          });
        } finally {
          try {
            digests.end();
          } finally {
            try {
              if (ledger.revisions.length > 0) {
                await this.deps.markReplacementCleared(ledger.revisions);
              }
            } finally {
              await this.deps.releaseHostOwnedKeys(tally.writtenKeys);
            }
          }
        }
        const jarTouched =
          tally.writtenKeys.length > 0 || ledger.revisions.length > 0;
        if (!jarTouched) {
          if (ending.failure !== null) throw ending.failure.error;
          return { ok: true, outcome: tally, notifiedHosts: 0 };
        }
        // Pushed whatever ended the write, and still inside the barrier - see
        // `pushJarToHosts`.
        const notifiedHosts = await this.deps.pushJarToHosts();
        if (tally.writtenKeys.length === 0) {
          // Touched and pushed, but nothing of the import's remains in the
          // jar: what stopped it is the whole answer, as above.
          if (ending.failure !== null) throw ending.failure.error;
          return { ok: true, outcome: tally, notifiedHosts };
        }
        if (ending.failure !== null) {
          this.warn("import-incomplete", ending.failure.error);
          return { ok: false, reason: "incomplete" };
        }
        return { ok: true, outcome: tally, notifiedHosts };
      },
    );
    if (!written.ok) return { status: "blocked", reason: written.reason };
    log.info("[browser-view] imported browser logins", {
      browser: source.browser,
      sites: written.outcome.importedSites,
      cookies: written.outcome.importedCookies,
      replaced: written.outcome.replacedSites,
      skipped: written.outcome.skippedInvalid,
      notifiedHosts: written.notifiedHosts,
    });
    return {
      status: "imported",
      importedSites: written.outcome.importedSites,
      importedCookies: written.outcome.importedCookies,
      replacedSites: written.outcome.replacedSites,
      skippedInvalid: written.outcome.skippedInvalid,
      notifiedHosts: written.notifiedHosts,
    };
  }

  /**
   * One site's replacement, in the order that never leaves the site empty: 1. WRITE every row, decrypting each immediately before its `set`.
   * 2. Nothing written means nothing touched: the slice the jar already held stays as it was, so a source whose every row Electron rejects (a hand-edited file with an invalid value).
   */
  private async writeSite(
    site: string,
    siteRows: readonly ImportCandidate[],
    carriedKeyIds: ReadonlySet<string>,
    // Every NAME the source holds for this site, from the same rows - the candidates' and the ones this reader never opens.
    sourceNames: ReadonlySet<string>,
    read: SourceRead & { ok: true },
    keys: ChromiumKeys & { ok: true },
    nowSeconds: number,
    session: LoginImportJarSession,
    signal: AbortSignal,
    // This site's forget-ledger record, taken here as the site reaches its
    // removals - and only then, so a site the write never reaches is never
    // in the ledger.
    recordReplacement: (site: string) => Promise<void>,
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
      // Counted as each lands, not once the site is through: an import the
      // barrier gives up on mid-site has put these in the jar, and the
      // count it answers with - and the push that follows - must say so.
      if (writtenRows.length === 0) {
        outcome.importedSites += 1;
        if (previous.length > 0) outcome.replacedSites += 1;
      }
      outcome.importedCookies += 1;
      writtenKeyIds.add(cookieKeyId(key));
      outcome.writtenKeys.push(key);
      writtenRows.push(candidate);
    }
    if (writtenRows.length === 0) return;

    const orphaned = (name: string): boolean =>
      sourceNames.has(name) &&
      !writtenRows.some(
        (candidate) =>
          candidate.row.name === name &&
          writtenKeyIds.has(candidateKeyId(candidate)),
      );
    const stale = previous.filter(
      (cookie) =>
        !carriedKeyIds.has(storageCookieKeyId(cookie)) &&
        !orphaned(cookie.name),
    );
    const removedNames = new Set<string>();
    let removalFailure: { readonly error: unknown } | null = null;
    // Recorded before the first `remove`, never after: a removal the ledger
    // does not yet cover is one a host's in-flight observation can undo.
    if (stale.length > 0) await recordReplacement(site);
    for (const cookie of stale) {
      if (signal.aborted) {
        if (removalFailure === null) {
          removalFailure = { error: barrierExpiredError() };
        }
        break;
      }
      removedNames.add(cookie.name);
      try {
        await removeBrowserCookie(cookie, session.cookies);
      } catch (error) {
        if (removalFailure === null) removalFailure = { error };
      }
    }
    for (const candidate of writtenRows) {
      if (!removedNames.has(candidate.row.name)) continue;
      const key = await this.writeRow(
        candidate,
        read,
        keys,
        nowSeconds,
        session,
      );
      if (key === null) {
        outcome.importedCookies -= 1;
        outcome.skippedInvalid += 1;
        const refusedKeyId = candidateKeyId(candidate);
        writtenKeyIds.delete(refusedKeyId);
        const index = outcome.writtenKeys.findIndex(
          (written) => cookieKeyId(written) === refusedKeyId,
        );
        if (index !== -1) outcome.writtenKeys.splice(index, 1);
      }
    }
    const nothingLanded = writtenKeyIds.size === 0;
    if (nothingLanded) {
      outcome.importedSites -= 1;
      if (previous.length > 0) outcome.replacedSites -= 1;
    }
    for (const cookie of previous) {
      const id = storageCookieKeyId(cookie);
      if (writtenKeyIds.has(id) || !removedNames.has(cookie.name)) continue;
      if (!nothingLanded && !carriedKeyIds.has(id) && !orphaned(cookie.name)) {
        continue;
      }
      try {
        await session.cookies.set(
          toElectronCookieSetDetails(toCookieSetDetails(cookie)),
        );
      } catch {
        // The jar held it a moment ago and refuses it now; nothing else to
        // put in its place, and the count already carries the failed row.
      }
    }
    // A removal that failed leaves the slice a union of two sign-ins, not the
    // source's: reported, now that the cookies the removals reached are back,
    // and without the localStorage clear a whole slice would earn.
    if (removalFailure !== null) throw removalFailure.error;
    if (nothingLanded) return;
    // LAST, once the cookie slice is whole again: a clear that fails throws
    // out of a site whose cookies are already the source's, not one whose
    // same-name removals have not been put back yet.
    throwIfBarrierExpired(signal);
    await this.deps.clearSiteLocalStorage(site, signal);
  }

  /** `null` is a row that could not be read, would not normalise, or that Electron rejected - the rejection names the cookie, so it is counted by the caller and dropped. */
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
    scanId: string,
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
      scanId,
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
        const file = await readBoundedFile(
          location.cookiesPath,
          MAX_LOGIN_IMPORT_FILE_BYTES,
        );
        if (!file.ok) {
          return {
            ok: false,
            blocked:
              file.reason === "denied"
                ? "needs-full-disk-access"
                : blockedForFile(file.reason),
          };
        }
        const parsed = parseSafariBinaryCookies(file.bytes);
        return {
          ok: true,
          rows: parsed.rows,
          unreadable: parsed.malformed,
          chromium: null,
        };
      }
      case "file": {
        const file = await readBoundedFile(
          location.path,
          MAX_LOGIN_IMPORT_FILE_BYTES,
        );
        if (!file.ok)
          return { ok: false, blocked: blockedForFile(file.reason) };
        const parsed = parseCookieFile(file.bytes.toString("utf8"));
        if (!parsed.ok) return { ok: false, blocked: "unreadable" };
        return { ok: true, rows: parsed.rows, unreadable: 0, chromium: null };
      }
    }
  }

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
    const file = await readBoundedFile(
      localStatePath,
      MAX_LOGIN_IMPORT_FILE_BYTES,
    );
    if (!file.ok) return null;
    try {
      const parsed = localStateKeySchema.safeParse(
        JSON.parse(file.bytes.toString("utf8")),
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

  /** The id is a digest, not the path, so the renderer still never learns one. */
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
  private warn(
    stage: "list" | "scan" | "import" | "import-incomplete",
    error: unknown,
  ): void {
    log.warn("[browser-view] login import failed", {
      stage,
      code:
        errnoCode(error) ?? (error instanceof Error ? error.name : "unknown"),
    });
  }
}

/**
 * The barrier gave this import up and is admitting the jar work queued behind it: stop before the next mutation.
 * The flush and settle window still run (the write's `finally`), and the outer catch answers `blocked` for a jar that was only partly written.
 */
function throwIfBarrierExpired(signal: AbortSignal): void {
  if (signal.aborted) throw barrierExpiredError();
}

function barrierExpiredError(): Error {
  return new Error("The jar barrier expired before the import finished");
}

/** The key a candidate's write lands at, from the same scope the write uses. */
function candidateKeyId(candidate: ImportCandidate): string {
  return cookieKeyId({
    domain: candidate.scope.domain,
    name: candidate.row.name,
    path: candidate.scope.path,
  });
}

function blockedFor(reason: SqliteSnapshotFailure): LoginImportBlocked {
  if (reason === "locked") return "browser-locked";
  if (reason === "too-large") return "profile-too-large";
  return "unreadable";
}

/** A file the bounded read refused; `denied` is the caller's to place. */
function blockedForFile(
  reason: Extract<BoundedFileRead, { readonly ok: false }>["reason"],
): LoginImportBlocked {
  return reason === "too-large" ? "file-too-large" : "unreadable";
}

function blockedScan(
  sourceId: string,
  scanId: string,
  blocked: LoginImportBlocked,
): LoginImportScan {
  return {
    sourceId,
    scanId,
    sites: [],
    excluded: [],
    protectedCookieCount: 0,
    partitionedCookieCount: 0,
    unreadableCookieCount: 0,
    unlock: null,
    blocked,
  };
}
