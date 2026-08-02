import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  HostRestartRequestResult,
  MutationOutcome,
} from "../../ipc-contracts/host-management-types";
import { readFile } from "node:fs/promises";
import { readPidMetadata } from "../host/host-lifecycle";
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

/**
 * The `hostId` from the host's durable enrollment record, or `null` when the
 * machine has never enrolled (or the file is unreadable/malformed - an
 * unusable record and an absent one mean the same thing to the caller).
 */
async function readEnrolledHostId(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const hostId = (parsed as Record<string, unknown>).hostId;
    return typeof hostId === "string" && hostId.length > 0 ? hostId : null;
  } catch {
    return null;
  }
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
  //
  // `pid.json` first (it describes the host that is actually running), then the
  // enrollment record. The fallback is the load-bearing half: the host UNLINKS
  // `pid.json` on graceful shutdown, which is precisely what a reinstall
  // performs - so on the launch this seed exists for, the live file is gone and
  // only the durable enrollment still identifies this machine.
  bridge.handleInvoke(
    RunnerHostInvoke.lastKnownLocalHostId,
    async (): Promise<string | null> => {
      const metadata = await readPidMetadata(
        bridge.options.host.pidMetadataFile,
      );
      if (metadata !== null) return metadata.hostId;
      return readEnrolledHostId(bridge.options.host.identityEnrollmentFile);
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
