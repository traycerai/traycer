import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import {
  ensureHostDownloadCacheDir,
  hostDownloadCacheDir,
  HOST_DOWNLOAD_CACHE_SUBDIR,
} from "../store/paths";
import { isProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import {
  currentProcessIdentityToken,
  verifyProcessIdentityAsync,
  type ProcessIdentityToken,
  type ProcessIdentityVerdict,
} from "../store/process-identity";

// Cross-invocation staging for registry archive downloads (traycer#585,
// #586, #588).
//
// The archive used to land in a fresh `mkdtemp` dir per CLI process, so a
// re-spawned CLI could never see the previous invocation's partial file:
// every retry restarted from byte zero, and a 700MB host archive over a
// link that resets every few MB could never finish. Here the path is
// DERIVED from the version + sha256 instead, so the next process finds the
// partial and `downloadToFile` resumes it with a Range request.
//
// A predictable path means two CLI processes could otherwise append to the
// same file concurrently (`host download` runs its transfer phase outside
// the cli-lock, and nothing stops a user running `traycer host install` in
// a terminal while Desktop's download lane is mid-flight). Every entry is
// therefore claimed with an owner marker holding the claimant's process
// identity - the same pid + start-time token `install-staging/`'s temp dirs
// use. A live owner makes the caller fall back to a private, unshared path
// (correct, just without cross-process resume); a dead owner - the SIGKILL
// case this whole change exists for - is taken over and resumed.

const OWNER_SUFFIX = ".owner";
const PRIVATE_DIR_PREFIX = "private-";
const BREAK_SUFFIX = ".break";
// Every suffix that means something to `sweepDownloadCache`. A slot file name
// must not end in one - see `foldReservedSuffixes`. Add to this list, not
// just to the sweep, when introducing a new bookkeeping suffix.
const RESERVED_SLOT_SUFFIXES: readonly string[] = [OWNER_SUFFIX, BREAK_SUFFIX];
// A break sub-lock's critical section is a read plus an unlink, so one older
// than this belongs to a breaker that died mid-section.
const BREAK_MARKER_GRACE_MS = 30_000;
// Longest a publisher-controlled path component may contribute to a slot
// name. `sanitizeSegment` already reduces the alphabet; this bounds the
// length so a pathological manifest cannot push the resolved path past the
// filesystem's limit and fail every download with ENAMETOOLONG.
const MAX_SLOT_SEGMENT_LENGTH = 96;

// How long an entry whose owner CANNOT be identified must sit completely
// idle before another process may take it over. Only reached when
// `verifyProcessIdentity` answers "indeterminate" - a probe that positively
// says dead or alive-different frees the entry at once, and "alive-same"
// holds it regardless of age.
//
// Idleness, not the marker's own age, is the signal: a live downloader
// appends to its archive continuously and cannot go quiet for longer than
// `DOWNLOAD_WATCHDOG_MS` plus a capped backoff without aborting the
// attempt, and the verify/extract phase that follows still finishes well
// inside this window. A flat 24h marker-age ceiling was safe but far too
// blunt - on a host where the liveness probe itself is unavailable (a
// locked-down Windows with no usable `tasklist`, which is the reporter's
// platform) EVERY verdict is indeterminate, so the first abandoned marker
// pinned the shared slot for a day and silently turned cross-process
// resume back off: exactly the pre-fix behaviour, with a 700MB partial
// stranded next to it.
const UNIDENTIFIED_OWNER_IDLE_TAKEOVER_MS = 15 * 60 * 1000;

export interface DownloadSlot {
  // Where the archive should be streamed. Stable across CLI invocations
  // when `resumable` is true.
  readonly archivePath: string;
  // False when another live process already owns the shared slot and this
  // caller got a private per-invocation path instead. Callers do not need
  // to branch on it - it exists for logging and tests.
  readonly resumable: boolean;
}

export interface AcquireDownloadSlotOptions {
  readonly environment: Environment;
  readonly version: string;
  readonly sha256: string;
  readonly urlBasename: string;
}

// Claims the shared slot for `version`+`sha256`, falling back to a private
// temp path when a live process already holds it. Also sweeps entries no
// live process owns, so a superseded partial cannot pin hundreds of MB.
export async function acquireDownloadSlot(
  opts: AcquireDownloadSlotOptions,
): Promise<DownloadSlot> {
  const logger = createCliLogger(opts.environment);
  await ensureHostDownloadCacheDir(opts.environment);
  const cacheDir = hostDownloadCacheDir(opts.environment);
  const sharedName = slotFileName(opts);
  const archivePath = join(cacheDir, sharedName);
  const verdicts: IdentityVerdictCache = new Map();
  const slot =
    (await claimEntry(archivePath, verdicts)) !== "denied"
      ? { archivePath, resumable: true }
      : await createPrivateSlot(cacheDir, opts, logger);
  // The shared slot for THIS version is spared even when this caller fell
  // back to a private path - falling back is precisely what proves another
  // process is working on it. Without that, the loser of a race would sweep
  // the entry the winner is mid-takeover of: claim it in the window between
  // the winner's unlink and its own marker write, delete the partial, and
  // leave both processes on private paths with the resumable bytes gone.
  await sweepDownloadCache(
    opts.environment,
    new Set([
      sharedName,
      basename(claimedPathFor(opts.environment, slot.archivePath)),
    ]),
    verdicts,
  );
  return slot;
}

// Drops this process's claim while KEEPING the partial file, so the next
// invocation resumes it. For the failed-transfer path only.
export async function releaseDownloadSlotOwnership(
  environment: Environment,
  archivePath: string,
): Promise<void> {
  await releaseOwnerMarker(
    ownerPathFor(claimedPathFor(environment, archivePath)),
  );
}

// Removes the archive and its claim. For the terminal paths: the caller
// consumed the archive, or it is verified-bad and must not be resumed.
//
// Both halves are gated on still OWNING the claim. A slot legitimately
// changes hands while this process holds it - the idle takeover below fires
// during a long extract, for instance - and after that the archive and the
// marker belong to a fresh holder that is resuming them. Deleting on the
// path alone would blow away that holder's live claim and the bytes it is
// working on. Mirrors `host-lock/cross-process-lock.ts`'s compare-and-delete
// `release()`, which exists for exactly this reason.
export async function releaseDownloadSlot(
  environment: Environment,
  archivePath: string,
): Promise<void> {
  const claimed = claimedPathFor(environment, archivePath);
  if (!(await ownsMarker(ownerPathFor(claimed)))) return;
  await rm(claimed, { recursive: true, force: true }).catch(() => undefined);
  await rm(ownerPathFor(claimed), { force: true }).catch(() => undefined);
}

// Marks the claim as still being worked on. The idle rule that frees an
// unidentifiable owner measures the newest mtime across the marker and the
// entry it claims, and the phases AFTER the transfer - hashing, signature
// verification, and above all the caller's extract - only ever READ the
// archive, so its mtime stops advancing while the slot is still legitimately
// held. Without this the idle clock would run out mid-extract and another
// process could take the slot over.
export async function refreshDownloadSlotClaim(
  environment: Environment,
  archivePath: string,
): Promise<void> {
  const ownerPath = ownerPathFor(claimedPathFor(environment, archivePath));
  if (!(await ownsMarker(ownerPath))) return;
  const now = new Date();
  await utimes(ownerPath, now, now).catch(() => undefined);
}

// Compare-and-delete of an owner marker: drop it only if it is still ours.
async function releaseOwnerMarker(ownerPath: string): Promise<void> {
  if (!(await ownsMarker(ownerPath))) return;
  await rm(ownerPath, { force: true }).catch(() => undefined);
}

// Whether the marker at `ownerPath` is still this process's own claim. A pid
// is unique among live processes, so a marker recording our pid can only be
// ours. Anything we cannot positively attribute to ourselves is left alone.
async function ownsMarker(ownerPath: string): Promise<boolean> {
  const raw = await readMarkerRaw(ownerPath);
  if (raw === null) return false;
  const token = parseOwnerToken(raw);
  return token !== null && token.pid === process.pid;
}

// A shared slot is claimed at the archive path itself; a private slot is
// claimed at its containing `private-*` directory, so removing the claim
// removes the whole directory the archive sits in.
//
// The private case escalates a targeted delete into a RECURSIVE one, so it
// is admitted only for a directory that provably resolves to a child of this
// environment's own download cache. `releaseDownloadSlot` is exported and
// called for any archive the installer considers temporary, including
// archives this module never created; matching on the directory's name would
// let such an archive aim an `rm -rf` at its own parent.
function claimedPathFor(environment: Environment, archivePath: string): string {
  const parent = resolve(dirname(archivePath));
  const isPrivateSlot =
    basename(parent).startsWith(PRIVATE_DIR_PREFIX) &&
    dirname(parent) === resolve(hostDownloadCacheDir(environment));
  return isPrivateSlot ? parent : archivePath;
}

async function createPrivateSlot(
  cacheDir: string,
  opts: AcquireDownloadSlotOptions,
  logger: ILogger,
): Promise<DownloadSlot> {
  // A private path costs this invocation a full re-download, but two
  // writers appending to one file would corrupt both.
  //
  // Claim BEFORE creating the directory. The reverse order (the `mkdtemp`
  // this replaced) left a real window in which the directory existed with
  // no marker beside it, and a concurrent process's sweep reads exactly
  // that - an unowned entry - and recursively removes a live download.
  // With the marker first, a sweep landing mid-creation finds an orphaned
  // marker, reads this process's own live token from it, and leaves it
  // alone.
  const privateDir = join(cacheDir, `${PRIVATE_DIR_PREFIX}${randomUUID()}`);
  if (!(await createOwnerMarker(ownerPathFor(privateDir)))) {
    throw new Error(
      `host registry: download slot ${privateDir} is already claimed`,
    );
  }
  try {
    await mkdir(privateDir, { mode: 0o700 });
  } catch (err) {
    // Claiming first is what makes this safe, but it also means the claim
    // outlives a failed creation. Nothing would ever collect it: the sweep
    // judges an orphaned marker by its own freshness, and this one is fresh.
    await rm(ownerPathFor(privateDir), { force: true }).catch(() => undefined);
    throw err;
  }
  logger.warn("Registry download slot is owned by another live process", {
    environment: opts.environment,
    version: opts.version,
  });
  return {
    archivePath: join(privateDir, sanitizeBasename(opts.urlBasename)),
    resumable: false,
  };
}

// `<version>-<sha-prefix>-<publisher basename>`. The sha prefix is what
// makes resume safe across a re-publish: a changed asset resolves to a
// different path, so a stale partial is never appended to a new entity.
function slotFileName(opts: AcquireDownloadSlotOptions): string {
  // Both the version and the basename come off the manifest, so both are
  // length-capped; only the digest has a bound of its own.
  const version = sanitizeSegment(opts.version).slice(
    0,
    MAX_SLOT_SEGMENT_LENGTH,
  );
  const digest = sanitizeSegment(opts.sha256).slice(0, 16);
  return `${version}-${digest}-${sanitizeBasename(opts.urlBasename)}`;
}

// The basename comes from the manifest URL's last path segment, which is
// publisher-controlled. Everything outside a conservative allowlist is
// folded away so it can never contribute a separator, a parent-dir hop, or
// a leading dot to the resolved path.
function sanitizeBasename(value: string): string {
  const cleaned = sanitizeSegment(value)
    // A run of dots is never part of a real archive name, and a leading dot
    // would make the entry hidden. Neither can traverse anywhere once the
    // separators are gone, but both are folded away so the resolved name
    // stays boring and greppable.
    .replace(/\.{2,}/g, ".")
    .replace(/^[.]+/, "");
  const bounded =
    cleaned.length === 0
      ? "host-archive"
      : cleaned.slice(0, MAX_SLOT_SEGMENT_LENGTH);
  // AFTER the length cap, so a truncation cannot re-expose a suffix the fold
  // already removed.
  return foldReservedSuffixes(bounded);
}

// This module distinguishes an archive from its own bookkeeping purely by
// suffix, so a slot file must never END in one the sweep would act on.
// Nothing upstream prevents it: the basename is the manifest URL's last path
// segment, and `sanitizeSegment` deliberately preserves `.` and `-`, so a
// published asset named `…owner` or `…break` would land as `<version>-<digest>
// -x.owner`. Three things break at once if it does:
//
//   - `sweepDownloadCache` classifies it as an orphaned marker and hands it
//     to `readMarkerRaw`, which reads the whole file as UTF-8 - a several
//     hundred MB partial archive loaded into a string.
//   - A `.break` name is skipped by the sweep unconditionally, so its
//     partial is never reclaimed and pins the disk for good.
//   - `ownerPathFor` of a DIFFERENT slot named `x` resolves to `x.owner`,
//     which is that archive itself - the marker and the payload collide.
//
// Replacing the separating dot keeps the name recognizable while taking it
// out of the reserved namespace.
function foldReservedSuffixes(name: string): string {
  let folded = name;
  for (;;) {
    const reserved = RESERVED_SLOT_SUFFIXES.find((suffix) =>
      folded.endsWith(suffix),
    );
    // Terminates: every replacement ends in `-<suffix>`, which no reserved
    // suffix (each of which starts with `.`) can match.
    if (reserved === undefined) return folded;
    folded = `${folded.slice(0, -reserved.length)}-${reserved.slice(1)}`;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function ownerPathFor(claimedPath: string): string {
  return `${claimedPath}${OWNER_SUFFIX}`;
}

// How this process came to hold an entry. The sweep needs the distinction:
// "created from nothing" against an entry whose marker WAS listed a moment
// ago means the marker vanished in between, which is another process
// mid-takeover rather than litter.
type ClaimOutcome = "created" | "took-over" | "denied";

// Claims `claimedPath` for this process. Every path to a non-"denied"
// outcome ends in an EXCLUSIVE create, so at most one process can hold a
// given entry at a time; a loser falls back to a private slot.
//
// Deliberately not `host-lock/cross-process-lock`'s `acquireLock`, whose
// protocol this mirrors: that lock's contract is "wait for the holder", and
// an unidentifiable holder there correctly wedges forever because a wedge is
// safer than concurrent mutation of an install tree. A download slot wants
// the opposite two things - fall back to a private path instead of waiting,
// and eventually take over an entry nobody is working on, because "wait"
// here does not mean "be safe", it means "silently stop resuming and
// re-download 700MB".
async function claimEntry(
  claimedPath: string,
  verdicts: IdentityVerdictCache,
): Promise<ClaimOutcome> {
  const ownerPath = ownerPathFor(claimedPath);
  if (await createOwnerMarker(ownerPath)) return "created";
  // The exact bytes every decision below is made on.
  const decisionRaw = await readMarkerRaw(ownerPath);
  // Gone between the failed create and this read - it was released, or
  // another contender broke it. Either way the path may be free now.
  if (decisionRaw === null) {
    return (await createOwnerMarker(ownerPath)) ? "created" : "denied";
  }
  if (!(await markerIsStale(decisionRaw, ownerPath, verdicts))) return "denied";
  if (!(await breakStaleMarker(ownerPath, decisionRaw, verdicts))) {
    return "denied";
  }
  return (await createOwnerMarker(ownerPath)) ? "took-over" : "denied";
}

// Serializes the removal of a marker proved stale, then re-verifies the
// decision under that exclusivity.
//
// Both halves are load-bearing. Proving a marker stale is not the same as
// being the one allowed to replace it: two processes can reach that
// conclusion about the same marker, and the gap between deciding and acting
// is not microseconds - `markerIsStale` may shell out to `ps`/`tasklist`
// with a 3s timeout and retries, during which the real owner can exit and a
// THIRD process can claim the slot legitimately.
//
// A rename-to-claim protocol cannot close this, for the reason
// `host-lock/cross-process-lock.ts` sets out where it rejected the same
// idea: `rename` cannot be made conditional on what it is overwriting, so a
// delayed contender renames away a marker some genuinely fresh holder has
// since written, and any "restore it" recovery path can then clobber a
// third. Serializing the unlink behind an exclusively-created sub-lock is
// what makes it sound - while that sub-lock is held nobody else can unlink
// the marker, so a raw-byte comparison taken under it is conclusive proof
// the marker is still the exact one the staleness decision was made on.
async function breakStaleMarker(
  ownerPath: string,
  decisionRaw: string,
  verdicts: IdentityVerdictCache,
): Promise<boolean> {
  const breakPath = `${ownerPath}${BREAK_SUFFIX}`;
  const nonce = await acquireBreakMarker(breakPath, verdicts);
  if (nonce === null) return false;
  try {
    // A read failure is not evidence, and a marker whose bytes changed
    // belongs to a holder that appeared after the decision. Neither may be
    // unlinked.
    if ((await readMarkerRaw(ownerPath)) !== decisionRaw) return false;
    await rm(ownerPath, { force: true });
    return true;
  } finally {
    await releaseBreakMarker(breakPath, nonce);
  }
}

// Returns this acquisition's nonce, or null if another breaker holds the
// sub-lock. Recovery from a sub-lock left behind by a CRASHED breaker
// requires positive evidence that its writer is gone - age alone is not
// evidence. A live breaker descheduled between its re-read and its unlink
// would otherwise have its sub-lock stolen, and then two processes hold it:
// the second completes a legitimate takeover, and the first's unlink lands
// on the marker the second just wrote for itself. Both would append to one
// archive. Same ordering as
// `cross-process-lock.ts`'s `tryRecoverCrashedBreakLock` - identity first,
// age as an additional gate.
async function acquireBreakMarker(
  breakPath: string,
  verdicts: IdentityVerdictCache,
): Promise<string | null> {
  const first = await createBreakMarker(breakPath);
  if (first !== null) return first;
  const raw = await readMarkerRaw(breakPath);
  if (raw === null) return createBreakMarker(breakPath);
  const token = parseOwnerToken(raw);
  if (token !== null) {
    const verdict = await identityVerdictFor(token, verdicts);
    if (verdict !== "dead" && verdict !== "alive-different") return null;
  }
  const ageMs = await entryAgeMs(breakPath);
  if (ageMs === null || ageMs < BREAK_MARKER_GRACE_MS) return null;
  await rm(breakPath, { force: true }).catch(() => undefined);
  return createBreakMarker(breakPath);
}

// Compare-and-delete, mirroring `cross-process-lock.ts`'s
// `releaseBreakLock`: a recoverer that correctly took this sub-lock over
// from a presumed-crashed breaker must not have its ownership silently
// clobbered by that breaker's own late release.
async function releaseBreakMarker(
  breakPath: string,
  nonce: string,
): Promise<void> {
  const raw = await readMarkerRaw(breakPath);
  if (raw === null) return;
  if (parseBreakMarkerNonce(raw) !== nonce) return;
  await rm(breakPath, { force: true }).catch(() => undefined);
}

// The sub-lock carries this process's identity (so a contender can tell a
// crashed breaker from a live one) plus a per-acquisition nonce (so the
// release above can tell its own claim from a successor's).
async function createBreakMarker(breakPath: string): Promise<string | null> {
  const nonce = randomUUID();
  const payload = JSON.stringify({
    ...currentProcessIdentityToken(),
    nonce,
  });
  return (await createExclusive(breakPath, payload)) ? nonce : null;
}

function parseBreakMarkerNonce(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const nonce = (parsed as Record<string, unknown>).nonce;
  return typeof nonce === "string" ? nonce : null;
}

async function createOwnerMarker(ownerPath: string): Promise<boolean> {
  return createExclusive(
    ownerPath,
    JSON.stringify(currentProcessIdentityToken()),
  );
}

// Exclusive create: `wx` fails with EEXIST rather than truncating, which is
// what makes a claim a claim.
async function createExclusive(
  path: string,
  contents: string,
): Promise<boolean> {
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if (!isExistsError(err)) throw err;
    return false;
  }
}

// One `acquireDownloadSlot` call judges the slot it wants plus every entry
// in the sweep, and each judgement can shell out to `ps`/`tasklist` with a
// 3s timeout and retries - synchronously, on the event loop, before the
// download is allowed to start. Entries abandoned by the same process share
// a token, so memoizing per token collapses that to one probe per distinct
// owner.
type IdentityVerdictCache = Map<string, ProcessIdentityVerdict>;

async function identityVerdictFor(
  token: ProcessIdentityToken,
  cache: IdentityVerdictCache,
): Promise<ProcessIdentityVerdict> {
  // Keyed on the operand the verdict is actually derived from. Keying on
  // `startedAtMs` (which nothing reads any more) would let two tokens with
  // the same pid but different creation stamps share one cached verdict.
  const key = `${token.pid}:${token.startIdentity ?? "unknown"}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const verdict = await verifyProcessIdentityAsync(token);
  cache.set(key, verdict);
  return verdict;
}

// True when the process that wrote `decisionRaw` is not working on the
// entry any more.
async function markerIsStale(
  decisionRaw: string,
  ownerPath: string,
  verdicts: IdentityVerdictCache,
): Promise<boolean> {
  const token = parseOwnerToken(decisionRaw);
  if (token !== null) {
    const verdict = await identityVerdictFor(token, verdicts);
    // "alive-same" is the only verdict that proves the recorded downloader
    // still exists. "alive-different" means the pid was recycled onto an
    // unrelated process, which is positive evidence the owner is gone.
    if (verdict === "alive-same") return false;
    if (verdict === "dead" || verdict === "alive-different") return true;
  }
  // The marker says nothing usable - it is corrupt, or the identity probe
  // itself failed. Fall back to whether the claim is still being WORKED ON
  // rather than to how old the marker is.
  const idleMs = await entryIdleMs(ownerPath);
  return idleMs !== null && idleMs >= UNIDENTIFIED_OWNER_IDLE_TAKEOVER_MS;
}

// How long since anything last touched this claim: the newest mtime across
// the marker and the entry it claims. A private slot claims a DIRECTORY
// whose own mtime does not move while the archive inside it grows, so a
// directory resolves to the newest mtime among its children too.
async function entryIdleMs(ownerPath: string): Promise<number | null> {
  const claimedPath = ownerPath.slice(0, -OWNER_SUFFIX.length);
  const [markerMs, claimedMs] = await Promise.all([
    newestMtimeMs(ownerPath),
    newestMtimeMs(claimedPath),
  ]);
  const newest =
    markerMs === null || claimedMs === null
      ? (markerMs ?? claimedMs)
      : Math.max(markerMs, claimedMs);
  return newest === null ? null : Date.now() - newest;
}

async function entryAgeMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function newestMtimeMs(path: string): Promise<number | null> {
  let entryStat;
  try {
    entryStat = await stat(path);
  } catch {
    return null;
  }
  if (!entryStat.isDirectory()) return entryStat.mtimeMs;
  let children: string[];
  try {
    children = await readdir(path);
  } catch {
    return entryStat.mtimeMs;
  }
  const childTimes = await Promise.all(
    children.map(async (child) => {
      try {
        return (await stat(join(path, child))).mtimeMs;
      } catch {
        return null;
      }
    }),
  );
  return childTimes.reduce<number>(
    (newest, value) => (value !== null && value > newest ? value : newest),
    entryStat.mtimeMs,
  );
}

// `null` means the marker could not be read at all - it is absent, or the
// read failed. Neither is evidence about an owner, and neither may be
// compared against a staleness decision.
async function readMarkerRaw(ownerPath: string): Promise<string | null> {
  try {
    return await readFile(ownerPath, "utf8");
  } catch {
    return null;
  }
}

function parseOwnerToken(raw: string): ProcessIdentityToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== "number") return null;
  return {
    pid: obj.pid,
    startedAtMs: typeof obj.startedAtMs === "number" ? obj.startedAtMs : null,
    startIdentity: isProcessStartIdentity(obj.startIdentity)
      ? obj.startIdentity
      : null,
  };
}

// Best-effort removal of every entry no live process owns, except the one
// the caller just claimed. A partial for a superseded version is dead
// weight the moment a newer one resolves - the only file worth keeping
// across invocations is the one being downloaded now.
async function sweepDownloadCache(
  environment: Environment,
  spareNames: ReadonlySet<string>,
  verdicts: IdentityVerdictCache,
): Promise<void> {
  const logger = createCliLogger(environment);
  const cacheDir = hostDownloadCacheDir(environment);
  let entries;
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }
  const present = new Set(entries);
  const spared = (name: string): boolean =>
    spareNames.has(name) ||
    (name.endsWith(OWNER_SUFFIX) &&
      spareNames.has(name.slice(0, -OWNER_SUFFIX.length)));
  for (const name of entries) {
    if (spared(name)) continue;
    // Break sub-locks are transient and owned by whoever is mid-takeover;
    // `acquireBreakMarker` ages them out itself.
    if (name.endsWith(BREAK_SUFFIX)) continue;
    const entryPath = join(cacheDir, name);
    if (name.endsWith(OWNER_SUFFIX)) {
      // A marker whose claimed entry still exists is decided together with
      // that entry, below; only an orphaned marker is judged on its own,
      // and removing one is still an unlink another contender could be
      // racing, so it goes through the same arbitration.
      if (present.has(name.slice(0, -OWNER_SUFFIX.length))) continue;
      const orphanRaw = await readMarkerRaw(entryPath);
      if (orphanRaw === null) continue;
      if (!(await markerIsStale(orphanRaw, entryPath, verdicts))) continue;
      await breakStaleMarker(entryPath, orphanRaw, verdicts);
      continue;
    }
    // Claim the entry before deleting it. Proving it stale is not enough on
    // its own: another process can be taking the very same entry over to
    // RESUME it, and a sweep that deleted the archive out from under a
    // successful claim would throw away exactly the partial this cache
    // exists to preserve. Winning the claim is what proves nobody else got
    // there first; losing it means someone did, so leave it alone.
    const outcome = await claimEntry(entryPath, verdicts);
    if (outcome === "denied") continue;
    // The listing showed a marker, yet the claim created one from nothing:
    // the marker vanished in between, which is a contender that has already
    // unlinked it and is about to write its own. Sparing the CURRENT
    // version's slot is not enough to cover this - the entry being taken
    // over belongs to whatever version that other process wants, not ours.
    // Hand the claim straight back and leave its partial alone.
    if (outcome === "created" && present.has(ownerPathFor(name))) {
      await releaseOwnerMarker(ownerPathFor(entryPath));
      continue;
    }
    await removeSwept(entryPath, environment, logger);
    await removeSwept(ownerPathFor(entryPath), environment, logger);
  }
}

async function removeSwept(
  path: string,
  environment: Environment,
  logger: ILogger,
): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch((err) => {
    logger.warn("Registry failed to sweep a stale download-cache entry", {
      environment,
      errorName: errorFromUnknown(err).name,
    });
  });
}

function isExistsError(err: unknown): boolean {
  return errnoCodeOf(err) === "EEXIST";
}

function errnoCodeOf(err: unknown): string | null {
  if (err === null || typeof err !== "object" || !("code" in err)) return null;
  return typeof err.code === "string" ? err.code : null;
}
