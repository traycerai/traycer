import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../app/logger";
import { getHostFsLayout, type Environment } from "./host-paths";

// The registration stamp records the app build identity at the last SUCCESSFUL
// SMAppService register cycle. Identity is the desktop's per-build
// `config.version` (`<target>.<epochMs>.<gitSha>` — unique per build; Electron's
// app version alone is not). An app update changes the identity, so the stamp
// no longer matches, so the register-cycle state machine treats it as a
// `definitionChange` and cycles once to flush the stale BTM LWCR (the EX_CONFIG
// hazard), then restamps.
//
// Semantics: an absent OR corrupt stamp reads as a mismatch (one cycle +
// restamp — the first rollout deliberately costs one fleet-wide cycle, and a
// corrupt file is safer to treat as "unknown identity" than to trust).

// In-memory successful-apply latch. Set when a register cycle succeeded but its
// stamp WRITE failed: it suppresses the stamp-mismatch *reason* for this exact
// identity for the rest of the launch, so the machine does not re-cycle every
// ensure for a stamp it cannot persist. It suppresses ONLY the stamp-mismatch
// cause — a later missing-agent repair still cycles. Persistence is retried at
// the next ensure and next launch; the latch dies with the process.
let appliedIdentityLatch: string | null = null;

export async function readRegistrationStamp(
  environment: Environment,
): Promise<string | null> {
  const path = getHostFsLayout(environment).registrationStampFile;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "identity" in parsed &&
      typeof parsed.identity === "string" &&
      parsed.identity.length > 0
    ) {
      return parsed.identity;
    }
    // Present but corrupt/unexpected shape → mismatch (treated as absent).
    return null;
  } catch {
    // Absent or unreadable → mismatch. A transient read fault costing one
    // cycle is strictly safer than trusting a stamp we could not read.
    return null;
  }
}

/**
 * Whether the persisted stamp equals `identity`. Absent/corrupt ⇒ false
 * (mismatch). Consulted by the register-cycle state machine as a
 * `definitionChange` cause; pair it with {@link isRegistrationIdentityApplied}
 * to honour the in-launch applied latch.
 */
export async function registrationStampMatches(
  environment: Environment,
  identity: string,
): Promise<boolean> {
  return (await readRegistrationStamp(environment)) === identity;
}

/**
 * Atomically persist `identity` as the last successfully applied register
 * cycle (temp write + rename, so a crash mid-write never leaves a torn file —
 * and a torn file would only read as a mismatch, i.e. one extra cycle). Returns
 * whether the persist succeeded; a failure is the caller's cue to set the
 * in-memory applied latch via {@link markRegistrationIdentityApplied}.
 */
export async function writeRegistrationStamp(
  environment: Environment,
  identity: string,
): Promise<boolean> {
  const path = getHostFsLayout(environment).registrationStampFile;
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      tmpPath,
      JSON.stringify({ identity, writtenAt: new Date().toISOString() }),
      { encoding: "utf8" },
    );
    await rename(tmpPath, path);
    return true;
  } catch (err) {
    log.warn("[registration-stamp] failed to persist registration stamp", {
      path,
      identity,
      err,
    });
    // Best-effort temp cleanup; never mask the original failure.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * Record that a register cycle for `identity` succeeded this launch even though
 * its stamp write failed. Suppresses the stamp-mismatch reason for this
 * identity until the process restarts (or the stamp persists on a later retry).
 */
export function markRegistrationIdentityApplied(identity: string): void {
  appliedIdentityLatch = identity;
}

export function isRegistrationIdentityApplied(identity: string): boolean {
  return appliedIdentityLatch === identity;
}

/** Test-only: the in-launch latch would otherwise leak across test cases. */
export function resetRegistrationStampLatchForTests(): void {
  appliedIdentityLatch = null;
}
