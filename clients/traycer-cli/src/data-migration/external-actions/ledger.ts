import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  sha256Digest,
  type ExternalAction,
  type ObjectFingerprint,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  traycerDataRoot,
  type DataRootPlatform,
} from "@traycer/protocol/config/data-root";
import { isErrnoException } from "../../runner/errors";

/**
 * Shared vocabulary of the data-root migration's external-action adapters
 * (issue 718, ticket 5). The ledger contract itself - the journal's
 * `ExternalAction` record and the before/after reconciliation rule - is
 * `@traycer/protocol/config/data-migration-contracts`; this module only adds
 * what every concrete adapter shares: plan results, blockers, the conflict
 * error a compare-and-set write raises, root rebasing and exact-bytes file
 * images.
 *
 * Adapters live in the CLI because the CLI coordinates the migration and owns
 * every effect outside the copied data root (the host's offline maintenance
 * entry point may write only inside the destination).
 */

/**
 * Which coordinator step an action belongs to. `quiesce` runs while starting
 * the barrier (owned registrations disabled), `prepare` in
 * `preparing-external`, `activate` only after `activated` is durable - an
 * `activate` action is forward-only, since rollback is refused from there.
 */
export type ExternalActionStage = "quiesce" | "prepare" | "activate";

/** A reason a planner refuses the migration BEFORE any external effect. */
export type ExternalActionBlocker = {
  readonly code: string;
  /** The exact object that cannot be handled (a task, a path, a worktree). */
  readonly object: string;
  readonly message: string;
};

export type ExternalActionPlan = {
  /** Ledger entries in apply order, every one `planned`. */
  readonly actions: readonly ExternalAction[];
  readonly blockers: readonly ExternalActionBlocker[];
};

/**
 * A compare-and-set write found its object in neither the image it expected
 * nor the one it would produce: someone else changed it. Never retried and
 * never overwritten; the reconciler turns it into a `conflict` outcome.
 */
export class ExternalActionConflictError extends Error {
  readonly object: string;
  constructor(object: string, message: string) {
    super(message);
    this.name = "ExternalActionConflictError";
    this.object = object;
  }
}

export function isExternalActionConflictError(
  error: unknown,
): error is ExternalActionConflictError {
  return error instanceof ExternalActionConflictError;
}

/**
 * A stable ledger id (`^[a-z0-9][a-z0-9.-]{0,79}$`): the adapter's short
 * prefix plus a digest of everything that names the object, so planning the
 * same object twice gives the same id and two objects never share one.
 */
export function externalActionId(
  prefix: string,
  ...naming: readonly string[]
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(naming))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}.${hash}`;
}

export function presentFingerprint(value: unknown): ObjectFingerprint {
  return { kind: "present", digest: sha256Digest(value) };
}

export const ABSENT_FINGERPRINT: ObjectFingerprint = { kind: "absent" };

// ---- Root rebasing ---------------------------------------------------------

function pathApiFor(platform: DataRootPlatform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function comparablePath(value: string, platform: DataRootPlatform): string {
  const api = pathApiFor(platform);
  const resolved = api.resolve(value).replace(/[\\/]+$/u, "");
  return platform === "win32"
    ? resolved.replace(/\//gu, "\\").toLowerCase()
    : resolved;
}

/** Whether two absolute paths name the same location, lexically. */
export function samePath(
  left: string,
  right: string,
  platform: DataRootPlatform,
): boolean {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

/**
 * The path of `value` relative to `root` on path-segment boundaries (Windows
 * compares case- and separator-insensitively), or `null` when `value` is not
 * `root` or inside it. The empty string means `value` IS the root.
 */
export function pathInsideRoot(
  value: string,
  root: string,
  platform: DataRootPlatform,
): string | null {
  const api = pathApiFor(platform);
  const base = comparablePath(root, platform);
  const candidate = comparablePath(value, platform);
  if (candidate === base) return "";
  const prefix = `${base}${api.sep}`;
  if (!candidate.startsWith(prefix)) return null;
  // Slice the ORIGINAL spelling, so the relative part keeps its case. The
  // offset comes from the unfolded root: lower-casing can change a string's
  // length, the spelling cannot.
  const resolved = api.resolve(value).replace(/[\\/]+$/u, "");
  const rootLength = api.resolve(root).replace(/[\\/]+$/u, "").length;
  return resolved.slice(rootLength + 1);
}

/**
 * `value` moved from `fromRoot` to `toRoot` when it lies inside `fromRoot`,
 * otherwise `null`: a path outside the data root (an npm or hand-placed CLI,
 * a user repository) is not the migration's to move.
 */
export function rebaseRootPath(
  value: string,
  fromRoot: string,
  toRoot: string,
  platform: DataRootPlatform,
): string | null {
  const relative = pathInsideRoot(value, fromRoot, platform);
  if (relative === null) return null;
  const api = pathApiFor(platform);
  return relative.length === 0 ? toRoot : api.join(toRoot, relative);
}

/**
 * A path this process derives under its OWN data root (`traycerDataRoot()`),
 * re-rooted at `root`. Path builders (`cliInstallHomeDir`, the launcher path)
 * resolve the process's root, which during a migration is the source - or,
 * for a recovery run from the destination CLI, the destination - so the
 * migration takes only their layout below the root from them.
 */
export function layoutUnderRoot(
  pathUnderCurrentRoot: string,
  root: string,
  platform: DataRootPlatform,
): string {
  const inside = pathInsideRoot(
    pathUnderCurrentRoot,
    traycerDataRoot(),
    platform,
  );
  if (inside === null) {
    throw new Error("the path does not lie under this process's data root");
  }
  return inside.length === 0 ? root : pathApiFor(platform).join(root, inside);
}

// ---- Exact-bytes file images -----------------------------------------------

/** A regular file's bytes, `null` when absent; anything else is refused. */
export async function readFileImage(path: string): Promise<Buffer | null> {
  let isFile: boolean;
  try {
    isFile = (await lstat(path)).isFile();
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return null;
    throw cause;
  }
  if (!isFile) {
    throw new ExternalActionConflictError(
      path,
      "the object is not a regular file",
    );
  }
  return readFile(path);
}

export function fileImageFingerprint(bytes: Buffer | null): ObjectFingerprint {
  if (bytes === null) return ABSENT_FINGERPRINT;
  return presentFingerprint({
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export function encodeImage(bytes: Buffer | null): string | null {
  return bytes === null ? null : bytes.toString("base64");
}

export function decodeImage(encoded: string | null): Buffer | null {
  return encoded === null ? null : Buffer.from(encoded, "base64");
}

/**
 * Compare-and-set of one file: replaced by `next` (removed for `null`) only
 * while its bytes are exactly `expected`. The write is temp-then-rename in the
 * same folder, so a crash leaves the old or the new image, never a torn one.
 * The window between the read and the rename is not closed - no filesystem
 * offers a compare-and-set here - and the reconciler re-observes afterwards.
 */
export async function compareAndSetFileImage(
  path: string,
  expected: Buffer | null,
  next: Buffer | null,
): Promise<void> {
  const current = await readFileImage(path);
  const matches =
    current === null || expected === null
      ? current === expected
      : current.equals(expected);
  if (!matches) {
    throw new ExternalActionConflictError(
      path,
      "the file changed since the migration recorded it",
    );
  }
  if (next === null) {
    await rm(path, { force: true });
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, next, { flag: "wx" });
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
}
