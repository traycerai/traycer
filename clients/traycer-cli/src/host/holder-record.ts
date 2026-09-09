import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareProcessStartIdentity,
  isProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";
import { isProcessAlive } from "../store/cli-lock";
import { readProcessStartIdentity } from "../store/process-identity";
import { isReadablePid } from "./pid-value";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";

/**
 * `holder.json` - who currently holds a host DATA ROOT.
 *
 * An on-disk contract written by the host and read here by string path, the
 * same no-host-import rule `pid-metadata.ts` follows.
 *
 * This exists because `pid.json` cannot answer the question the store-format
 * floor actually asks. `pid.json` is SLOT-scoped: it is published by the
 * host's RPC layer once a hostId is known, into the home the host was started
 * in. A dev host that acquires a POOLED IDENTITY home writes its chat stores
 * there and never publishes a `pid.json` into it - the host's own
 * `layer0-lock.ts` says so where it writes this file: "`holder.json` exists
 * the moment the kernel lock is won, which is what lets `readCurrentIncumbent`
 * corroborate a held dev identity home lock (which never gets a `pid.json`)".
 *
 * So the holder record is the ONLY evidence co-located with the data it
 * protects, and that co-location is the whole point: it answers "is anyone
 * writing THIS root" without needing to know where its writer was launched
 * from. A host may be started with any `--host-data-dir` beneath
 * `~/.traycer/host` (`main-bootstrap.ts`), so no enumeration of home
 * directories can be complete, while this read is complete by construction.
 *
 * Never deleted on release, so a stale record outlives its writer - which
 * costs nothing, because liveness is decided the same way `pid.json`'s is:
 * a dead pid, or a pid whose creation stamp no longer matches, is gone.
 */
export interface HostHolderRecord {
  readonly pid: number;
  readonly processStartIdentity: string | null;
}

export type HostHolderEvidence =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "read"; readonly holder: HostHolderRecord };

const HOLDER_FILENAME = "holder.json";

/** The holder record inside a host data root. */
export function hostHolderRecordPathIn(dataRoot: string): string {
  return join(dataRoot, HOLDER_FILENAME);
}

/**
 * Read one data root's holder record, keeping absence apart from failure for
 * the same reason `readHostPidMetadataEvidence` does: a torn or unreadable
 * record is not evidence that nothing holds the root.
 */
export async function readHostHolderEvidenceAt(
  path: string,
  logEnvironment: Environment,
): Promise<HostHolderEvidence> {
  const logger = createCliLogger(logEnvironment);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = readErrorCode(err);
    if (code === "ENOENT") return { kind: "absent" };
    logger.debug("Host holder record read failed", {
      environment: logEnvironment,
      errorName: errorFromUnknown(err).name,
      errorCode: code,
    });
    return { kind: "unreadable", cause: `read failed (${code ?? "unknown"})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", cause: "not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "unreadable", cause: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  // Positive integer, not merely a number - `isReadablePid` owns why. Shared
  // with `pid.json`'s reader so one file's worth of corruption cannot read as
  // malformed to one record reader and as a live writer to the other.
  if (!isReadablePid(obj.pid)) {
    return { kind: "unreadable", cause: "malformed record (pid unusable)" };
  }
  return {
    kind: "read",
    holder: {
      pid: obj.pid,
      // Same positive-evidence reading `pid.json` takes: a record without a
      // usable stamp keeps the record rather than being waved through.
      processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
        ? obj.processStartIdentity
        : null,
    },
  };
}

/**
 * Whether the process the holder record names is PROVABLY not the one that
 * took the root - byte-for-byte the rule `publishedHostProcessGone` applies to
 * `pid.json`, so a holder and a pid record can never disagree about liveness.
 */
export function hostHolderProcessGone(holder: HostHolderRecord): boolean {
  if (!isProcessAlive(holder.pid)) return true;
  if (!isProcessStartIdentity(holder.processStartIdentity)) return false;
  return (
    compareProcessStartIdentity(
      holder.processStartIdentity,
      readProcessStartIdentity(holder.pid),
    ) === "different"
  );
}

function readErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}
