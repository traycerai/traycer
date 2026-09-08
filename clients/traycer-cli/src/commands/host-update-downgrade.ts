import type { ApplyHostOutcome } from "../installer/apply";
import {
  discardStagedHostInstallSource,
  stageHostInstallSource,
  type InstallPhaseHooks,
} from "../installer/install";
import { readHostInstallRecord } from "../manifest/host-install";
import { assertHostNotBusy } from "../host/busy-check";
import {
  requireCliUpdateMutationCapability,
  withCliAttemptMutation,
  withCliUpdateExecutionSegment,
  type WithCliUpdateContenderOptions,
} from "../host/update-contender";
import { commitHostInstallSourceWithAttempt } from "../host/update-mutation";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

export interface InstallHostDowngradeInput {
  readonly environment: Environment;
  readonly version: string;
  readonly force: boolean;
  readonly onProgress: (info: ProgressInfo) => void;
  /**
   * Runs under the mutation lock, AFTER the busy gate and the under-lock
   * no-op and immediately before the commit - the first point at which this
   * command is the only updater acting and has committed to acting. A caller
   * driving the coarse progress marker by hand takes ownership of it here
   * (the one it wrote before waiting for admission may have been withdrawn
   * or replaced by another run); a busy refusal and a no-op must come first,
   * so a parked run never seizes a marker for work it then does not do.
   *
   * The attempt executor passes a no-op: its marker is projected from the
   * record, so it has nothing to take over. Same decision, same reason, as
   * the apply arm's omitted `onWillCommitStaged`.
   */
  readonly onBeforeCommit: () => Promise<void>;
  /** See `ApplyHostOptions.onWillDisruptHost`: the same actuator-reported boundary. */
  readonly onWillDisruptHost: () => void;
  /**
   * See `StageVerifiedSourceOptions.beforeExtract` - the verified-bytes
   * barrier, threaded into the private staging path so an attempt-driving
   * caller reaches `preparing` on this arm exactly as it does on the shared
   * one. Callers driving no attempt record pass a no-op.
   */
  readonly beforeExtract: () => Promise<void>;
  /**
   * The two swap barriers, threaded into the lifecycle this function builds.
   * `beforeSwapCommit` fires after the busy gate and after the cooperative
   * stop SUCCEEDED, immediately before the commit lands; `afterSwap` fires
   * after the swap and before the relaunch. A busy refusal reaches neither.
   * Callers driving no attempt record pass `NO_INSTALL_PHASE_HOOKS`.
   */
  readonly hooks: InstallPhaseHooks;
}

/**
 * An explicit install the monotonic shared stage would refuse - a rollback
 * below the record, or another build of the record's release - uses the
 * install primitive, whose private verified source survives independently of
 * the background-update stage. Keep the update command's progress marker and
 * health check around this operation.
 *
 * This wrapper opens its own execution segment; `installHostDowngradeInSegment`
 * below is the same body under a capability the CALLER already holds, which is
 * what the attempt executor needs - it owns its segment for the length of the
 * run and cannot let this function open a second one.
 */
export async function installHostDowngrade(
  input: InstallHostDowngradeInput,
): Promise<Extract<ApplyHostOutcome, { outcome: "applied" | "no-op" }>> {
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment: input.environment,
    reason: "host-update-downgrade",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "legacy-update-shadow",
  };
  return withCliUpdateExecutionSegment(contenderOptions, (capability) =>
    installHostDowngradeInSegment(input, capability, contenderOptions),
  );
}

export async function installHostDowngradeInSegment(
  input: InstallHostDowngradeInput,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
): Promise<Extract<ApplyHostOutcome, { outcome: "applied" | "no-op" }>> {
  const verify = (): Promise<void> =>
    requireCliUpdateMutationCapability(capability, contenderOptions);
  const staged = await stageHostInstallSource({
    environment: input.environment,
    source: { kind: "registry", versionRequest: input.version },
    onProgress: input.onProgress,
    recordVersionOverride: null,
    verifyMutationCapability: verify,
    beforeExtract: input.beforeExtract,
  });
  let outcome: Extract<ApplyHostOutcome, { outcome: "applied" | "no-op" }>;
  try {
    outcome = await withCliAttemptMutation(
      capability,
      contenderOptions,
      async () => {
        // Recheck under the mutation lock: uninstall may have won before this
        // execution segment was claimed. An update never bootstraps a host.
        const installed = await readHostInstallRecord(input.environment);
        if (installed === null) {
          throw cliError({
            code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
            message:
              "host update: no host installed; run 'traycer host install' first",
            details: { environment: input.environment },
            exitCode: 1,
          });
        }
        // The caller decided "requested below installed, or another build of
        // its release" before this lock; re-derived here like every pre-lock
        // fact. Another actor may have installed the requested version
        // meanwhile (an explicit `host update` of its own): committing
        // identical bytes again would restart the host for nothing. The
        // no-op is decided before the busy gate - a host with nothing owed
        // is not asked - and before `onBeforeCommit` and both swap barriers,
        // so neither the marker nor the record is advanced for work that is
        // not done. The caller re-derives the activation state, as it does
        // for a consumed stage.
        //
        // STRING equality, like every other identity test on this path:
        // `2.0.0+bar` installed under a request for `2.0.0+foo` is not the
        // requested artifact, and this arm is precisely the one that exists
        // to deliver it.
        if (installed.version === input.version) {
          return {
            outcome: "no-op",
            installedVersion: installed.version,
          } satisfies Extract<ApplyHostOutcome, { outcome: "no-op" }>;
        }
        if (!input.force) await assertHostNotBusy(input.environment);
        await input.onBeforeCommit();
        const handle = createServiceInstallLifecycle({
          environment: input.environment,
          bootstrap: null,
          force: input.force,
          onWillStopHost: input.onWillDisruptHost,
          hooks: input.hooks,
        });
        const result = await commitHostInstallSourceWithAttempt(
          capability,
          contenderOptions,
          {
            environment: input.environment,
            staged,
            onProgress: input.onProgress,
            lifecycle: handle.lifecycle,
            onWillSwap: input.onWillDisruptHost,
          },
        );
        return {
          outcome: "applied",
          record: result.record,
          previous: result.previous,
          installGeneration: result.installGeneration,
          runningActivated:
            handle.state.postSwapError === null &&
            handle.state.postSwapAction !== "none",
          serviceLifecycle: {
            priorServiceState: handle.state.priorState,
            stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
            postSwapAction: handle.state.postSwapAction,
          },
          postSwapError: handle.state.postSwapError,
        } satisfies Extract<ApplyHostOutcome, { outcome: "applied" }>;
      },
    );
  } catch (error) {
    await discardStagedHostInstallSource(input.environment, staged, verify);
    throw error;
  }
  if (outcome.outcome === "no-op") {
    // The private source was staged for a commit that is not needed.
    await discardStagedHostInstallSource(input.environment, staged, verify);
  }
  return outcome;
}
