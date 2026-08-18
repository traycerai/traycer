import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  HostRestartRequestResult,
  MutationOutcome,
} from "../../ipc-contracts/host-management-types";
import { readLastKnownLocalHostId } from "../host/local-host-identity";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

// Collapses a restart-intent outcome to the wire result both restart
// surfaces resolve (this handler and `traycerHostRestart`). `busy` and
// `deferred` become a resolved `declined` - the host was deliberately NOT
// restarted (in-progress work denied the shutdown claim, removed-by-user,
// lock contention), a state that clears on its own or on a later retry -
// so the renderer can present it as information. Every other non-"ok"
// kind still rejects the invoke, keeping genuine failures on the existing
// catch-based reportable-error path (field RCA 2026-07-28: throwing the
// busy denial produced a "Report issue" error toast for a self-recovering
// condition).
export function restartRequestResultFromOutcome<TOk>(
  outcome: MutationOutcome<TOk>,
): HostRestartRequestResult {
  if (outcome.kind === "ok") return { kind: "restarted" };
  if (outcome.kind === "busy" || outcome.kind === "deferred") {
    return { kind: "declined", message: outcome.message };
  }
  throw new Error(outcome.message);
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
      const outcome = await bridge.options.hostController.respawn();
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
      readLastKnownLocalHostId({
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
