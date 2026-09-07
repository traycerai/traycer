import { app } from "electron";
import { join } from "node:path";
import { z } from "zod";
import {
  BROWSER_FORGET_LEDGER_MAX_DOMAINS,
  type BrowserCookieKey,
  type BrowserForgetLedger,
} from "@traycer/protocol/host/browser/contracts";
import {
  registrableDomain,
  registrableDomainForUrl,
} from "@traycer/protocol/host/browser/registrable-domain";
import { describeLogError, log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";
import {
  cookieKeyId,
  type BrowserPrimaryProfileCaptureResult,
} from "./browser-storage-state";

/**
 * It exists because a forget must reach a host that was not connected when the user performed it.
 * The ledger is monotonic and never shrinks, so asserting all of it on every push would re-clear a site the user has since signed back into, on every later forget action, forever.
 */
const FORGET_LEDGER_FILE_NAME = "browser-forget-ledger.json";

/** The safe direction (a re-login, never a resurrection), but not one to court. */
const MAX_ACKED_HOSTS = 128;

/** Eviction is oldest-first and an evicted key becomes desktop-owned, so the bound can only ever REMOVE a right, never grant one. */
const MAX_HEADLESS_ORIGIN_KEYS = 4_096;

const domainEntrySchema = z.strictObject({
  domain: z.string(),
  forgottenAt: z.number(),
  revision: z.number(),
});

const recordSchema = z.strictObject({
  /** Monotonic; every forget action bumps it. `0` means "nothing ever". */
  revision: z.number(),
  /** Local-only: a host is never told this, and it takes no part in a digest. */
  clearedThrough: z.number(),
  forgetAll: z
    .strictObject({ at: z.number(), revision: z.number() })
    .nullable(),
  domains: z.array(domainEntrySchema),
  /** Such a host comes back with its pre-forget store and this desktop's watermark still says it is caught up, so forgets below that watermark are never re-sent. */
  ackedByHost: z.array(
    z.strictObject({ hostId: z.string(), revision: z.number() }),
  ),
  /** The rule it serves is add-only: a host may create a key this jar does not hold and may update one that is named here, and may never overwrite anything else. */
  headlessOriginKeys: z
    .array(
      z.strictObject({
        domain: z.string(),
        name: z.string(),
        path: z.string(),
      }),
    )
    .default([]),
});
type ForgetLedgerRecord = z.infer<typeof recordSchema>;

const EMPTY_RECORD: ForgetLedgerRecord = {
  revision: 0,
  clearedThrough: 0,
  forgetAll: null,
  domains: [],
  ackedByHost: [],
  headlessOriginKeys: [],
};

/** One connection acking a revision it finished pruning. */
export interface BrowserForgetLedgerAck {
  readonly hostId: string;
  readonly connectionId: string;
  readonly revision: number;
  /** See {@link recordForgetLedgerAck} for why an ack is worth no more than that, and nothing at all before the first digest. */
  readonly sentRevision: number;
}

let store: StrictJsonFileStore<ForgetLedgerRecord> | null = null;
let ledger: ForgetLedgerRecord = EMPTY_RECORD;
/**
 * The durable one asks "what does this host still owe me?", which must survive a restart or the next digest would re-clear sites the user signed back into.
 * That costs one attach round trip and buys a gate that never trusts a stream it has not heard from.
 */
const ackedByConnectionId = new Map<string, number>();
const completedClears = new Set<number>();
let headlessOriginKeyIds = new Set<string>();
const changeListeners = new Set<() => void>();
/** The ledger itself is never deferred - every record lands in memory and on disk as it is made. */
let deferredNotificationDepth = 0;
let notificationPending = false;

export function browserForgetLedgerFilePath(): string {
  return join(app.getPath("userData"), FORGET_LEDGER_FILE_NAME);
}

export async function initBrowserForgetLedger(filePath: string): Promise<void> {
  store = createJsonFileStore<ForgetLedgerRecord>(
    filePath,
    EMPTY_RECORD,
    (value) => recordSchema.safeParse(value).data ?? EMPTY_RECORD,
  );
  completedClears.clear();
  openBrackets.clear();
  deferredNotificationDepth = 0;
  notificationPending = false;
  const loaded = await store.load();
  ledger = {
    ...loaded,
    domains: trimDomains(normalizedLoadedDomains(loaded.domains)),
    ackedByHost: loaded.ackedByHost.slice(-MAX_ACKED_HOSTS),
    headlessOriginKeys: loaded.headlessOriginKeys.slice(
      -MAX_HEADLESS_ORIGIN_KEYS,
    ),
  };
  reindexHeadlessOriginKeys();
  log.info("[browser-view] forget ledger loaded", {
    revision: ledger.revision,
    domains: ledger.domains.length,
    forgetAll: ledger.forgetAll !== null,
  });
}

function normalizedLoadedDomains(
  rows: readonly ForgetLedgerRecord["domains"][number][],
): ForgetLedgerRecord["domains"][number][] {
  const byScope = new Map<string, ForgetLedgerRecord["domains"][number]>();
  for (const row of rows) {
    const scope = registrableDomain(row.domain);
    if (scope === null) continue;
    const held = byScope.get(scope);
    if (held !== undefined && held.revision >= row.revision) continue;
    byScope.set(scope, { ...row, domain: scope });
  }
  return [...byScope.values()];
}

/**
 * In memory FIRST and synchronously, before the durable write is awaited, because the bump is what starts refusing in-flight observations and the caller is about to empty the jar.
 * A write that fails leaves this run's ledger ahead of the file.
 */
export async function recordForgetAllBrowserLogins(): Promise<number> {
  const revision = ledger.revision + 1;
  mutate({
    revision,
    clearedThrough: revision - 1,
    forgetAll: { at: Date.now(), revision },
    domains: [],
    ackedByHost: ledger.ackedByHost,
    // Every login is going, so every custody mark goes with it: the jar this
    // machine wakes up with holds nothing a host contributed.
    headlessOriginKeys: [],
  });
  noteRecordedForgets([], true);
  await persist();
  return revision;
}

export async function recordForgottenBrowserSite(
  domain: string,
): Promise<number> {
  return (await recordForgottenBrowserSites([domain])) ?? ledger.revision;
}

/**
 * Several sites forgotten under ONE revision - the shape a caller that knows its whole batch up front records with.
 * The login import is NOT such a caller: it records each site on its own, immediately before that site's first removal, so a site the write never reaches is never in the ledger (a.
 */
export async function recordForgottenBrowserSites(
  domains: readonly string[],
): Promise<number | null> {
  const scopes = new Set<string>();
  for (const domain of domains) {
    const scope = registrableDomain(domain);
    if (scope === null) {
      log.warn("[browser-view] not recording a forget for an underivable site");
      continue;
    }
    scopes.add(scope);
  }
  if (scopes.size === 0) return null;
  const revision = ledger.revision + 1;
  const forgottenAt = Date.now();
  mutate({
    revision,
    clearedThrough: ledger.clearedThrough,
    forgetAll: ledger.forgetAll,
    domains: trimDomains([
      ...ledger.domains.filter((entry) => !scopes.has(entry.domain)),
      ...[...scopes].map((domain) => ({ domain, forgottenAt, revision })),
    ]),
    ackedByHost: ledger.ackedByHost,
    // The custody marks go with the cookies they describe. Leaving them would
    // let a host re-add the key AND keep the right to overwrite it later, on
    // the strength of a contribution the user has since deleted.
    headlessOriginKeys: ledger.headlessOriginKeys.filter(
      (key) => !scopes.has(registrableDomain(key.domain) ?? ""),
    ),
  });
  noteRecordedForgets(scopes, false);
  await persist();
  return revision;
}

/** Only ever advances, and never past the ledger's own top: a clear cannot have completed work no forget has recorded. */
export async function markBrowserForgetLedgerCleared(
  revision: number,
): Promise<void> {
  await markBrowserForgetLedgerClearedMany([revision]);
}

export async function markBrowserForgetLedgerClearedMany(
  revisions: readonly number[],
): Promise<void> {
  const completed = revisions.filter(
    (revision) =>
      revision > ledger.clearedThrough && revision <= ledger.revision,
  );
  if (completed.length === 0) return;
  // Advancing straight to the newest completed revision would step over an older one that crashed, and the boot reconciliation would never re-run it.
  for (const revision of completed) completedClears.add(revision);
  // A revision the ledger no longer REPRESENTS can never be completed, and the watermark must step over it rather than wedge on it.
  const oldestPending = [
    ledger.forgetAll?.revision,
    ...ledger.domains.map((entry) => entry.revision),
  ].reduce<number | null>((oldest, candidate) => {
    if (
      candidate === undefined ||
      candidate <= ledger.clearedThrough ||
      completedClears.has(candidate)
    ) {
      return oldest;
    }
    return oldest === null || candidate < oldest ? candidate : oldest;
  }, null);
  const clearedThrough =
    oldestPending === null
      ? ledger.revision
      : Math.min(ledger.revision, oldestPending - 1);
  // Only the drained ones: a completion above the watermark is still the thing
  // that lets a later drain step past its revision.
  for (const done of [...completedClears]) {
    if (done <= clearedThrough) completedClears.delete(done);
  }
  if (clearedThrough <= ledger.clearedThrough) return;
  mutate({ ...ledger, clearedThrough });
  await persist();
}

/** What a forget recorded but never finished clearing - read once at startup, before any host stream is serviced. */
export function browserForgetLedgerPendingClears(): {
  /** The forget-all still to re-run, with the revision that recorded it. */
  readonly forgetAll: { readonly revision: number } | null;
  readonly domains: readonly {
    readonly domain: string;
    readonly revision: number;
  }[];
} {
  const cleared = ledger.clearedThrough;
  const forgetAll = ledger.forgetAll;
  return {
    // Per ENTRY, never "something is pending, so re-run everything": a forget-all that already completed must not be re-run because a later single-site clear did not, or one crashed.
    // Marking the ledger's top instead - which is whatever the newest forget happened to be - adds a number the drain can never reach past, and one wedge is permanent.
    forgetAll:
      forgetAll !== null && forgetAll.revision > cleared
        ? { revision: forgetAll.revision }
        : null,
    domains: ledger.domains
      .filter((entry) => entry.revision > cleared)
      .map((entry) => ({ domain: entry.domain, revision: entry.revision })),
  };
}

export interface BrowserForgetLedgerUnclearedForgets {
  /** A forget-all is recorded and its jar clear has not finished. */
  readonly forgetAll: boolean;
  /** Registrable domains whose site clear is recorded and not finished. */
  readonly domains: ReadonlySet<string>;
}

export function browserForgetLedgerUnclearedForgets(): BrowserForgetLedgerUnclearedForgets {
  const uncleared = (revision: number): boolean =>
    revision > ledger.clearedThrough && !completedClears.has(revision);
  const forgetAll = ledger.forgetAll;
  return {
    forgetAll: forgetAll !== null && uncleared(forgetAll.revision),
    domains: new Set(
      ledger.domains
        .filter((entry) => uncleared(entry.revision))
        .map((entry) => entry.domain),
    ),
  };
}

/** The forgets in either answer. */
export function unionUnclearedForgets(
  a: BrowserForgetLedgerUnclearedForgets,
  b: BrowserForgetLedgerUnclearedForgets,
): BrowserForgetLedgerUnclearedForgets {
  return {
    forgetAll: a.forgetAll || b.forgetAll,
    domains: new Set([...a.domains, ...b.domains]),
  };
}

interface OpenUnclearedForgetsBracket {
  forgetAll: boolean;
  readonly domains: Set<string>;
}
const openBrackets = new Set<OpenUnclearedForgetsBracket>();

function noteRecordedForgets(
  scopes: Iterable<string>,
  forgetAll: boolean,
): void {
  for (const bracket of openBrackets) {
    if (forgetAll) bracket.forgetAll = true;
    for (const scope of scopes) bracket.domains.add(scope);
  }
}

export interface UnclearedForgetsBracket {
  readonly close: () => BrowserForgetLedgerUnclearedForgets;
}

export function bracketUnclearedForgets(): UnclearedForgetsBracket {
  const before = browserForgetLedgerUnclearedForgets();
  const recorded: OpenUnclearedForgetsBracket = {
    forgetAll: false,
    domains: new Set(),
  };
  openBrackets.add(recorded);
  let closed: BrowserForgetLedgerUnclearedForgets | null = null;
  return {
    close: () => {
      if (closed !== null) return closed;
      openBrackets.delete(recorded);
      closed = unionUnclearedForgets(
        unionUnclearedForgets(before, browserForgetLedgerUnclearedForgets()),
        recorded,
      );
      return closed;
    },
  };
}

/**
 * A capture read between the record and the clear still carries the site, and a host that takes it re-learns what it just pruned.
 * The push must therefore carry the jar as the ledger says it WILL be, not as it momentarily is.
 */
export function withoutUnclearedForgets(
  result: BrowserPrimaryProfileCaptureResult,
  uncleared: BrowserForgetLedgerUnclearedForgets,
): BrowserPrimaryProfileCaptureResult {
  if (result.status !== "captured") return result;
  if (uncleared.forgetAll) {
    return {
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    };
  }
  if (uncleared.domains.size === 0) return result;
  const forgotten = (scope: string | null): boolean =>
    scope !== null && uncleared.domains.has(scope);
  return {
    status: "captured",
    storageState: {
      cookies: result.storageState.cookies.filter(
        (cookie) => !forgotten(registrableDomain(cookie.domain)),
      ),
      origins: result.storageState.origins.filter(
        (origin) => !forgotten(registrableDomainForUrl(origin.origin)),
      ),
    },
    reason: null,
  };
}

export function browserForgetLedgerDigestForHost(
  hostId: string,
): BrowserForgetLedger {
  const acked = ackedRevisionForHost(hostId);
  const forgetAll = ledger.forgetAll;
  return {
    forgetAllAt:
      forgetAll !== null && forgetAll.revision > acked ? forgetAll.at : null,
    domains: ledger.domains
      .filter((entry) => entry.revision > acked)
      .map((entry) => ({
        domain: entry.domain,
        forgottenAt: entry.forgottenAt,
      })),
    revision: ledger.revision,
  };
}

/**
 * Both watermarks advance, and both only ever advance: an ack that arrived out of order, or one replayed on a reconnect, must never lower what a later one established.
 * The gate reopens on the SYNCHRONOUS half - the in-memory maps - so the awaited durable write never delays an observation.
 */
export async function recordForgetLedgerAck(
  ack: BrowserForgetLedgerAck,
): Promise<void> {
  const revision = Math.min(ack.revision, ack.sentRevision, ledger.revision);
  const connection = ackedByConnectionId.get(ack.connectionId) ?? 0;
  if (revision > connection) {
    ackedByConnectionId.set(ack.connectionId, revision);
  }
  if (revision <= ackedRevisionForHost(ack.hostId)) return;
  const others = ledger.ackedByHost.filter(
    (entry) => entry.hostId !== ack.hostId,
  );
  // Appended last, so the bound below evicts the least recently confirmed host
  // rather than an arbitrary one.
  mutate({
    ...ledger,
    ackedByHost: [...others, { hostId: ack.hostId, revision }].slice(
      -MAX_ACKED_HOSTS,
    ),
  });
  await persist();
}

/** A closed stream can ack nothing more; its gate state goes with it. */
export function releaseBrowserForgetLedgerConnection(
  connectionId: string,
): void {
  ackedByConnectionId.delete(connectionId);
}

export function isBrowserForgetLedgerPendingAck(input: {
  readonly connectionId: string;
  readonly domain: string;
}): boolean {
  const acked = ackedByConnectionId.get(input.connectionId) ?? 0;
  const forgetAll = ledger.forgetAll;
  if (forgetAll !== null && forgetAll.revision > acked) return true;
  // Collapsed the same way every other jar path collapses a domain, so a
  // forget of `example.com` refuses an observation naming `www.example.com`.
  const scope = registrableDomain(input.domain) ?? input.domain;
  const entry = ledger.domains.find((row) => row.domain === scope);
  return entry !== undefined && entry.revision > acked;
}

/** It never means "absent from the jar": whether the jar holds the key at all is the applier's question, asked of the jar. */
export function isHeadlessOriginCookieKey(keyId: string): boolean {
  return headlessOriginKeyIds.has(keyId);
}

/** Recorded BEFORE the cookies are written, not after, and the ordering is the argument: the desktop's own cookie observer hands ownership back on any local write it sees, so. */
export async function recordHeadlessOriginCookieKeys(
  keys: readonly BrowserCookieKey[],
): Promise<void> {
  const seen = new Set<string>();
  const added = keys.filter((key) => {
    const id = cookieKeyId(key);
    if (headlessOriginKeyIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (added.length === 0) return;
  mutate({
    ...ledger,
    // Appended last and trimmed from the front, so the bound evicts the
    // oldest contribution rather than the newest.
    headlessOriginKeys: [
      ...ledger.headlessOriginKeys,
      ...added.map((key) => ({
        domain: key.domain,
        name: key.name,
        path: key.path,
      })),
    ].slice(-MAX_HEADLESS_ORIGIN_KEYS),
  });
  await persist();
}

export async function releaseHeadlessOriginCookieKeys(
  keys: readonly BrowserCookieKey[],
): Promise<void> {
  const released = new Set(
    keys.map(cookieKeyId).filter((id) => headlessOriginKeyIds.has(id)),
  );
  if (released.size === 0) return;
  mutate({
    ...ledger,
    headlessOriginKeys: ledger.headlessOriginKeys.filter(
      (entry) => !released.has(cookieKeyId(entry)),
    ),
  });
  try {
    // `saveStrict` rather than `save`: same queue, but the failure reaches
    // here instead of being swallowed as a generic store warning.
    await store?.saveStrict(ledger);
  } catch (error) {
    // No cookie name or domain: a warn line is the user's browsing history if
    // it carries one.
    log.warn(
      "[browser-view] forget ledger: a headless-origin key release did not reach disk",
      { keys: released.size, err: describeLogError(error) },
    );
  }
}

/** Ack bookkeeping deliberately does NOT notify: it changes what a host is owed, not what any host must be told. */
export function onBrowserForgetLedgerChanged(listener: () => void): {
  dispose: () => void;
} {
  changeListeners.add(listener);
  return {
    dispose: () => {
      changeListeners.delete(listener);
    },
  };
}

/** Holds the "tell every stream" edge until `end()`, for a caller that records sites one at a time (the login import, one revision per site as each reaches its removals): the records. */
export function deferBrowserForgetLedgerNotifications(): {
  readonly end: () => void;
} {
  deferredNotificationDepth += 1;
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      deferredNotificationDepth -= 1;
      if (deferredNotificationDepth > 0 || !notificationPending) return;
      notificationPending = false;
      notifyChanged();
    },
  };
}

function notifyChanged(): void {
  for (const listener of [...changeListeners]) listener();
}

function ackedRevisionForHost(hostId: string): number {
  return (
    ledger.ackedByHost.find((entry) => entry.hostId === hostId)?.revision ?? 0
  );
}

function reindexHeadlessOriginKeys(): void {
  headlessOriginKeyIds = new Set(ledger.headlessOriginKeys.map(cookieKeyId));
}

function mutate(next: ForgetLedgerRecord): void {
  const bumped = next.revision > ledger.revision;
  ledger = next;
  reindexHeadlessOriginKeys();
  if (!bumped) return;
  if (deferredNotificationDepth > 0) {
    notificationPending = true;
    return;
  }
  notifyChanged();
}

/**
 * `save`, not `saveStrict`: a failed write is reported by the store itself and must not reach the caller, who is in the middle of emptying the jar on the user's instruction.
 * A ledger that did not reach disk is not a reason to leave the logins in place.
 */
function persist(): Promise<void> {
  return store?.save(ledger) ?? Promise.resolve();
}

function trimDomains(
  domains: readonly ForgetLedgerRecord["domains"][number][],
): ForgetLedgerRecord["domains"] {
  if (domains.length <= BROWSER_FORGET_LEDGER_MAX_DOMAINS) return [...domains];
  return [...domains]
    .sort((left, right) => left.revision - right.revision)
    .slice(-BROWSER_FORGET_LEDGER_MAX_DOMAINS);
}
