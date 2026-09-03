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
 * The whole answer, hosts included. The push to the hosts is a jar frame,
 * sent from main and never from a renderer - and made by this service through
 * `pushJarToHosts`, inside its barrier, so the IPC handler has nothing to add.
 */
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

/**
 * What main's confirmation dialog names: the registered source (never the
 * renderer's word for it) and how many sites the request validated to.
 */
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
   * Empties the durable jar's localStorage for every origin under a site
   * that this process remembers (the capture coordinator's memory, the only
   * record of which origins hold any), and forgets those origins, so the
   * capture that follows the import does not ship them back. The source
   * carries cookies alone, so the slice a written site ends with is the
   * source's: its cookies, and no localStorage from whichever account was
   * signed in before - a site that keeps account state there would
   * otherwise pair the old identity with the imported cookies. Reads the
   * barrier's signal between origins: a site whose tiles keep landing on
   * new origins re-enumerates until nothing new turns up, and an import the
   * barrier has given up on must not go on clearing under the work queued
   * behind it.
   */
  readonly clearSiteLocalStorage: (
    site: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * The forget ledger's record that these sites are being REPLACED, taken
   * once, before the first cookie any site removes, and answering the ledger
   * revision it made (`null` when it recorded nothing). Taken then rather
   * than before the first write because it is the removals it covers, and
   * an import that removes nothing - every row refused, or every jar cookie
   * carried - must not have every host prune sites this machine still
   * holds. The same entry a site clear records, and for the same two reasons. A
   * host that hears it prunes the site and then takes the capture pushed
   * after the write - so a host that was away for the import still ends
   * with the source's slice, not a union of it and what it held. And until
   * a host has acked that revision, its observations for the site are
   * refused (`isBrowserForgetLedgerPendingAck`): an observation of a cookie
   * the import removed - one the source did not carry - would otherwise
   * find the name free in the jar and put it straight back, and the next
   * capture would sync that union to every host. The written keys' release
   * covers only keys the import WROTE; this is what covers the ones it
   * removed.
   */
  readonly recordReplacedSites: (
    sites: readonly string[],
  ) => Promise<number | null>;
  /**
   * The local side of that record is done: `markBrowserForgetLedgerCleared`
   * for the revision above, once the writes have ended - however they
   * ended - so the boot reconciliation does not re-run a clear of these
   * sites at the next launch over the cookies the import put there.
   */
  readonly markReplacementCleared: (revision: number) => Promise<void>;
  /**
   * The push of the jar to every host, INSIDE the barrier, after the mute
   * has lifted and the written keys are the desktop's. Inside, because a
   * toggle of saved logins queued behind the barrier would otherwise run
   * first and move the capture's session to the ephemeral jar, sending the
   * hosts old ephemeral state - or nothing - while the dialog reports them
   * notified; the capture reads the jar it is asked for without queueing on
   * the serializer, so the barrier holder can make it. Answers how many
   * hosts acked the jar; never rejects.
   */
  readonly pushJarToHosts: () => Promise<number>;
  /**
   * Main's own confirmation of the replacement, shown once the request has
   * been validated against its scan and before anything is read, prompted or
   * written. The renderer may ASK; a native dialog it cannot draw over or
   * dismiss is what turns the ask into a decision - the same rule as clearing
   * a site or forgetting every login, and for the same reason: a compromised
   * renderer can list, scan and then import every site a profile holds, and
   * a plaintext (Firefox, Safari, file) import raises no other prompt at all.
   * Answers false for a declined or dismissed dialog.
   */
  readonly confirmImport: (summary: LoginImportSummary) => Promise<boolean>;
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

/**
 * What the barrier hands back: the tallies, or why nothing was written - the
 * source could not be read, changed since the scan, the keystore refused, or
 * saving is off. Every reason is the renderer's closed set.
 */
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

/**
 * How many successful scans the service keeps at once. Each Settings window
 * holds one live scan per Choose step, so a handful is every window there
 * could be; the oldest goes when the set is full, and an import quoting it
 * answers `unreadable`, which the dialog's Try again re-scans out of.
 */
export const RETAINED_SCAN_LIMIT = 16;

/** A scan token: random, opaque, and no function of the source or the jar. */
function mintScanId(): string {
  return randomBytes(16).toString("hex");
}

export class LoginImportService {
  private readonly sources = new Map<string, DiscoveredLoginImportSource>();
  /**
   * What each retained successful scan listed, keyed by the scan's own token
   * and in insertion order. An import quotes the token of the scan its window
   * rendered and honours only domains in THAT scan's sets: the renderer
   * chooses from what it was shown, never from the jar at large or from a
   * later scan another window took of the same source - which could carry a
   * keystore promise this window's Choose step never made. A site that
   * appears in the file between scan and import is not imported unseen. The
   * `excluded` (Google) set is honoured only with the request's explicit
   * opt-in. A scan is dropped with its source when a re-listing no longer
   * finds it, when an import finds the source changed under it, and when it
   * is the oldest of `RETAINED_SCAN_LIMIT`.
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
    // Under the serializer's barrier FROM THE CONFIRMATION ON - the source
    // read, the keystore prompt and the write all inside it, with the
    // observer muted for the write. The barrier orders this import against
    // every other jar mutation in the order the user confirmed them: a
    // forget-all or a site clear confirmed from another window AFTER this
    // "Import" queues behind the whole import rather than clearing the jar,
    // reporting done, and then having this import write the logins back over
    // an empty jar - which is what it would do from any point outside the
    // barrier, the multi-second read of a large jar as much as the prompt
    // the user can sit on for minutes. The mute is what keeps the per-site
    // removals from reaching the hosts.
    const written = await this.deps.serializeJarWrite(
      async (signal): Promise<ImportWrite> => {
        // The pref first, inside the barrier the toggle itself takes, so it
        // cannot change under anything below: a window that turned saving
        // off while this import sat on the confirmation has moved the tiles
        // to the ephemeral jar, and a write to the durable one now would land
        // where nothing reads it and be captured by nobody - and there is no
        // reason to read a jar, let alone raise a prompt, for that.
        if (!this.deps.readSaveLogins()) {
          return { ok: false, reason: "saved-logins-off" };
        }
        const read = await this.readSource(source.location);
        if (!read.ok) return { ok: false, reason: read.blocked };
        const nowSeconds = Math.floor(this.deps.now() / 1000);
        const candidates: ImportCandidate[] = [];
        // Every key the source HOLDS for a chosen site, whether or not this
        // reader can open the row: a row this desktop cannot decrypt (an
        // app-bound `v20`) or must not write (a partitioned one) still says
        // the source has a cookie at that key, and the jar's cookie there is
        // kept rather than removed as "not carried" - see `writeSite` step 3.
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
        // The prompt the Choose step announced is the only prompt Import may
        // raise. A keystore no chosen site was scanned as needing means the
        // source changed since (a Linux site that was all `v10` gained a
        // `v11` row); the scan is dropped so the way back in is a fresh one.
        // DPAPI is exempt: it unseals silently, so there was nothing to
        // announce.
        const needed = this.unlockFor(keyNeedsOf(candidates));
        if (
          needed !== null &&
          needed !== "windows-dpapi" &&
          ![...chosen].some((site) => allowed.unlockBySite.get(site) === needed)
        ) {
          this.scanned.delete(request.scanId);
          return { ok: false, reason: "source-changed" };
        }

        // Grouped as ROWS, still ciphertext: a value is decrypted inside the
        // write loop, immediately before its `cookies.set`, and is
        // unreferenced once that call returns. Materialising the plaintext
        // jar up front would keep every value alive through the other sites'
        // writes, the flush and the settle window.
        const bySite = new Map<string, ImportCandidate[]>();
        for (const candidate of candidates) {
          const siteRows = bySite.get(candidate.scope.site) ?? [];
          siteRows.push(candidate);
          bySite.set(candidate.scope.site, siteRows);
        }
        // Every site the write touches goes into the forget ledger under one
        // revision, and the ledger keeps that many domains: a batch past it
        // would be TRIMMED, and a trimmed scope never reaches a host's digest,
        // so a host that was away would keep what the import removed. Refused
        // here, before the keystore is opened or a cookie moves.
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
        // The ledger before a cookie is REMOVED - the order a site clear
        // keeps, and for the same reason: the revision is what refuses a
        // host's in-flight observation of what is about to be removed, and
        // what a host that is away prunes from when it comes back. One
        // revision for every site the write touches, taken by the first site
        // that reaches its removals, and none at all for an import that
        // removes nothing.
        const ledger: { revision: number | null; recorded: boolean } = {
          revision: null,
          recorded: false,
        };
        const recordReplacement = async (): Promise<void> => {
          if (ledger.recorded) return;
          ledger.recorded = true;
          ledger.revision = await this.deps.recordReplacedSites([
            ...bySite.keys(),
          ]);
        };
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
              // On the failure path too: a removal Chromium reports on the
              // listener pipe after `remove()` resolved is what the settle
              // window absorbs, and a throw mid-site must not let the
              // observer wake before it has passed, or a removal that
              // escaped here would reach the host as `removedKeys` ahead of
              // the capture that reconciles it.
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
          // Whatever ended the write - the last site, a throw from a row,
          // the barrier's abort - the ledger's local side is done and every
          // key the write DID put in the jar becomes the desktop's here,
          // after the mute has lifted. On the ordinary path that is still
          // inside the barrier, so nothing queued behind it (a host's
          // observation of an OLDER value for one of these keys) can run
          // before the keys are the desktop's; on the abort path the gate is
          // already open and this runs late, which still beats a key left
          // host-owned for good, which the host's next observation would put
          // the old value back over.
          try {
            if (ledger.revision !== null) {
              await this.deps.markReplacementCleared(ledger.revision);
            }
          } finally {
            await this.deps.releaseHostOwnedKeys(tally.writtenKeys);
          }
        }
        // The jar is the hosts' to hear about once anything of the import's
        // is in it - or once the ledger has told them to prune a site, even
        // one the write then put back as it was: a host that pruned and was
        // never captured would hold LESS than this machine until something
        // else asked for a capture. Nothing of either is nothing to hear.
        const jarTouched = tally.writtenKeys.length > 0 || ledger.recorded;
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
          // Answered as what it is - an import that stopped part-way, with
          // what it did write kept, counted and pushed - rather than as a
          // source that could not be read, which is what `unreadable` says
          // and what Try again would then wrongly re-diagnose.
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
   * One site's replacement, in the order that never leaves the site empty:
   *
   * 1. WRITE every row, decrypting each immediately before its `set`. Same
   *    key (name, domain scope, path) overwrites in place, which is what
   *    Chromium does for a sign-in.
   * 2. Nothing written means nothing touched: the slice the jar already held
   *    stays as it was, so a source whose every row Electron rejects (a
   *    hand-edited file with an invalid value) cannot sign the user out.
   * 3. Otherwise REMOVE what the source did not CARRY - the jar's cookies for
   *    the site whose key no source row names - so the slice is the
   *    source's, not a union of two sign-ins. Carried, not written: a row
   *    the source has for that key but that could not be decrypted,
   *    normalised or set - or that this reader never tried, an app-bound
   *    `v20` row or a partitioned one - leaves the jar's cookie at that key
   *    alone, since the source did hold a cookie there and removing the
   *    working one would turn one unreadable row into a sign-out. The same
   *    holds one step wider, by NAME: a source row that did not land and
   *    whose name no landed row shares leaves the jar's cookies of that name
   *    alone under ANY scope - a host-only `sid` beside the source's failed
   *    domain `sid` is the sign-in that row would have replaced, and its key
   *    being unnamed by the source is a difference of scope, not of cookie.
   * 4. Electron removes by `{url, name}`, which also catches a just-written
   *    cookie of the same NAME under a different scope or path - and a kept
   *    cookie of that name from step 3. Any written row whose name a removal
   *    named is written once more, decrypted again rather than held; a
   *    re-write refused is no longer written, and then, like any kept cookie
   *    a removal named, the jar's prior cookie at that key is put back from
   *    the listing taken before the first write - and, when no landed row
   *    shares the name, so is every prior cookie of that name the removal
   *    reached, carried or not, exactly as step 3 would have kept them had
   *    the row failed on its first write. Should NO written row survive its
   *    re-write, the site is back to step 2: everything the removals reached
   *    is put back, the site is not counted as imported or replaced, and its
   *    localStorage is left alone.
   * 5. The site's localStorage goes with the cookies the source did not
   *    carry: it belongs to whichever account was signed in before, and a
   *    site that keeps account state there would otherwise run the old
   *    identity on the imported cookies.
   */
  private async writeSite(
    site: string,
    siteRows: readonly ImportCandidate[],
    // Every key the source holds for this site - the candidates' AND the
    // rows this reader could not open - from the rows' metadata, which is
    // the same scope the write derives its key from, so a row that fails on
    // the way in (or never starts) still marks its key as carried.
    carriedKeyIds: ReadonlySet<string>,
    // Every NAME the source holds for this site, from the same rows - the
    // candidates' and the ones this reader never opens - for the by-name
    // keep of step 3: a protected `sid` the reader never tried is still a
    // `sid` the source has, so the jar's `sid` under another scope is not
    // stale for want of a landed row of that name.
    sourceNames: ReadonlySet<string>,
    read: SourceRead & { ok: true },
    keys: ChromiumKeys & { ok: true },
    nowSeconds: number,
    session: LoginImportJarSession,
    signal: AbortSignal,
    // The import's one forget-ledger record for every site it touches,
    // taken here by the first site that reaches its removals.
    recordReplacement: () => Promise<void>,
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

    // A name the source has a row for but no LANDED row of: that row failed
    // on the way in (or, below, on its re-write), or was never opened, so
    // the jar's cookies of that name are the sign-in it would have replaced,
    // whatever their scope. Read against `writtenKeyIds` as it stands, so
    // the re-write pass moving a key out of it moves that name in here.
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
    // The names the removals REACHED, each added before its `remove` is
    // attempted: a rejection tells nothing about what the call took with it,
    // so the recovery below covers that name either way. A removal that
    // fails, or the barrier giving up between two, ends the removals but not
    // the site: the recovery passes run for whatever was reached, and only
    // then is the failure thrown - a `sid` a successful removal erased and a
    // later rejection would otherwise leave un-rewritten, which is a
    // sign-out reported as `incomplete`.
    const removedNames = new Set<string>();
    let removalFailure: { readonly error: unknown } | null = null;
    // Recorded before the first `remove`, never after: a removal the ledger
    // does not yet cover is one a host's in-flight observation can undo.
    if (stale.length > 0) await recordReplacement();
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
    // The recovery passes read no abort signal: each is a handful of `set`
    // calls that put a reached cookie back, the serializer holds the gate
    // through the action's settlement (up to its grace) even after it has
    // given the import up, and a site left half-removed is a sign-out.
    //
    // Written rows a same-name removal reached are written once more. One
    // refused now is no longer written: its key leaves `writtenKeyIds`, so
    // the restore below treats it like any other carried key the source
    // could not write and puts the jar's prior cookie back.
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
        // Accepted a moment ago and refused now: counted as it stands, and
        // no longer the import's - the restore below puts the jar's prior
        // cookie back at this key, so the desktop must not take ownership
        // of a value a host may own.
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
    // No written row survived its re-write: the site is back to step 2, and
    // the removals - every one of them made for a replacement that is not
    // happening - are undone in full below, the site uncounted, its
    // localStorage left alone.
    const nothingLanded = writtenKeyIds.size === 0;
    if (nothingLanded) {
      outcome.importedSites -= 1;
      if (previous.length > 0) outcome.replacedSites -= 1;
    }
    // The jar's cookies at a carried key the source could NOT write - on the
    // first attempt or on the re-write just above - are kept (step 3), but a
    // same-name removal reaches them too, so each one a removal named is put
    // back as it was, from the listing taken before any write. So is every
    // prior cookie of a name no landed row shares (a re-write refused, with
    // the differently scoped `sid` beside it that was the sign-in), and, when
    // nothing landed at all, everything the removals reached.
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
 * The barrier gave this import up and is admitting the jar work queued
 * behind it: stop before the next mutation. The flush and settle window still
 * run (the write's `finally`), and the outer catch answers `blocked` for a
 * jar that was only partly written - the message never leaves this process,
 * `warn` logs only the error's name.
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
