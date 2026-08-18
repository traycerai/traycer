import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../../config";
import type {
  PreferredHostSaveResult,
  PreferredHostStore,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { environmentSubdir } from "../host/host-paths";

const PREFERRED_HOST_STATE_VERSION = 1;

/**
 * Names the file in the refusal, not just the fact that one exists: the
 * reason surfaces all the way up to a user deciding whether to fix
 * permissions on it, and a fixed string with no path told them a file
 * existed somewhere without saying where to look.
 */
function unreadableStateReason(filePath: string): string {
  return `preferred-host state file exists but could not be read: ${filePath}`;
}

/**
 * A NEWER writer's file is a different refusal from an unreadable one, and
 * the reason says which: the user's fix is not "check permissions" but "you
 * rolled back; the newer Traycer's host preferences are in this file".
 */
function newerVersionStateReason(filePath: string, version: number): string {
  return `preferred-host state file was written by a newer Traycer (format v${version}, this build reads v${PREFERRED_HOST_STATE_VERSION}) and is left untouched: ${filePath}`;
}

interface PreferredHostStoreLogger {
  warn(message: string, meta: unknown): void;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Environment-scoped, mirroring `resolveDesktopStateFilePath`: a staging
 * window must not inherit the host a production window was activated on -
 * the ids name registry rows in different clouds.
 */
export function resolvePreferredHostFilePath(): string {
  const base = environmentSubdir(
    join(homedir(), ".traycer"),
    config.environment,
  );
  return join(base, "desktop-preferred-host.json");
}

/**
 * Durable, IDENTITY-SCOPED home of `preferredHostId` (G1).
 *
 * SYNCHRONOUS on purpose. The engine loads the preference inside the identity
 * transaction that establishes the identity, and an async load would land
 * after the first derivation - the user would watch the app pick a host and
 * then move. The file holds one short string per account and is written only
 * on Activate or a deregister-clear, so the main thread pays a rare small
 * write, never a hot path.
 *
 * A bucket is DELETED on sign-out rather than merely scoped: persistence
 * exists to survive a restart, not a user switch, and a shared machine must
 * not show the previous user their host choice. Scoping alone would already
 * stop account B inheriting account A's id; deleting also honours the
 * "sign-out wipes" half of G1.
 */
export class DesktopPreferredHostStore implements PreferredHostStore {
  private readonly filePath: string;
  private readonly logger: PreferredHostStoreLogger;
  /** Lazily read once, then authoritative: this process is the only writer. */
  private byIdentity: Map<string, string> | null = null;
  /**
   * Identity keys whose sign-out wipe could not be written. `load` refuses to
   * serve them and every call re-attempts, so a bucket promised wiped is never
   * handed back even while the disk lags behind the promise.
   */
  private readonly pendingWipes = new Set<string>();
  /**
   * Why the last `read()` answered `null`, for the refusal `save` returns.
   * Two different files produce that answer - one this build cannot READ and
   * one a NEWER build wrote - and the user's remedy differs, so the reason
   * must too. Overwritten on every `null` read; meaningless otherwise.
   */
  private refusalReason: string;

  constructor(filePath: string, logger: PreferredHostStoreLogger) {
    this.filePath = filePath;
    this.logger = logger;
    this.refusalReason = unreadableStateReason(filePath);
  }

  load(identityKey: string | null): string | null {
    if (identityKey === null) return null;
    this.drainPendingWipes();
    if (this.pendingWipes.has(identityKey)) {
      // Promised wiped, disk still lagging. Serving the stale value would make
      // the sign-out wipe a lie for exactly as long as the disk stays broken -
      // and G1's whole point is that the next user never sees the previous
      // one's choice. `drainPendingWipes` above has already re-attempted the
      // write; this answer holds whether or not it succeeded.
      return null;
    }
    // Unreadable reads as "no preference" here - the contract says a failed
    // READ is genuinely that, and derivation's local default is safe. It is
    // the WRITE paths that must not build on it.
    return this.read()?.get(identityKey) ?? null;
  }

  /**
   * COPY, PERSIST, SWAP - in that order, and the order is the fix.
   *
   * `read()` hands back the LIVE cache (this process is the only writer, so it
   * is authoritative), so mutating it before writing published the new
   * preference to the authority whether or not the disk agreed. Worse, the
   * no-op fast paths then read that mutated cache: an identical retry after a
   * failed write short-circuited on memory that already "had" the value, so
   * the user's second attempt wrote nothing and the failure latched until
   * restart. Building a copy leaves the cache at the last DURABLE state, which
   * is what makes the retry a real retry.
   */
  save(
    identityKey: string | null,
    hostId: string | null,
  ): PreferredHostSaveResult {
    if (identityKey === null) {
      // Signed out: there is no account whose choice could be remembered, so
      // there is nothing to fail at.
      return { ok: true };
    }
    this.drainPendingWipes();
    const current = this.read();
    if (current === null) {
      // The file exists and could not be read (or a newer build wrote it), so
      // the durable set is UNKNOWN.
      // A wipe cannot be confirmed absent - hold it pending so `load` refuses
      // the bucket and the next call re-attempts against a real read. An
      // Activate cannot merge into a set it cannot see: writing would replace
      // every other identity's preference with this one entry.
      if (hostId === null) this.pendingWipes.add(identityKey);
      return { ok: false, reason: this.refusalReason };
    }
    const next = new Map(current);
    if (hostId === null) {
      if (!next.delete(identityKey)) return { ok: true };
    } else {
      if (next.get(identityKey) === hostId) return { ok: true };
      next.set(identityKey, hostId);
    }
    const written = this.write(next);
    if (!written.ok) {
      if (hostId === null) {
        // A wipe that did not reach the disk. Remember it so `load` refuses to
        // serve the bucket meanwhile and every later call re-attempts.
        this.pendingWipes.add(identityKey);
      }
      return written;
    }
    this.pendingWipes.delete(identityKey);
    this.byIdentity = next;
    return { ok: true };
  }

  /**
   * Best-effort retry of wipes whose write failed, run at the top of every
   * store call. No timer and no backoff: the store has no lifecycle of its
   * own, and the calls that matter (a load during the next transition, the
   * next Activate) are exactly the moments the answer is about to be used.
   */
  private drainPendingWipes(): void {
    if (this.pendingWipes.size === 0) return;
    const current = this.read();
    // Still refused (unreadable, or a newer build's file): "absent from the
    // durable set" cannot be claimed off a
    // set we did not read, so the wipes stay pending rather than being cleared
    // as honoured.
    if (current === null) return;
    const next = new Map(current);
    let changed = false;
    for (const key of this.pendingWipes) {
      if (next.delete(key)) changed = true;
    }
    if (!changed) {
      // Already absent from the durable set - the wipe is honoured.
      this.pendingWipes.clear();
      return;
    }
    if (!this.write(next).ok) return;
    this.byIdentity = next;
    this.pendingWipes.clear();
  }

  /**
   * The durable set, or `null` when the file EXISTS but could not be read -
   * or was written by a NEWER build (see the version check below), which is
   * refused the same way for the same reason.
   *
   * Absent and unreadable are different answers and used to be one. An absent
   * file is a legitimate state (first run; derivation defaults to local) and
   * is cached as the empty set. An unreadable one is NOT cached: caching it as
   * empty made a transient `EACCES` authoritative for the rest of the process,
   * so a later sign-out found the identity "already absent", reported the wipe
   * done without writing, and the preference came back at the next launch -
   * and a later Activate would have written that false-empty set over every
   * other identity's preference. Callers treat `null` as "do not trust, do not
   * write"; the next call re-reads. Unreadable is refused, not repaired - a
   * repair would be exactly the clobber this prevents, so the reason names
   * the file (`unreadableStateReason`) instead, letting a user fix permissions
   * on the one path that actually needs it.
   */
  private read(): Map<string, string> | null {
    const cached = this.byIdentity;
    if (cached !== null) return cached;
    const entries = new Map<string, string>();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        this.byIdentity = entries;
        return entries;
      }
      this.logger.warn("[selection-preferred] state file unreadable", {
        error: String(error),
      });
      this.refusalReason = unreadableStateReason(this.filePath);
      return null;
    }
    // Cached only AFTER the format check below has passed or failed as
    // corrupt: a file this build must not overwrite (a newer version's) must
    // not be cached either, for the same reason an unreadable one is not.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") {
        this.byIdentity = entries;
        return entries;
      }
      const record: Record<string, unknown> = { ...parsed };
      const version = record["version"];
      if (
        typeof version === "number" &&
        version > PREFERRED_HOST_STATE_VERSION
      ) {
        // Written by a NEWER Traycer, then rolled back to this one. The file
        // is valid - it is just in a shape this build does not read - and it
        // holds every identity's preference for the newer build. Reading it
        // as empty and caching that would make a sign-out here report its
        // wipe honoured without touching the file, and an Activate here
        // REPLACE the file with one in THIS build's format holding a single
        // identity, deleting every other preference the newer build kept.
        // So it is refused exactly like an unreadable file: not cached, no
        // write built on it, derivation falls back to its local default, and
        // the reason names the file and both versions.
        this.logger.warn(
          "[selection-preferred] state file written by a newer version",
          { version, supported: PREFERRED_HOST_STATE_VERSION },
        );
        this.refusalReason = newerVersionStateReason(this.filePath, version);
        return null;
      }
      this.byIdentity = entries;
      // An OLDER or MISSING `version` degrades to empty, cached and
      // overwritable, silently: only this build has ever written the file, so
      // anything below v1 is malformed, not a format to preserve - and
      // refusing it would strand the user with no way to set a preference.
      if (version !== PREFERRED_HOST_STATE_VERSION) return entries;
      const byIdentity = record["byIdentity"];
      if (byIdentity === null || typeof byIdentity !== "object") return entries;
      for (const [key, value] of Object.entries({ ...byIdentity })) {
        if (typeof value === "string" && value.length > 0) {
          entries.set(key, value);
        }
      }
    } catch (error: unknown) {
      // A corrupt file degrades to "no preference", never to a crash: the
      // whole point of this value is that losing it is survivable. Unlike an
      // UNREADABLE file this IS cached and IS overwritten by the next save -
      // there is nothing left in it to protect.
      this.byIdentity = entries;
      this.logger.warn("[selection-preferred] corrupt state file", {
        error: String(error),
      });
    }
    return entries;
  }

  /**
   * Write-then-rename, and the failure is REPORTED rather than swallowed. No
   * `fsync`: the fault this defends against is a write that could not happen
   * at all (a full or read-only disk, a permissions change) being reported as
   * success - not power loss, whose window the rename already narrows.
   */
  private write(entries: Map<string, string>): PreferredHostSaveResult {
    const payload = JSON.stringify({
      version: PREFERRED_HOST_STATE_VERSION,
      byIdentity: Object.fromEntries(entries),
    });
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // A crash mid-write must not leave a truncated file that reads as "no
      // preference" on the next launch.
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(temporaryPath, payload, "utf8");
      renameSync(temporaryPath, this.filePath);
      return { ok: true };
    } catch (error: unknown) {
      const reason = String(error);
      this.logger.warn("[selection-preferred] state write failed", {
        error: reason,
      });
      return { ok: false, reason };
    }
  }
}
