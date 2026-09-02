import { app } from "electron";
import { join } from "node:path";
import { z } from "zod";
import {
  BROWSER_FORGET_LEDGER_MAX_DOMAINS,
  type BrowserCookieKey,
  type BrowserForgetLedger,
} from "@traycer/protocol/host/browser/contracts";
import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";
import { describeLogError, log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";
import { cookieKeyId } from "./browser-storage-state";

/**
 * The durable forget ledger: this machine's record of every login the user
 * asked to be gone, and of how far each host has confirmed it pruned.
 *
 * It exists because a forget must reach a host that was not connected when the
 * user performed it. The one-shot `primaryProfileForgotten` fan-out it replaced
 * could only reach the desktops attached at that instant, so a host that came
 * back later re-offered - through the attach replay - exactly the logins the
 * user had deleted.
 *
 * WHAT MAKES IT SAFE TO RE-SEND. The ledger is monotonic and never shrinks, so
 * asserting all of it on every push would re-clear a site the user has since
 * signed back into, on every later forget action, forever. Each entry therefore
 * carries the REVISION that created it, this file records what each host has
 * acked, and a digest carries only the entries above that host's watermark. The
 * host stays stateless and idempotent: it clears what it is given.
 *
 * WHAT THE REVISION IS FOR ON THIS SIDE. It is also the desktop's
 * no-resurrection gate. A host that has acked revision N pruned everything
 * through N before it said so, so anything it observes afterwards is a
 * post-prune capture; an observation for a ledger-covered domain from a
 * connection that has NOT acked the covering revision is exactly the frame that
 * was captured before the prune, and it is dropped on that fact rather than on
 * an estimate of flight time. That is why the acked map has two halves with
 * different lifetimes - see {@link recordForgetLedgerAck}.
 *
 * Timestamps here are this machine's clock and are never sent anywhere to be
 * compared: a host reads the digest as instructions, not as times.
 *
 * WHAT ELSE THIS FILE CARRIES. The ownership rule needs one more durable fact
 * about the same jar - which cookie keys got there
 * because a host observed them, and are therefore the only ones a host may
 * overwrite. It lives here rather than in a file of its own because it has the
 * same custody question, the same lifetime, and the same erasure events: a
 * forget of a site drops its keys, and a forget-all drops every one of them.
 * Two files would be two answers to "what does this machine remember about the
 * user's logins".
 *
 * KNOWN LIMITATION, accepted (single primary desktop is the supported model):
 * this ledger is per machine, and a forget performed here
 * is never pushed to another desktop of the same user. A second desktop keeps
 * the login in its own jar, re-teaches it to the shared host on ITS next
 * attach, and the host's replay can then hand it back to this one. Two
 * desktops converge on the union of what they hold, not on the forget.
 */
const FORGET_LEDGER_FILE_NAME = "browser-forget-ledger.json";

/**
 * Hosts whose acked revision this file remembers. Far above the number of
 * machines a person runs, and bounded so a file that only ever grows cannot.
 *
 * Eviction is not free, which is why the bound is generous rather than tight:
 * an evicted host is sent the whole ledger again and re-prunes it, which
 * re-clears any of those sites the user has since signed back into. The safe
 * direction (a re-login, never a resurrection), but not one to court.
 */
const MAX_ACKED_HOSTS = 128;

/**
 * How many host-contributed cookie keys this machine remembers.
 *
 * Generous against a real jar - a person's saved logins are dozens of sites of
 * a handful of cookies each - and a hard ceiling on a file a remote party can
 * grow: every applied observation adds an entry. Eviction is oldest-first and
 * an evicted key becomes desktop-owned, so the bound can only ever REMOVE a
 * right, never grant one.
 *
 * It does have a cost, and it is a feature-level one rather than a security
 * one: the set is global across hosts, so a host that floods it strips the
 * refresh rights of every OTHER host of this user. Their contributed sessions
 * stay in the jar and keep working; what they lose is the ability to update
 * them, until the user signs in again on this machine or forgets the site.
 */
const MAX_HEADLESS_ORIGIN_KEYS = 4_096;

const domainEntrySchema = z.strictObject({
  domain: z.string(),
  forgottenAt: z.number(),
  revision: z.number(),
});

const recordSchema = z.strictObject({
  /** Monotonic; every forget action bumps it. `0` means "nothing ever". */
  revision: z.number(),
  /**
   * The newest revision whose LOCAL jar clear actually finished.
   *
   * It exists because the two are separate steps and a crash fits between
   * them: the ledger is written first, deliberately, so an in-flight
   * observation is refused before a cookie moves - which leaves a window where
   * the ledger claims a site is forgotten while the jar still holds it. That
   * jar is the master, so the next whole-jar capture would teach every host
   * the login all over again, and no host-side prune can undo it.
   *
   * Local-only: a host is never told this, and it takes no part in a digest.
   */
  clearedThrough: z.number(),
  forgetAll: z
    .strictObject({ at: z.number(), revision: z.number() })
    .nullable(),
  domains: z.array(domainEntrySchema),
  /**
   * Oldest ack first, so the bound evicts the least recently confirmed host.
   *
   * KNOWN LIMITATION, accepted: it is keyed by `hostId`, which survives a host
   * being restored from a backup or cloned onto a new machine. Such a host
   * comes back with its pre-forget store and this desktop's watermark still
   * says it is caught up, so forgets below that watermark are never re-sent.
   * The remedy if it ever bites is a per-host store epoch on the ack, not a
   * smarter desktop.
   */
  ackedByHost: z.array(
    z.strictObject({ hostId: z.string(), revision: z.number() }),
  ),
  /**
   * Cookie keys an observed frame put in this jar, newest last - the desktop's
   * account of what it does NOT own.
   *
   * The rule it serves is add-only: a host may create a key this jar does not
   * hold and may update one that is named here, and may never overwrite
   * anything else. So membership is the host's PERMISSION, and every way an
   * entry can be lost - the bound below, a corrupt file read back as empty, a
   * forget - costs the host that permission rather than granting it.
   *
   * `.default([])` reads a ledger written before this field existed. Those
   * files were written by a build whose applier could overwrite anything, so
   * an empty set is also the honest answer for them: nothing in that jar is
   * known to be host-contributed.
   */
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
  /**
   * The highest revision this connection was actually sent in a digest. See
   * {@link recordForgetLedgerAck} for why an ack is worth no more than that,
   * and nothing at all before the first digest.
   */
  readonly sentRevision: number;
}

let store: StrictJsonFileStore<ForgetLedgerRecord> | null = null;
let ledger: ForgetLedgerRecord = EMPTY_RECORD;
/**
 * The acked revision of each LIVE stream incarnation, in memory only.
 *
 * Per connection rather than per host, and deliberately narrower than the
 * durable `ackedByHost`: the two answer different questions. The durable one
 * asks "what does this host still owe me?", which must survive a restart or the
 * next digest would re-clear sites the user signed back into. This one asks
 * "has THIS connection confirmed it pruned?", and a fresh connection has not -
 * whatever an earlier one did - so it starts at zero and every observation for
 * a ledger-covered domain drops until its first ack. That costs one attach
 * round trip and buys a gate that never trusts a stream it has not heard from.
 */
const ackedByConnectionId = new Map<string, number>();
/**
 * Clears that finished ahead of an older one that has not - see
 * {@link markBrowserForgetLedgerCleared}. Drains as the gap fills, and holds
 * at most one entry per forget action of this run.
 */
const completedClears = new Set<number>();
/**
 * {@link ForgetLedgerRecord.headlessOriginKeys} as ids, for the per-cookie
 * lookup the applier does on every observed cookie. Rebuilt from the record on
 * every change rather than maintained alongside it, so there is one source of
 * truth and no way for the two to drift.
 */
let headlessOriginKeyIds = new Set<string>();
const changeListeners = new Set<() => void>();

export function browserForgetLedgerFilePath(): string {
  return join(app.getPath("userData"), FORGET_LEDGER_FILE_NAME);
}

/**
 * `on-ready`, beside the saved-logins pref. A missing or unparseable file reads
 * back as an EMPTY ledger at revision 0 - nothing forgotten, nobody acked -
 * rather than wedging: a corrupt ledger must not be able to stop the user
 * signing in, and the worst it costs is that hosts are not re-told about
 * forgets this machine can no longer name.
 */
export async function initBrowserForgetLedger(filePath: string): Promise<void> {
  store = createJsonFileStore<ForgetLedgerRecord>(
    filePath,
    EMPTY_RECORD,
    (value) => recordSchema.safeParse(value).data ?? EMPTY_RECORD,
  );
  completedClears.clear();
  ledger = await store.load();
  reindexHeadlessOriginKeys();
  log.info("[browser-view] forget ledger loaded", {
    revision: ledger.revision,
    domains: ledger.domains.length,
    forgetAll: ledger.forgetAll !== null,
  });
}

/**
 * "Forget all browser logins": one instruction that covers every site, so the
 * per-domain rows are dropped - they can add nothing to a floor that is already
 * under all of them.
 *
 * In memory FIRST and synchronously, before the durable write is awaited,
 * because the bump is what starts refusing in-flight observations and the
 * caller is about to empty the jar. A write that fails leaves this run's ledger
 * ahead of the file; the next launch re-reads the older one, which under-tells
 * hosts rather than over-telling them, and is the direction a failed write must
 * take.
 */
export async function recordForgetAllBrowserLogins(): Promise<number> {
  const revision = ledger.revision + 1;
  mutate({
    revision,
    // Carried to the revision just below this one, because the rows that made
    // the gap are deleted on the next line and nothing can ever mark them
    // cleared again. Left where it was, an older clear-site that failed wedges
    // the CONTIGUOUS drain in `markBrowserForgetLedgerCleared` for good: this
    // forget-all completes, its own revision never becomes contiguous, and the
    // boot reconciler re-forgets every login at every launch forever. Sound
    // rather than optimistic - emptying the whole jar subsumes every clear
    // below it, and this forget-all's own revision stays pending until its
    // clear finishes, so a crash here still re-runs it.
    clearedThrough: revision - 1,
    forgetAll: { at: Date.now(), revision },
    domains: [],
    ackedByHost: ledger.ackedByHost,
    // Every login is going, so every custody mark goes with it: the jar this
    // machine wakes up with holds nothing a host contributed.
    headlessOriginKeys: [],
  });
  await persist();
  return revision;
}

/**
 * One site forgotten: "Clear" in Settings or on a tile, and the host-driven
 * evict that says another machine of the user's cleared it.
 *
 * The evict is recorded too, and that is not redundancy. It makes this ledger
 * the machine's complete record of what is gone, so a host that hears about it
 * only from here still prunes - and it starts the same refusal window for
 * in-flight observations that a local clear gets.
 *
 * A domain that does not collapse to a registrable one is not recorded: the
 * ledger's entries are the blast radius of a clear, and a row nothing can match
 * would be a forget that never fires.
 */
export async function recordForgottenBrowserSite(
  domain: string,
): Promise<number> {
  const scope = registrableDomain(domain);
  if (scope === null) {
    log.warn("[browser-view] not recording a forget for an underivable site");
    return ledger.revision;
  }
  const revision = ledger.revision + 1;
  mutate({
    revision,
    clearedThrough: ledger.clearedThrough,
    forgetAll: ledger.forgetAll,
    domains: trimDomains([
      ...ledger.domains.filter((entry) => entry.domain !== scope),
      { domain: scope, forgottenAt: Date.now(), revision },
    ]),
    ackedByHost: ledger.ackedByHost,
    // The custody marks go with the cookies they describe. Leaving them would
    // let a host re-add the key AND keep the right to overwrite it later, on
    // the strength of a contribution the user has since deleted.
    headlessOriginKeys: ledger.headlessOriginKeys.filter(
      (key) => registrableDomain(key.domain) !== scope,
    ),
  });
  await persist();
  return revision;
}

/**
 * The local jar clear for `revision` finished. Until this lands, a crash
 * leaves the ledger claiming a site is gone while the jar still serves it -
 * and the jar is the master, so the next whole-jar capture would re-teach
 * every host the login the user deleted.
 *
 * Only ever advances, and never past the ledger's own top: a clear cannot have
 * completed work no forget has recorded.
 */
export async function markBrowserForgetLedgerCleared(
  revision: number,
): Promise<void> {
  if (revision <= ledger.clearedThrough || revision > ledger.revision) return;
  // A CONTIGUOUS watermark, not a high-water mark, because two clears of
  // different sites run in parallel through the jar serializer and can
  // complete out of order. Advancing straight to the newest completed
  // revision would step over an older one that crashed, and the boot
  // reconciliation would never re-run it - the exact gap this field exists to
  // close. Held in memory only: a completion the process did not live to
  // record is one the next launch re-runs anyway.
  completedClears.add(revision);
  let clearedThrough = ledger.clearedThrough;
  // A revision the ledger no longer REPRESENTS can never be completed, and the
  // contiguous drain must step over it rather than wedge on it. That happens
  // whenever a row is superseded before its clear finishes - forget a site
  // twice and the second record replaces the first's row - or when
  // `trimDomains` drops one. Nothing is pending for such a revision by
  // definition, so treating it as complete re-runs no clear; leaving it as a
  // hole is what made the boot reconciler re-clear the same site at every
  // launch forever, deleting whatever login the user created in between.
  const nothingPendingAt = (candidate: number): boolean =>
    candidate <= ledger.revision &&
    ledger.forgetAll?.revision !== candidate &&
    !ledger.domains.some((entry) => entry.revision === candidate);
  while (
    completedClears.delete(clearedThrough + 1) ||
    nothingPendingAt(clearedThrough + 1)
  ) {
    clearedThrough += 1;
  }
  if (clearedThrough === ledger.clearedThrough) return;
  mutate({ ...ledger, clearedThrough });
  await persist();
}

/**
 * What a forget recorded but never finished clearing - read once at startup,
 * before any host stream is serviced.
 *
 * `forgetAll` and `domains` are the instructions to re-run, and re-running
 * them is free: emptying a site twice is emptying it. An empty answer (the
 * normal case) means every forget this machine recorded also completed.
 */
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
    // Per ENTRY, never "something is pending, so re-run everything": a
    // forget-all that already completed must not be re-run because a later
    // single-site clear did not, or one crashed clear-site would empty the
    // whole jar on the next launch.
    //
    // Each entry carries its OWN revision, and that is what the reconciler
    // marks as it finishes it. Marking the ledger's top instead - which is
    // whatever the newest forget happened to be - adds a number the drain can
    // never reach past, and one wedge is permanent.
    forgetAll:
      forgetAll !== null && forgetAll.revision > cleared
        ? { revision: forgetAll.revision }
        : null,
    domains: ledger.domains
      .filter((entry) => entry.revision > cleared)
      .map((entry) => ({ domain: entry.domain, revision: entry.revision })),
  };
}

/**
 * The digest for one host: everything it has not yet acked, plus the ledger's
 * CURRENT top revision.
 *
 * The revision is the top rather than the highest entry included, because the
 * ack means "pruned through here" and not "pruned what was in that frame". An
 * empty digest is therefore not a wasted frame - it is how a caught-up host's
 * fresh connection tells this machine it may start accepting that connection's
 * observations again, which is why one is sent at every attach.
 */
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
 * A host finished pruning through `revision`. Both watermarks advance, and
 * both only ever advance: an ack that arrived out of order, or one replayed on
 * a reconnect, must never lower what a later one established.
 *
 * The gate reopens on the SYNCHRONOUS half - the in-memory maps - so the
 * awaited durable write never delays an observation. What it buys is that the
 * per-host watermark survives a restart, which is what stops the next digest
 * re-asserting a forget this host has already applied.
 */
export async function recordForgetLedgerAck(
  ack: BrowserForgetLedgerAck,
): Promise<void> {
  // CLAMPED twice, and both clamps are load-bearing rather than defensive.
  //
  // To this machine's own top, because the revision is minted here and merely
  // echoed by the host: an ack above the current one is meaningless by
  // construction, but taken at face value it would be recorded as "pruned
  // through here" for a ledger that does not exist yet, which permanently
  // disables the no-resurrection gate (every future entry compares below it)
  // and empties every future digest for that host.
  //
  // And to what this CONNECTION was actually sent, because the ack is
  // otherwise unsolicited: nothing in the frame ties
  // it to a digest, so a host that was told nothing could ack anyway and open
  // the gate on the strength of its own claim. `sentRevision` is 0 until a
  // digest goes out on that connection, so a pre-digest ack clamps to 0 and
  // both watermarks below decline it - no branch of its own, because it is the
  // BINDING between the two frames rather than a filter in front of them.
  //
  // A host is not trusted to bound its own echo, and it is not trusted to say
  // what it was asked.
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

/**
 * Is this observation for a site the user forgot at a revision this connection
 * has not confirmed pruning?
 *
 * This is the whole no-resurrection gate, and it answers on facts only: the
 * ledger says the site was forgotten at revision R, the connection has acked
 * through A, and an observation is refused exactly when R > A. Before a
 * connection's first ack, A is 0 and everything the ledger covers is refused -
 * which is right, because a host that has told this machine nothing has told it
 * nothing about the forget either.
 *
 * A forget-all covers every domain, so its revision is checked first and needs
 * no per-domain row to stand on.
 */
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

/**
 * Is this cookie key one an observed frame put in the jar?
 *
 * The whole ownership rule reads out of here. `false` means the desktop owns
 * the key - either its own browsing wrote it,
 * or this machine has no record of anyone else having done so - and a host may
 * not overwrite it. It never means "absent from the jar": whether the jar
 * holds the key at all is the applier's question, asked of the jar.
 */
export function isHeadlessOriginCookieKey(keyId: string): boolean {
  return headlessOriginKeyIds.has(keyId);
}

/**
 * These keys are the contributing host's to update from now on.
 *
 * Recorded BEFORE the cookies are written, not after, and the ordering is the
 * argument: the desktop's own cookie observer hands ownership back on any
 * local write it sees, so recording afterwards would let a page's concurrent
 * write to the same key be overtaken by this record and leave a
 * desktop-written key marked as the host's. Recording first means the worst a
 * race produces is a key that goes straight back to the desktop.
 *
 * A key the jar then refuses is marked all the same, which costs nothing: it
 * names a cookie that does not exist, and the desktop's first local write of
 * it takes the mark back.
 */
export async function recordHeadlessOriginCookieKeys(
  keys: readonly BrowserCookieKey[],
): Promise<void> {
  const added = keys.filter(
    (key) => !headlessOriginKeyIds.has(cookieKeyId(key)),
  );
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

/**
 * These keys are the desktop's again - either its own browsing wrote them, or
 * the jar refused the write the claim was taken for.
 *
 * Called for every local cookie insert the observer sees, which is ordinary
 * traffic on every site - so the common answer is "not a key anyone
 * contributed" and nothing is written. Only the rare transfer touches the file.
 *
 * The persist is a DURABILITY OBLIGATION, not best effort, and it is the one
 * direction in this file where a lost write grants a right instead of removing
 * one: the in-memory index drops synchronously, but a crash before the file
 * lands re-reads the key on the next boot as the host's, over a cookie the
 * user's own browsing now owns. So it goes on the ledger's write queue with
 * every other mutation and a failure is surfaced at WARN rather than dropped -
 * there is nothing to retry against a jar that has moved on, but a lost mark
 * has to be explainable.
 */
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

/**
 * Every forget mutation. Each live stream answers by pushing its own host's
 * digest, which it reads for itself - so the edge carries no payload. Ack
 * bookkeeping deliberately does NOT notify: it changes what a host is owed, not
 * what any host must be told.
 */
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
  for (const listener of [...changeListeners]) listener();
}

/**
 * `save`, not `saveStrict`: a failed write is reported by the store itself and
 * must not reach the caller, who is in the middle of emptying the jar on the
 * user's instruction. A ledger that did not reach disk is not a reason to
 * leave the logins in place - the in-memory bump has already closed the gate
 * for this run, and the next launch under-tells hosts rather than over-telling
 * them.
 */
function persist(): Promise<void> {
  return store?.save(ledger) ?? Promise.resolve();
}

/**
 * The wire bound, applied here because the desktop is the only end that can
 * choose what to drop.
 *
 * Oldest revision first, which IS the contract's "oldest timestamps" rule
 * without a second ordering to keep in step with it - the revision is
 * monotonic in the same order the clock is. The contract's other trim step,
 * dropping entries a forget-all already covers, is vacuous here: a forget-all
 * clears the map, so no surviving row can predate one.
 */
function trimDomains(
  domains: readonly ForgetLedgerRecord["domains"][number][],
): ForgetLedgerRecord["domains"] {
  if (domains.length <= BROWSER_FORGET_LEDGER_MAX_DOMAINS) return [...domains];
  return [...domains]
    .sort((left, right) => left.revision - right.revision)
    .slice(-BROWSER_FORGET_LEDGER_MAX_DOMAINS);
}
