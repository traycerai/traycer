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

function unreadableStateReason(filePath: string): string {
  return `preferred-host state file exists but could not be read: ${filePath}`;
}

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

/** Environment-scoped, mirroring `resolveDesktopStateFilePath`: a staging window must not inherit the host a production window was activated on. */
export function resolvePreferredHostFilePath(): string {
  const base = environmentSubdir(
    join(homedir(), ".traycer"),
    config.environment,
  );
  return join(base, "desktop-preferred-host.json");
}

/**
 * The engine loads the preference inside the identity transaction that establishes the identity, and an async load would land after the first derivation.
 * The file holds one short string per account and is written only on Activate or a deregister-clear, so the main thread pays a rare small write, never a hot path.
 */
export class DesktopPreferredHostStore implements PreferredHostStore {
  private readonly filePath: string;
  private readonly logger: PreferredHostStoreLogger;
  /** Lazily read once, then authoritative: this process is the only writer. */
  private byIdentity: Map<string, string> | null = null;
  /** `load` refuses to serve them and every call re-attempts, so a bucket promised wiped is never handed back even while the disk lags behind the promise. */
  private readonly pendingWipes = new Set<string>();
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
      return null;
    }
    // Unreadable reads as "no preference" here - the contract says a failed
    // READ is genuinely that, and derivation's local default is safe. It is
    // the WRITE paths that must not build on it.
    return this.read()?.get(identityKey) ?? null;
  }

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
      // A wipe cannot be confirmed absent - hold it pending so `load` refuses the bucket and the next call re-attempts against a real read.
      // An Activate cannot merge into a set it cannot see: writing would replace every other identity's preference with this one entry.
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

  private drainPendingWipes(): void {
    if (this.pendingWipes.size === 0) return;
    const current = this.read();
    // Still refused (unreadable, or a newer build's file): "absent from the durable set" cannot be claimed off a set we did not read, so the wipes stay pending rather than being cleared.
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

  /** Callers treat `null` as "do not trust, do not write"; the next call re-reads. */
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
        this.logger.warn(
          "[selection-preferred] state file written by a newer version",
          { version, supported: PREFERRED_HOST_STATE_VERSION },
        );
        this.refusalReason = newerVersionStateReason(this.filePath, version);
        return null;
      }
      this.byIdentity = entries;
      if (version !== PREFERRED_HOST_STATE_VERSION) return entries;
      const byIdentity = record["byIdentity"];
      if (byIdentity === null || typeof byIdentity !== "object") return entries;
      for (const [key, value] of Object.entries({ ...byIdentity })) {
        if (typeof value === "string" && value.length > 0) {
          entries.set(key, value);
        }
      }
    } catch (error: unknown) {
      // A corrupt file degrades to "no preference", never to a crash: the whole point of this value is that losing it is survivable.
      this.byIdentity = entries;
      this.logger.warn("[selection-preferred] corrupt state file", {
        error: String(error),
      });
    }
    return entries;
  }

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
