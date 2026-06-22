import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "./pid-metadata";
import { isProcessAlive } from "../store/cli-lock";
import type { Environment } from "../runner/environment";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";

// The host's unauthenticated, loopback-only `/activity` side-channel is the
// CLI's "can I safely restart you?" check. Before `provisionHost` swaps the
// bytes of a LIVE host (a reinstall the desktop then restarts), we ask the
// host whether it has any work in progress and refuse unless it is idle. The
// HTTP probe itself (`probeHostActivityBusy`) is shared with the desktop,
// which re-runs it before its own SMAppService restart cycle.

type RestartVerdict = "no-host" | "idle" | "busy";

/**
 * Throws `E_HOST_BUSY` when a LIVE host has work in progress, or when a
 * live host's idle/busy state can't be determined (fail-safe). Returns (so
 * the caller proceeds) when there is no live host to protect: no pid.json, or
 * a stale pid.json whose process has exited. Callers skip this under `--force`.
 *
 * Liveness is judged from pid.json + the process being alive, NOT the OS
 * service-controller status. This is deliberate: in the macOS host-owned
 * SMAppService path the CLI does not own the service registration, so its
 * service status reports "not-installed" even while the host is live. Keying
 * the busy check off that status would skip the probe and let a reinstall tear
 * down in-progress work.
 */
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
  // A stale pid.json whose process has exited is not a live host - a reinstall
  // has nothing to lose.
  if (!isProcessAlive(metadata.pid)) {
    return "no-host";
  }
  // A live host: probe its `/activity` side-channel. Any reachable-but-
  // unprobeable outcome (404 from a pre-feature host, malformed body, connect
  // error, or timeout) is treated as busy (fail-safe), so we never tear down a
  // live host we cannot confirm is idle. Only an explicit `busy:false` is idle.
  return (await probeHostActivityBusy(metadata.websocketUrl)) ? "busy" : "idle";
}
