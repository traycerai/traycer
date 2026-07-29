import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  HostRestartRequestResult,
  MutationOutcome,
} from "../../ipc-contracts/host-management-types";
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

  const onHostChange = (snapshot: DesktopLocalHostSnapshot | null): void => {
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
