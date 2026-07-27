import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown, type ILogger } from "../logger";
import { ensureHostStagingRoot, hostStagingRoot } from "./paths";
import {
  currentProcessIdentityToken,
  verifyProcessIdentity,
  type ProcessIdentityToken,
} from "./process-identity";

// Owner-tokened temp dirs under the host staging root
// (`~/.traycer/host[/<env>]/install-staging/`) - Host Update Layer
// Redesign Tech Plan, "Stage lifecycle" step 5. `host download`'s
// download+extract phase runs outside the `cli-lock` (no busy check, no
// lock during network transfer), so its in-progress temp has to survive
// every OTHER command's reconcile pass that runs concurrently. Each temp
// is stamped with its creator's pid + process-start-time; reconcile
// spares a verified-live owner regardless of age and only falls back to
// the historical 24h-mtime rule when the owner's identity can't be
// established at all.

const OWNER_TOKEN_FILENAME = ".owner.json";

// Fallback ceiling for temps whose owner identity is unreadable or
// unverifiable (the token file is missing/corrupt, or the identity probe
// itself failed) - the pre-hardening sweep rule, kept as the safety net
// for exactly the cases where "identity outranks age" has no identity to
// outrank age with.
const UNVERIFIABLE_TEMP_AGE_FALLBACK_MS = 24 * 60 * 60 * 1000;

export interface OwnedTempDir {
  readonly path: string;
}

// Creates a fresh temp dir under the staging root and stamps it with this
// process's identity token. `prefix` is passed straight to `mkdtemp`
// (joined onto the staging root) so callers control the debug-friendly
// naming, e.g. `dl-` for `host download`'s temp.
export async function createOwnedTempDir(
  environment: Environment,
  prefix: string,
): Promise<OwnedTempDir> {
  await ensureHostStagingRoot(environment);
  const path = await mkdtemp(join(hostStagingRoot(environment), prefix));
  await writeOwnerToken(path, currentProcessIdentityToken());
  return { path };
}

async function writeOwnerToken(
  dirPath: string,
  token: ProcessIdentityToken,
): Promise<void> {
  await writeFile(
    join(dirPath, OWNER_TOKEN_FILENAME),
    JSON.stringify(token),
    "utf8",
  );
}

async function readOwnerToken(
  dirPath: string,
): Promise<ProcessIdentityToken | null> {
  let raw: string;
  try {
    raw = await readFile(join(dirPath, OWNER_TOKEN_FILENAME), "utf8");
  } catch {
    return null;
  }
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
  };
}

async function dirAgeMs(dirPath: string): Promise<number | null> {
  try {
    const st = await stat(dirPath);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

async function removeTempDir(dirPath: string, logger: ILogger): Promise<void> {
  await rm(dirPath, { recursive: true, force: true }).catch((err) => {
    logger.warn("Stage reconcile failed to sweep a temp dir", {
      dirPath,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
  });
}

// Sweeps stale temp dirs directly under the staging root. Best-effort -
// one entry's sweep failure never aborts the pass. Returns the paths
// actually removed.
//
// Decision per entry:
//   - owner token reads + `verifyProcessIdentity` returns "alive-same"
//     -> spared, regardless of age (a stalled-but-alive download costs
//        only disk).
//   - "dead" or "alive-different" (positive evidence the recorded owner
//     is gone or the pid was recycled) -> swept immediately, regardless
//     of age.
//   - token unreadable, or the identity probe itself was "indeterminate"
//     -> the 24h-mtime fallback decides, but ONLY on a successful,
//        readable mtime. An unreadable age (the directory vanished, a
//        stat error) is itself just another form of "can't verify" and
//        must spare, not delete - "only positive evidence" applies to
//        age-based sweeping exactly as it does to identity-based
//        sweeping; there is no positive evidence in an unreadable stat.
export async function sweepOwnedTempDirs(
  environment: Environment,
): Promise<readonly string[]> {
  const logger = createCliLogger(environment);
  const root = hostStagingRoot(environment);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(root, entry.name);
    const token = await readOwnerToken(dirPath);
    if (token !== null) {
      const verdict = verifyProcessIdentity(token);
      if (verdict === "alive-same") continue;
      if (verdict === "dead" || verdict === "alive-different") {
        await removeTempDir(dirPath, logger);
        swept.push(dirPath);
        continue;
      }
      // "indeterminate" falls through to the age fallback below.
    }
    const ageMs = await dirAgeMs(dirPath);
    if (ageMs !== null && ageMs >= UNVERIFIABLE_TEMP_AGE_FALLBACK_MS) {
      await removeTempDir(dirPath, logger);
      swept.push(dirPath);
    }
  }
  return swept;
}
