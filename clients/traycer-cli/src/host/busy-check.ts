import {
  isValidLocalHostWebsocketUrl,
  publishedHostProcessGone,
  readHostPidMetadata,
} from "./pid-metadata";
import type { Environment } from "../runner/environment";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";

// The host's unauthenticated, loopback-only `/activity` side-channel is the CLI's "can I safely restart you?" check.
// Before `provisionHost` swaps the bytes of a LIVE host (a reinstall the desktop then restarts), we ask the host whether it has any work in progress and refuse unless it is idle.

type RestartVerdict = "no-host" | "idle" | "busy";

/** Throws `E_HOST_BUSY` when a LIVE host has work in progress, or when a live host's idle/busy state can't be determined (fail-safe). Returns (so the caller proceeds) when there is no live host to protect: no pid.json, or a stale pid.json whose process has exited. */
export async function assertHostNotBusy(
  environment: Environment | undefined,
): Promise<void> {
  if ((await probeHostForRestart(environment)) === "busy") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_BUSY,
      message:
        "The running host has work in progress; refusing to restart it and lose that work. Re-run with --force to restart anyway.",
      details: null,
      exitCode: 1,
    });
  }
}

async function probeHostForRestart(
  environment: Environment | undefined,
): Promise<RestartVerdict> {
  const metadata = await readHostPidMetadata(environment);
  if (
    metadata === null ||
    !isValidLocalHostWebsocketUrl(metadata.websocketUrl)
  ) {
    return "no-host";
  }
  // A stale pid.json whose process has exited - or whose pid now belongs to an
  // unrelated process - is not a live host: a reinstall has nothing to lose,
  // and probing the dead endpoint below would read as "busy" (fail-safe) and
  // block the repair.
  if (publishedHostProcessGone(metadata)) {
    return "no-host";
  }
  // A live host: probe its `/activity` side-channel.
  // Any reachable-but- unprobeable outcome (404 from a pre-feature host, malformed body, connect error, or timeout) is treated as busy (fail-safe), so we never tear down a live host we cannot confirm is idle.
  return (await probeHostActivityBusy(metadata.websocketUrl)) ? "busy" : "idle";
}
