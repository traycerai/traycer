import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";
import { errorCode } from "@traycer/protocol/config/credentials-fs";
import {
  decodeHostUpdateAttempt,
  type HostUpdateAttemptRead,
} from "@traycer/protocol/config/host-update-attempt";
import { updateAttemptRecordPath } from "@traycer/protocol/config/host-update-attempt-paths";

// The READ side of `update-attempt.json` (§1.4).
// `traycer-host` projects this record into `host.status` and cannot import `@traycer-clients/shared`.

// `O_NOFOLLOW | O_NONBLOCK` is the POSIX fast path: it binds the descriptor to a non-link and makes an attempted FIFO/device open total.
interface RecordOpenPlatform {
  readonly noFollow: number;
  readonly nonBlock: number;
}

const defaultRecordOpenPlatform: RecordOpenPlatform = {
  noFollow: typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0,
  nonBlock: typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0,
};

let recordOpenPlatformForTest: RecordOpenPlatform | null = null;

/** Test-only override for the actual Node-on-Windows missing-flag branch. */
export function __setRecordOpenPlatformForTest(
  platform: RecordOpenPlatform | null,
): void {
  recordOpenPlatformForTest = platform;
}

function recordOpenPlatform(): RecordOpenPlatform {
  return recordOpenPlatformForTest ?? defaultRecordOpenPlatform;
}

export { errorCode };

// ---- Path classification ----------------------------------------------------

export type PathKind =
  | { readonly kind: "absent" }
  | { readonly kind: "regular-file"; readonly stats: Stats }
  | { readonly kind: "symlink" }
  | { readonly kind: "other" }
  | { readonly kind: "stat-error"; readonly cause: string };

// `lstat`, never `stat`: `stat` follows a link and reports the TARGET's type, so a symlink planted at the record path would read as a perfectly ordinary regular file.
export async function classifyPath(path: string): Promise<PathKind> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return { kind: "symlink" };
    if (stats.isFile()) return { kind: "regular-file", stats };
    return { kind: "other" };
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "absent" };
    return { kind: "stat-error", cause: errorCode(err) ?? String(err) };
  }
}

// Test seam: deterministic swap-at-open
let beforeRecordOpenHook: (() => Promise<void>) | null = null;

export function __setBeforeRecordOpenHookForTest(
  hook: (() => Promise<void>) | null,
): void {
  beforeRecordOpenHook = hook;
}

type RecordOpen =
  | { readonly kind: "opened"; readonly handle: FileHandle }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly cause: string };

/** Result of reading one security-sensitive sidecar through an opened, no-follow descriptor. */
export type RegularFileNoFollowRead =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unreadable"; readonly cause: string };

async function openRecordNoFollow(path: string): Promise<RecordOpen> {
  const platform = recordOpenPlatform();
  const hasSafeDescriptorOpen =
    platform.noFollow !== 0 && platform.nonBlock !== 0;

  // Windows Node exposes neither flag.
  let priorStats: Stats | null = null;
  if (!hasSafeDescriptorOpen) {
    const kind = await classifyPath(path);
    if (kind.kind === "absent") return { kind: "missing" };
    if (kind.kind === "symlink") {
      return { kind: "unreadable", cause: "attempt-record-is-symlink" };
    }
    if (kind.kind === "other") {
      return { kind: "unreadable", cause: "attempt-record-not-a-regular-file" };
    }
    if (kind.kind === "stat-error") {
      return { kind: "unreadable", cause: kind.cause };
    }
    priorStats = kind.stats;
  }

  if (beforeRecordOpenHook !== null) await beforeRecordOpenHook();

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (hasSafeDescriptorOpen
          ? platform.noFollow | platform.nonBlock
          : platform.nonBlock),
    );
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") {
      // `open` can see ENOENT after an attacker swaps a present pathname for a dangling link.
      // A visible replacement is unreadable evidence, never a licence to continue as if no file existed.
      const after = await classifyPath(path);
      if (after.kind === "absent") return { kind: "missing" };
      if (after.kind === "symlink") {
        return { kind: "unreadable", cause: "attempt-record-is-symlink" };
      }
      if (after.kind === "other") {
        return {
          kind: "unreadable",
          cause: "attempt-record-not-a-regular-file",
        };
      }
      return {
        kind: "unreadable",
        cause:
          after.kind === "stat-error"
            ? after.cause
            : "attempt-record-swapped-at-open",
      };
    }
    // `O_NOFOLLOW` reports a symlink as ELOOP on Linux and macOS; some platforms use EMLINK.
    // Either way the path IS a link and must not be followed.
    if (code === "ELOOP" || code === "EMLINK") {
      return { kind: "unreadable", cause: "attempt-record-is-symlink" };
    }
    return { kind: "unreadable", cause: code ?? String(err) };
  }

  // Validate the OPENED handle, not the path - this is the descriptor the
  // bytes will actually come from.
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      await handle.close().catch(() => undefined);
      return { kind: "unreadable", cause: "attempt-record-not-a-regular-file" };
    }
    if (priorStats !== null) {
      const after = await classifyPath(path);
      if (after.kind === "symlink") {
        await handle.close().catch(() => undefined);
        return { kind: "unreadable", cause: "attempt-record-is-symlink" };
      }
      if (after.kind === "other") {
        await handle.close().catch(() => undefined);
        return {
          kind: "unreadable",
          cause: "attempt-record-not-a-regular-file",
        };
      }
      if (after.kind === "absent" || after.kind === "stat-error") {
        await handle.close().catch(() => undefined);
        return {
          kind: "unreadable",
          cause:
            after.kind === "stat-error"
              ? after.cause
              : "attempt-record-swapped-at-open",
        };
      }
      if (
        !sameFileIdentity(priorStats, opened) ||
        !sameFileIdentity(opened, after.stats)
      ) {
        // The fallback is valid only with positive proof that the descriptor
        // and both pathname observations name one regular object.
        await handle.close().catch(() => undefined);
        return { kind: "unreadable", cause: "attempt-record-swapped-at-open" };
      }
    }
    return { kind: "opened", handle };
  } catch (err) {
    await handle.close().catch(() => undefined);
    return { kind: "unreadable", cause: errorCode(err) ?? String(err) };
  }
}

/**
 * Read a small, security-sensitive file without following links or blocking on a FIFO/device.
 * This is the descriptor/identity pattern used for the durable update record, shared with the host-start adoption proof so a visible special entry can never be mistaken for an absent proof.
 */
export async function readRegularFileNoFollow(
  path: string,
): Promise<RegularFileNoFollowRead> {
  const opened = await openRecordNoFollow(path);
  if (opened.kind === "missing") return { kind: "absent" };
  if (opened.kind === "unreadable") {
    return { kind: "unreadable", cause: opened.cause };
  }
  try {
    return { kind: "text", text: await opened.handle.readFile("utf8") };
  } catch (err) {
    return {
      kind: "unreadable",
      cause: errorCode(err) ?? String(err),
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

// The Windows fallback admits an opened descriptor only with POSITIVE proof it is the same entry classified before `open`.
// The POSIX descriptor path never reaches here; a platform missing either required descriptor flag uses this same conservative fallback.
function sameFileIdentity(
  a: Pick<Stats, "ino" | "dev">,
  b: Pick<Stats, "ino" | "dev">,
): boolean {
  if (a.ino === 0 || b.ino === 0 || a.dev === 0 || b.dev === 0) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

/** Test-only projection of the Windows identity rule. */
export function __sameRecordFileIdentityForTest(
  a: Pick<Stats, "ino" | "dev">,
  b: Pick<Stats, "ino" | "dev">,
): boolean {
  return sameFileIdentity(a, b);
}

/**
 * Total read of the durable attempt record.
 * Lock-free by design - a status projection reads without contending, and can never write.
 */
export async function readUpdateAttemptRecord(
  hostHomeDir: string,
): Promise<HostUpdateAttemptRead> {
  return readUpdateAttemptRecordAtPath(
    updateAttemptRecordPath(resolve(hostHomeDir)),
  );
}

/**
 * The same total read, given the record path directly.
 * Separate from the `hostHomeDir` entry point because the write side already holds a lease bound to one canonical record path and must re-read THAT path, not re-derive one from a directory it would have to be trusted to.
 */
export async function readUpdateAttemptRecordAtPath(
  recordPath: string,
): Promise<HostUpdateAttemptRead> {
  const opened = await readRegularFileNoFollow(recordPath);
  if (opened.kind === "absent") {
    return decodeHostUpdateAttempt({ kind: "missing" });
  }
  if (opened.kind === "unreadable") {
    return decodeHostUpdateAttempt({
      kind: "unreadable",
      cause: opened.cause,
    });
  }
  return decodeHostUpdateAttempt({ kind: "bytes", text: opened.text });
}
