import { randomUUID } from "node:crypto";
import {
  compareHostVersions,
  isValidHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  attemptIdentityOf,
  isParkedPhase,
  isTerminalPhase,
  readUpdateAttemptRecord,
  type AttemptAdvance,
  type AttemptClaimRefresh,
  type AttemptCommitOutcome,
  type HostUpdateAttemptClaimBaseline,
  type HostUpdateAttemptContinuation,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptPhase,
  type HostUpdateAttemptProgress,
  type HostUpdateAttemptRead,
  type HostUpdateAttemptRecord,
  type HostUpdateTrigger,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { commitExecutorAttemptMutation } from "@traycer-clients/shared/host-update/contender";
import { installHostDowngradeInSegment } from "../commands/host-update-downgrade";
import type { ApplyHostOutcome } from "../installer/apply";
import {
  downloadAndStageHostInSegment,
  resolveUpdatePlan,
  type HostDownloadOutcome,
  type HostUpdatePlan,
  type HostUpdatePlanIdentity,
  type StageMaintenanceContenderOptions,
} from "../installer/download-stage";
import type { ILogger } from "../logger";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import {
  readHostStagedRecord,
  type HostStagedRecord,
} from "../manifest/host-staged";
import type { RegistryClient } from "../registry";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import { createServiceController, serviceLabelFor } from "../service";
import { assertHostNotBusy } from "./busy-check";
import { readHostPidMetadata } from "./pid-metadata";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import { hostHomeDir } from "../store/paths";
import {
  installDispatchAckStamper,
  type DispatchAckStamper,
} from "./update-dispatch-ack";
import {
  createUpdateProgressMarkerIfAbsent,
  deleteUpdateProgressMarkerIfUnchanged,
  progressRecord,
  readUpdateProgressMarker,
  replaceUpdateProgressMarkerIfUnchanged,
  sameProgress,
  updateProgressRecordHasLiveWriter,
  type ConditionalMarkerDelete,
  type ConditionalMarkerReplace,
  type HostUpdateProgress,
} from "./update-progress-marker";
import {
  runLocalAttemptExecutorSegment,
  NO_UPDATE_EXECUTOR_FAULTS,
  type ExecutorClaimOutcome,
  type ExecutorClaimSelection,
  type ExecutorSegmentOutcome,
} from "./update-executor";
import {
  withCliAttemptMutation,
  type WithCliAttemptExecutorOptions,
  type WithCliUpdateContenderOptions,
} from "./update-contender";
import {
  applyHostWithAttempt,
  relaunchHostAfterRestartWithAttempt,
  stopHostForRestartWithAttempt,
} from "./update-mutation";
import { observeAttemptRecoveryEvidence } from "./update-recovery-evidence";
import { currentInstallPlatform } from "../installer/install";

// `traycer host update`, on the schema-v2 attempt executor (Plan D1).
//
// The command file is a thin shell: argument parsing, the
// `LegacyHostUpdateResult` projection and the human summary. EVERYTHING that
// decides, writes or actuates lives here, because every arm shares one
// selector, one record writer and one ACK exit, and a half-cutover would
// leave `host update` writing records for some arms and coarse markers for
// others.
//
// Shape (CLI wiring, "Shape"):
//
//   plan   - ADVISORY, intent-shaped, no lock, no record. `install` resolves
//            the registry; `activate` reads local evidence only; `continue`
//            touches the registry only for a downgrade re-download.
//   select - AWAITED under the contender lock, before the first write. It is
//            the only place a run may read live evidence and still be able to
//            say "nothing to do": the plan runs where both facts can still
//            move, and `execute` runs after a phase is already written.
//   arm    - one writer owns every record write; the installer's own hook
//            interface supplies the phase barriers.
//   ACK    - stamped on EVERY exit, `claimed` from the executor's own
//            acknowledgement boundary and `no-attempt {reason}` otherwise.
//
// The coarse `update-progress.json` marker is DUAL-WRITTEN for one release
// (Plan D10) by `mirrorMarker` below, driven by record writes rather than by
// arm callbacks. Its rules are the legacy command's, ported function by
// function; the host still returns the marker over the record while one is
// present, so that mapping is what every 1.2.x and 1.3 host shows.

/** The bound intents an argv option may carry (Plan D16). `install` is absent. */
export type HostUpdateBoundIntent = "activate" | "continue";

// EVERY EXIT OF THIS FILE AND ITS SHELL, and what each stamps (Plan D7).
// Fourteen in total; twelve are `runHostUpdate`'s. All of them funnel through
// ONE once-only settlement (`createDispatchSettlement`), so where two are
// reached in sequence the FIRST wins and the second is not even called.
//
//  1. throw, illegal `--ack-nonce`      - no ACK is possible: the correlation
//                                         is already lost, and a nonce this
//                                         build rejects cannot be one the
//                                         resolver minted.
//  2. throw, explicitly empty target    - `refused-e-invalid-argument`
//  3. throw, illegal bound-intent pair  - `refused-e-invalid-argument`
//  4. throw from the advisory plan      - `refused-<code>` / `refused-unexpected`
//  5. throw from the selector           - `refused-e-host-not-installed`, and
//                                         `refused-unexpected` for its I/O
//  6. throw from an arm after the claim - `claimed` (stamped at the boundary)
//  7. `E_HOST_BUSY` park after a claim  - `claimed`
//  8. return, executed                  - `claimed`
//  9. return, released                  - `no-attempt {reason}`
// 10. throw, rejected segment           - `no-attempt {segment's own reason}`,
//                                         then `E_HOST_UPDATE_ATTEMPT_ACTIVE`
// 11. throw, projection cannot backfill - the release's reason, already stamped
// 12. throw/return, terminalized        - `recovered-complete` / `-failed`
//                                         (unreachable under `reselect`)
// 13. shell returns the legacy payload  - whatever this file stamped
// 14. shell rethrows                    - whatever this file stamped
//
// Exits 2 and 3 are why BOTH argument checks live here rather than at the
// registration site or in the command body. Commander ACCEPTS these arguments
// - an empty `--release=` and a `--intent` with no `--expect-attempt` are both
// well-formed argv, not the unknown-option exit an old parser takes - so a
// refusal thrown before the stamper exists leaves a dispatching host waiting
// to its deadline and reporting `dispatch-indeterminate`, for a refusal this
// CLI knew instantly.

/** Everything the run decides from, all of it from ARGV or the process env. */
export interface HostUpdateRunArgs {
  readonly environment: Environment;
  readonly logger: ILogger;
  readonly onProgress: (info: ProgressInfo) => void;
  /** `null` stages the latest registry version; an explicit value is a pin. */
  readonly versionRequest: string | null;
  readonly allowDowngrade: boolean;
  readonly force: boolean;
  readonly ackNonce: string | null;
  /**
   * The bound intent, from ARGV only (Plan D16). Never read from the
   * environment: an intent is AUTHORITY and must fail closed on a CLI that
   * cannot honour it, which only an argv option a pre-cutover parser rejects
   * can do. The trigger is provenance and rides the env for the opposite
   * reason - it must keep working on every CLI.
   */
  readonly intent: string | null;
  /** The attempt a bound intent is bound to; required with `intent`. */
  readonly expectAttempt: string | null;
  /** Test seam, as `DownloadAndStageHostOptions.registryClient`. */
  readonly registryClient: RegistryClient | null;
  /** `null` uses the production evidence-loop budget. */
  readonly verifyBudgetMs: number | null;
  /** `null` uses the production evidence-loop poll interval. */
  readonly verifyPollIntervalMs: number | null;
}

export interface LegacyHostUpdateServiceLifecycle {
  readonly priorServiceState: "running" | "stopped" | "not-installed";
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: "restart" | "start" | "install" | "none";
  readonly postSwapError: string | null;
}

/**
 * `host update`'s `--json` payload: a deliberate LEGACY-COMPAT projection, not
 * the executor's internals. Desktop's `projectInstallResult` reads this flat
 * shape and silently degrades every missing field to a fallback, so a shape
 * change here is invisible at the boundary and must not happen by accident.
 */
export interface LegacyHostUpdateResult {
  readonly version: string;
  readonly installedAt: string;
  readonly executablePath: string;
  readonly source: HostInstallRecord["source"];
  readonly archiveSha256: string | null;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly previousVersion: string | null;
  readonly serviceLifecycle: LegacyHostUpdateServiceLifecycle;
}

export interface HostUpdateRunOutcome {
  readonly legacy: LegacyHostUpdateResult;
  /**
   * The ACK reason when the selector declined the work, `null` when an attempt
   * actually ran. The shell renders it; the dispatching host reads the same
   * value out of the ACK file.
   */
  readonly releasedReason: string | null;
}

// Matches `projectInstallResult`'s own fallback when `serviceLifecycle` is
// absent - used whenever this run took no service action at all.
const NO_SERVICE_ACTION_LIFECYCLE: LegacyHostUpdateServiceLifecycle = {
  priorServiceState: "not-installed",
  stoppedBeforeSwap: false,
  postSwapAction: "none",
  postSwapError: null,
};

/** Provenance (Plan D11). Unknown values are treated as absent. */
const TRIGGER_ENV_VAR = "TRAYCER_HOST_UPDATE_TRIGGER";

const CONTENDER_WAIT_MS = 30_000;
const CONTENDER_POLL_INTERVAL_MS = 100;

/** The evidence loop's own budget, matching the health probe it replaces. */
const VERIFY_BUDGET_MS = 45_000;
const VERIFY_POLL_INTERVAL_MS = 500;

/** Download ticks coalesce below these thresholds (CLI wiring, "One writer"). */
const PROGRESS_MIN_INTERVAL_MS = 500;
const PROGRESS_MIN_PERCENT_DELTA = 1;

export async function runHostUpdate(
  args: HostUpdateRunArgs,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostUpdateRunOutcome> {
  const { environment, logger } = args;
  const home = hostHomeDir(environment);
  // FIRST, before anything is read or written: a run dispatched with a nonce
  // this build cannot honour has already lost the correlation its caller is
  // waiting on, and discovering that after staging bytes would mean doing
  // destructive work for a dispatch that can only ever report indeterminate.
  const ack = installDispatchAckStamper(home, args.ackNonce);
  const trigger = triggerFromEnvironment(env);

  const mirror = createMarkerMirror(environment, logger);
  const writerRef: { current: AttemptRecordWriter | null } = { current: null };
  const onProgress = (info: ProgressInfo): void => {
    // The stop is ISSUED here, not succeeded: `commitInstallFromSource` emits
    // `service-stop` immediately before the stop and `swap` before the rename,
    // and past either the host's state is this run's doing. A FLAG, never a
    // phase - `onProgress` writes no phases (CLI wiring, "One writer").
    if (info.stage === "service-stop" || info.stage === "swap") {
      mirror.markDisturbed();
    }
    writerRef.current?.progress(downloadTick(info));
    args.onProgress(info);
  };

  // Run-scoped, and deliberately not on the record: the selector reads them
  // under the lock and the arm consumes them there, which is the whole of
  // their lifetime.
  const selection: SelectionFacts = {
    installedUnderLock: null,
    debtReading: null,
    underLockRunningVersion: null,
    lastSeenRunningVersion: null,
    planActivationReading: null,
  };

  // The ONE settlement point every exit in the table above funnels through.
  // The stamper is idempotent too, but that only makes the second WRITE a
  // no-op; this makes the second CALL one, which is what "exactly once" has to
  // mean for an exit that decides its reason from what the first one already
  // answered (exits 10→11 are precisely that sequence).
  const settlement = createDispatchSettlement(ack, logger);
  try {
    // Inside the try, so exits 2 and 3 answer their dispatcher like every
    // other refusal. Nothing has been read or written at this point.
    refuseEmptyVersionRequest(args.versionRequest);
    const intent: "install" | HostUpdateBoundIntent =
      parseBoundIntent(args.intent, args.expectAttempt) ?? "install";
    const plan = await resolvePlan(args, intent, selection);
    const segment = await runLocalAttemptExecutorSegment(
      {
        platform: currentInstallPlatform(),
        contender: executorContenderOptions(environment),
        request: (current) =>
          selectClaim({ args, intent, trigger, plan, selection, current }),
        // This caller performs the activation itself, so a recovered
        // `activate` continuation is handed to `execute` rather than re-parked.
        recoveredActivation: "execute",
        // A dispatcher that named a target still wants it: an interrupted A
        // followed by a request for B completes A and then starts B.
        afterRecovery: "reselect",
        nowIso: () => new Date().toISOString(),
        faults: NO_UPDATE_EXECUTOR_FAULTS,
      },
      async (claim) => {
        await settlement.claimed(claim);
      },
      async (capability, claim, complete) =>
        runArm({
          args,
          plan,
          selection,
          mirror,
          writerRef,
          onProgress,
          capability,
          claim,
          complete,
        }),
    );
    return await projectSegment({ args, settlement, selection, segment });
  } catch (err) {
    await settlement.refused(refusedAckReason(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The dispatch contract (Plan D11, D16)
// ---------------------------------------------------------------------------

function triggerFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): HostUpdateTrigger {
  const raw = env[TRIGGER_ENV_VAR];
  if (raw === "automatic" || raw === "support-floor") return raw;
  // Absent OR unknown. An unrecognized value is provenance this build cannot
  // interpret, and inventing one would put a wrong `trigger` on a durable
  // record; `manual` is the honest floor.
  return "manual";
}

/**
 * An EXPLICIT empty target is a mistake, not a request for latest.
 *
 * `--version=`, `--release=` and an unset shell variable (`--release "$PIN"`)
 * all arrive as `""`, and treating that as "resolve latest" would silently
 * update a machine the caller meant to pin.
 *
 * It lives HERE, and not at the registration site where it used to, for the
 * same reason the bound-intent parse does: Commander ACCEPTS these arguments -
 * this is not the unknown-option exit an old parser takes - so a refusal
 * thrown before the dispatch-ACK settlement exists leaves a host that passed a
 * nonce waiting to its deadline and reporting `dispatch-indeterminate`, for a
 * refusal the CLI knew instantly. The error and its message are unchanged;
 * only the side of the settlement it is thrown on has moved.
 *
 * Returns nothing: on the far side of it `versionRequest` is either `null` or
 * a non-empty string, which is what every reader downstream assumes.
 */
function refuseEmptyVersionRequest(versionRequest: string | null): void {
  if (versionRequest === null || versionRequest.length > 0) return;
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message:
      "host update: --release (or its --version alias) needs a version; pass one, or omit the flag entirely to update to the latest release",
    details: { release: versionRequest },
    exitCode: 1,
  });
}

/**
 * The `--intent` / `--expect-attempt` pairing and legal-value check.
 *
 * Commander has no option pairing: its parser rejects UNKNOWN options - which
 * is the whole point of putting the intent on argv, so a pre-cutover parser
 * exits before any body runs - but it has nothing to say about two options
 * that are only meaningful together. A bound intent with no attempt to bind to
 * is an authorization with no subject, and running it as a plain install would
 * be exactly the broader authorization the argv contract exists to prevent.
 *
 * The value arrives RAW from argv so an illegal one is refused with a CLI
 * error a caller can read, rather than being silently widened at the
 * registration site.
 */
function parseBoundIntent(
  intent: string | null,
  expectAttempt: string | null,
): HostUpdateBoundIntent | null {
  if (intent !== null && intent !== "activate" && intent !== "continue") {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `host update: --intent must be 'activate' or 'continue' (got '${intent}')`,
      details: { intent },
      exitCode: 1,
    });
  }
  if (intent === null && expectAttempt !== null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "host update: --expect-attempt names the attempt a bound intent acts on; pass --intent too",
      details: { expectAttempt },
      exitCode: 1,
    });
  }
  if (intent !== null && expectAttempt === null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `host update: --intent ${intent} needs the attempt it is bound to; pass --expect-attempt <id>`,
      details: { intent },
      exitCode: 1,
    });
  }
  return intent;
}

/**
 * The run's single answer to its dispatcher.
 *
 * One run, one ACK: whichever of the two arms is reached FIRST is the true
 * one, and every later exit is a consequence of it rather than a better
 * description of it. A rejected segment reports the claim refusal and then
 * throws `E_HOST_UPDATE_ATTEMPT_ACTIVE`; a release whose projection cannot read
 * the install record reports the release and then throws
 * `E_HOST_NOT_INSTALLED`. Letting the second win would replace "the cohort
 * refused this claim" with "something was already active".
 *
 * Idempotent HERE as well as inside the stamper, and the difference matters:
 * the stamper's flag makes a second write a no-op, this makes the second CALL
 * one - so "stamped exactly once" is observable at the call site and not only
 * in the file that survives.
 */
interface DispatchSettlement {
  readonly claimed: (claim: {
    readonly identity: HostUpdateAttemptIdentity;
  }) => Promise<void>;
  readonly refused: (reason: string) => Promise<void>;
}

function createDispatchSettlement(
  ack: DispatchAckStamper | null,
  logger: ILogger,
): DispatchSettlement {
  let settled = false;
  return {
    claimed: async (claim): Promise<void> => {
      if (settled) return;
      settled = true;
      // NOT swallowed, unlike the refusal below: this one runs at the
      // executor's acknowledgement boundary, where a throw is the executor's
      // to handle, and a run that cannot answer a dispatcher which is waiting
      // on a claim has not quietly succeeded.
      if (ack !== null) await ack.acknowledge(claim);
    },
    refused: async (reason): Promise<void> => {
      if (settled) return;
      settled = true;
      if (ack === null) return;
      try {
        await ack.noAttempt(reason);
      } catch {
        // The ACK is correlation, not the outcome: a stamp that cannot land
        // turns the dispatcher's wait into a deadline, which is a true
        // answer. It must never replace the error (or the result) this run is
        // actually reporting.
        logger.info(
          "Host update could not stamp its dispatch acknowledgement",
          {
            reason,
          },
        );
      }
    },
  };
}

/**
 * The ACK reason for a throw that happened BEFORE any claim.
 *
 * `E_HOST_NOT_INSTALLED` becomes `refused-e-host-not-installed`; anything that
 * is not a `CliError` (an fs error, a bare `Error`) is `refused-unexpected`.
 * The result is forced into the ACK's reason grammar rather than trusted to
 * match it, because the value crosses a repository boundary.
 */
function refusedAckReason(err: unknown): string {
  if (!(err instanceof CliError)) return "refused-unexpected";
  const mapped = `refused-${err.code.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  return mapped.length <= 64 ? mapped : "refused-unexpected";
}

// ---------------------------------------------------------------------------
// The advisory plan (Plan D1)
// ---------------------------------------------------------------------------

/**
 * What the plan and the selector learned, carried between them and the arm.
 *
 * `debtReading` is the reading the SELECTOR took under the lock, and the busy
 * gate keys on it: the legacy activation arm gates on `debt` only, because a
 * host that is gone has no live work to protect.
 */
interface SelectionFacts {
  /** The install record the selector read under the lock, for the backfill. */
  installedUnderLock: HostInstallRecord | null;
  debtReading: "debt" | "no-live-host" | null;
  /** What was serving when the SELECTOR saw the debt, under the lock. */
  underLockRunningVersion: string | null;
  /** What was serving when the PLAN saw the debt; the legacy "before". */
  lastSeenRunningVersion: string | null;
  /** The PLAN's activation reading, the stale-`failed` clear's precondition. */
  planActivationReading: ActivationReading | null;
}

/**
 * The advisory plan as this run consumes it: `resolveUpdatePlan`'s installer-
 * side variants, plus the one shape only this layer can compose.
 *
 * `activation-debt` is not a member of the installer's plan union on purpose
 * (execution-run D-1): the RUNNING half of a debt is a fact about the live
 * host, and reading it from `installer/download-stage.ts` would invert the
 * layering. It is layered here, over a `no-op` (install intent) or over an
 * `activate` plan, by the same `readActivationState` the legacy command used.
 */
type RunPlan =
  | { readonly kind: "installer"; readonly plan: HostUpdatePlan }
  | {
      readonly kind: "activation-debt";
      readonly identity: HostUpdatePlanIdentity;
      readonly installedVersion: string;
      /** `null` when the plan's reading saw no live host to name. */
      readonly runningVersion: string | null;
    };

async function resolvePlan(
  args: HostUpdateRunArgs,
  intent: "install" | HostUpdateBoundIntent,
  selection: SelectionFacts,
): Promise<RunPlan> {
  const { environment } = args;
  if (intent === "activate") {
    // Local evidence only: no version to resolve, therefore no registry,
    // therefore no way for an unreachable registry to fail an activation.
    const plan = await resolveUpdatePlan({
      environment,
      request: { intent: "activate" },
      onProgress: args.onProgress,
      registryClient: args.registryClient,
    });
    if (plan.kind !== "activate") return { kind: "installer", plan };
    const reading = await readActivationState(environment);
    selection.planActivationReading = reading;
    const runningVersion =
      reading.kind === "debt" ? reading.runningVersion : null;
    selection.lastSeenRunningVersion = runningVersion;
    return {
      kind: "activation-debt",
      identity: plan.identity,
      installedVersion: plan.identity.installedVersion,
      runningVersion,
    };
  }

  if (intent === "continue") {
    const targetVersion = args.versionRequest;
    if (targetVersion === null) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host update: --intent continue needs the attempt's target version; pass --version",
        details: { environment },
        exitCode: 1,
      });
    }
    return {
      kind: "installer",
      plan: await resolveUpdatePlan({
        environment,
        request: {
          intent: "continue",
          targetVersion,
          // The ONLY case that touches the registry: a `resume-apply` park
          // with no usable stage, which is the downgrade re-download (Plan
          // D14). Every other park resumes from bytes already on disk - and
          // an ACTIVATION park has no bytes to fetch at all, so a `continue`
          // that resolved an asset for one would fail offline on work that
          // needs no network.
          needsTransfer: await parkNeedsTransfer(
            environment,
            args.expectAttempt,
          ),
        },
        onProgress: args.onProgress,
        registryClient: args.registryClient,
      }),
    };
  }

  const plan = await resolveUpdatePlan({
    environment,
    request: {
      intent: "install",
      versionRequest: args.versionRequest,
      allowDowngrade: args.allowDowngrade,
    },
    onProgress: args.onProgress,
    registryClient: args.registryClient,
  });
  if (plan.kind !== "no-op") return { kind: "installer", plan };
  // "Installed" is a fact about `install.json`; "running" is a fact about the
  // process, and the two disagree whenever bytes were swapped by a caller that
  // could not restart the host. Activation debt is an update this command
  // OWES, not a no-op it may report.
  const reading = await readActivationState(environment);
  selection.planActivationReading = reading;
  if (reading.kind !== "debt") return { kind: "installer", plan };
  selection.lastSeenRunningVersion = reading.runningVersion;
  return {
    kind: "activation-debt",
    identity: plan.identity,
    installedVersion: reading.installedVersion,
    runningVersion: reading.runningVersion,
  };
}

/**
 * The park's own shape decides whether a `continue` may reach the registry.
 *
 * Read from the CONTINUATION first and the stage second. Stage presence alone
 * cannot answer this: an activation park normally has no stage - its bytes are
 * already installed - so a stage-only test says "needs a transfer" for the one
 * continuation that needs nothing, and an offline `continue` on an activation
 * park then fails in the plan, before selection, on a run that could have
 * completed with no network at all.
 *
 * Advisory, like the whole plan: it reads pre-lock and the selector decides
 * again under the lock. A record that is not the one this intent names, or one
 * this read cannot make sense of, needs no transfer - the selector will refuse
 * it anyway, and reaching the registry to discover that would be worse.
 */
async function parkNeedsTransfer(
  environment: Environment,
  expectAttempt: string | null,
): Promise<boolean> {
  const read = await readUpdateAttemptRecord(hostHomeDir(environment));
  const record = read.kind === "valid" ? read.value : null;
  if (record === null) return false;
  if (expectAttempt !== null && record.attemptId !== expectAttempt)
    return false;
  if (record.continuation !== "resume-apply") return false;
  const staged = await readHostStagedRecord(environment);
  // "Usable" is all three: present, fingerprinted, and AT this park's target.
  return (
    staged === null ||
    staged.stageId === null ||
    staged.version !== record.targetVersion
  );
}

/** The target this run would work toward, as the plan sees it (advisory). */
function planTargetVersion(plan: RunPlan): string | null {
  if (plan.kind === "activation-debt") return plan.installedVersion;
  switch (plan.plan.kind) {
    case "not-installed":
      return null;
    case "activate":
      return plan.plan.identity.installedVersion;
    default:
      return plan.plan.targetVersion;
  }
}

// ---------------------------------------------------------------------------
// Claim selection under the lock (Plan D4, D16, D19)
// ---------------------------------------------------------------------------

interface SelectClaimInput {
  readonly args: HostUpdateRunArgs;
  readonly intent: "install" | HostUpdateBoundIntent;
  readonly trigger: HostUpdateTrigger;
  readonly plan: RunPlan;
  readonly selection: SelectionFacts;
  readonly current: HostUpdateAttemptRead;
}

async function selectClaim(
  input: SelectClaimInput,
): Promise<ExecutorClaimSelection> {
  const { args, intent, current } = input;
  if (current.kind !== "valid" && current.kind !== "absent") {
    // The executor's own decision surface refuses this too; saying so here
    // keeps the release reason inside the ACK's grammar.
    return { kind: "release", reason: "record-fail-closed" };
  }
  const record =
    current.kind === "valid" && current.value.execution !== "terminal"
      ? current.value
      : null;

  if (intent === "activate")
    return selectBoundResume(input, record, "activate");
  if (intent === "continue")
    return selectBoundResume(input, record, "continue");

  // ---- `install` -----------------------------------------------------------
  if (record !== null) {
    if (record.targetVersion === planTargetVersion(input.plan)) {
      // A same-target park or interrupted attempt admits exactly one action, a
      // resume. The identity re-validation under the lock is what refuses a
      // moved install record, TERMINALLY - never a release (D19).
      return resumeSelection(input, record);
    }
    if (isNoOpPlan(input.plan)) {
      // A park is left for its own continuation and an interrupted record for
      // the next `host update` naming THAT target; a plain up-to-date run
      // supersedes neither.
      await readInstalledUnderLock(args.environment, input.selection);
      return { kind: "release", reason: "nothing-to-do" };
    }
    // Another target and real work to do: `start` for the plan's target, which
    // the core turns into supersede-then-create.
  }
  return startSelection(input);
}

function isNoOpPlan(plan: RunPlan): boolean {
  return plan.kind === "installer" && plan.plan.kind === "no-op";
}

/**
 * The `start` a fresh `install` run claims.
 *
 * The activation-debt arm is decided AGAIN here, under the lock, exactly as
 * the legacy `activateInstalledAndProjectLegacy` does inside its contender:
 * both halves of a debt can move while a run waits for admission, and a host
 * that is already current owes nothing, busy or not.
 */
async function startSelection(
  input: SelectClaimInput,
): Promise<ExecutorClaimSelection> {
  const { args, plan, selection } = input;
  if (plan.kind === "activation-debt") return selectDebtStart(input);
  if (plan.plan.kind === "not-installed")
    throw hostNotInstalled(args.environment);
  if (plan.plan.kind === "activate") return selectDebtStart(input);
  if (plan.plan.kind === "no-op") {
    // Read under the lock for the shell's backfill, and throw the way the
    // legacy `applyAndProjectLegacy` does when the record is GONE: the shell
    // must never report "already up to date" for a host with no install.
    await readInstalledUnderLock(args.environment, selection);
    return { kind: "release", reason: "nothing-to-do" };
  }
  const identity = plan.plan.identity;
  return {
    kind: "claim",
    request: {
      targetVersion: plan.plan.targetVersion,
      trigger: input.trigger,
      action: "start",
      expected: null,
      newAttemptId: randomUUID(),
      initialPhase:
        plan.plan.kind === "already-staged" ? "preparing" : "downloading",
      initialContinuation: null,
      claim: baselineFrom(identity, args.allowDowngrade),
    },
  };
}

/**
 * The activation-debt `start`, decided from TWO reads under the lock - the
 * install record (`requireInstalled`'s rule) and then `readActivationState` -
 * exactly the pair the legacy arm takes inside its contender and before its
 * busy gate.
 *
 * A cleared debt must stay a RELEASE and never become a `start` that parks or
 * completes: a `start` here writes `preparing` and then `restarting` or
 * `failed`, and the legacy contract is that a cleared debt writes NOTHING.
 */
async function selectDebtStart(
  input: SelectClaimInput,
): Promise<ExecutorClaimSelection> {
  const { args, selection } = input;
  const installed = await readHostInstallRecord(args.environment);
  if (installed === null) throw hostNotInstalled(args.environment);
  selection.installedUnderLock = installed;
  const reading = await readActivationState(args.environment);
  if (reading.kind !== "debt" && reading.kind !== "no-live-host") {
    // `activated`, `foreign-runtime`, or a record that vanished between the
    // two reads: the legacy no-ops on anything but `debt` / `no-live-host`.
    // No stale-`failed` clear - the legacy clears only when the PRE-lock
    // reading was `activated`, and this run's was `debt`.
    return { kind: "release", reason: "nothing-to-do" };
  }
  selection.debtReading = reading.kind;
  selection.underLockRunningVersion =
    reading.kind === "debt" ? reading.runningVersion : null;
  return {
    kind: "claim",
    request: {
      targetVersion: installed.version,
      trigger: input.trigger,
      action: "start",
      expected: null,
      newAttemptId: randomUUID(),
      initialPhase: "preparing",
      // Without it a busy host at the activation gate has no legal park:
      // `waiting-to-activate` may be born only from `applying`, or re-parked
      // from an `activate` segment (Plan D5).
      initialContinuation: "activate",
      claim: {
        installedVersion: installed.version,
        installGeneration: installGenerationOf(installed),
        stageFingerprint: null,
        allowDowngrade: args.allowDowngrade,
      },
    },
  };
}

/** The resume every intent uses: one identity-bound `continue` action. */
function resumeSelection(
  input: SelectClaimInput,
  record: HostUpdateAttemptRecord,
): ExecutorClaimSelection {
  return {
    kind: "claim",
    request: {
      targetVersion: record.targetVersion,
      trigger: record.trigger,
      // `continue` adopts EITHER continuation: the dispatcher named an
      // attempt, not an operation, and the record is what says which.
      action: "continue",
      expected: attemptIdentityOf(record),
      newAttemptId: randomUUID(),
      initialPhase: "preparing",
      initialContinuation: null,
      claim: null,
    },
  };
}

/**
 * `activate` / `continue`: a bound intent resumes exactly the park it names,
 * or it releases with the reason the ACK reports. It never starts anything.
 */
async function selectBoundResume(
  input: SelectClaimInput,
  record: HostUpdateAttemptRecord | null,
  intent: HostUpdateBoundIntent,
): Promise<ExecutorClaimSelection> {
  const expect = input.args.expectAttempt;
  if (record === null || expect === null || record.attemptId !== expect) {
    return { kind: "release", reason: "refused-attempt-gone" };
  }
  if (record.execution !== "parked") {
    // An ACTIVE record for this id is an interrupted attempt; recovery owns
    // it, and a bound intent has no park to resume.
    return { kind: "release", reason: "refused-attempt-gone" };
  }
  if (intent === "activate" && record.phase !== "waiting-to-activate") {
    return { kind: "release", reason: "refused-attempt-gone" };
  }
  const baseline = record.claim;
  if (record.phase === "waiting-to-activate") {
    // NO ordering test: `target === installed` by construction on every
    // activation park. A claim-less one is unverifiable (D19, 01's ignore
    // rule) - version ordering cannot establish an earlier authorization.
    if (baseline === undefined) {
      return { kind: "release", reason: "refused-unverifiable" };
    }
    return resumeSelection(input, record);
  }
  if (baseline === undefined) {
    // A claim-less park is resumable only as an upgrade above the LIVE
    // installed version - there is no baseline to consent with.
    const installed = await readHostInstallRecord(input.args.environment);
    if (installed === null) throw hostNotInstalled(input.args.environment);
    input.selection.installedUnderLock = installed;
    return strictlyNewer(record.targetVersion, installed.version)
      ? resumeSelection(input, record)
      : { kind: "release", reason: "refused-unverifiable" };
  }
  // The ordering operand is the PARK's baseline, never the live install
  // record: this is a CONSENT check (was this park an upgrade, or a downgrade
  // the claimant consented to). Read the live record here instead and a park
  // whose stage another actor consumed - installed now EQUALS the target -
  // is released before the claim, so its `install-changed` terminalization
  // never runs and the level-triggered reconciler re-spawns the refusal every
  // idle tick.
  const consented =
    baseline.allowDowngrade ||
    strictlyNewer(record.targetVersion, baseline.installedVersion);
  return consented
    ? resumeSelection(input, record)
    : { kind: "release", reason: "refused-unverifiable" };
}

function strictlyNewer(candidate: string, floor: string): boolean {
  const comparison = compareHostVersions(candidate, floor);
  return comparison.comparable && comparison.ordering === "greater";
}

async function readInstalledUnderLock(
  environment: Environment,
  selection: SelectionFacts,
): Promise<HostInstallRecord> {
  const installed = await readHostInstallRecord(environment);
  if (installed === null) throw hostNotInstalled(environment);
  selection.installedUnderLock = installed;
  return installed;
}

function hostNotInstalled(environment: Environment): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    message: `host update: no host installed for environment=${environment}; run 'traycer host install' first`,
    details: { environment },
    exitCode: 1,
  });
}

function baselineFrom(
  identity: HostUpdatePlanIdentity,
  allowDowngrade: boolean,
): HostUpdateAttemptClaimBaseline {
  return {
    installedVersion: identity.installedVersion,
    installGeneration: identity.installGeneration,
    stageFingerprint: identity.stageFingerprint,
    allowDowngrade,
  };
}

function installGenerationOf(record: HostInstallRecord): string {
  return encodeInstallGeneration({
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  });
}

// ---------------------------------------------------------------------------
// One writer, fixed barriers (Plan D2, D3)
// ---------------------------------------------------------------------------

/**
 * Every record write this run makes, on one queue.
 *
 * One in-flight write; `progress` coalesces (latest wins, one queued) and a
 * barrier discards whatever tick is still queued. A write failure is STORED:
 * it rejects the barrier that issued it and is rethrown by the next call, so
 * an arm can never pass a barrier that did not land and go on to actuate.
 */
class AttemptRecordWriter {
  private held: HostUpdateAttemptIdentity;
  private phaseNow: HostUpdateAttemptPhase;
  private continuationNow: HostUpdateAttemptContinuation;
  /** Never rejects: it is the serialization point, not an error channel. */
  private current: Promise<void> = Promise.resolve();
  private queuedTick: HostUpdateAttemptProgress = null;
  private failure: unknown = null;
  private disposed = false;
  private lastTickAtMs = 0;
  private lastTickPercent: number | null = null;

  constructor(
    private readonly capability: UpdateMutationCapability,
    private readonly home: string,
    private readonly mirror: MarkerMirror,
    record: HostUpdateAttemptRecord,
  ) {
    this.held = attemptIdentityOf(record);
    this.phaseNow = record.phase;
    this.continuationNow = record.continuation;
  }

  get phase(): HostUpdateAttemptPhase {
    return this.phaseNow;
  }

  /** Whether the record has already reached a park or a terminal. */
  get settled(): boolean {
    return isTerminalPhase(this.phaseNow) || isParkedPhase(this.phaseNow);
  }

  /** A download tick. Fire-and-forget by contract: progress never blocks. */
  progress(tick: HostUpdateAttemptProgress): void {
    if (this.disposed || this.failure !== null || tick === null) return;
    if (!this.tickIsWorthWriting(tick)) return;
    this.queuedTick = tick;
    this.current = this.current.then(async () => {
      const queued = this.queuedTick;
      // `null` here means a barrier discarded it while it waited.
      if (queued === null || this.disposed) return;
      this.queuedTick = null;
      try {
        await this.commit({
          phase: this.phaseNow,
          continuation: this.continuationNow,
          progress: queued,
          error: null,
          claimRefresh: null,
          nowIso: new Date().toISOString(),
        });
      } catch (err) {
        this.failure ??= err;
      }
    });
  }

  phaseWrite(phase: HostUpdateAttemptPhase): Promise<void> {
    return this.barrier({
      phase,
      continuation: this.continuationNow,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: new Date().toISOString(),
    });
  }

  park(
    phase: "waiting-for-work" | "waiting-to-activate",
    refresh: AttemptClaimRefresh | null,
  ): Promise<void> {
    return this.barrier({
      phase,
      continuation: phase === "waiting-for-work" ? "resume-apply" : "activate",
      progress: null,
      error: null,
      claimRefresh: refresh,
      nowIso: new Date().toISOString(),
    });
  }

  fail(error: {
    readonly code: string;
    readonly message: string;
    readonly phase: string;
  }): Promise<void> {
    return this.barrier({
      phase: "failed",
      continuation: null,
      progress: null,
      error,
      claimRefresh: null,
      nowIso: new Date().toISOString(),
    });
  }

  /** Settles the in-flight write under the capability and drops the queue. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.queuedTick = null;
    await this.current;
  }

  private async barrier(advance: AttemptAdvance): Promise<void> {
    // Queued ticks are DISCARDED, not flushed: the phase this barrier writes
    // is what the record should say next, and a tick landing after it would
    // describe a phase the run has left.
    this.queuedTick = null;
    await this.current;
    if (this.failure !== null) throw this.failure;
    const op = this.commit(advance);
    this.current = op.catch(() => undefined);
    try {
      await op;
    } catch (err) {
      this.failure ??= err;
      throw err;
    }
  }

  private async commit(advance: AttemptAdvance): Promise<void> {
    const outcome = await commitExecutorAttemptMutation(
      this.capability,
      this.home,
      { kind: "advance", held: this.held, advance },
    );
    if (outcome.kind !== "committed") {
      throw cliError({
        code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
        message: `host update: the attempt record refused a ${advance.phase} write`,
        details: {
          phase: advance.phase,
          outcome: outcome.kind,
          reason: outcome.kind === "rejected" ? outcome.reason : outcome.cause,
        },
        exitCode: 1,
      });
    }
    this.held = outcome.identity;
    this.phaseNow = outcome.record.phase;
    this.continuationNow = outcome.record.continuation;
    await this.mirror.record(outcome.record);
  }

  private tickIsWorthWriting(
    tick: Exclude<HostUpdateAttemptProgress, null>,
  ): boolean {
    const now = Date.now();
    const percent = tick.percent;
    const farEnough =
      percent !== null &&
      (this.lastTickPercent === null ||
        Math.abs(percent - this.lastTickPercent) >= PROGRESS_MIN_PERCENT_DELTA);
    if (now - this.lastTickAtMs < PROGRESS_MIN_INTERVAL_MS && !farEnough) {
      return false;
    }
    this.lastTickAtMs = now;
    this.lastTickPercent = percent;
    return true;
  }
}

function downloadTick(info: ProgressInfo): HostUpdateAttemptProgress {
  if (info.stage !== "download") return null;
  if (info.percent === null && info.bytes === null) return null;
  return {
    percent: info.percent,
    bytes: info.bytes,
    totalBytes: info.totalBytes,
  };
}

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------

interface RunArmInput {
  readonly args: HostUpdateRunArgs;
  readonly plan: RunPlan;
  readonly selection: SelectionFacts;
  readonly mirror: MarkerMirror;
  readonly writerRef: { current: AttemptRecordWriter | null };
  readonly onProgress: (info: ProgressInfo) => void;
  readonly capability: UpdateMutationCapability;
  readonly claim: Extract<ExecutorClaimOutcome, { readonly kind: "claimed" }>;
  readonly complete: () => Promise<AttemptCommitOutcome>;
}

async function runArm(input: RunArmInput): Promise<LegacyHostUpdateResult> {
  const { args, claim, mirror } = input;
  const home = hostHomeDir(args.environment);
  // The ENTRY mirror, before the first actuator: the lock holder owns the
  // marker, so whatever the path holds is taken over here. The claim write
  // itself was made by the executor core, which the writer never sees.
  await mirror.record(claim.record);
  const writer = new AttemptRecordWriter(
    input.capability,
    home,
    mirror,
    claim.record,
  );
  input.writerRef.current = writer;
  try {
    const live = await revalidateInstallIdentity(input, writer);
    return await runArmBody(input, writer, live);
  } catch (err) {
    if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
      // A PARK, not a failure: every busy gate on this path runs BEFORE it
      // touches the install, so nothing has changed except that a stage may
      // now be waiting. Never a `failed` write.
      throw err;
    }
    // A record that already settled said what happened - the identity
    // re-validation's `install-changed`, the evidence loop's `verify-timeout`.
    // Stamping a second cause over it would replace the specific with the
    // generic.
    if (!writer.settled) await writeFailure(writer, err);
    throw err;
  } finally {
    input.writerRef.current = null;
    await writer.dispose().catch(() => undefined);
  }
}

async function writeFailure(
  writer: AttemptRecordWriter,
  err: unknown,
): Promise<void> {
  const phase = writer.phase;
  try {
    await writer.fail({
      code: err instanceof CliError ? err.code : "unexpected",
      message: err instanceof Error ? err.message : String(err),
      phase,
    });
  } catch {
    // The writer already stored its own failure; the arm's error is the one
    // worth reporting, and a second write cannot repair the first.
  }
}

/**
 * Identity re-validation under the lock, before the first actuator.
 *
 * The `installedVersion` + `installGeneration` comparison is NEW: today's
 * activation path compares versions only. A mismatch is written
 * `failed {install-changed}` WITHOUT touching bytes - terminal, never a
 * refusal, because a same-target park admits only a resume and a refusal
 * would leave a park nothing can start over while a level-triggered
 * reconciler re-spawned it every idle tick.
 */
async function revalidateInstallIdentity(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): Promise<HostInstallRecord | null> {
  const live = await readHostInstallRecord(input.args.environment);
  const baseline = input.claim.record.claim;
  // A claim-less upgrade park compares nothing: there is no baseline to be
  // equal to, and a refresh may not grant an authorization nobody issued.
  if (baseline === undefined) return live;
  const matches =
    live !== null &&
    live.version === baseline.installedVersion &&
    installGenerationOf(live) === baseline.installGeneration;
  if (matches) return live;
  const message = `host update: the installed host changed while attempt ${input.claim.identity.attemptId} was waiting (expected ${baseline.installedVersion}, found ${live?.version ?? "none"})`;
  await writer.fail({
    code: "install-changed",
    message,
    phase: "preparing",
  });
  throw cliError({
    code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    message,
    details: {
      environment: input.args.environment,
      attemptId: input.claim.identity.attemptId,
      expectedInstalledVersion: baseline.installedVersion,
      installedVersion: live?.version ?? null,
    },
    exitCode: 1,
  });
}

/**
 * Which arm runs is the RECORD's decision first and the plan's second.
 *
 * A resumed park carries its continuation, and `install` on a same-target park
 * runs the continuation's arm - the resume - never the plan's, because the
 * plan is advisory and the record is what says what this attempt is.
 */
async function runArmBody(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  live: HostInstallRecord | null,
): Promise<LegacyHostUpdateResult> {
  const continuation = input.claim.record.continuation;
  if (continuation === "activate") return activationArm(input, writer, live);
  if (continuation === "resume-apply") return resumedApplyArm(input, writer);
  const plan = input.plan;
  if (plan.kind === "activation-debt")
    return activationArm(input, writer, live);
  if (plan.plan.kind === "downgrade") return downgradeArm(input, writer);
  if (plan.plan.kind === "already-staged") {
    return applyArm(
      input,
      writer,
      await bindApplyToClaimTarget(
        input,
        writer,
        input.claim.record.claim?.stageFingerprint ?? null,
        null,
      ),
    );
  }
  return upgradeArm(input, writer);
}

/** Transfer, then apply. `beforeExtract` is the verified-bytes barrier. */
async function upgradeArm(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): Promise<LegacyHostUpdateResult> {
  const transfer = await transferUnderClaim(
    input,
    writer,
    input.args.versionRequest,
  );
  // The transfer's own promote-time policy may DISCARD what it fetched and
  // leave an unrelated stage standing (a pre-existing higher version is
  // `not-strictly-newer`, and no competing writer is needed for that). The
  // apply would then commit those bytes, because a null expected fingerprint
  // means "whatever is staged". So the stage is bound to the CLAIM's target
  // here, before any actuator, and the observed fingerprint - not the plan's,
  // which predates this very transfer - is what the apply is pinned to.
  return applyArm(
    input,
    writer,
    await bindApplyToClaimTarget(input, writer, null, transfer),
  );
}

/** A resumed `resume-apply` park: re-download only when its stage is gone. */
async function resumedApplyArm(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): Promise<LegacyHostUpdateResult> {
  const baseline = input.claim.record.claim;
  const target = input.claim.record.targetVersion;
  const staged = await readHostStagedRecord(input.args.environment);
  const stageIsHere = staged !== null && staged.version === target;
  if (stageIsHere) {
    return applyArm(
      input,
      writer,
      await bindApplyToClaimTarget(
        input,
        writer,
        baseline?.stageFingerprint ?? null,
        null,
      ),
    );
  }
  if (
    baseline !== undefined &&
    baseline.allowDowngrade &&
    !strictlyNewer(target, baseline.installedVersion)
  ) {
    // A busy downgrade keeps no bytes: `installHostDowngrade` discards its
    // private source on any throw, so the resume re-downloads (Plan D14).
    // Safe to reach with a foreign stage present, and the reason is
    // structural: the downgrade installer stages into an owner-tokened temp
    // dir and commits from there, so it never writes the shared stage and
    // cannot destroy whatever is in it.
    await writer.phaseWrite("downloading");
    return downgradeArm(input, writer);
  }
  if (staged !== null) {
    // A stage IS here and it is NOT this park's. An ABSENT stage is a
    // legitimate re-download; this is a changed world, and re-downloading
    // over it would DESTROY it - the transfer below passes an explicit
    // version, and the settled promote-time policy for an explicit request is
    // replace-any-STAGE (D6), so it does not defend the bytes for us. The
    // park's authorization covered its own target and nothing else, so this
    // terminalizes before anything is fetched, let alone promoted.
    return terminalizeStageMismatch(
      input,
      writer,
      staged,
      null,
      "the resume was about to re-download",
    );
  }
  const transfer = await transferUnderClaim(input, writer, target);
  return applyArm(
    input,
    writer,
    await bindApplyToClaimTarget(input, writer, null, transfer),
  );
}

/**
 * The stage this attempt is allowed to apply, or a terminal failure.
 *
 * An apply with a `null` expected fingerprint commits WHATEVER is staged, and
 * "whatever is staged" is not always this attempt's target: the transfer's
 * promote-time policy discards a candidate that is not strictly newer than an
 * existing stage, so a host installed at 1.0.0 with a stage for 3.0.0 and a
 * claim for 2.0.0 would install 3.0.0 and then fail verification for 2.0.0.
 * There is no race in that: the higher stage was simply already there.
 *
 * `claimFingerprint` is the claim's own expectation and wins where it exists -
 * it detects a stage REPLACED since the claim, which a version check cannot
 * see. It is deliberately NOT used on an arm whose own transfer just ran: the
 * claim's fingerprint predates that transfer, so pinning to it would refuse
 * the bytes this run just placed.
 */
async function bindApplyToClaimTarget(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  claimFingerprint: string | null,
  transfer: HostDownloadOutcome | null,
): Promise<string | null> {
  const target = input.claim.record.targetVersion;
  const staged = await readHostStagedRecord(input.args.environment);
  if (staged !== null && staged.version === target) {
    return claimFingerprint ?? staged.stageId;
  }
  return terminalizeStageMismatch(
    input,
    writer,
    staged,
    transfer,
    "the apply was about to run",
  );
}

/**
 * The stage in front of this attempt is not the one it was authorized for.
 *
 * Terminal, and the same family as the identity re-validation above: the world
 * this claim was authorized against is not the world in front of it. Never a
 * refusal - a same-target park admits only a resume, so a refusal would leave
 * it for a level-triggered reconciler to re-spawn forever.
 */
async function terminalizeStageMismatch(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  staged: HostStagedRecord | null,
  transfer: HostDownloadOutcome | null,
  moment: string,
): Promise<never> {
  const target = input.claim.record.targetVersion;
  const message = `host update: no stage for ${target} was present when ${moment} (found ${staged?.version ?? "none"})`;
  await writer.fail({ code: "install-changed", message, phase: "preparing" });
  throw cliError({
    code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    message,
    details: {
      environment: input.args.environment,
      attemptId: input.claim.identity.attemptId,
      targetVersion: target,
      stagedVersion: staged?.version ?? null,
      stagedFingerprint: staged?.stageId ?? null,
      // The transfer's own account of what it did, when there was one. A
      // `discarded` outcome is one cause and is not an error: the policy was
      // right to keep the newer stage, and wrong only if this attempt then
      // applied it. `null` means no transfer ran - which is the point of the
      // pre-transfer refusal, since a transfer here would have replaced the
      // very stage the mismatch is about.
      transferOutcome: transfer?.outcome ?? null,
      transferReason:
        transfer !== null && transfer.outcome !== "promoted"
          ? transfer.reason
          : null,
    },
    exitCode: 1,
  });
}

async function transferUnderClaim(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  versionRequest: string | null,
): Promise<HostDownloadOutcome> {
  const { args } = input;
  const contenderOptions: StageMaintenanceContenderOptions = {
    environment: args.environment,
    reason: "host-update-stage",
    waitMs: CONTENDER_WAIT_MS,
    pollIntervalMs: CONTENDER_POLL_INTERVAL_MS,
    admission: "attempt-executor",
  };
  return downloadAndStageHostInSegment(
    {
      environment: args.environment,
      versionRequest,
      // Explicit-incomparable policy: a `local-*` install proceeds (D6 parity).
      automatic: false,
      onProgress: input.onProgress,
      registryClient: args.registryClient,
      // The record's `downloading` phase is the announcement; the coarse
      // marker follows it. Nothing extra to publish before the first byte.
      onWillDownload: null,
      // SHA and signature live inside `downloadAndVerify`, so this fires with
      // VERIFIED bytes on disk and an unbuilt tree - which is what `preparing`
      // means (Plan D3).
      beforeExtract: () => writer.phaseWrite("preparing"),
      // This run IS the attempt the promote-time guard would otherwise yield
      // to; a foreign nonterminal record still wins (Plan D6).
      ownAttempt: input.claim.identity,
    },
    input.capability,
    contenderOptions,
  );
}

async function applyArm(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  expectedStageFingerprint: string | null,
): Promise<LegacyHostUpdateResult> {
  const { args } = input;
  if (writer.phase !== "preparing") await writer.phaseWrite("preparing");
  const contenderOptions = mutationContenderOptions(
    args.environment,
    "host-update-apply",
  );
  const outcome = await withCliAttemptMutation(
    input.capability,
    contenderOptions,
    async () => {
      try {
        return await applyHostWithAttempt(input.capability, contenderOptions, {
          environment: args.environment,
          force: args.force,
          noService: false,
          expectedStageFingerprint,
          onProgress: input.onProgress,
          // Deliberately NO `onWillCommitStaged`: it fires BEFORE the
          // cooperative stop, so a denial there must still park from
          // `preparing`, and the coarse marker is record-driven now.
          hooks: {
            beforeSwapCommit: () => writer.phaseWrite("applying"),
            afterSwap: () => writer.phaseWrite("restarting"),
          },
        });
      } catch (err) {
        if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
          // Parked from INSIDE the same lock span the busy decision was made
          // in, so the staged version the park records - and the message
          // quotes - cannot have moved out from under that decision the way a
          // read after the lock released could.
          throw await parkForWork(input, writer, err);
        }
        throw err;
      }
    },
  );
  if (outcome.outcome === "no-op") {
    // Reachable only as a race the executor cannot itself cause: the transfer
    // runs UNDER the claim, so nothing of this run's can discard its stage
    // before the apply. Under the record model an apply that found nothing to
    // commit is a failure of THIS attempt, not a no-op it may report - the
    // next plain `host update` meets the terminal record and starts over.
    const message = `host update: nothing was staged for ${input.claim.record.targetVersion} when the apply ran`;
    await writer.fail({
      code: "stage-missing",
      message,
      phase: writer.phase,
    });
    throw cliError({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message,
      details: { environment: args.environment },
      exitCode: 1,
    });
  }
  if (outcome.outcome === "stage-fingerprint-mismatch") {
    throw cliError({
      code: CLI_ERROR_CODES.UNEXPECTED,
      message: "host update: staged handoff changed unexpectedly",
      details: {
        expectedStageFingerprint: outcome.expectedStageFingerprint,
        actualStageFingerprint: outcome.actualStageFingerprint,
      },
      exitCode: 1,
    });
  }
  await verifyUnderClaim(input, writer);
  return projectApplied(outcome);
}

async function downgradeArm(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): Promise<LegacyHostUpdateResult> {
  const { args } = input;
  const target = input.claim.record.targetVersion;
  const contenderOptions = mutationContenderOptions(
    args.environment,
    "host-update-downgrade",
  );
  let outcome: Extract<ApplyHostOutcome, { outcome: "applied" }>;
  try {
    outcome = await installHostDowngradeInSegment(
      {
        environment: args.environment,
        version: target,
        force: args.force,
        onProgress: input.onProgress,
        beforeExtract: () => writer.phaseWrite("preparing"),
        hooks: {
          beforeSwapCommit: () => writer.phaseWrite("applying"),
          afterSwap: () => writer.phaseWrite("restarting"),
        },
      },
      input.capability,
      contenderOptions,
    );
  } catch (err) {
    if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
      throw await parkForWork(input, writer, err);
    }
    throw err;
  }
  await verifyUnderClaim(input, writer);
  return projectApplied(outcome);
}

/**
 * The activation arm: bytes are already committed, so this is the stop →
 * relaunch pair `host restart` drives, under the same busy gate the legacy
 * arm runs, and ONLY when the selector's under-lock reading was `debt`.
 */
async function activationArm(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  live: HostInstallRecord | null,
): Promise<LegacyHostUpdateResult> {
  const { args, selection } = input;
  const contenderOptions = mutationContenderOptions(
    args.environment,
    "host-update-activate",
  );
  if (live === null) throw hostNotInstalled(args.environment);
  const installed = live;
  // ONE lock span across the gate, the stop and the relaunch, exactly as the
  // legacy arm holds one: a window between the stop and the relaunch is a
  // window in which another CLI can act on a host this run just took down.
  // The record writes inside it take no CLI lock of their own.
  await withCliAttemptMutation(input.capability, contenderOptions, async () => {
    try {
      // A host that is GONE has no live work to protect, so the gate is not
      // asked on the `no-live-host` reading - the stop reports an absent
      // host as a forced recycle and the relaunch repairs it.
      if (!args.force && selection.debtReading !== "no-live-host") {
        await assertHostNotBusy(args.environment);
      }
      const controller = createServiceController();
      const label = serviceLabelFor(args.environment);
      const stopped = await stopHostForRestartWithAttempt(
        input.capability,
        contenderOptions,
        controller,
        label,
        { force: args.force },
        // The disruption boundary, INSIDE the facade: it runs after the
        // mutation-capability check and immediately before the actuator, so
        // a refused capability arrives here undisturbed and a failure there
        // restores a live writer's taken-over marker. Nothing marks the flag
        // around this call (#1752 round 8).
        () => input.mirror.markDisturbed(),
      );
      await writer.phaseWrite("restarting");
      await relaunchHostAfterRestartWithAttempt(
        input.capability,
        contenderOptions,
        controller,
        label,
        stopped,
      );
    } catch (err) {
      if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
        throw await parkForActivation(input, writer, err);
      }
      throw err;
    }
  });
  await verifyUnderClaim(input, writer);
  // Projected as an UPDATE, not a no-op: `previousVersion` is what was
  // serving, which is what actually happened from the operator's seat. On the
  // `no-live-host` reading there is nothing running to name, so the plan's
  // last-seen running version is the best available fact about "before".
  const previousVersion =
    selection.underLockRunningVersion ??
    selection.lastSeenRunningVersion ??
    installed.version;
  return {
    ...projectNoOp(installed),
    previousVersion,
    serviceLifecycle: {
      priorServiceState: "running",
      stoppedBeforeSwap: false,
      postSwapAction: "restart",
      postSwapError: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Parks and the evidence loop
// ---------------------------------------------------------------------------

async function parkForWork(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  busy: CliError,
): Promise<CliError> {
  const refresh = await readClaimRefresh(input.args.environment);
  await writer.park("waiting-for-work", refresh.refresh);
  // The staged version comes from the very read the PARK write recorded,
  // under the same lock span the busy decision was made in - never a later
  // re-read that could disagree with the decision it describes.
  const staged = refresh.stagedVersion;
  return cliError({
    code: CLI_ERROR_CODES.HOST_BUSY,
    message:
      staged === null
        ? `${busy.message} Host ${input.claim.record.targetVersion} downloads again on the next update once the host is idle, or now with --force.`
        : `${busy.message} Host ${staged} stays staged; it installs on the next update once the host is idle, or now with --force.`,
    details: { stagedVersion: staged },
    exitCode: busy.exitCode,
  });
}

async function parkForActivation(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  busy: CliError,
): Promise<CliError> {
  const refresh = await readClaimRefresh(input.args.environment);
  await writer.park("waiting-to-activate", refresh.refresh);
  return busy;
}

async function readClaimRefresh(environment: Environment): Promise<{
  readonly refresh: AttemptClaimRefresh | null;
  readonly stagedVersion: string | null;
}> {
  const installed = await readHostInstallRecord(environment);
  const staged = await readHostStagedRecord(environment);
  if (installed === null) {
    // Nothing readable to refresh with. `null` carries the record's prior
    // baseline unchanged, which beats minting one from a read that saw no
    // install record at all.
    return { refresh: null, stagedVersion: staged?.version ?? null };
  }
  return {
    refresh: {
      installedVersion: installed.version,
      installGeneration: installGenerationOf(installed),
      stageFingerprint: staged?.stageId ?? null,
    },
    stagedVersion: staged?.version ?? null,
  };
}

/**
 * `verifying`, then the evidence loop, then the executor's terminal write.
 *
 * The loop is the success contract: exit 0 means installed AND running are
 * both VERIFIED at the target with the running host bound to this home. On
 * deadline the record says `failed {verify-timeout}` and the run exits
 * non-zero; there is no rollback (`applyHost`'s documented contract).
 */
async function verifyUnderClaim(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): Promise<void> {
  const { args } = input;
  await writer.phaseWrite("verifying");
  const home = hostHomeDir(args.environment);
  const target = input.claim.record.targetVersion;
  const budgetMs = args.verifyBudgetMs ?? VERIFY_BUDGET_MS;
  const pollMs = args.verifyPollIntervalMs ?? VERIFY_POLL_INTERVAL_MS;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const observation = await observeAttemptRecoveryEvidence(
      args.environment,
      home,
    );
    const { installed, running } = observation.evidence;
    if (
      installed.kind === "verified" &&
      installed.version === target &&
      running.kind === "verified" &&
      running.owner === "host-home-bound" &&
      running.version === target
    ) {
      break;
    }
    if (Date.now() >= deadline) {
      const message = `host update: applied ${target} but the host did not become healthy at that version`;
      await writer.fail({
        code: "verify-timeout",
        message,
        phase: "verifying",
      });
      throw cliError({
        code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
        message,
        details: { environment: args.environment, version: target },
        exitCode: 1,
      });
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  const committed = await input.complete();
  if (committed.kind !== "committed") {
    const message = `host update: the completion write for ${target} was refused`;
    await writer.fail({
      code: "verify-timeout",
      message,
      phase: "verifying",
    });
    throw cliError({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
      message,
      details: { environment: args.environment, version: target },
      exitCode: 1,
    });
  }
  await input.mirror.record(committed.record);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface ProjectSegmentInput {
  readonly args: HostUpdateRunArgs;
  readonly settlement: DispatchSettlement;
  readonly selection: SelectionFacts;
  readonly segment: ExecutorSegmentOutcome<LegacyHostUpdateResult>;
}

async function projectSegment(
  input: ProjectSegmentInput,
): Promise<HostUpdateRunOutcome> {
  const { args, segment, selection } = input;
  if (segment.kind === "executed") {
    return { legacy: segment.result, releasedReason: null };
  }
  // `terminalized` is `update-verify`'s exit and never this command's: under
  // `afterRecovery: "reselect"` a terminalizing recovery re-selects and
  // returns `released` or `rejected`. Named anyway so the reason it reports
  // is the recovery's own rather than an invented one.
  const reason =
    segment.kind === "terminalized"
      ? segment.outcome === "complete"
        ? "recovered-complete"
        : "recovered-failed"
      : segment.reason;
  await input.settlement.refused(reason);
  if (segment.kind === "rejected") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
      message: `host update: the attempt claim was refused (${reason})`,
      details: { environment: args.environment, reason },
      exitCode: 1,
    });
  }
  // A release changed nothing. The one aftercare it owes is the stale-`failed`
  // reconciliation: a marker outlives the failure it reported, and only a
  // no-work run that has OBSERVED the running host at the installed version
  // may clear it. Run outside the attempt lock, as the legacy's is - it is a
  // compare-and-delete, so nothing depends on the lock.
  if (
    reason === "nothing-to-do" &&
    selection.planActivationReading !== null &&
    selection.planActivationReading.kind === "activated"
  ) {
    await clearStaleFailedMarker(args.logger, args.environment);
  }
  const installed =
    selection.installedUnderLock ??
    (await readHostInstallRecord(args.environment));
  if (installed === null) throw hostNotInstalled(args.environment);
  return { legacy: projectNoOp(installed), releasedReason: reason };
}

export function projectNoOp(
  installed: HostInstallRecord,
): LegacyHostUpdateResult {
  return {
    version: installed.version,
    installedAt: installed.installedAt,
    executablePath: installed.executablePath,
    source: installed.source,
    archiveSha256: installed.archiveSha256,
    signatureKeyId: installed.signatureKeyId,
    sizeBytes: installed.sizeBytes,
    previousVersion: installed.version,
    serviceLifecycle: NO_SERVICE_ACTION_LIFECYCLE,
  };
}

function projectApplied(
  outcome: Extract<ApplyHostOutcome, { outcome: "applied" }>,
): LegacyHostUpdateResult {
  return {
    version: outcome.record.version,
    installedAt: outcome.record.installedAt,
    executablePath: outcome.record.executablePath,
    source: outcome.record.source,
    archiveSha256: outcome.record.archiveSha256,
    signatureKeyId: outcome.record.signatureKeyId,
    sizeBytes: outcome.record.sizeBytes,
    previousVersion: outcome.previous?.version ?? null,
    serviceLifecycle:
      outcome.serviceLifecycle === null
        ? NO_SERVICE_ACTION_LIFECYCLE
        : {
            ...outcome.serviceLifecycle,
            priorServiceState: toLegacyPriorServiceState(
              outcome.serviceLifecycle.priorServiceState,
            ),
            postSwapError: outcome.postSwapError,
          },
  };
}

// `LegacyHostUpdateServiceLifecycle` is a pinned, frozen wire shape - it must
// not silently grow to track new `ServiceState` variants. `externally-managed`
// has no legacy equivalent and degrades exactly as Desktop's own reader
// already degrades any value outside its three-way union.
function toLegacyPriorServiceState(
  state: "running" | "stopped" | "not-installed" | "externally-managed",
): "running" | "stopped" | "not-installed" {
  return state === "externally-managed" ? "not-installed" : state;
}

function executorContenderOptions(
  environment: Environment,
): WithCliAttemptExecutorOptions {
  return {
    environment,
    reason: "host-update",
    waitMs: CONTENDER_WAIT_MS,
    pollIntervalMs: CONTENDER_POLL_INTERVAL_MS,
  };
}

function mutationContenderOptions(
  environment: Environment,
  reason: string,
): WithCliUpdateContenderOptions {
  return {
    environment,
    reason,
    waitMs: CONTENDER_WAIT_MS,
    pollIntervalMs: CONTENDER_POLL_INTERVAL_MS,
    admission: "attempt-executor",
  };
}

// ---------------------------------------------------------------------------
// The activation reading (moved verbatim from `commands/host-update.ts`)
// ---------------------------------------------------------------------------

/** The install record and the live process disagree about the version. */
interface ActivationDebt {
  readonly kind: "debt";
  readonly installedVersion: string;
  readonly runningVersion: string;
}

/**
 * What the install record and the live process say about each other. Every
 * reading is named rather than collapsed to "debt or not", because the places
 * that consult it need different things from the non-debt cases: OUT of the
 * contender lock only `debt` is a reason to act; UNDER it, `debt` and
 * `no-live-host` both are, while `activated` is the reason NOT to.
 *
 * - `no-install`: nothing to activate;
 * - `no-live-host`: no pid metadata, or a pid that is not alive. Before the
 *   lock this is left alone - a host that is DOWN is the service manager's
 *   problem. Under the lock, after a debt was seen, it means the host this run
 *   was about to replace is gone, which is not the same as replaced;
 * - `foreign-runtime`: a running version that is not a release version,
 *   against a record with no runtime stamp. A record WITH a runtime stamp
 *   never reads this way: the stamp is whatever the archive reported about
 *   itself (a staging host's is `staging.<epoch>.<sha>`), and equality with it
 *   is the whole test;
 * - `activated`: the committed archive is what is running, carrying the
 *   record's catalog `version` so a caller can ask WHICH archive;
 * - `debt`: the record and the process disagree.
 */
type ActivationReading =
  | { readonly kind: "no-install" }
  | { readonly kind: "no-live-host"; readonly installedVersion: string }
  | { readonly kind: "foreign-runtime" }
  | { readonly kind: "activated"; readonly installedVersion: string }
  | ActivationDebt;

/**
 * Read the activation state of the committed install.
 *
 * "Match" is decided in the RUNTIME identity domain when the record has one.
 * `pid.json` publishes the version the host binary reports about itself, and
 * the install record keeps that same stamp as `runtimeVersion` precisely
 * because it can differ from the catalog `version` the caller asked for.
 * Ordering those two domains by SemVer would skip a needed restart when they
 * happen to read equal, or restart a correctly activated host on every run
 * when they do not; equality of runtime stamps is the test.
 *
 * The comparison is on VERSION rather than on install generation because
 * `pid.json` publishes the version and nothing finer; a swap to the same
 * version is invisible here, and restarting for it would be gratuitous.
 *
 * Either direction of inequality is debt. A downgrade that was committed but
 * never activated leaves the running host AHEAD of the record, and the record
 * is what the operator asked for.
 */
async function readActivationState(
  environment: Environment,
): Promise<ActivationReading> {
  const installed = await readHostInstallRecord(environment);
  if (installed === null) return { kind: "no-install" };
  const running = await readHostPidMetadata(environment);
  if (running === null) {
    return { kind: "no-live-host", installedVersion: installed.version };
  }
  // The published identity verdict, not bare pid liveness: a `pid.json` that
  // survived a crash names a pid the OS may since have handed to an unrelated
  // process. `indeterminate` keeps the host, the same fail-open reading every
  // other consumer of the verdict takes.
  const identity = await getPublishedProcessIdentityVerdict(
    running.pid,
    running.processStartIdentity,
  );
  if (identity === "dead" || identity === "mismatch") {
    return { kind: "no-live-host", installedVersion: installed.version };
  }
  if (installed.runtimeVersion !== null) {
    // Runtime-stamp domain: equality decides, and the STAMPS are not required
    // to be SemVer. A SemVer guard applied before this comparison would
    // classify every staging host as foreign.
    return running.version === installed.runtimeVersion
      ? { kind: "activated", installedVersion: installed.version }
      : {
          kind: "debt",
          installedVersion: installed.version,
          runningVersion: running.version,
        };
  }
  // Catalog-version domain (a record with no runtime stamp yet).
  if (!isValidHostVersion(running.version)) return { kind: "foreign-runtime" };
  const comparison = compareHostVersions(running.version, installed.version);
  if (!comparison.comparable || comparison.ordering === "equal") {
    return { kind: "activated", installedVersion: installed.version };
  }
  return {
    kind: "debt",
    installedVersion: installed.version,
    runningVersion: running.version,
  };
}

/**
 * Whether the running host has been OBSERVED serving `targetVersion`. Used by
 * the marker's failure arm to withhold a `failed` for a target another actor
 * has since delivered. Never throws: a reading that cannot be taken is "not
 * observed", and the stamp lands.
 */
async function targetObservedRunning(
  environment: Environment,
  targetVersion: string,
): Promise<boolean> {
  try {
    const reading = await readActivationState(environment);
    if (reading.kind !== "activated") return false;
    // The catalog-domain comparator, not `===`: it ignores build metadata, so
    // `1.3.0+abc` and `1.3.0` are one release to it and must be one here.
    const comparison = compareHostVersions(
      reading.installedVersion,
      targetVersion,
    );
    return comparison.comparable && comparison.ordering === "equal";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The coarse marker mirror (Plan D10)
// ---------------------------------------------------------------------------

interface MarkerMirror {
  /** Mirror one record write. Best-effort: never fails the update. */
  record(record: HostUpdateAttemptRecord): Promise<void>;
  markDisturbed(): void;
}

/**
 * The legacy command's marker state machine, driven by RECORD WRITES.
 *
 * Every rule is the one #1752 round 8 merged, named by its legacy function:
 * `reassertMarkerUnderLock` for the entry mirror (the executor has no pre-lock
 * phase, so the pre-lock claim's deference to a live writer does not apply and
 * the lock holder takes over any record), `liveDisplacedRecord` for the
 * restore-time liveness re-read, `markUpdateFailed` for the stamp,
 * `targetObservedRunning` for the withdrawal, and `logConditionalMarkerOutcome`
 * for the outcomes. Nothing is ever written blind: every replace, clear and
 * create is conditional on what was read.
 */
function createMarkerMirror(
  environment: Environment,
  logger: ILogger,
): MarkerMirror {
  // The marker THIS run wrote or took over, kept so every later write is
  // conditional on it. Null while the entry mirror's primitive could not land.
  let own: HostUpdateProgress | null = null;
  // A LIVE writer's record the entry mirror displaced, kept for one purpose:
  // an exit that follows the takeover WITHOUT this run having disturbed the
  // host puts it back. A record no writer is acting on is replaced and GONE.
  let displaced: HostUpdateProgress | null = null;
  // Whether this run has begun to disturb the host. Before it, the host is as
  // the displaced writer left it; past it, the host's state is this run's
  // doing and its `failed` is the truth the next updater takes over in turn.
  let disturbed = false;
  // The version this run announced. Kept apart from `own` because a run whose
  // entry mirror could not land holds no record and still has a target to name.
  let announcedTarget: string | null = null;
  let entered = false;

  const liveDisplacedRecord = (): HostUpdateProgress | null =>
    displaced !== null && updateProgressRecordHasLiveWriter(displaced)
      ? displaced
      : null;

  async function takeOver(targetVersion: string): Promise<void> {
    announcedTarget = targetVersion;
    // Bounded: each iteration either settles or observed a concurrent write.
    // Only `changed` is re-read; a `failed` write is never retried - the
    // update must not fail, or spin, on its progress signal.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const onDisk = await readUpdateProgressMarker(environment);
      const fresh = progressRecord({
        state: "updating",
        error: null,
        targetVersion,
      });
      if (onDisk !== null) {
        const isOwn = own !== null && sameProgress(onDisk, own);
        if (isOwn && onDisk.targetVersion === targetVersion) return;
        const replaced = await replaceUpdateProgressMarkerIfUnchanged(
          environment,
          onDisk,
          fresh,
        );
        if (replaced === "replaced") {
          own = fresh;
          if (!isOwn) {
            const writerLive = updateProgressRecordHasLiveWriter(onDisk);
            displaced = writerLive ? onDisk : null;
            logger.info(
              writerLive
                ? "Host update took over the progress marker under the lock - its writer is not doing disruptive work"
                : "Host update replaced the progress marker under the lock - no writer is acting on it",
              {
                environment,
                targetVersion,
                previousState: onDisk.state,
                previousTarget: onDisk.targetVersion,
              },
            );
          }
          return;
        }
        if (replaced === "failed") {
          logger.warn(
            "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
            { environment, targetVersion },
          );
          return;
        }
        continue;
      }
      const created = await createUpdateProgressMarkerIfAbsent(
        environment,
        fresh,
      );
      if (created === "created") {
        own = fresh;
        return;
      }
      if (created === "failed") {
        logger.warn(
          "Host update could not write the progress marker under the lock; proceeding without re-asserting it",
          { environment, targetVersion },
        );
        return;
      }
      // "exists": a marker landed between the read and the create; the next
      // iteration reads it and takes it over.
    }
    logger.warn(
      "Host update could not establish ownership of the progress marker under the lock; proceeding without re-asserting it",
      { environment, targetVersion },
    );
  }

  async function park(): Promise<void> {
    if (own === null) return;
    // Liveness is re-read HERE, not trusted from the takeover: the displaced
    // writer had the whole stop attempt to die in between, and a park that
    // restored its now-dead `updating` would re-plant exactly the record the
    // retain rule exists to drop.
    const restoreTo = liveDisplacedRecord();
    if (restoreTo === null) {
      const withdrawn = await deleteUpdateProgressMarkerIfUnchanged(
        environment,
        own,
      );
      logConditionalMarkerOutcome(logger, environment, {
        outcome: withdrawn,
        done: "Host update parked - the host has work in progress; the progress marker was withdrawn",
        moved:
          "Host update parked - the host has work in progress; the progress marker was left in place - another updater owns it now",
        gone: "Host update parked - the host has work in progress; found no progress marker to withdraw",
        failed:
          "Host update parked - the host has work in progress; its progress marker could not be withdrawn and stays until the next update supersedes it",
      });
      return;
    }
    const restored = await replaceUpdateProgressMarkerIfUnchanged(
      environment,
      own,
      restoreTo,
    );
    logConditionalMarkerOutcome(logger, environment, {
      outcome: restored,
      done: "Host update parked - the host has work in progress; the progress marker it took over was restored to its previous writer",
      moved:
        "Host update parked - the host has work in progress; the progress marker it took over was not restored - another updater owns it now",
      gone: "Host update parked - the host has work in progress; the progress marker it took over was not restored - the path is empty",
      failed:
        "Host update parked - the host has work in progress; the progress marker it took over could not be restored and stays until the next update supersedes it",
    });
  }

  async function complete(): Promise<void> {
    if (own === null) return;
    // Cleared CONDITIONALLY: a third updater writes its `updating` before it
    // waits for the lock, so a marker that is no longer this run's belongs to
    // someone whose update is still to come.
    const cleared = await deleteUpdateProgressMarkerIfUnchanged(
      environment,
      own,
    );
    if (cleared === "changed") {
      logger.info(
        "Host update left the progress marker in place - another updater owns it now",
        { environment },
      );
    } else if (cleared === "absent") {
      logger.info("Host update found no progress marker to clear", {
        environment,
      });
    } else if (cleared === "failed") {
      logger.info(
        "Host update could not clear its progress marker; it stays until the next update supersedes it",
        { environment },
      );
    }
  }

  async function failed(record: HostUpdateAttemptRecord): Promise<void> {
    const cause =
      record.error?.message ?? record.error?.code ?? "update failed";
    // The evidence loop's deadline is the ONE failure that must be reported
    // whatever the coarse observation says. It is disturbed by construction -
    // the bytes are committed and the host was restarted - and it fires
    // precisely because the host did NOT come back healthy at the target. The
    // observed-running suppressions below read `pid.json`, which a host that
    // is up but not yet answering still fills in at the target version, so
    // reusing them here withholds the only signal a 1.2.x host would ever
    // show for a failed update. The legacy health-failure branch stamps
    // unconditionally, and so does this.
    //
    // Ownership protection is NOT relaxed: the stamp is still a CAS over this
    // run's own record, or a create into a path that reads EMPTY.
    const unconditional = record.error?.code === "verify-timeout";
    if (own === null) {
      // No record of this run's on disk (the entry mirror's primitive
      // answered `failed`). The failure is still this run's to report whenever
      // it announced a target: create-if-absent lands it into an EMPTY path
      // only - against another writer's live marker that is the no-op it
      // should be. Unless the host is already RUNNING that target: "update to
      // X failed" over a host serving X reports a failure that did not happen.
      // Disturbance is NOT consulted in this arm.
      if (announcedTarget === null) return;
      if (
        !unconditional &&
        (await targetObservedRunning(environment, announcedTarget))
      ) {
        logger.info(
          "Host update did not stamp its failure - the running host has been observed at the target it announced",
          { environment, targetVersion: announcedTarget },
        );
        return;
      }
      await markUpdateFailed(logger, environment, announcedTarget, cause, null);
      return;
    }
    // Liveness re-read here for the same reason as in the park arm.
    const restoreTo = liveDisplacedRecord();
    if (restoreTo !== null && !disturbed && !unconditional) {
      const restored = await replaceUpdateProgressMarkerIfUnchanged(
        environment,
        own,
        restoreTo,
      );
      logConditionalMarkerOutcome(logger, environment, {
        outcome: restored,
        done: "Host update failed before disturbing the host; the progress marker it took over was restored to its previous writer",
        moved:
          "Host update failed before disturbing the host; the progress marker it took over was not restored - another updater owns it now",
        gone: "Host update failed before disturbing the host; the progress marker it took over was not restored - the path is empty",
        failed:
          "Host update failed before disturbing the host; the progress marker it took over could not be restored and stays until the next update supersedes it",
      });
      return;
    }
    if (
      !unconditional &&
      !disturbed &&
      (await targetObservedRunning(environment, own.targetVersion))
    ) {
      // An actor that writes no marker at all - `host apply --no-service`,
      // Desktop's launch converge, an out-of-band relaunch between the claim
      // and the stop - delivered the very target this run announced. The
      // record describes an update another actor completed, so it is
      // WITHDRAWN, not stamped. Pre-disruption only: past the stop the host's
      // state is this run's doing and its failure is reported whatever the
      // host now serves.
      const withdrawn = await deleteUpdateProgressMarkerIfUnchanged(
        environment,
        own,
      );
      logConditionalMarkerOutcome(logger, environment, {
        outcome: withdrawn,
        done: "Host update failed before disturbing the host, and the running host has been observed at the target it announced; the progress marker was withdrawn",
        moved:
          "Host update failed before disturbing the host, and the running host has been observed at the target it announced; the progress marker was left in place - another updater owns it now",
        gone: "Host update failed before disturbing the host, and the running host has been observed at the target it announced; found no progress marker to withdraw",
        failed:
          "Host update failed before disturbing the host, and the running host has been observed at the target it announced; its progress marker could not be withdrawn and stays until the next update supersedes it",
      });
      return;
    }
    await markUpdateFailed(logger, environment, own.targetVersion, cause, own);
  }

  return {
    markDisturbed: (): void => {
      disturbed = true;
    },
    record: async (record: HostUpdateAttemptRecord): Promise<void> => {
      try {
        switch (record.phase) {
          case "downloading":
          case "preparing":
          case "applying":
          case "restarting":
          case "verifying": {
            // The ENTRY mirror takes the marker over once. Every later active
            // phase already has this run's own `updating` naming the record's
            // target - the target is fixed at the claim and no arm re-points -
            // and a run whose entry mirror could not land stays marker-less,
            // which is what the failure arm's create-if-absent is for.
            if (entered) return;
            entered = true;
            await takeOver(record.targetVersion);
            return;
          }
          case "waiting-for-work":
          case "waiting-to-activate":
            await park();
            return;
          case "complete":
            await complete();
            return;
          case "failed":
            await failed(record);
            return;
          case "superseded":
            // Someone else's `start` ended this attempt; the create that
            // follows mirrors its own `updating`.
            return;
        }
      } catch (err) {
        // Marker I/O is deliberately never allowed to fail the update: a
        // missing marker degrades the remote progress readout, it must not
        // break the local update.
        logger.warn("Host update could not mirror the progress marker", {
          environment,
          phase: record.phase,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * One log line per conditional-marker outcome, so a withdrawal or restore that
 * did NOT happen is never reported as if it had. All INFO: none of these fails
 * the update, and the marker layer owns the WARN.
 */
function logConditionalMarkerOutcome(
  logger: ILogger,
  environment: Environment,
  lines: {
    readonly outcome: ConditionalMarkerDelete | ConditionalMarkerReplace;
    readonly done: string;
    readonly moved: string;
    readonly gone: string;
    readonly failed: string;
  },
): void {
  const { outcome } = lines;
  const message =
    outcome === "cleared" || outcome === "replaced"
      ? lines.done
      : outcome === "failed"
        ? lines.failed
        : outcome === "absent"
          ? lines.gone
          : lines.moved;
  logger.info(message, { environment, outcome });
}

/**
 * Stamp this run's failure - but only over ITS OWN marker, or into a path that
 * reads EMPTY. Stamping over another updater's live marker would hide its
 * progress for the whole update and report a failure that is not about it.
 */
async function markUpdateFailed(
  logger: ILogger,
  environment: Environment,
  targetVersion: string,
  error: string,
  ours: HostUpdateProgress | null,
): Promise<void> {
  const failed = progressRecord({ state: "failed", error, targetVersion });
  if (ours === null) {
    const created = await createUpdateProgressMarkerIfAbsent(
      environment,
      failed,
    );
    if (created !== "created") {
      logger.info(
        created === "exists"
          ? "Host update did not stamp its failure - the progress marker holds another record"
          : "Host update did not stamp its failure - the progress marker could not be written",
        { environment, targetVersion, outcome: created },
      );
    }
    return;
  }
  // One atomic compare-and-swap, not a read followed by a write.
  const outcome = await replaceUpdateProgressMarkerIfUnchanged(
    environment,
    ours,
    failed,
  );
  if (outcome !== "replaced") {
    logger.info(
      outcome === "failed"
        ? "Host update did not stamp its failure - the progress marker could not be written"
        : "Host update did not stamp its failure - another updater owns the progress marker now",
      { environment, outcome },
    );
  }
}

/**
 * Remove a `failed` progress marker that the observed state contradicts.
 *
 * The delete is CONDITIONAL on the marker still being the `failed` record that
 * was read: another updater racing this no-op can replace it with a live
 * `updating` in between, and deleting that would erase the only progress
 * signal for the whole download → swap → restart.
 */
async function clearStaleFailedMarker(
  logger: ILogger,
  environment: Environment,
): Promise<void> {
  const marker = await readUpdateProgressMarker(environment);
  if (marker === null || marker.state !== "failed") return;
  const outcome = await deleteUpdateProgressMarkerIfUnchanged(
    environment,
    marker,
  );
  if (outcome === "cleared") {
    logger.info(
      "Host update cleared a stale failed progress marker - the running host is at the installed version",
      { environment, staleTargetVersion: marker.targetVersion },
    );
  } else if (outcome === "failed") {
    logger.info(
      "Host update left the progress marker alone - the stale-failure clear could not be written",
      { environment, outcome },
    );
  } else {
    logger.info(
      "Host update left the progress marker alone - it changed under the stale-failure check",
      { environment, outcome },
    );
  }
}
