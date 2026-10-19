import {
  restartTargetStillCurrent,
  type RestartTargetHost,
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
 * checked again here - inside the lock, before anything is stopped - and the
 * command refuses `E_HOST_RESTART_TARGET_CHANGED` when `pid.json` names a
 * different process that is or may be running, or cannot be read
 * (`restartTargetStillCurrent`).
 */
export async function refuseUnlessRestartTarget(
  verb: string,
  environment: Environment,
  target: RestartTargetHost,
): Promise<void> {
  const evidence = await readHostPidMetadataEvidence(environment);
  const stillCurrent = await restartTargetStillCurrent(
    target,
    evidence.kind === "read"
      ? {
          kind: "published",
          pid: evidence.metadata.pid,
          startIdentity: evidence.metadata.processStartIdentity,
        }
      : evidence,
  );
  if (stillCurrent) return;
  throw cliError({
    code: CLI_ERROR_CODES.HOST_RESTART_TARGET_CHANGED,
    message: `${verb}: the host this restart was confirmed for (pid ${String(target.pid)}) is no longer the one published, so nothing was stopped`,
    details: null,
    exitCode: 1,
  });
}
