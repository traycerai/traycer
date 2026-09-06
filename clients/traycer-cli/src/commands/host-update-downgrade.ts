import type { ApplyHostOutcome } from "../installer/apply";
import {
  discardStagedHostInstallSource,
  stageHostInstallSource,
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
import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

/**
 * Explicit rollback uses the install primitive, whose private verified source
 * survives independently of the monotonic background-update stage. Keep the
 * update command's progress marker and health check around this operation.
 */
export async function installHostDowngrade(input: {
  readonly environment: Environment;
  readonly version: string;
  readonly force: boolean;
  readonly onProgress: (info: ProgressInfo) => void;
  /**
   * Runs under the mutation lock, AFTER the busy gate and immediately before
   * the commit - the first point at which this command is the only updater
   * acting and has committed to acting. `host update` takes ownership of the
   * progress marker here (the one it wrote before waiting for admission may
   * have been withdrawn or replaced by another run); a busy refusal must
   * come first, so a parked run never seizes a marker for work it then does
   * not do.
   */
  readonly onBeforeCommit: () => Promise<void>;
  /** See `ApplyHostOptions.onWillDisruptHost`: the same actuator-reported boundary. */
  readonly onWillDisruptHost: () => void;
}): Promise<Extract<ApplyHostOutcome, { outcome: "applied" }>> {
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment: input.environment,
    reason: "host-update-downgrade",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "legacy-update-shadow",
  };
  return withCliUpdateExecutionSegment(contenderOptions, async (capability) => {
    const verify = (): Promise<void> =>
      requireCliUpdateMutationCapability(capability, contenderOptions);
    const staged = await stageHostInstallSource({
      environment: input.environment,
      source: { kind: "registry", versionRequest: input.version },
      onProgress: input.onProgress,
      recordVersionOverride: null,
      verifyMutationCapability: verify,
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
          await input.onBeforeCommit();
          const handle = createServiceInstallLifecycle({
            environment: input.environment,
            bootstrap: null,
            force: input.force,
            onWillStopHost: input.onWillDisruptHost,
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
  });
}
