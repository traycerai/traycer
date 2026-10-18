import { randomUUID } from "node:crypto";
import { platform as osPlatform } from "node:os";
import {
  link,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode } from "./credentials-fs";
import {
  breakStaleLock,
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
 * The lock only ever appears complete: the holder's record (pid, start-time
 * fingerprint, nonce) is written to a temp file of its own, then hard-linked
 * into place, which fails with EEXIST when the lock exists. On a filesystem
 * without hard links the record is written by an `O_CREAT | O_EXCL` create
 * instead (`flag: "wx"`, `CREATE_NEW` on Windows), which can leave an empty
 * lock behind a holder stopped between the create and the write; the caller's
 * {@link CliConfigLockHandle.stillHeld} check before its rename is the guard
 * for that path.
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
 */

export interface CliConfigLockTiming {
  // Longest a contender waits for the lock before failing.
  readonly waitMs: number;
  // Poll cadence while waiting.
  readonly pollMs: number;
  // Minimum lock age (file mtime) before a dead holder's lock may be broken.
  readonly staleAgeMs: number;
}

const DEFAULT_TIMING: CliConfigLockTiming = {
  waitMs: 15_000,
  pollMs: 25,
  staleAgeMs: 5_000,
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

// What `link` answers on a filesystem without hard links (FAT, exFAT, some
// network shares); the exclusive create still works there.
const LINK_UNSUPPORTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
]);

const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 15;

let timingOverride: CliConfigLockTiming | null = null;

/** Shortens the lock's waits for tests; `null` restores the defaults. */
export function setCliConfigLockTimingForTests(
  timing: CliConfigLockTiming | null,
): void {
  timingOverride = timing;
}

export interface CliConfigLockHandle {
  // Whether the lock file still carries this handle's record. Checked right
  // before the config rename, so a holder whose lock was taken from it
  // (the exclusive-create path, or a misjudged takeover) writes nothing.
  stillHeld(): Promise<boolean>;
  // Owner-checked unlink: removes the lock only while it is still ours.
  release(): Promise<void>;
}

interface LockRecord {
  readonly pid: number;
  readonly pidStartTime: string | null;
  readonly nonce: string;
  readonly acquiredAt: number;
}

/**
 * Acquires the lock at `lockPath`, waiting up to the configured `waitMs`.
 * Throws when the wait runs out, naming only the lock path, so the caller
 * writes nothing without the lock.
 */
export async function acquireCliConfigLock(
  lockPath: string,
): Promise<CliConfigLockHandle> {
  const timing = timingOverride ?? DEFAULT_TIMING;
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
    if (await tryCreate(lockPath, serialized)) {
      return makeHandle(lockPath, record);
    }
    const holder = await readHolder(lockPath);
    if (holder === null) continue; // released between our create and read
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
        if (
          await holderProvablyDead(
            holder.record.pid,
            holder.record.pidStartTime,
          )
        ) {
          if ((await breakStaleLock(lockPath, holder.raw)) === "removed") {
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
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timing.waitMs}ms waiting for the settings lock ${lockPath}. Another Traycer process is changing settings; if none is running, delete that file and retry.`,
      );
    }
    await sleep(timing.pollMs);
  }
}

/**
 * One attempt to take the lock. The record goes into a temp file first and is
 * linked into place, so the lock never exists without its record; where the
 * filesystem has no hard links, an exclusive create writes it instead.
 */
async function tryCreate(
  lockPath: string,
  serialized: string,
): Promise<boolean> {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      await link(tmp, lockPath);
      return true;
    } catch (err) {
      const code = errorCode(err);
      if (code === "EEXIST") return false;
      if (code === null || !LINK_UNSUPPORTED_ERROR_CODES.has(code)) throw err;
    }
    return await tryExclusiveCreate(lockPath, serialized);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function tryExclusiveCreate(
  lockPath: string,
  serialized: string,
): Promise<boolean> {
  try {
    await writeFile(lockPath, serialized, {
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
  // `null` when the lock names no holder (empty, unparseable, or unreadable
  // mid-release on Windows): never broken.
  readonly record: LockRecord | null;
}

async function readHolder(lockPath: string): Promise<Holder | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return null;
    if (isTransientWindowsError(code)) return { raw: "", record: null };
    throw err;
  }
  return { raw, record: parseRecord(raw) };
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

async function lockAgeMs(lockPath: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
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

function makeHandle(lockPath: string, record: LockRecord): CliConfigLockHandle {
  let released = false;
  return {
    stillHeld: async () => isOurs(await readHolder(lockPath), record),
    release: async () => {
      if (released) return;
      for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
        try {
          if (!isOurs(await readHolder(lockPath), record)) {
            // Gone, or not ours: nothing of ours to remove.
            released = true;
            return;
          }
          await unlink(lockPath);
          released = true;
          return;
        } catch (err) {
          if (errorCode(err) === "ENOENT") {
            released = true;
            return;
          }
          // Transient (a Windows sharing violation): retry so this process
          // does not leave its own live lock behind for every later writer.
          if (attempt < RELEASE_ATTEMPTS - 1) await sleep(RELEASE_RETRY_MS);
        }
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
