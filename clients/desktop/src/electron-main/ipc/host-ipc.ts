import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  HostRestartRequestResult,
  HostServiceRestartResult,
} from "../../ipc-contracts/host-management-types";
import type { GuardedMutationOutcome } from "../host/host-controller-types";
import { readLastKnownLocalHostId } from "../host/local-host-identity";
import { appliedLocalHostCapability } from "../host/local-host-capability";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

// Collapses a restart-intent outcome to the wire result every restart
// surface resolves (this handler, `traycerHostRestart` and the Doctor
// repairs). `busy`, `deferred` and `abandoned` become a resolved `declined`
// - the host was deliberately NOT restarted (in-progress work denied the
// shutdown claim, removed-by-user, lock contention, or the lane-head guard
// found the local host is no longer the one the restart named), a state
// that clears on its own or on a later retry - so the renderer can present
// it as information. Every other non-"ok" kind still rejects the invoke,
// keeping genuine failures on the existing catch-based reportable-error
// path (field RCA 2026-07-28: throwing the busy denial produced a "Report
// issue" error toast for a self-recovering condition).
export function restartRequestResultFromOutcome<TOk>(
  outcome: GuardedMutationOutcome<TOk>,
): HostRestartRequestResult {
  if (outcome.kind === "ok") return { kind: "restarted" };
  if (
    outcome.kind === "busy" ||
    outcome.kind === "deferred" ||
    outcome.kind === "abandoned"
  ) {
    return { kind: "declined", message: outcome.message };
  }
  throw new Error(outcome.message);
}

// The idle-gated service restart's wire result. The one difference from
// `restartRequestResultFromOutcome`: the host's own busy refusal is
// `host-busy`, not `declined`, because its caller answers it with a Force
// offer over the listed work - a lane refusal, a removal or a replaced host
// offers nothing to force. The CLI's refusal text is dropped here: it tells
// its own caller to re-run with `--force`.
export function serviceRestartResultFromOutcome<TOk>(
  outcome: GuardedMutationOutcome<TOk>,
): HostServiceRestartResult {
  if (outcome.kind === "busy") return { kind: "host-busy" };
  return restartRequestResultFromOutcome(outcome);
}

export function registerHostIpc(bridge: RunnerIpcBridge): void {
  // Renderer-driven host respawn.
  //
  // `HostController.respawn()` is the single shared entrypoint used by
  // every respawn surface - this IPC handler, the tray's "Restart Host",
  // and any menu-bar host command. Its mutation lane owns both the
  // in-flight dedupe (so concurrent Retry clicks can't interleave
  // SMAppService unregister/register cycles) and the routing between the
  // SMAppService cycle (macOS host-owned login item) and the CLI restart
  // path. `HostController` never rejects (wait-never-reject); this handler
  // resolves ok/busy/deferred as a `HostRestartRequestResult` and re-throws
  // the rest so the renderer's catch-based error handling stays for
  // genuine failures.
  bridge.handleInvoke(
    RunnerHostInvoke.requestHostRespawn,
    async (): Promise<HostRestartRequestResult> => {
      // A desktop booted in the lifecycle policy's `none` mode runs no local
      // host, so there is nothing to respawn - and starting one would undo
      // the mode. Declined, not thrown: it is information, not a failure.
      if (appliedLocalHostCapability() === "none") {
        return {
          kind: "declined",
          message:
            "This app runs no local host. Change the host lifecycle setting and restart Traycer to use one.",
        };
      }
      // `background` = no identity guard, not "not user-initiated": this
      // channel restarts THE local host as a role, whatever currently fills
      // it, so there is no expected host id for a lane-head guard to hold
      // the job to. Only the Doctor repairs name a specific host.
      const outcome = await bridge.options.hostController.respawn(
        { kind: "background" },
        "force",
      );
      return restartRequestResultFromOutcome(outcome);
    },
  );

  // Read on demand rather than cached at install time: both files change
  // across the host's lifecycle, and a renderer asking during a restart should
  // get today's answer, not whatever was on disk when the bridge was built.
  // The enrollment-over-pid.json ordering and its rationale live with the
  // reader (`host/local-host-identity.ts`), which the selection authority's
  // fleet port shares so both answers about "which host is local" agree by
  // construction. The renderer treats null as "keep the persisted value",
  // which is the correct do-no-harm answer.
  bridge.handleInvoke(
    RunnerHostInvoke.lastKnownLocalHostId,
    (): Promise<string | null> =>
      // `none` mode: no host is local to this app, whatever the enrollment
      // record left behind by an earlier host still says.
      appliedLocalHostCapability() === "none"
        ? Promise.resolve(null)
        : readLastKnownLocalHostId({
            identityEnrollmentFile: bridge.options.host.identityEnrollmentFile,
            pidMetadataFile: bridge.options.host.pidMetadataFile,
          }),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.localHostSnapshot,
    (): Promise<DesktopPublishedHostSnapshot | null> =>
      Promise.resolve(bridge.options.host.getSnapshot()),
  );

  const onHostChange = (
    snapshot: DesktopPublishedHostSnapshot | null,
  ): void => {
    bridge.fanOut(RunnerHostEvent.localHostChange, snapshot);
  };
  bridge.options.host.on("change", onHostChange);
  bridge.disposeFns.push(() => {
    bridge.options.host.off("change", onHostChange);
  });

  bridge.fanOut(
    RunnerHostEvent.localHostChange,
    bridge.options.host.getSnapshot(),
  );
}
