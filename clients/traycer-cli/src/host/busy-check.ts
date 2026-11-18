import {
  isValidLocalHostWebsocketUrl,
  publishedHostProcessGone,
  readHostPidMetadataEvidence,
} from "./pid-metadata";
import type { Environment } from "../runner/environment";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";

// The host's unauthenticated, loopback-only `/activity` side-channel is the
// CLI's "can I safely restart you?" check. Before `provisionHost` swaps the
// bytes of a LIVE host (a reinstall the desktop then restarts), we ask the
// host whether it has any work in progress and refuse unless it is idle. The
// HTTP probe itself (`probeHostActivityBusy`) is shared with the desktop,
// which re-runs it before its own SMAppService restart cycle.

// `unverifiable`: a host may be running, but its record cannot be read or
// names no endpoint the probe may dial - so whether it is idle cannot be
// known. Refused like `busy` (the gates fail closed), in words that say why.
type RestartVerdict = "no-host" | "idle" | "busy" | "unverifiable";

/**
 * Throws `E_HOST_BUSY` when a LIVE host has work in progress, or when a
 * host's idle/busy state can't be determined (fail-safe): a `pid.json` that
 * is there but cannot be read or parsed, or one that names an endpoint the
 * probe may not dial. Returns (so the caller proceeds) only when there is
 * provably no live host to protect: no pid.json, or a pid.json whose process
 * has exited. Callers skip this under `--force`.
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
  switch (await probeHostForRestart(environment)) {
    case "no-host":
    case "idle":
      return;
    case "busy":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message:
          "The running host has work in progress; refusing to restart it and lose that work. Re-run with --force to restart anyway.",
        details: null,
        exitCode: 1,
      });
    case "unverifiable":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: unverifiableHostMessage("restart"),
        details: { reason: "host-state-unverifiable" },
        exitCode: 1,
      });
  }
}

/**
 * {@link assertHostNotBusy} for a STOP: the same probe and the same
 * `E_HOST_BUSY`, worded for `host stop --if-idle`, whose caller (the
 * desktop's automatic idle-only quit stop) branches on the code and falls
 * back to asking the user.
 */
export async function assertHostIdleForStop(
  environment: Environment,
): Promise<void> {
  switch (await probeHostForRestart(environment)) {
    case "no-host":
    case "idle":
      return;
    case "busy":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message:
          "The running host has work in progress; refusing to stop it and lose that work. Re-run with --force to stop it anyway.",
        details: null,
        exitCode: 1,
      });
    case "unverifiable":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: unverifiableHostMessage("stop"),
        details: { reason: "host-state-unverifiable" },
        exitCode: 1,
      });
  }
}

function unverifiableHostMessage(action: "restart" | "stop"): string {
  return `A host may be running, but its pid.json cannot be read or names no local endpoint, so whether it has work in progress cannot be checked; refusing to ${action} it. Re-run with --force to ${action} it anyway.`;
}

async function probeHostForRestart(
  environment: Environment | undefined,
): Promise<RestartVerdict> {
  // The evidence reader, not `readHostPidMetadata`: that one folds a record
  // that is there but cannot be read or parsed into `null`, which is right for
  // a best-effort display and wrong for a gate that must fail closed - a torn
  // or momentarily unreadable record is not evidence that no host is running.
  const evidence = await readHostPidMetadataEvidence(environment);
  switch (evidence.kind) {
    case "absent":
      return "no-host";
    case "unreadable":
      return "unverifiable";
    case "read":
      break;
  }
  const metadata = evidence.metadata;
  // A stale pid.json whose process has exited - or whose pid now belongs to an
  // unrelated process - is not a live host: a reinstall has nothing to lose,
  // and probing the dead endpoint below would read as "busy" (fail-safe) and
  // block the repair.
  if (publishedHostProcessGone(metadata)) {
    return "no-host";
  }
  // A live host whose record names an endpoint the probe may not dial (not
  // exactly `127.0.0.1`): it is running, and nothing says it is idle.
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    return "unverifiable";
  }
  // A live host: probe its `/activity` side-channel. Any reachable-but-
  // unprobeable outcome (404 from a pre-feature host, malformed body, connect
  // error, or timeout) is treated as busy (fail-safe), so we never tear down a
  // live host we cannot confirm is idle. Only an explicit `busy:false` is idle.
  return (await probeHostActivityBusy(metadata.websocketUrl)) ? "busy" : "idle";
}
