import { join } from "node:path";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { Environment } from "../runner/environment";
import { createCliLogger } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { readHostStagedRecord } from "../manifest/host-staged";
import { hostStagedDir } from "../store/paths";
import { assertHostNotBusy } from "../host/busy-check";
import type { ServiceState } from "../service";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { reconcileHostStage } from "./stage-reconcile";
import { commitInstallFromSource, currentInstallPlatform } from "./install";

// `host apply` core - Host Update Layer Redesign Tech Plan, "New/changed
// commands" > `host apply`. Promotes the single-slot staged tree over the
// current install: no download, no extraction - the stage was already
// verified by `host download`. The stop -> swap -> start tail is
// `commitInstallFromSource` (installer/install.ts), shared with
// `installHost`.
//
// Concurrency: like `installHost`, this assumes the caller already holds
// the environment's `cli-lock` (see `commands/host-apply.ts`) - reconcile,
// the record reads, the no-op/busy checks, and the commit all run inside
// ONE lock span, per the Tech Plan's "the final idle decision happens
// inside an acquired lock immediately before the disruptive step".

export interface ApplyHostOptions {
  readonly environment: Environment;
  // Desktop receives this from its off-lane registry eligibility pass. The
  // value is checked after reconcile, while the caller holds cli-lock.
  // Null means "no fingerprint pin" - callers state that explicitly.
  readonly expectedStageFingerprint: string | null;
  // Skips the busy check. Does NOT affect `--no-service`'s own busy-check
  // skip below - the two flags are independent knobs with the same effect
  // on this one gate.
  readonly force: boolean;
  // Internal/hidden (desktop-owned packaged-macOS path): skips the busy
  // check AND the service stop/start lifecycle entirely (a non-disruptive
  // POSIX swap). Rejected on Windows, where the service stop is load-
  // bearing for releasing file handles the rename needs.
  readonly noService: boolean;
  readonly onProgress: (info: ProgressInfo) => void;
}

// The facts `createServiceInstallLifecycle` observed around the swap -
// mirrors the same family of facts `host ensure`'s `serviceLifecycle`
// payload already reports (Tech Plan: "Attested generation in results"),
// so a caller (the controller, or `host update`'s legacy-projection
// compat boundary) can attribute readiness without re-deriving it.
// `postSwapError` stays a sibling on `ApplyHostOutcome` itself, not
// nested here, matching this function's existing no-rollback contract.
export interface ApplyServiceLifecycleFacts {
  readonly priorServiceState: ServiceState;
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: "restart" | "start" | "install" | "none";
}

export type ApplyHostOutcome =
  | {
      // The ONLY reachable no-op path: reconcile (this function's own
      // first step) already deletes a `comparable staged <= installed`
      // stage via its own "stale-or-equal-version" deletion rule before
      // this function ever reads it - so a distinct "not newer" no-op
      // branch here would be unreachable dead code, not a second real
      // outcome. See stage-reconcile.ts's `evaluateStageForDeletion`.
      readonly outcome: "no-op";
      readonly installedVersion: string;
    }
  | {
      readonly outcome: "applied";
      readonly record: HostInstallRecord;
      readonly previous: HostInstallRecord | null;
      // False whenever `--no-service` was set (no start was even
      // attempted) or the post-swap start/restart failed - true only when
      // the newly-committed bytes are confirmed running.
      readonly runningActivated: boolean;
      // The attested, committed canonical install-generation fingerprint -
      // read from the record this call itself just wrote, never a later
      // disk re-read, so callers never race a subsequent mutation.
      readonly installGeneration: string;
      // `null` iff `--no-service` skipped the lifecycle entirely - apply
      // has no service facts to report, not a synthesized "not-installed"
      // guess.
      readonly serviceLifecycle: ApplyServiceLifecycleFacts | null;
      // Non-null iff the post-swap start/restart threw. Per the Tech
      // Plan's no-rollback contract, this is a WARNING alongside a
      // successful "applied" outcome, never a thrown error - "installed,
      // not converged", never "update ready".
      readonly postSwapError: string | null;
    }
  | {
      readonly outcome: "stage-fingerprint-mismatch";
      readonly installedVersion: string;
      readonly expectedStageFingerprint: string | null;
      readonly actualStageFingerprint: string | null;
    };

export async function applyHost(
  opts: ApplyHostOptions,
): Promise<ApplyHostOutcome> {
  const logger = createCliLogger(opts.environment);

  if (opts.noService && currentInstallPlatform() === "win32") {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host apply: --no-service is not supported on Windows",
      details: { environment: opts.environment },
      exitCode: 1,
    });
  }

  await reconcileHostStage(opts.environment);

  const installed = await readHostInstallRecord(opts.environment);
  if (installed === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `host apply: no host installed for environment=${opts.environment}; run 'traycer host install latest' first`,
      details: { environment: opts.environment },
      exitCode: 1,
    });
  }

  // Reconcile above already applies the Version Identity policy for us:
  // its own "stale-or-equal-version" deletion rule removes a `comparable
  // staged <= installed` stage before this read ever sees it, and its
  // orphan rule guarantees a surviving stage never outlives its install
  // record. So if a stage is still here, it's already either incomparable
  // to `installed` (proceeds - D6 parity) or strictly newer - there is no
  // separate "staged but not newer" case left to check.
  const staged = await readHostStagedRecord(opts.environment);
  const expectedStageFingerprint = opts.expectedStageFingerprint;
  if (
    expectedStageFingerprint !== null &&
    (staged === null || staged.stageId !== expectedStageFingerprint)
  ) {
    logger.info("Host apply rejected a replaced staged handoff", {
      environment: opts.environment,
      expectedStageFingerprint,
      actualStageFingerprint: staged?.stageId ?? null,
    });
    return {
      outcome: "stage-fingerprint-mismatch",
      installedVersion: installed.version,
      expectedStageFingerprint,
      actualStageFingerprint: staged?.stageId ?? null,
    };
  }
  if (staged === null) {
    logger.info("Host apply found nothing staged", {
      environment: opts.environment,
    });
    return { outcome: "no-op", installedVersion: installed.version };
  }

  if (!opts.noService && !opts.force) {
    await assertHostNotBusy(opts.environment);
  }

  // `bootstrap: null` - apply is strictly an update over an existing,
  // already-registered install (guaranteed by the `HOST_NOT_INSTALLED`
  // check above), never a first registration; mirrors `host update`'s
  // existing lifecycle construction.
  const lifecycleHandle = opts.noService
    ? null
    : createServiceInstallLifecycle({
        environment: opts.environment,
        bootstrap: null,
      });

  const stagedDir = hostStagedDir(opts.environment);
  const { record, previous } = await commitInstallFromSource({
    environment: opts.environment,
    sourceDir: stagedDir,
    executablePath: join(stagedDir, staged.executablePath),
    version: staged.version,
    runtimeVersion: staged.runtimeVersion,
    source: staged.source,
    archiveSha256: staged.archiveSha256,
    signatureVerifiedAt: staged.signatureVerifiedAt,
    signatureKeyId: staged.signatureKeyId,
    sizeBytes: staged.sizeBytes,
    onProgress: opts.onProgress,
    lifecycle: lifecycleHandle?.lifecycle ?? null,
    onCommitted: () => {},
  });

  // `createServiceInstallLifecycle`'s `afterSwap` already swallows its own
  // start/restart/register failures into `state.postSwapError` rather than
  // throwing (see service/install-lifecycle.ts) - that existing swallow-
  // into-field behavior IS this function's no-rollback contract; no
  // separate try/catch needed here.
  const postSwapError = lifecycleHandle?.state.postSwapError ?? null;
  const runningActivated =
    lifecycleHandle !== null &&
    postSwapError === null &&
    lifecycleHandle.state.postSwapAction !== "none";
  const serviceLifecycle: ApplyServiceLifecycleFacts | null =
    lifecycleHandle === null
      ? null
      : {
          priorServiceState: lifecycleHandle.state.priorState,
          stoppedBeforeSwap: lifecycleHandle.state.stoppedBeforeSwap,
          postSwapAction: lifecycleHandle.state.postSwapAction,
        };

  const installGeneration = encodeInstallGeneration({
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  });

  logger.info("Host apply completed", {
    environment: opts.environment,
    version: record.version,
    previousVersion: previous?.version ?? null,
    runningActivated,
    hasPostSwapError: postSwapError !== null,
  });

  return {
    outcome: "applied",
    record,
    previous,
    runningActivated,
    installGeneration,
    serviceLifecycle,
    postSwapError,
  };
}
