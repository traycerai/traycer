import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../../ipc-contracts/host-types";
import type { HostRestartRequestResult } from "../../ipc-contracts/host-management-types";
import type { GuardedMutationOutcome } from "../host/host-controller-types";
import { readLastKnownLocalHostId } from "../host/local-host-identity";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

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

export function registerHostIpc(bridge: RunnerIpcBridge): void {
  // `HostController` never rejects (wait-never-reject).
  bridge.handleInvoke(
    RunnerHostInvoke.requestHostRespawn,
    async (): Promise<HostRestartRequestResult> => {
      const outcome = await bridge.options.hostController.respawn({
        kind: "background",
      });
      return restartRequestResultFromOutcome(outcome);
    },
  );

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
