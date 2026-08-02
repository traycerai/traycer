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

type EnrollmentRead =
  | { readonly kind: "enrolled"; readonly hostId: string }
  /** No file (ENOENT): a legacy install that predates the enrollment record. */
  | { readonly kind: "absent" }
  /**
   * The record EXISTS but cannot answer - unreadable, unparseable, or missing
   * its `hostId`. Not the same fact as absent: an existing record proves this
   * install HAS enrollment machinery, so its content being momentarily
   * unusable must not hand the decision to a lower-trust source.
   */
  | { readonly kind: "unusable" };

/** The `hostId` from the host's durable enrollment record. */
async function readEnrolledHostId(path: string): Promise<EnrollmentRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "absent" };
    }
    return { kind: "unusable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { kind: "unusable" };
    }
    const hostId = (parsed as Record<string, unknown>).hostId;
    return typeof hostId === "string" && hostId.length > 0
      ? { kind: "enrolled", hostId }
      : { kind: "unusable" };
  } catch {
    return { kind: "unusable" };
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
  // The ENROLLMENT record decides, and `pid.json` is only the fallback. Which
  // is the reverse of what "the file describing the running host" suggests,
  // and the reversal is the point:
  //
  //  - The launch this seed exists for is a reinstall, where the host is down.
  //    The host unlinks `pid.json` on graceful shutdown, so the live file is
  //    already gone and enrollment is the only thing left that identifies this
  //    machine. Enrollment carries that case either way.
  //  - `pid.json` does NOT survive only while the host runs. An ungraceful
  //    stop leaves it behind, and `readPidMetadata` accepts it structurally -
  //    no liveness or reachability check. Re-enroll while the host is down and
  //    that stale file names the PREVIOUS id, which the renderer would then
  //    persist, neutralize the wrong registry row with, and leave this
  //    machine's real twin remote-kind and relay-dialable: the exact lockout
  //    the seed was added to prevent, reached from the other direction.
  //
  // A running host's `pid.json` agrees with enrollment, so preferring
  // enrollment costs nothing when both answer. The pid fallback is reserved
  // for `absent` alone - a legacy install that predates the enrollment
  // record. An `unusable` record answers null WITHOUT consulting pid: the
  // record existing proves this install enrolls, so its content being
  // unreadable right now must not hand the decision to the very source whose
  // staleness this ordering exists to outrank. The renderer treats null as
  // "keep the persisted value", which is the correct do-no-harm answer.
  bridge.handleInvoke(
    RunnerHostInvoke.lastKnownLocalHostId,
    async (): Promise<string | null> => {
      const enrollment = await readEnrolledHostId(
        bridge.options.host.identityEnrollmentFile,
      );
      if (enrollment.kind === "enrolled") return enrollment.hostId;
      if (enrollment.kind === "unusable") return null;
      const metadata = await readPidMetadata(
        bridge.options.host.pidMetadataFile,
      );
      return metadata === null ? null : metadata.hostId;
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
