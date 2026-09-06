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
 * Explicit rollback uses the install primitive, whose private verified source
 * survives independently of the monotonic background-update stage.
 *
 * This wrapper opens its own execution segment; `installHostDowngradeInSegment`
 * below is the same body under a capability the CALLER already holds, which is
 * what the attempt executor needs - it owns its segment for the length of the
 * run and cannot let this function open a second one.
 */
export async function installHostDowngrade(
  input: InstallHostDowngradeInput,
): Promise<Extract<ApplyHostOutcome, { outcome: "applied" }>> {
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
): Promise<Extract<ApplyHostOutcome, { outcome: "applied" }>> {
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
  try {
    return await withCliAttemptMutation(
      capability,
      contenderOptions,
      async () => {
        // Recheck under the mutation lock: uninstall may have won before this
        // execution segment was claimed. An update never bootstraps a host.
        if ((await readHostInstallRecord(input.environment)) === null) {
          throw cliError({
            code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
            message:
              "host update: no host installed; run 'traycer host install' first",
            details: { environment: input.environment },
            exitCode: 1,
          });
        }
        if (!input.force) await assertHostNotBusy(input.environment);
        const handle = createServiceInstallLifecycle({
          environment: input.environment,
          bootstrap: null,
          force: input.force,
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
}
