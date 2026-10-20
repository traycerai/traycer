import {
  restartTargetStillCurrent,
  type RestartTargetHost,
  type RestartTargetPublished,
} from "@traycer-clients/shared/host-lock/restart-target";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { readHostPidMetadataEvidence } from "./pid-metadata";

/**
 * The binding of a Desktop force restart to one host process, checked by each
 * command that can stop or boot out a host on that restart's behalf: `host
 * restart`, and the `host service install --takeover` its packaged-macOS
 * re-register fallback can reach. The person confirmed stopping THAT process,
 * and the command waited for its lock after Desktop last checked it, so it is
 * checked again here - inside the lock, before anything is stopped, and at
 * each actuator edge after that (`service/stop-target.ts`) - and the command
 * refuses `E_HOST_RESTART_TARGET_CHANGED` when `pid.json` names a different
 * process that is or may be running, or cannot be read
 * (`restartTargetStillCurrent`).
 *
 * `alreadyDone` is what the command had already done to the confirmed host
 * when the change was seen, or `null` when nothing had been done; the refusal
 * says which, so it is true at every edge.
 */
export async function refuseUnlessRestartTarget(
  verb: string,
  environment: Environment,
  target: RestartTargetHost,
  alreadyDone: string | null,
): Promise<void> {
  if (await targetStillPublished(environment, target)) return;
  throw cliError({
    code: CLI_ERROR_CODES.HOST_RESTART_TARGET_CHANGED,
    message: `${verb}: the host this restart was confirmed for (pid ${String(target.pid)}) is no longer the one published, so ${alreadyDone === null ? "nothing was stopped" : `it went no further: ${alreadyDone}`}`,
    details: null,
    exitCode: 1,
  });
}

/** How many times a record that changes under its own liveness probe is read. */
const TARGET_READ_ATTEMPTS = 3;

// The record read is the last await before the caller acts. A record naming
// another instance is classified by a liveness probe, which awaits (a
// `tasklist` spawn on Windows), and a host can publish while it runs: the
// probe would call a stale record dead and the edge would act on the new
// host. So after a probe the record is read again, and the verdict stands
// only when that read is the record the probe classified. A record that keeps
// changing is refused.
async function targetStillPublished(
  environment: Environment,
  target: RestartTargetHost,
): Promise<boolean> {
  let published = await readPublished(environment);
  for (let attempt = 0; attempt < TARGET_READ_ATTEMPTS; attempt += 1) {
    const stillCurrent = await restartTargetStillCurrent(target, published);
    if (!needsLivenessProbe(target, published)) return stillCurrent;
    const reread = await readPublished(environment);
    if (samePublished(published, reread)) return stillCurrent;
    published = reread;
  }
  return false;
}

async function readPublished(
  environment: Environment,
): Promise<RestartTargetPublished> {
  const evidence = await readHostPidMetadataEvidence(environment);
  return evidence.kind === "read"
    ? {
        kind: "published",
        pid: evidence.metadata.pid,
        startIdentity: evidence.metadata.processStartIdentity,
      }
    : evidence.kind === "absent"
      ? { kind: "absent" }
      : { kind: "unreadable" };
}

// Whether `restartTargetStillCurrent` awaits a liveness probe for this record:
// only for a record naming an instance other than the target.
function needsLivenessProbe(
  target: RestartTargetHost,
  published: RestartTargetPublished,
): boolean {
  return (
    published.kind === "published" &&
    !(
      published.pid === target.pid &&
      published.startIdentity === target.startIdentity
    )
  );
}

function samePublished(
  a: RestartTargetPublished,
  b: RestartTargetPublished,
): boolean {
  if (a.kind !== "published" || b.kind !== "published")
    return a.kind === b.kind;
  return a.pid === b.pid && a.startIdentity === b.startIdentity;
}
