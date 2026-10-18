import { createHash, randomUUID } from "node:crypto";
import { platform as osPlatform } from "node:os";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorCode } from "./credentials-fs";
import {
  holderProvablyDead,
  ownPidStartFingerprintAsync,
} from "./credentials-lock";

/**
 * Cross-process lock for `config.json` read-modify-writes
 * (`config.json.lock` beside it). The host, the CLI and the desktop main
 * process all mutate that one document, each by reading it whole, changing
 * one block and renaming a whole new document over it; without this lock a
 * writer whose read predates another writer's rename silently reverts that
 * write. Readers never take it: the rename keeps every whole-document read
 * atomic.
 *
 * The holder's record (pid, start-time fingerprint, nonce) is written to a
 * temp file of its own, then hard-linked into place, which fails with EEXIST
 * when the lock exists, so the lock appears complete. On a filesystem without
 * hard links the record is written by an `O_CREAT | O_EXCL` create instead
 * (`flag: "wx"`, `CREATE_NEW` on Windows), which can leave an empty lock
 * behind a holder stopped between the create and the write.
 *
 * A lock is broken only when it is older than `staleAgeMs` AND it names a
 * holder that is provably dead: the pid is gone, or its start-time
 * fingerprint changed (the pid was reused). A live holder, one whose liveness
 * cannot be decided, and a lock that names no holder (empty or unparseable)
 * are never broken, however old - the contender times out with an error
 * naming the lock path instead. The age guard keeps a holder whose pid this
 * process cannot see (another pid namespace sharing the home directory) from
 * being judged dead mid-write; a legitimate hold lasts one read, merge, write
 * and rename.
 *
 * Breaking is exclusive per dead record: only the creator of the break token
 * for that record's nonce (`config.json.lock.break-<hash>.<generation>`) may
 * unlink the lock, and only after re-reading it and finding that same record.
 * Every other breaker of the record loses the token race and waits, so no
 * breaker can remove a lock that replaced the dead one. A token whose creator
 * died is never removed by another breaker; the next one claims the
 * generation after the highest that exists instead. Tokens of records that
 * are gone are swept by the next holder.
 */

export interface CliConfigLockTiming {
  // Longest a contender waits for the lock before failing.
  readonly waitMs: number;
  // Poll cadence while waiting.
  readonly pollMs: number;
  // Minimum lock age (file mtime) before a dead holder's lock may be broken.
  readonly staleAgeMs: number;
  // Backoff for a release that failed in the foreground, retried in the
  // background until it lands (the last delay repeats).
  readonly backgroundReleaseDelaysMs: readonly number[];
}

const DEFAULT_TIMING: CliConfigLockTiming = {
  waitMs: 15_000,
  pollMs: 25,
  staleAgeMs: 5_000,
  backgroundReleaseDelaysMs: [100, 250, 500, 1_000, 2_000, 5_000],
};

// How long a live verdict for one lock record is reused before probing again,
// so a contender polling behind a live holder does not spawn `tasklist` (the
// Windows liveness probe) on every poll.
const LIVE_VERDICT_REUSE_MS = 1_000;

// Windows reports a create or link over a file that is being deleted (a
// peer's release still has a handle open) as access denied rather than
// EEXIST. That is a busy lock, not an I/O failure.
const TRANSIENT_WINDOWS_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

// What `link` answers on a filesystem without hard links: EPERM on a FAT
// volume under Linux, ENOTSUP / EOPNOTSUPP / ENOSYS elsewhere, and EISDIR,
// libuv's reading of the ERROR_INVALID_FUNCTION a FAT volume gives Windows.
// The exclusive create still works there.
const LINK_UNSUPPORTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EISDIR",
]);

const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 15;

let timingOverride: CliConfigLockTiming | null = null;

/** Overrides some of the lock's timings for tests; `null` restores them all. */
export function setCliConfigLockTimingForTests(
  timing: Partial<CliConfigLockTiming> | null,
): void {
  timingOverride = timing === null ? null : { ...DEFAULT_TIMING, ...timing };
}

function currentTiming(): CliConfigLockTiming {
  return timingOverride ?? DEFAULT_TIMING;
}

export interface CliConfigLockHandle {
  // Whether the lock file still carries this handle's record. Checked right
  // before the config rename, so a holder whose lock was taken from it
  // (a misjudged takeover) writes nothing.
  stillHeld(): Promise<boolean>;
  // Owner-checked unlink: removes the lock only while it is still ours. A
  // removal that keeps failing is never dropped: it is logged and retried
  // in the background and before this process's next acquire.
  release(): Promise<void>;
}

interface LockRecord {
  readonly pid: number;
  readonly pidStartTime: string | null;
  readonly nonce: string;
  readonly acquiredAt: number;
}

// This process's own locks whose release has not landed yet, by lock path.
const unreleased = new Map<string, LockRecord[]>();

// Retries of those releases, chained per lock path. The ownership check and
// the unlink are two steps, so two retries of one record running at once
// could both pass the check, and the second would unlink the fresh lock that
// replaced the record after the first removed it.
const removalChains = new Map<string, Promise<void>>();

function serializeRemoval(
  lockPath: string,
  removal: () => Promise<void>,
): Promise<void> {
  const run = (removalChains.get(lockPath) ?? Promise.resolve()).then(removal);
  const settled = run.catch(() => undefined);
  removalChains.set(lockPath, settled);
  void settled.then(() => {
    if (removalChains.get(lockPath) === settled) removalChains.delete(lockPath);
  });
  return run;
}

function isUnreleased(lockPath: string, record: LockRecord): boolean {
  return (unreleased.get(lockPath) ?? []).some(
    (entry) => entry.nonce === record.nonce,
  );
}

/** Retries one pending release, unless another retry already landed it. */
function retryRelease(lockPath: string, record: LockRecord): Promise<boolean> {
  let landed = false;
  return serializeRemoval(lockPath, async () => {
    if (!isUnreleased(lockPath, record)) {
      landed = true;
      return;
    }
    if (await removeIfOurs(lockPath, record)) {
      forget(lockPath, record);
      landed = true;
    }
  }).then(() => landed);
}

/**
 * Acquires the lock at `lockPath`, waiting up to the configured `waitMs`.
 * Throws when the wait runs out, naming only the lock path, so the caller
 * writes nothing without the lock.
 */
export async function acquireCliConfigLock(
  lockPath: string,
): Promise<CliConfigLockHandle> {
  const timing = currentTiming();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const record: LockRecord = {
    pid: process.pid,
    pidStartTime: await ownPidStartFingerprintAsync(),
    nonce: randomUUID(),
    acquiredAt: Date.now(),
  };
  const serialized = JSON.stringify(record);
  const deadline = Date.now() + timing.waitMs;
  let liveVerdict: { readonly raw: string; readonly until: number } | null =
    null;
  while (true) {
    await releaseUnreleased(lockPath);
    await removeRetainedTokens();
    if (await tryCreate(lockPath, serialized)) {
      await sweepBreakTokens(lockPath, record.nonce);
      return makeHandle(lockPath, record);
    }
    const holder = await readHolder(lockPath);
    if (holder === null) {
      // Released between our create and read: retry at once, within the wait.
      if (Date.now() >= deadline) throw lockTimeoutError(timing, lockPath);
      continue;
    }
    const ageMs = await lockAgeMs(lockPath);
    if (
      holder.record !== null &&
      ageMs !== null &&
      ageMs >= timing.staleAgeMs
    ) {
      const reuseVerdict =
        liveVerdict !== null &&
        liveVerdict.raw === holder.raw &&
        Date.now() < liveVerdict.until;
      if (!reuseVerdict) {
        if (await recordHolderDead(holder.record)) {
          if (
            await breakDeadLock(
              lockPath,
              holder.raw,
              holder.record.nonce,
              serialized,
              timing,
              deadline,
            )
          ) {
            continue;
          }
        } else {
          liveVerdict = {
            raw: holder.raw,
            until: Date.now() + LIVE_VERDICT_REUSE_MS,
          };
        }
      }
    }
    if (Date.now() >= deadline) throw lockTimeoutError(timing, lockPath);
    await sleep(timing.pollMs);
  }
}

function lockTimeoutError(
  timing: CliConfigLockTiming,
  lockPath: string,
): Error {
  return new Error(
    `Timed out after ${timing.waitMs}ms waiting for the settings lock ${lockPath}. Another Traycer process is changing settings; if none is running, delete that file and retry.`,
  );
}

/**
 * Removes the dead lock whose bytes are `deadRaw`, if this contender wins the
 * break token for its nonce. Resolves `true` when the caller should retry its
 * create at once (the lock is gone, by this breaker or another), `false` to
 * keep waiting.
 *
 * The generation to claim is the one after the highest that exists, read from
 * the directory each attempt, and is taken only when every existing token's
 * creator died holding it. There is no fixed number of generations: however
 * many breakers died mid-break, the next one can still break, and the acquire
 * deadline is the only bound.
 */
async function breakDeadLock(
  lockPath: string,
  deadRaw: string,
  deadNonce: string,
  serialized: string,
  timing: CliConfigLockTiming,
  deadline: number,
): Promise<boolean> {
  const tokenBase = breakTokenBase(lockPath, deadNonce);
  // Creators already proven dead in this call, so a long chain of dead tokens
  // is probed once per creator, not once per generation per attempt.
  const deadCreators = new Set<string>();
  while (Date.now() < deadline) {
    const generations = await tokenGenerations(tokenBase);
    // Any token whose creator is not provably dead is a breaker at work (or
    // one nothing proves dead): it alone may remove this record, so we wait.
    for (const generation of generations) {
      if (
        !(await tokenCreatorDead(
          `${tokenBase}.${generation}`,
          timing,
          deadCreators,
        ))
      ) {
        return false;
      }
    }
    const next = generations.reduce((max, g) => Math.max(max, g + 1), 0);
    const tokenPath = `${tokenBase}.${next}`;
    if (await tryCreate(tokenPath, serialized)) {
      try {
        // Only this token's creator may remove the record, and the lock cannot
        // change under it: the dead holder will not release, and every other
        // breaker of this record needs this token.
        const current = await readHolder(lockPath);
        if (current === null || current.raw !== deadRaw) return true;
        try {
          await unlink(lockPath);
        } catch (err) {
          const code = errorCode(err);
          // A Windows sharing violation is contention: wait and try again.
          if (isTransientWindowsError(code)) return false;
          if (code !== "ENOENT") throw err;
        }
        return true;
      } finally {
        // Never fails the acquire. A token that will not go is retried by this
        // process: when the dead lock is still there (a blocked unlink), only
        // its removal lets the next breaker in, since it names a live creator.
        await rm(tokenPath, { force: true }).catch(() => {
          retainTokenRemoval(tokenPath, serialized);
        });
      }
    }
    // Another breaker claimed that generation first: look again.
  }
  return false;
}

/** The generations of the break tokens that exist under `tokenBase`. */
async function tokenGenerations(tokenBase: string): Promise<number[]> {
  const prefix = `${basename(tokenBase)}.`;
  let entries: string[];
  try {
    entries = await readdir(dirname(tokenBase));
  } catch {
    return [];
  }
  const generations: number[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue; // a breaker's temp file
    const generation = Number(suffix);
    if (Number.isSafeInteger(generation)) generations.push(generation);
  }
  return generations;
}

/**
 * Whether the token at `tokenPath` was left by a creator that died holding it:
 * a complete record, older than the stale age, whose holder is provably dead.
 * A token that vanished, is young, names no holder, or whose holder may be
 * alive is not.
 */
async function tokenCreatorDead(
  tokenPath: string,
  timing: CliConfigLockTiming,
  deadCreators: Set<string>,
): Promise<boolean> {
  const token = await readHolder(tokenPath);
  if (token === null || token.record === null) return false;
  const ageMs = await lockAgeMs(tokenPath);
  if (ageMs === null || ageMs < timing.staleAgeMs) return false;
  const creator = `${token.record.pid}:${token.record.pidStartTime ?? ""}`;
  if (deadCreators.has(creator)) return true;
  if (!(await recordHolderDead(token.record))) return false;
  deadCreators.add(creator);
  return true;
}

function breakTokenPrefix(lockPath: string): string {
  return `${basename(lockPath)}.break-`;
}

function breakTokenBase(lockPath: string, nonce: string): string {
  // Hashed: the nonce comes from a file anyone could have written, so it
  // never becomes a path segment as is.
  const digest = createHash("sha256").update(nonce).digest("hex").slice(0, 32);
  return join(dirname(lockPath), `${breakTokenPrefix(lockPath)}${digest}`);
}

// A break token's own name: `<lock>.break-<32 hex>.<generation>`. A breaker's
// temp file for a token (`<token>.<uuid>.tmp`) does not match, so a sweep never
// pulls one from under a `link` in flight.
const BREAK_TOKEN_SUFFIX = /^[0-9a-f]{32}\.\d+$/;

/**
 * Removes every break token but those for `heldNonce`. Run by a new holder:
 * the record each other token names is gone for good (nonces never repeat),
 * so a breaker still working on one re-reads the lock, finds another record
 * and removes nothing.
 */
async function sweepBreakTokens(
  lockPath: string,
  heldNonce: string,
): Promise<void> {
  const dir = dirname(lockPath);
  const prefix = breakTokenPrefix(lockPath);
  const keep = `${basename(breakTokenBase(lockPath, heldNonce))}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.startsWith(prefix) &&
      BREAK_TOKEN_SUFFIX.test(entry.slice(prefix.length)) &&
      !entry.startsWith(keep)
    ) {
      await rm(join(dir, entry), { force: true }).catch(() => undefined);
    }
  }
}

function recordHolderDead(record: LockRecord): Promise<boolean> {
  return holderProvablyDead(record.pid, record.pidStartTime);
}

/**
 * One attempt to create the file at `path` carrying `serialized`. The record
 * goes into a temp file first and is linked into place, so the file never
 * exists without its record; where the filesystem has no hard links, an
 * exclusive create writes it instead.
 */
async function tryCreate(path: string, serialized: string): Promise<boolean> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      const code = errorCode(err);
      if (code === "EEXIST" || isTransientWindowsError(code)) return false;
      if (code === null || !LINK_UNSUPPORTED_ERROR_CODES.has(code)) throw err;
    }
    return await tryExclusiveCreate(path, serialized);
  } finally {
    // Best effort: once linked, the file at `path` is ours, and a temp file a
    // filesystem filter will not let go of yet must not turn that into a
    // failed acquire that leaves the lock behind.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function tryExclusiveCreate(
  path: string,
  serialized: string,
): Promise<boolean> {
  try {
    await writeFile(path, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === "EEXIST" || isTransientWindowsError(code)) return false;
    throw err;
  }
}

function isTransientWindowsError(code: string | null): boolean {
  return (
    osPlatform() === "win32" &&
    code !== null &&
    TRANSIENT_WINDOWS_ERROR_CODES.has(code)
  );
}

interface Holder {
  readonly raw: string;
  // `null` when the file names no holder (empty, unparseable, or unreadable
  // mid-release on Windows): never broken.
  readonly record: LockRecord | null;
  // The file exists but a Windows filter would not let us read it. Its owner
  // is unknown, not absent.
  readonly unreadable: boolean;
}

async function readHolder(path: string): Promise<Holder | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return null;
    if (isTransientWindowsError(code)) {
      return { raw: "", record: null, unreadable: true };
    }
    throw err;
  }
  return { raw, record: parseRecord(raw), unreadable: false };
}

function parseRecord(raw: string): LockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const pid = Reflect.get(parsed, "pid");
  const nonce = Reflect.get(parsed, "nonce");
  if (typeof pid !== "number" || typeof nonce !== "string") return null;
  const pidStartTime = Reflect.get(parsed, "pidStartTime");
  const acquiredAt = Reflect.get(parsed, "acquiredAt");
  return {
    pid,
    pidStartTime: typeof pidStartTime === "string" ? pidStartTime : null,
    nonce,
    acquiredAt: typeof acquiredAt === "number" ? acquiredAt : 0,
  };
}

async function lockAgeMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function isOurs(holder: Holder | null, record: LockRecord): boolean {
  return (
    holder !== null &&
    holder.record !== null &&
    holder.record.nonce === record.nonce &&
    holder.record.pid === record.pid
  );
}

/**
 * Removes `record`'s lock if it is still there. Resolves `true` once the lock
 * no longer carries it (removed now, or already gone or replaced), `false` on
 * a removal that failed and must be retried.
 */
async function removeIfOurs(
  lockPath: string,
  record: LockRecord,
): Promise<boolean> {
  try {
    const holder = await readHolder(lockPath);
    // An owner check a Windows filter blocked has not shown the lock is not
    // ours: retry it like a blocked unlink.
    if (holder !== null && holder.unreadable) return false;
    if (!isOurs(holder, record)) return true;
    await unlink(lockPath);
    return true;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

/** Retries this process's failed releases of `lockPath` once each. */
async function releaseUnreleased(lockPath: string): Promise<void> {
  const pending = unreleased.get(lockPath);
  if (pending === undefined) return;
  for (const record of [...pending]) await retryRelease(lockPath, record);
}

function forget(lockPath: string, record: LockRecord): void {
  const pending = unreleased.get(lockPath);
  if (pending === undefined) return;
  const rest = pending.filter((entry) => entry.nonce !== record.nonce);
  if (rest.length === 0) unreleased.delete(lockPath);
  else unreleased.set(lockPath, rest);
}

/**
 * Keeps calling `retry` with backoff until it reports it landed: a release
 * that failed in the foreground, or a break token that would not go. An
 * acquire in this process retries both first. Unref'd: a process that exits
 * leaves a dead holder or creator, which the next writer handles.
 */
function retryInBackground(
  retry: () => Promise<boolean>,
  attempt: number,
): void {
  const delays = currentTiming().backgroundReleaseDelaysMs;
  const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
  const timer = setTimeout(() => {
    void retry().then((landed) => {
      if (!landed) retryInBackground(retry, attempt + 1);
    });
  }, delay);
  timer.unref();
}

// This process's break tokens whose removal failed, by path, with the bytes
// this process wrote into each.
const retainedTokens = new Map<string, string>();

function retainTokenRemoval(tokenPath: string, serialized: string): void {
  retainedTokens.set(tokenPath, serialized);
  retryInBackground(() => retryTokenRemoval(tokenPath), 0);
}

/**
 * Removes a retained token if it still carries this process's bytes. Chained
 * per path like release retries, so two retries never remove a token another
 * breaker created at that path after the first removed ours.
 */
function retryTokenRemoval(tokenPath: string): Promise<boolean> {
  let landed = false;
  return serializeRemoval(tokenPath, async () => {
    const serialized = retainedTokens.get(tokenPath);
    if (serialized === undefined) {
      landed = true;
      return;
    }
    try {
      if ((await readFile(tokenPath, "utf8")) === serialized) {
        await rm(tokenPath, { force: true });
      }
      retainedTokens.delete(tokenPath);
      landed = true;
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        retainedTokens.delete(tokenPath);
        landed = true;
      }
    }
  }).then(() => landed);
}

/** Retries every retained token removal once. */
async function removeRetainedTokens(): Promise<void> {
  for (const tokenPath of [...retainedTokens.keys()]) {
    await retryTokenRemoval(tokenPath);
  }
}

function makeHandle(lockPath: string, record: LockRecord): CliConfigLockHandle {
  let released = false;
  return {
    stillHeld: async () => isOurs(await readHolder(lockPath), record),
    release: async () => {
      if (released) return;
      released = true;
      for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
        if (await removeIfOurs(lockPath, record)) return;
        // Transient (a Windows sharing violation): retry before handing it to
        // the background.
        if (attempt < RELEASE_ATTEMPTS - 1) await sleep(RELEASE_RETRY_MS);
      }
      console.warn(
        `Could not remove the settings lock ${lockPath}; retrying in the background.`,
      );
      unreleased.set(lockPath, [...(unreleased.get(lockPath) ?? []), record]);
      retryInBackground(() => retryRelease(lockPath, record), 0);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
