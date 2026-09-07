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
import { LAUNCHD_THROTTLE_INTERVAL_SECONDS } from "../service/platforms/macos";
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
  updateProgressRecordHasProvenLiveWriter,
  type ConditionalMarkerDelete,
  type ConditionalMarkerReplace,
  type HostUpdateProgress,
} from "./update-progress-marker";
import {
  runLocalAttemptExecutorSegment,
  type AdvanceExecutorSegment,
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
import {
  observeAttemptRecoveryEvidence,
  type AttemptRecoveryEvidenceObservation,
} from "./update-recovery-evidence";
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
  /**
   * The non-release version a live host was publishing when this run decided
   * to leave it alone, or `null` when no arm made that decision (D-51). The
   * shell renders it; a machine reader gets the same string here rather than
   * having to parse the sentence.
   */
  readonly foreignRuntimeVersion: string | null;
  /**
   * What a live host was serving when this run finished, or `null` when NO
   * host is running (Linux E6L, Q5 defect 3).
   *
   * Only a release populates it, and only because a release is the one exit
   * that reports on a host it did not touch. `legacy.version` is the INSTALLED
   * version, so "host stays at 1.4.3" was true about the bytes and false about
   * the machine: it read as reassurance over a box with nothing running. The
   * running state is a different fact and now travels as one.
   */
  readonly runningVersion: string | null;
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
/**
 * Consecutive authenticated-RPC refusals that end the verify leg early (Q19).
 *
 * TWO, and the second one is doing real work rather than being caution. The
 * messenger under this call revalidates a bearer and retries once, so a single
 * `UNAUTHORIZED` can be the tail of a rotation this run is about to win, and
 * stopping on it would turn a self-healing case into a reported failure. Two
 * readings a poll apart cost 500 ms.
 *
 * Not more than two: each extra reading buys nothing - a host that has refused
 * twice across a poll has decided - and pays for it in the exact seconds this
 * ticket exists to stop burning.
 */
const VERIFY_REFUSAL_STREAK_TO_STOP = 2;

/**
 * The budget when the post-swap service start ITSELF errored (Mac item 6,
 * Q6/F-mac-1).
 *
 * The full budget exists to absorb a start that is slow but PROCEEDING. A start
 * the service manager refused - `E_SERVICE_CONTROL_FAILED` returned 65 ms after
 * the swap - is not proceeding. But it is not over either, and the wait is
 * DERIVED from why:
 *
 *  - Something else starts the host. Prompt: nothing is waiting on a
 *    supervisor handshake.
 *  - **The manager reported failure and relaunches it anyway.** On macOS this
 *    is `KeepAlive{SuccessfulExit:false}` and it is NOT prompt - launchd paces
 *    respawns by `ThrottleInterval`, the same interval every caller here
 *    already avoids `kickstart -k` for. The host cannot legally reappear before
 *    it elapses.
 *
 * So the floor is the throttle interval, and the budget is that plus a margin
 * for the process to come up and answer once it is permitted to. A budget AT
 * the interval would expire at the exact moment the host first becomes
 * possible, which is the worst place a deadline can sit - it would report a
 * failure precisely against the slowest legitimate recovery, on the platform
 * the defect was found on.
 *
 * Derived rather than written down twice: the interval is exported from the
 * plist that sets it, so the two cannot drift.
 */
const VERIFY_START_ERROR_MARGIN_MS = 8_000;
const VERIFY_BUDGET_AFTER_START_ERROR_MS =
  LAUNCHD_THROTTLE_INTERVAL_SECONDS * 1_000 + VERIFY_START_ERROR_MARGIN_MS;

/**
 * The verify budget, as a pure function so the choice is testable without a
 * wall clock.
 *
 * `override` is the test/caller pin and stays authoritative, but it is a
 * CEILING rather than a replacement when the start errored: a suite that pins
 * a 60 s budget must not thereby re-acquire the 45 s wait this exists to cut,
 * and one that pins 50 ms must keep its 50 ms.
 */
export function verifyBudgetFor(
  postSwapError: string | null,
  override: number | null,
): number {
  const base = override ?? VERIFY_BUDGET_MS;
  return postSwapError === null
    ? base
    : Math.min(base, VERIFY_BUDGET_AFTER_START_ERROR_MS);
}

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
    // Deliberately NOT a disturbance seam (#1752 rounds 10/11, cold review B
    // C2). The `service-stop` and `swap` labels are emitted by
    // `commitInstallFromSource` BEFORE the lifecycle's status and authority
    // checks, so a refusal in those checks - a capability denied, a service
    // controller that will not answer - arrives with the label already
    // printed and NOTHING stopped. Marking `disturbed` from the label made
    // that refusal overwrite a live displaced writer's `updating` marker with
    // this run's `failed`, which is the marker theft round 10 removed. The
    // flag now has exactly three sources, all of them reports FROM the
    // actuator that is about to act: `onWillDisruptHost` on the apply and
    // downgrade arms, and the pre-stop callback inside
    // `stopHostForRestartWithAttempt` on the activation arm.
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
    foreignRuntimeVersion: null,
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
      async (capability, claim, complete, advance) =>
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
          advance,
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
  /**
   * The non-release string a live host was publishing when an arm decided to
   * leave it alone (D-51). The one fact in here written by an ARM rather than
   * the selector, and it is here because this is the run-scoped channel
   * `projectSegment` already receives: the attempt record has nowhere to put
   * it (a `superseded` write carries no `error` by D-46's design), and the
   * operator has to be told which build was running and that nothing was
   * activated.
   */
  foreignRuntimeVersion: string | null;
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
    const targetVersion = await boundContinueTarget(args);
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
  // An EXPLICIT request owes the activation of ITS version and no other.
  //
  // For an explicit request the `no-op` plan above fires only for a record
  // that IS the request - `resolveUpdatePlan` refuses any other record at or
  // above it before it ever returns `no-op` - so the record this debt read
  // sees can name another version only if it MOVED between the two reads:
  // another actor's commit in the gap. A record above the request (2.0.0
  // after `--version 1.2.0`) is not this run's to restart onto; the caller
  // confirmed 1.2.0, and checked ITS floor, and nothing else.
  //
  // Left, not refused: this run has claimed nothing, announced nothing and
  // written nothing, so there is no failure to report - the debt is real and
  // stays owed to an implicit `host update` or a `host restart`. Logged so
  // the reason a debt was visibly skipped is on the record, and reported as
  // the no-op the up-to-date plan already resolved to.
  const requested = requestedVersion(args);
  if (requested !== null && reading.installedVersion !== requested) {
    args.logger.info(
      "Host update leaves the install record's activation debt: the explicit request names another version",
      {
        environment,
        requestedVersion: requested,
        installedVersion: reading.installedVersion,
        runningVersion: reading.runningVersion,
      },
    );
    return { kind: "installer", plan };
  }
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
/**
 * The target a bound `continue` works toward (Q10, Linux E6L recovery matrix).
 *
 * It comes from THE RECORD, because the record is what a bound `continue` is
 * bound to: `--expect-attempt` already names the attempt, and that attempt
 * already carries the only target it may legally resume. Demanding `--version`
 * on top asked the caller to re-supply a fact the CLI was about to read anyway
 * - `parkNeedsTransfer` opens the same file three lines below - and the
 * refusal fired in plan resolution, before any record was read, so a recovery
 * that had everything it needed exited 1 `E_INVALID_ARGUMENT`.
 *
 * An explicit `--version` is still honoured, and is checked rather than
 * trusted: a caller who names a version that is not this attempt's target has
 * misunderstood which attempt they are resuming, and quietly preferring either
 * value would resume the wrong work under a confirmation made for the other.
 * That is a NAMED refusal, not a silent reconciliation.
 *
 * ## This guard is the ONLY layer, which is why it is here
 *
 * It would be tempting to call it the earlier of two refusals, on the grounds
 * that `decideAttemptClaim` refuses an identity-bound request whose target
 * disagrees. It does not, because **the core never sees `--version` on this
 * path**: `selectBoundResume` reaches `resumeSelection`, which builds the claim
 * with `targetVersion: record.targetVersion`, so
 * `request.targetVersion === current.targetVersion` by construction and no
 * mismatch branch can fire (cold review, Q10).
 *
 * There was a second layer before this, just not that one: `--version X`
 * against a record at Y resumed Y and then tripped the activation arm's
 * installed-version mismatch - a refusal phrased about installed versions
 * rather than about having named the wrong attempt. Refusing here is not
 * duplication; it is the only place that can say what actually went wrong.
 */
async function boundContinueTarget(args: HostUpdateRunArgs): Promise<string> {
  const { environment } = args;
  const read = await readUpdateAttemptRecord(hostHomeDir(environment));
  const record = read.kind === "valid" ? read.value : null;
  const bound =
    record !== null && record.attemptId === args.expectAttempt ? record : null;
  if (bound !== null) {
    if (
      args.versionRequest !== null &&
      args.versionRequest !== bound.targetVersion
    ) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: `host update: --version ${args.versionRequest} does not match attempt ${bound.attemptId}, whose target is ${bound.targetVersion}. Drop --version to continue that attempt, or check which attempt you meant.`,
        details: {
          environment,
          attemptId: bound.attemptId,
          targetVersion: bound.targetVersion,
          versionRequest: args.versionRequest,
        },
        exitCode: 1,
      });
    }
    return bound.targetVersion;
  }
  // No record this intent is bound to. An explicit `--version` still resolves a
  // plan, and the SELECTOR then answers `refused-attempt-gone` under the lock,
  // which is the existing and correct path - the record is what decides, and it
  // must be read under the lock rather than here.
  if (args.versionRequest !== null) return args.versionRequest;
  // Nothing names a target: no record to read one from, and no argument. This
  // is still `E_INVALID_ARGUMENT`, but it now says which attempt could not be
  // found instead of demanding a flag that would not have helped.
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `host update: no attempt ${args.expectAttempt ?? "<none>"} is recorded, so there is no target to continue; pass --version to name one explicitly`,
    details: { environment, expectAttempt: args.expectAttempt },
    exitCode: 1,
  });
}

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
    return {
      kind: "release",
      boundAttemptId: args.expectAttempt,
      reason: "record-fail-closed",
    };
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
      return { kind: "release", boundAttemptId: null, reason: "nothing-to-do" };
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
    return { kind: "release", boundAttemptId: null, reason: "nothing-to-do" };
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
  // Held to the request BEFORE the activation reading, and therefore before
  // the busy gate and the entry mirror's marker takeover - both of which live
  // past the claim this function is deciding. A record another actor moved
  // while this run waited for admission is refused here, with nothing claimed
  // and nothing written: the pre-lock gate in `resolvePlan` saw the record as
  // the request, and this read is the first that could see otherwise.
  const mismatch = installedVersionMismatch(
    requestedVersion(args),
    installed.version,
  );
  if (mismatch !== null) throw mismatch;
  selection.installedUnderLock = installed;
  const reading = await readActivationState(args.environment);
  if (reading.kind !== "debt" && reading.kind !== "no-live-host") {
    // `activated`, `foreign-runtime`, or a record that vanished between the
    // two reads: the legacy no-ops on anything but `debt` / `no-live-host`.
    // No stale-`failed` clear - the legacy clears only when the PRE-lock
    // reading was `activated`, and this run's was `debt`.
    return { kind: "release", boundAttemptId: null, reason: "nothing-to-do" };
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
      // `preparing` is not a choice beside the continuation below, it is the
      // only phase an `activate` birth has: the bytes are already placed, so
      // there is nothing to download or apply, and `ExecutorClaimRequest`'s
      // union admits the pair only in this shape (Codex #1773).
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
    return {
      kind: "release",
      boundAttemptId: expect,
      reason: "refused-attempt-gone",
    };
  }
  if (record.execution !== "parked") {
    // PRESENT, and therefore not GONE (Linux E6L, Q5 defect 2).
    //
    // An ACTIVE record under this exact id is an interrupted attempt whose
    // holder is dead - proven, not assumed, but NOT by this file (cold review
    // B): mutation spans are taken and released per arm, so mere acquisition
    // ordering would not exclude a live holder. Two layers do. The executor
    // lock `withCliAttemptExecutor` is held across the whole segment, so a
    // live holder still owns it and this run never reaches selection
    // (`host/update-contender.ts:136`); and `decideAttemptRecovery`
    // independently refuses `holder-not-proven-absent` unless the holder reads
    // `recovery-lock-held` (`shared/host-update/transition.ts:356`). That is
    // the RECOVERABLE case, and it is the only shape a crashed `host update`
    // leaves behind.
    //
    // Releasing `refused-attempt-gone` here said the opposite of what is on
    // disk, and said it to the two readers who act on it: the dispatching
    // host projects it as "there is nothing to continue", and the
    // level-triggered reconciler stops naming an attempt it is told does not
    // exist. On a CLI-only install that is a permanent outage - the record
    // sits at `restarting` indefinitely, and the recovery that would fix it
    // is exactly what this verb was dispatched to run.
    //
    // So it claims, and the CORE decides: an active record is
    // `requires-recovery`, and the recovery arm reconciles it from lock-scoped
    // evidence. Holder disposition and record presence are different
    // questions, and only the first one was ever asked here.
    return interruptedResume(input, record, intent);
  }
  if (intent === "activate" && record.phase !== "waiting-to-activate") {
    return {
      kind: "release",
      boundAttemptId: expect,
      reason: "refused-attempt-gone",
    };
  }
  const baseline = record.claim;
  if (record.phase === "waiting-to-activate") {
    // NO ordering test: `target === installed` by construction on every
    // activation park. A claim-less one is unverifiable (D19, 01's ignore
    // rule) - version ordering cannot establish an earlier authorization.
    if (baseline === undefined) {
      return {
        kind: "release",
        boundAttemptId: expect,
        reason: "refused-unverifiable",
      };
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
      : {
          kind: "release",
          boundAttemptId: expect,
          reason: "refused-unverifiable",
        };
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
    : {
        kind: "release",
        boundAttemptId: expect,
        reason: "refused-unverifiable",
      };
}

/**
 * The claim a BOUND verb makes on an interrupted attempt it named.
 *
 * The action is the VERB's, and that is the whole of the safety argument.
 * `resumeSelection`'s `continue` adopts either continuation by design - the
 * dispatcher named an attempt and the record says what it is - which is right
 * for `continue` and would be an over-authorization for `activate`: an
 * `activate` that reached `resume-new-generation` on a `resume-apply`
 * continuation would apply a stage nobody asked it to. Carrying the verb
 * through means `actionMayResume` refuses that pair inside the core, as
 * `request-action-mismatch`, instead of this function having to re-derive the
 * rule and get it wrong in a second place.
 *
 * `expected` is the record's own identity, so a record that moves between this
 * read and the claim is refused rather than resumed.
 */
function interruptedResume(
  input: SelectClaimInput,
  record: HostUpdateAttemptRecord,
  intent: HostUpdateBoundIntent,
): ExecutorClaimSelection {
  return {
    kind: "claim",
    request: {
      targetVersion: record.targetVersion,
      trigger: record.trigger,
      action: intent === "continue" ? "continue" : "activate",
      expected: attemptIdentityOf(record),
      newAttemptId: randomUUID(),
      initialPhase: "preparing",
      initialContinuation: null,
      claim: null,
    },
  };
}

function strictlyNewer(candidate: string, floor: string): boolean {
  const comparison = compareHostVersions(candidate, floor);
  return comparison.comparable && comparison.ordering === "greater";
}

// ---------------------------------------------------------------------------
// The explicit request's version binding (#1752 round 14)
// ---------------------------------------------------------------------------

/**
 * The version an EXPLICIT `host update <version>` is bound to, or `null` for
 * an implicit "latest".
 *
 * It is the ARGUMENT, not the claim's target, and the difference matters on
 * exactly one arm. For every arm that delivers bytes the two are the same
 * string - `resolveUpdatePlan` sets `targetVersion` from `versionRequest`
 * verbatim - but the activation-debt claim's target is the INSTALL RECORD's
 * version (`selectDebtStart`), which is precisely the value the binding must
 * be able to disagree with. Reading the claim there would compare the record
 * against itself and pass every time.
 */
function requestedVersion(args: HostUpdateRunArgs): string | null {
  return args.versionRequest;
}

/**
 * The refusal a reading that NAMES a record owes an explicit request, or
 * `null` when the record is the request (or there is no request to hold it
 * to).
 *
 * Identity is the STRING, the grain the apply binding uses: the request
 * resolved to a catalog version and the record names the catalog version it
 * committed, so the same artifact reads equal and `2.0.0+hotfix` is another
 * artifact. A record that is not a release version (`local-*`,
 * `host install --file`) is by construction not the requested one - it cannot
 * be compared, and it is exactly a record another actor wrote.
 *
 * A record NEWER than the request is the fact the promote-time discard
 * reports as `E_HOST_UPDATE_NOT_NEWER`, so it carries that code and the same
 * remedies - and, like it, is a SUPERSEDED request: `writeFailure` ends the
 * attempt `superseded` and the mirror withdraws the marker, rather than
 * stamping a `failed` no stale rule would ever clear (D-46). Any other
 * mismatch is `E_UNEXPECTED`, a failure before any disruption that IS stamped
 * over this run's own record, naming the version it announced.
 */
function installedVersionMismatch(
  expectedInstalledVersion: string | null,
  installedVersion: string,
): CliError | null {
  if (
    expectedInstalledVersion === null ||
    installedVersion === expectedInstalledVersion
  ) {
    return null;
  }
  const comparison = compareHostVersions(
    installedVersion,
    expectedInstalledVersion,
  );
  const details = {
    expectedInstalledVersion,
    actualInstalledVersion: installedVersion,
  };
  if (comparison.comparable && comparison.ordering === "greater") {
    return cliError({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      message: `host update: the installed host is ${installedVersion}, newer than the ${expectedInstalledVersion} this run was updating to - another actor installed it meanwhile; nothing was restarted. Run 'traycer host status' to see what is installed and running, or pass --allow-downgrade to install ${expectedInstalledVersion} over it`,
      details,
      exitCode: 1,
    });
  }
  return cliError({
    code: CLI_ERROR_CODES.UNEXPECTED,
    message: `host update: the installed host is ${installedVersion}, not the ${expectedInstalledVersion} this run was updating to - another actor changed the install before it could be activated; nothing was restarted. Run the update again`,
    details,
    exitCode: 1,
  });
}

/** Every reading that NAMES a record, held to the request. */
function refuseReadingAgainstRequest(
  reading: ActivationReading,
  requested: string | null,
): void {
  if (reading.kind === "no-install") return;
  const mismatch = installedVersionMismatch(
    requested,
    reading.installedVersion,
  );
  if (mismatch !== null) throw mismatch;
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
    /**
     * The segment's own write, built by `update-executor.ts` next to
     * `complete`. This class holds no capability and no host home: the
     * contender module is a two-importer module by construction (the shared
     * barrel and the executor), so an executing caller writes through the
     * closure it was handed or not at all - and `clients/shared`'s
     * architecture suite pins exactly that.
     */
    private readonly advance: AdvanceExecutorSegment,
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

  /**
   * The attempt's target was OUTGROWN, not lost: another actor committed (and
   * possibly activated) a newer artifact while this run held its claim, so the
   * request this attempt carries is superseded and nothing went wrong (D-46,
   * #1752 round 14).
   *
   * A non-failure terminal, and deliberately the phase the record model
   * already has: `superseded` is a legal successor of every active phase, it
   * carries NO `error`, and both GUI legs already read it the way this needs -
   * the live projection maps it to `idle`, the record leg drops it, so nothing
   * renders a red "Update to X failed" over a host serving Y. Stamping
   * `failed` here is exactly what round 14 removed: no stale rule clears a
   * `failed` whose target is not the running version, so it would stand until
   * some later update happened to do work.
   *
   * Carries the same `held` identity discipline as every other advance - it
   * goes through `barrier` and the segment's own closure - so a segment whose
   * claim was superseded underneath it is rejected here as it is anywhere
   * else, rather than terminalizing a record it no longer owns.
   */
  supersede(): Promise<void> {
    return this.barrier({
      phase: "superseded",
      continuation: null,
      progress: null,
      error: null,
      claimRefresh: null,
      nowIso: new Date().toISOString(),
    });
  }

  /** Settles the in-flight write through the closure and drops the queue. */
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
    const outcome = await this.advance({
      kind: "advance",
      held: this.held,
      advance,
    });
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
  /**
   * The segment's own non-terminal write. `capability` stays alongside it
   * because the ACTUATORS still take it directly - the apply, the stop, the
   * downgrade installer and `withCliAttemptMutation` all do - but no writer in
   * this file holds it any more.
   */
  readonly advance: AdvanceExecutorSegment;
}

async function runArm(input: RunArmInput): Promise<LegacyHostUpdateResult> {
  const { claim, mirror } = input;
  // The ENTRY mirror, before the first actuator: the lock holder owns the
  // marker, so whatever the path holds is taken over here. The claim write
  // itself was made by the executor core, which the writer never sees.
  await mirror.record(claim.record);
  const writer = new AttemptRecordWriter(input.advance, mirror, claim.record);
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
    if (!writer.settled) await writeFailure(writer, err, mirror.disturbed);
    throw err;
  } finally {
    input.writerRef.current = null;
    await writer.dispose().catch(() => undefined);
  }
}

/**
 * The terminal this arm's error deserves.
 *
 * Two terminals, one rule (#1752 round 14, D-46). A refusal because a NEWER
 * host is installed than the version this run was asked for -
 * `E_HOST_UPDATE_NOT_NEWER`, from the promote-time discard or from
 * `installedVersionMismatch`'s newer arm - is a SUPERSEDED request, not a
 * failure: another actor delivered something newer and nothing was wrong. Any
 * other error - an OLDER or non-release record under an explicit request, a
 * lost download, a changed stage - names something that DID go wrong and is
 * stamped `failed` as before.
 *
 * Pre-disruption only. Past the stop the host's state is this run's doing:
 * whatever it then finds installed, the run left a host mid-flight and that is
 * a failure to report, not a request someone else fulfilled. The marker mirror
 * applies the same cut to its own withdrawal, from the same flag.
 */
async function writeFailure(
  writer: AttemptRecordWriter,
  err: unknown,
  disturbed: boolean,
): Promise<void> {
  const phase = writer.phase;
  // Q11's third terminal, and the only one that is NO terminal at all: the
  // completion write was refused over a host verified healthy at the target.
  // This has to be caught HERE and not only at the throw site, because the
  // writer never settled - the refused write was the executor's, not the
  // writer's - so without this arm the generic path below stamps `failed` and
  // undoes the whole fix one frame up the stack. Leaving the record where the
  // verify loop had it IS the answer; see the throw site for who concludes it.
  //
  // WHAT THIS GUARD ASSUMES, stated because it is not visible from here (cold
  // review B). The rule is "over a host verified HEALTHY at the target"; the
  // test is an error CODE. Those coincide only because the code has exactly
  // ONE throw site - `runner/errors.ts` declares it once, `verifyUnderClaim`
  // throws it once, past the verify loop's `break`, and this is its only
  // reader. A second throw from a path that has not verified health - a
  // refused write at `applying`, say - would inherit the carve-out silently
  // and leave an active record with nothing stamped and no one reconciling it.
  // Adding one means re-deriving this, not reusing it.
  if (
    err instanceof CliError &&
    err.code === CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED
  ) {
    return;
  }
  const superseded =
    !disturbed &&
    err instanceof CliError &&
    err.code === CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER;
  try {
    if (superseded) {
      await writer.supersede();
      return;
    }
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
  // ...or the install moved to this attempt's OWN target because this attempt
  // is what put it there. Not a foreign change, and the baseline is simply
  // stale (Linux E6L, Q5).
  if (
    live !== null &&
    installedByThisAttempt(input.claim.record, baseline, live)
  ) {
    return live;
  }
  // Held to the REQUEST before it is called a changed install (#1752 round
  // 14). This is the site rounds 14's "the record moved while waiting for the
  // lock" reaches on the executor: the claim's baseline named the request, and
  // a record another actor moved ABOVE it is that request OUTGROWN, not a
  // corrupted handoff. Thrown rather than written, so `writeFailure` ends the
  // attempt `superseded` with the marker withdrawn - a `failed {install-
  // changed}` naming 2.0.0 over a host at 3.0.0 is exactly the red banner no
  // stale rule would ever clear. An implicit request has nothing to be
  // outgrown and keeps the terminal below.
  if (live !== null) {
    const outgrown = installedVersionMismatch(
      requestedVersion(input.args),
      live.version,
    );
    if (outgrown !== null) throw outgrown;
  }
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
 * Does the live install record read as THIS attempt's own work, rather than
 * as a foreign change the baseline comparison above is there to catch?
 *
 * ## The seam this closes (Linux E6L, Q5)
 *
 * An update to 1.4.3 reached `restarting` - the install dir already swapped
 * to 1.4.3 by this very attempt - and the CLI was then killed. The recovery
 * run reads the record, whose claim baseline still names the PRE-swap install
 * (1.4.2, refreshed only by parks), finds 1.4.3 on disk, and calls the
 * attempt's own successful swap "the installed host changed while attempt
 * <id> was waiting". The record terminalizes, the host is left DOWN because
 * nothing relaunched it, and every later `host update --version 1.4.3` hits
 * the same refusal - a state only `--allow-downgrade` could reset.
 *
 * Two correct halves, wrong at the join. `recoveryContinuation` had just
 * certified, from attested lock-scoped evidence, that the installed leg
 * verifies at this record's own `targetVersion`; this function then read the
 * same install record as evidence of a stranger.
 *
 * ## Why the CONTINUATION is the carrier, and not the phase
 *
 * The rule is "the install equals the attempt's own target AND this attempt
 * is past the swap". The phase cannot say the second half here: `resumedRecord`
 * lands EVERY recovery resume at `preparing`, for both continuations and by
 * design, so the `restarting` / `verifying` the killed run left behind is gone
 * before this code sees the record. A phase test at this site would never
 * fire.
 *
 * The continuation survives, and says exactly the right thing. Quoting
 * `resumedRecord`'s own comment on retaining it: it "is what still says
 * 'bytes are already placed, do not re-apply' if this segment dies before it
 * reaches its next write". And it is not testimony - `recoveryContinuation`
 * returns `activate` ONLY when the installed artifact is attested-verified at
 * this record's `targetVersion`, decided under this same lock from bytes it
 * hashed itself.
 *
 * ## The move this forgives is exactly one, and only once
 *
 * A baseline that ALREADY names the target has nothing left to explain: this
 * attempt's swap is accounted for in it, so any later difference is somebody
 * else's. That is what keeps the rule narrow enough to leave the
 * re-materialized park terminal - a `waiting-to-activate` park whose baseline
 * was refreshed to 2.0.0 at the park and whose install is now a DIFFERENT
 * 2.0.0 is `host install --force` re-landing bytes this claim never
 * authorized, and version equality alone cannot see it. Only the pre-swap
 * baseline → target step is forgiven, which is the one step the attempt
 * itself performed.
 *
 * ## The narrow case this ACCEPTS, stated rather than denied (cold review B)
 *
 * That protection is conditional on a refresh that can fail quietly, so there
 * is one park this rule does forgive. `readClaimRefresh` returns
 * `{ refresh: null }` when `readHostInstallRecord` reads nothing, `park()`
 * passes that through, and `refreshedClaimBaseline` retains the PRIOR
 * baseline - so a `waiting-to-activate` park whose install-record read
 * transiently failed keeps its PRE-swap baseline. All three clauses then hold
 * on the next resume, and a foreign same-version install landed in the
 * meantime is forgiven with no generation comparison.
 *
 * It is accepted, not overlooked. It needs a transient read failure at park
 * time AND a foreign same-version install before the resume; the alternative
 * is refusing every genuine E6L recovery to catch it. The durable fix is at
 * the other end - a park should not silently keep a baseline it could not
 * refresh - and belongs with `readClaimRefresh`, not here.
 *
 * A fourth clause requiring the baseline's generation to differ from the live
 * one does NOT close it, and cannot: it is a tautology here. The second and
 * third clauses already force `baseline.installedVersion !== live.version`,
 * and two install records at different versions are necessarily different
 * generations, so such a clause is true whenever the first three are - in the
 * foreign case exactly as much as in the honest one.
 *
 * ## What still refuses, and why each one must
 *
 *  - `resume-apply`: the bytes are NOT placed, so a target-equal install is
 *    another actor consuming this park's stage - the case the plan requires
 *    to terminalize `install-changed` rather than resume (D19), because
 *    resuming would apply a stage that is no longer the reason this park
 *    exists;
 *  - a `null` continuation: a fresh start has placed nothing at all;
 *  - a baseline already AT the target: the re-materialized park above, still
 *    decided by the install generation;
 *  - any install that is neither the baseline nor the target: genuinely
 *    foreign, and today's terminal is unchanged.
 *
 * ## Why VERSION equality carries the target side
 *
 * The generation is not available to compare against: the pre-swap baseline
 * names the generation this attempt REPLACED, so there is nothing here that
 * records what its own swap wrote. What decides instead is the layer that
 * already looked: `recoveryContinuation` returned `activate` only because the
 * installed artifact verified - hashed under this same lock - at this
 * record's own target. Re-deriving a stricter answer here from a baseline
 * that predates the swap would not be a second check; it would be a refusal
 * of the first one.
 *
 * The wedged Linux box says the same thing from disk rather than from
 * reasoning: `install.json` had already moved to the generation the 1.4.3
 * swap minted (`id:f55134a3-…`), while the record's claim baseline still
 * named the 1.4.2 generation it replaced (`id:4950d09a-…`). The generation
 * this attempt's own swap wrote survives in exactly one place - the install
 * record - which is the same place a foreign installer overwrites.
 */
function installedByThisAttempt(
  record: HostUpdateAttemptRecord,
  baseline: HostUpdateAttemptClaimBaseline,
  live: HostInstallRecord,
): boolean {
  return (
    record.continuation === "activate" &&
    live.version === record.targetVersion &&
    baseline.installedVersion !== record.targetVersion
  );
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
      await stageFingerprintForApply(
        input,
        input.claim.record.claim?.stageFingerprint ?? null,
      ),
      null,
    );
  }
  return upgradeArm(input, writer);
}

/**
 * The refusal a DISCARDED transfer owes an explicit request (#1752 round 14).
 *
 * The promote-time policy is right to keep what it kept; what changed is who
 * hears about it. A discard under an explicit request means the version the
 * caller named was not delivered, and saying so with the discard's own reason
 * beats letting the apply's version binding report a "replaced stage" it will
 * name the wrong cause for.
 */
function discardedExplicitRequestError(
  outcome: Extract<HostDownloadOutcome, { readonly outcome: "discarded" }>,
): CliError {
  const target = outcome.targetVersion;
  switch (outcome.reason) {
    case "not-newer-than-installed":
      return cliError({
        code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
        message: `host update: ${target} was downloaded, but the installed host is no longer older than it - another update landed meanwhile; nothing was applied. Run 'traycer host status' to see what is installed, or pass --allow-downgrade to install ${target} over it`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
    case "not-strictly-newer":
      return cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: a newer host was staged while ${target} downloaded; nothing was applied - run the update again to install what is staged`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
    case "install-record-vanished":
      return cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: the install record vanished while ${target} downloaded; nothing was applied - run 'traycer host doctor'`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
    case "automatic-refused-incomparable-installed":
      return cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: `host update: the installed host's version cannot be compared with ${target}; nothing was applied - run 'traycer host status' to see what is installed`,
        details: { targetVersion: target, reason: outcome.reason },
        exitCode: 1,
      });
  }
}

/** Transfer, then apply. `beforeExtract` is the verified-bytes barrier. */
async function upgradeArm(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): Promise<LegacyHostUpdateResult> {
  const { args } = input;
  const transfer = await transferUnderClaim(input, writer, args.versionRequest);
  const requested = requestedVersion(args);
  if (requested !== null && transfer.outcome === "discarded") {
    // An EXPLICIT request whose download was DISCARDED at promote time has
    // nothing of its own to apply. Decided HERE, before the apply, so a run
    // that has already decided not to act does not go on to open a mutation
    // lock and ask the installer about a stage it must not commit.
    const installed = await readHostInstallRecord(args.environment);
    // `not-newer-than-installed` covers EQUAL: the record can BE the request,
    // committed by another actor during the unlocked transfer (Desktop's
    // converge). That is the request DELIVERED, not discarded - and the
    // executor answers it the way it answers a consumed stage, one arm below.
    const deliveredByAnotherActor =
      transfer.reason === "not-newer-than-installed" &&
      installed !== null &&
      installed.version === input.claim.record.targetVersion;
    if (!deliveredByAnotherActor) {
      // The DISCARD's own reason, and only it. The record is deliberately NOT
      // put through `installedVersionMismatch` here: on this arm the record
      // being behind the request is the ordinary state of an upgrade that has
      // not landed yet, so holding it to the request would refuse every
      // discard as a changed handoff. The discard already carries the right
      // code - `not-newer-than-installed` IS the superseded request and
      // reports `E_HOST_UPDATE_NOT_NEWER`, which `writeFailure` ends
      // `superseded` with the marker withdrawn; every other reason is
      // `E_UNEXPECTED` and stamped.
      throw discardedExplicitRequestError(transfer);
    }
    return settleDeliveredByAnotherActor(
      input,
      writer,
      `host update: ${input.claim.record.targetVersion} was committed by another actor while it downloaded`,
    );
  }
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
    await stageFingerprintForApply(input, null),
    transfer,
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
      await stageFingerprintForApply(input, baseline?.stageFingerprint ?? null),
      null,
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
    // dir and commits from there, so its private download never PROMOTES
    // into the shared stage and an eligible newer stage survives it (review
    // B probe: 2.0.0 over 3.0.0 with 4.0.0 staged keeps the stage id,
    // sidecar and bytes). The ordinary commit-time reconciliation still runs
    // (`reconcileHostStageWithAttempt`) and may remove a stale or invalid
    // stage - that is the reconcile rule's decision, not a transfer over it.
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
    await stageFingerprintForApply(input, null),
    transfer,
  );
}

/**
 * The stage FINGERPRINT this attempt pins its apply to, if any.
 *
 * The VERSION half of the binding is not here: it is the installer's
 * `expectedStagedVersion`, fed by `applyArm` with the claim's target (ticket
 * 08 decision 2 - one binding, decided before the busy gate and before
 * anything is announced). This function answers only the finer question the
 * version cannot: WHICH stage of that version.
 *
 * `claimFingerprint` is the claim's own expectation and wins where it exists -
 * it detects a stage REPLACED since the claim at the SAME version, which a
 * version check cannot see. It is deliberately NOT used on an arm whose own
 * transfer just ran: the claim's fingerprint predates that transfer, so
 * pinning to it would refuse the bytes this run just placed.
 *
 * A stage at any OTHER version contributes nothing: pinning its id would make
 * the installer answer `stage-fingerprint-mismatch` for what is really a
 * version mismatch, and the version binding says that in one sentence.
 */
async function stageFingerprintForApply(
  input: RunArmInput,
  claimFingerprint: string | null,
): Promise<string | null> {
  if (claimFingerprint !== null) return claimFingerprint;
  const staged = await readHostStagedRecord(input.args.environment);
  return staged !== null && staged.version === input.claim.record.targetVersion
    ? staged.stageId
    : null;
}

/**
 * The stage in front of this attempt is not the one it was authorized for.
 *
 * Terminal, and the same family as the identity re-validation above: the world
 * this claim was authorized against is not the world in front of it. Never a
 * refusal - a same-target park admits only a resume, so a refusal would leave
 * it for a level-triggered reconciler to re-spawn forever.
 */
interface ObservedStage {
  readonly version: string;
  readonly stageId: string | null;
}

async function terminalizeStageMismatch(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  staged: ObservedStage | null,
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
  transfer: HostDownloadOutcome | null,
): Promise<LegacyHostUpdateResult> {
  const { args } = input;
  const target = input.claim.record.targetVersion;
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
          // The ONE version binding (#1752 round 10/14, ticket 08 decision 2).
          // The executor feeds the installer the CLAIM's target - not the
          // argument - because the claim is this attempt's authorization: an
          // implicit `latest` that resolved to 2.0.0 is as bound to 2.0.0 as
          // an explicit `--version 2.0.0`, and the stage another promoter
          // replaced in the unlocked wait must not be committed under either.
          // The installer decides it BEFORE the busy gate and before it
          // announces anything, and reports `stage-version-mismatch` having
          // consumed nothing.
          expectedStagedVersion: target,
          onProgress: input.onProgress,
          // Deliberately NO `onWillCommitStaged`: it fires BEFORE the
          // cooperative stop, so a denial there must still park from
          // `preparing`, and the coarse marker is record-driven now.
          onWillCommitStaged: null,
          // The disruption boundary, and the ONLY one on this arm: reported
          // by the ACTUATORS (the lifecycle's pre-stop check and the commit's
          // pre-swap check), never inferred from the `service-stop` / `swap`
          // progress lines, which precede both and precede the authority
          // checks that can still refuse (#1752 rounds 10/11, cold review B
          // C2). The progress-derived rule that used to shadow this callback
          // is gone; nothing else marks the flag here.
          onWillDisruptHost: () => input.mirror.markDisturbed(),
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
    // The stage this attempt was going to commit was gone by the time it held
    // the lock: another actor consumed it - Desktop's launch converge runs
    // `host apply --no-service`, which commits the bytes and restarts nothing.
    //
    return settleDeliveredByAnotherActor(
      input,
      writer,
      `host update: nothing was staged for ${target} when the apply ran`,
    );
  }
  if (outcome.outcome === "stage-version-mismatch") {
    // The one binding's refusal, terminalized here: the installer decided it
    // and consumed nothing, and this is the same "the world this claim was
    // authorized against is not the world in front of it" family as every
    // other stage mismatch, so it takes the same terminal.
    return terminalizeStageMismatch(
      input,
      writer,
      { version: outcome.actualStagedVersion, stageId: null },
      transfer,
      "the apply ran",
    );
  }
  if (outcome.outcome === "stage-fingerprint-mismatch") {
    // A null actual fingerprint is not a REPLACED stage, it is an ABSENT one -
    // the same world the `no-op` arm above describes, reported under a
    // different name only because a pinned fingerprint is checked first
    // (`installer/apply.ts`: the fingerprint test precedes the no-stage
    // answer, so a consumed stage never reaches `no-op` when this attempt
    // pinned one). Cold review B, C3: every resumed park pins a fingerprint,
    // so before this branch existed the whole D-46 / D-47 / D-47b settlement
    // was unreachable in production for the case it was written for - a stage
    // another actor consumed and committed - and all three answers came out
    // as `failed` / `E_UNEXPECTED` instead.
    if (outcome.actualStageFingerprint === null) {
      return settleDeliveredByAnotherActor(
        input,
        writer,
        `host update: the stage for ${target} was gone when the apply ran`,
      );
    }
    // A DIFFERENT fingerprint is a stage that is present and is not this
    // claim's: bytes someone else promoted, which this attempt was never
    // authorized to commit. That stays the refusal (F1's family).
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
  await verifyUnderClaim(input, writer, outcome.postSwapError);
  return projectApplied(outcome);
}

/**
 * The three arms that find the REQUESTED work already done by ANOTHER ACTOR -
 * a stage consumed under the lock, a downgrade whose version is already
 * installed, an explicit download discarded because the record reached its
 * version during the transfer - settle here, and settle identically (#1752
 * round 14's `activateCommittedByAnotherActor`, one closure for all three).
 *
 * Three answers, checked in the order that makes each impossible to mistake
 * for the next:
 *
 *  1. **The record is not the request.** Every reading that NAMES a record is
 *     held to an explicit request. A record another actor moved ABOVE it is a
 *     SUPERSEDED request - `E_HOST_UPDATE_NOT_NEWER`, which `writeFailure`
 *     ends `superseded` with the marker withdrawn, because nothing went
 *     wrong. Any other version is `E_UNEXPECTED` and IS stamped. Desktop's
 *     converge commits whatever ITS stage held, so this is the arm that keeps
 *     `host update --version X` from restarting the host onto Y under a
 *     confirmation, and a floor check, made for X.
 *  2. **The request is delivered AND running.** The attempt's target is
 *     installed and serving it: the work is done, by someone else. The
 *     ordinary evidence loop confirms both halves independently and the
 *     ordinary completion write ends the attempt, so the record completes,
 *     the marker clears and the run exits 0 - never a red failure for work
 *     that is finished, and never a success this run did not verify.
 *  3. **Delivered but NOT running.** A restart is owed. This attempt cannot
 *     pay it: re-entering the activation arm mid-attempt is not open to the
 *     executor, because a `waiting-to-activate` park may be BORN only from an
 *     `applying` write (transition core §continuation-phase-order), so a busy
 *     gate there would have no legal park and the record would be corrupted
 *     instead. It ends `superseded` - D-47, and D-46's logic unchanged:
 *     another actor delivered the request, so NOTHING failed, and a record
 *     must not carry an `error` for a state whose only remedy is a restart.
 *     The debt is durable (it is the disagreement between `install.json` and
 *     the live process), so the next plain `host update` meets the terminal
 *     record, sees the debt in its plan, and runs the debt arm - which IS born
 *     with `continuation: "activate"` - while the GUI, following the record to
 *     idle, offers the same restart from its activation-debt leg. Only the
 *     terminal user's exit code is non-zero, and it names the restart.
 *
 * Answer 3's condition is "the install record IS the target", which also
 * catches the corner where the target is installed AND running but this
 * segment may not write the verification (`canReachVerifying`): delivered is
 * delivered, and a `failed` there would be the same red-over-finished-work
 * that D-46 removed. That corner takes the same `superseded` record and
 * **exits 0** (D-47b) - the run DID observe the live host serving the
 * requested string under its own lock, which is the same evidence answer 2
 * acts on; what it cannot do is WRITE `complete` from a continuation that
 * never wrote `applying`, and a record-shape limit is not a missing
 * verification. Answer 4 - the fallthrough - is the genuinely bad world: no
 * install record, or a record at a version nobody asked for. That one is
 * still `failed {stage-missing}`.
 */
async function settleDeliveredByAnotherActor(
  input: RunArmInput,
  writer: AttemptRecordWriter,
  failureMessage: string,
): Promise<LegacyHostUpdateResult> {
  const { args } = input;
  const target = input.claim.record.targetVersion;
  const contenderOptions = mutationContenderOptions(
    args.environment,
    "host-update-settle",
  );
  // ONE coherent observation, taken under the SAME lock a writer that could
  // move the record has to hold, with the terminal decided inside it (cold
  // review B, C1). Before this, the reading and the record the projection
  // returned were two unlocked reads: a competing installer committing 3.0.0
  // between them let an explicit `--version 2.0.0` exit 0 reporting 3.0.0 -
  // the exact "a request for X is never answered with Y" rule this ticket
  // exists to enforce, defeated inside the arm that enforces it. The lock is
  // taken here rather than held from the caller because the actuators release
  // theirs before answering: `applyHostWithAttempt` returns after its own
  // span, so there is nothing to inherit and nothing to re-enter.
  const settled = await withCliAttemptMutation(
    input.capability,
    contenderOptions,
    async (): Promise<DeliverySettlement> => {
      const observed = await readHostInstallRecord(args.environment);
      // Nothing installed at all is the genuinely bad world, and it names no
      // record for the request to be held to.
      if (observed === null) {
        await writer.fail({
          code: "stage-missing",
          message: failureMessage,
          phase: writer.phase,
        });
        return { kind: "not-delivered" };
      }
      const reading = await classifyActivationAgainst(
        args.environment,
        observed,
      );
      refuseReadingAgainstRequest(reading, requestedVersion(args));
      if (
        reading.kind === "activated" &&
        reading.installedVersion === target &&
        canReachVerifying(input, writer)
      ) {
        return { kind: "verify-and-complete", observed };
      }
      // The request WAS delivered - the install record names exactly the
      // target - so nothing failed, whatever this segment is still allowed to
      // write. The pre-disruption cut is `writeFailure`'s, for its reason:
      // past the stop a host that is not running the target may be THIS run's
      // doing, and a run that left a host down reports a failure rather than
      // someone else's success.
      if (reading.installedVersion === target && !input.mirror.disturbed) {
        await writer.supersede();
        // D-51: a live host publishing a NON-RELEASE string is outside the
        // activation domain. The catalog-domain rule #1752 rounds 9-16 settled
        // is that this command does not reason about a developer's build - and
        // it certainly does not stop one to install over it. So the claim ends
        // quietly: no restart owed, no remedy to name, exit 0, and the string
        // it left running carried out to the operator. `E_HOST_NOT_RUNNING`
        // would be false twice over - the host IS running, and there is
        // nothing for `traycer host restart` to fix.
        //
        // This is the ONLY place the foreign string is recorded (recheck E1).
        // `reading` is the observation this lock span took, the same one the
        // terminal write above was decided from, so the sentence the operator
        // reads and the record they can inspect describe one world. Four of
        // the five routes into this closure never touch the activation arm at
        // all, and the fifth - the arm's own cleared-debt continuation - hands
        // its decision to this read on purpose.
        if (reading.kind === "foreign-runtime") {
          input.selection.foreignRuntimeVersion = reading.runningVersion;
          args.logger.info(
            "Host update left a non-release host running: nothing was activated",
            {
              environment: args.environment,
              installedVersion: reading.installedVersion,
              runningVersion: reading.runningVersion,
            },
          );
          return { kind: "left-foreign-runtime", observed };
        }
        if (reading.kind !== "activated") {
          return { kind: "restart-owed", reading };
        }
        // D-47b: the request is delivered AND RUNNING, and only the RECORD
        // stands in the way - a `resume-apply` continuation that never wrote
        // `applying` may not write `complete`. That is a record-shape limit,
        // not a missing verification: this run read the live host UNDER THIS
        // LOCK and saw it serving the requested string, which is the same
        // evidence the exit-0 answer above acts on. A non-zero exit for a host
        // that runs exactly what was asked would be a lie in the other
        // direction from the RCA's finding 3. `superseded` is the honest
        // record - someone else finished this - and the run reports the no-op
        // it truthfully is, projecting the record it just validated.
        args.logger.info(
          "Host update was delivered by another actor: the requested version is installed and running",
          {
            environment: args.environment,
            targetVersion: target,
            runningVersion: reading.installedVersion,
          },
        );
        return { kind: "delivered-and-running", observed };
      }
      await writer.fail({
        code: "stage-missing",
        message: failureMessage,
        phase: writer.phase,
      });
      return { kind: "not-delivered" };
    },
  );
  switch (settled.kind) {
    case "verify-and-complete":
      // Verified outside the lock, as every other arm verifies: the evidence
      // loop polls a live host and must not hold the mutation boundary while
      // it waits. The PROJECTION is still the record validated above, never a
      // re-read.
      // No swap and no service start happened on this settlement - the work
      // was already delivered - so there is no start error to report.
      await verifyUnderClaim(input, writer, null);
      return projectNoOp(settled.observed);
    case "delivered-and-running":
    case "left-foreign-runtime":
      return projectNoOp(settled.observed);
    case "restart-owed":
      throw deliveredByAnotherActorError(input, settled.reading, target);
    case "not-delivered":
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: failureMessage,
        details: { environment: args.environment, targetVersion: target },
        exitCode: 1,
      });
  }
}

/**
 * What the settlement decided under its lock, so the answer can be ACTED on
 * after the lock is released without re-reading anything.
 *
 * `observed` is the install record the decision was made against and the one
 * the caller projects. Carrying it is the whole point: a second
 * `readHostInstallRecord` after the lock is exactly the unbound read C1 was.
 */
type DeliverySettlement =
  | {
      readonly kind: "verify-and-complete";
      readonly observed: HostInstallRecord;
    }
  | {
      readonly kind: "delivered-and-running";
      readonly observed: HostInstallRecord;
    }
  | {
      readonly kind: "left-foreign-runtime";
      readonly observed: HostInstallRecord;
    }
  | {
      readonly kind: "restart-owed";
      readonly reading: Exclude<
        ActivationReading,
        { readonly kind: "no-install" | "activated" | "foreign-runtime" }
      >;
    }
  | { readonly kind: "not-delivered" };

/**
 * What the terminal user is told when another actor delivered the request but
 * the host is NOT running it.
 *
 * NON-ZERO, deliberately: exit 0 for "the host does not run what you asked
 * for" is the RCA's finding-3 class. The RECORD is `superseded` all the same
 * (D-47) - the exit code addresses the person who typed the command, the
 * record addresses the GUI, and they answer different questions.
 *
 * `E_HOST_NOT_RUNNING`, chosen because it is what is literally true and
 * because the remedy is a restart: the debt is durable (it is the disagreement
 * between `install.json` and the live process), so `traycer host restart` - or
 * the next plain `host update`, whose debt arm is born with
 * `continuation: "activate"` - pays it. There is no restart-required /
 * activation-owed code in the table to prefer over it.
 *
 * The sibling corner, where the target IS running and only the record's shape
 * forbids the success write, exits 0 from the caller (D-47b) and never reaches
 * this function - which is why `activated` is excluded from the parameter.
 */
function deliveredByAnotherActorError(
  input: RunArmInput,
  reading: Exclude<
    ActivationReading,
    { readonly kind: "no-install" | "activated" | "foreign-runtime" }
  >,
  target: string,
): CliError {
  const { environment } = input.args;
  return cliError({
    code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
    message: `host update: ${target} is installed but the host is not running it - another actor committed it while this update ran. Run \`traycer host restart\` to finish.`,
    details: {
      environment,
      targetVersion: target,
      // `debt` names what is running; `no-live-host` has nothing to name, and
      // that null is honest rather than missing - the remedy is the same
      // restart either way. `foreign-runtime` never reaches here (D-51).
      runningVersion: reading.kind === "debt" ? reading.runningVersion : null,
    },
    exitCode: 1,
  });
}

/**
 * Whether this segment may still write `verifying`.
 *
 * A `resume-apply` continuation may not reach verification before it has
 * itself committed `applying` - that is the durable "these bytes are mine"
 * provenance, and the transition core rejects the write rather than trusting
 * the phase label. A resumed park that reached one of the
 * already-delivered arms without applying therefore takes the terminal, not
 * the success: the record cannot say it verified an apply it never made.
 */
function canReachVerifying(
  input: RunArmInput,
  writer: AttemptRecordWriter,
): boolean {
  // The two continuation rules, and ONLY them. Both say the same thing in
  // their own domain: a segment may claim a verification only for work it
  // actually did.
  //
  //  - `resume-apply` may not verify before it has written the `applying`
  //    that says the committed bytes are its own;
  //  - `activate` may not verify before it has written the `restarting` that
  //    says the restart was its own. That is the case cold review B's C4
  //    reaches: the debt cleared under the arm's own lock, so nothing was
  //    restarted, and this segment must not report a verification for another
  //    actor's activation. It takes the `superseded` answer instead.
  //
  // A generic `isLegalPhaseTransition(writer.phase, "verifying")` guard stood
  // here briefly and was removed as UNPINNABLE rather than left standing
  // unpinned (recheck D3): every route into the settlement is at `preparing`
  // or later - the claim's own `initialPhase` is `preparing` for every
  // resume and for the activation start, and the two arms born at
  // `downloading` reach it only after `beforeExtract` has written
  // `preparing` - so the generic rule never decides anything the two rules
  // below do not already decide. If a future arm can settle from
  // `downloading` or from a park, restore the guard AND pin it; the
  // reachability argument, not the guard, is what makes this safe.
  //
  // `input.claim.record.continuation` rather than the writer's for the same
  // reason: the only advances that change a writer's continuation are parks
  // and terminal writes, and this question is never asked after either.
  const continuation = input.claim.record.continuation;
  if (continuation === "resume-apply") {
    return (
      writer.phase === "applying" ||
      writer.phase === "restarting" ||
      writer.phase === "verifying"
    );
  }
  if (continuation === "activate") {
    return writer.phase === "restarting" || writer.phase === "verifying";
  }
  return true;
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
  let outcome: Extract<ApplyHostOutcome, { outcome: "applied" | "no-op" }>;
  try {
    outcome = await installHostDowngradeInSegment(
      {
        environment: args.environment,
        version: target,
        force: args.force,
        onProgress: input.onProgress,
        // The coarse marker is record-driven here as on the apply arm, so
        // there is nothing to take over at this hook. See the field's doc.
        onBeforeCommit: async () => {},
        // The actuator-reported disruption boundary, the same one the apply
        // arm threads (#1752 rounds 10/11): the lifecycle's pre-stop check and
        // the commit's pre-swap check, never the progress lines that precede
        // both.
        onWillDisruptHost: () => input.mirror.markDisturbed(),
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
  if (outcome.outcome === "no-op") {
    // Another actor installed the requested version while this run staged its
    // private source; the installer re-derived that under its own mutation
    // lock, before the busy gate and before any barrier, and discarded the
    // source rather than committing identical bytes and restarting the host
    // for nothing (#1752 round 14).
    //
    // What remains is the question a consumed stage asks - is the committed
    // record RUNNING? - and the executor answers it the same way, and for the
    // same structural reason: it cannot re-enter the activation arm
    // mid-attempt (a `waiting-to-activate` park may be BORN only from an
    // `applying` write, so a busy gate there would have no legal park). The
    // record is held to the request first, so a record another actor moved
    // ABOVE this downgrade target ends the attempt `superseded` with the
    // marker withdrawn rather than `failed`.
    return settleDeliveredByAnotherActor(
      input,
      writer,
      `host update: ${target} was already installed by another actor when the downgrade ran`,
    );
  }
  await verifyUnderClaim(input, writer, outcome.postSwapError);
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
  let installed = live;
  let restarted = false;
  // ONE lock span across the gate, the stop and the relaunch, exactly as the
  // legacy arm holds one: a window between the stop and the relaunch is a
  // window in which another CLI can act on a host this run just took down.
  // The record writes inside it take no CLI lock of their own.
  await withCliAttemptMutation(input.capability, contenderOptions, async () => {
    // The record, re-read under THIS lock and held to the request, FIRST -
    // before the busy gate and before the stop. `live` was read under the
    // claim lock, which this arm does not hold: another actor can commit in
    // the gap, and a changed handoff must disturb nothing and take nothing
    // over. Refusing here rather than after the gate is what makes "nothing
    // was restarted" true in the message.
    const underLock = await readHostInstallRecord(args.environment);
    if (underLock === null) throw hostNotInstalled(args.environment);
    const mismatch = installedVersionMismatch(
      requestedVersion(args),
      underLock.version,
    );
    if (mismatch !== null) throw mismatch;
    installed = underLock;
    selection.installedUnderLock = underLock;
    // ...and the RUNNING half of the same reading, under the same lock (cold
    // review B, C4). Re-reading only `install.json` here left the DEBT half
    // decided by the selector, several seconds and a different lock earlier:
    // a service-manager start that finishes in that gap - no competing
    // installer needed - left this arm gating and restarting a host that was
    // ALREADY serving the target, or parking `waiting-to-activate` over it on
    // a busy refusal. Main re-reads the whole activation state inside this
    // same lock (`591a7966a:commands/host-update.ts:1478`) and returns
    // without gate or stop when the debt has cleared; this is that read.
    const readingUnderLock = await classifyActivationAgainst(
      args.environment,
      underLock,
    );
    if (readingUnderLock.kind === "debt") {
      // The freshest "before" there is: what the host was serving at the
      // moment this arm decided to replace it.
      selection.underLockRunningVersion = readingUnderLock.runningVersion;
    }
    // MAIN's predicate, not a paraphrase of it (cold review B recheck, D2).
    // Only `debt` and `no-live-host` are this command's to act on; every
    // other reading is a no-op, and `selectDebtStart` 1,400 lines above uses
    // exactly this test with exactly this comment. The first port returned
    // early on `activated` alone and gated on `kind !== "no-live-host"`,
    // which is the same thing for the two readings the SELECTOR can produce -
    // and wrong for `foreign-runtime`, which only became reachable here when
    // C4 made the arm take its own reading under its own lock. It sent the
    // busy gate, a stop and a relaunch at a host running a developer's build.
    //
    // What this branch does NOT do is record the foreign string (recheck E1).
    // It is read under THIS lock and the operator is told under the NEXT one:
    // `restarted` is still false here, so every reading that lands in this
    // branch continues into `settleDeliveredByAnotherActor` below, which
    // re-reads the activation state under its own lock and writes the fact
    // from THAT reading. Capturing it here as well was the C1 shape in
    // miniature - a fact from lock A rendered beside a decision from lock B.
    // If the host went back to a release build in the gap, the settlement
    // answers `delivered-and-running` and says nothing, and a value written
    // here would have survived to tell the operator about a build that is no
    // longer running.
    if (
      readingUnderLock.kind !== "debt" &&
      readingUnderLock.kind !== "no-live-host"
    ) {
      return;
    }
    try {
      // A host that is GONE has no live work to protect, so the gate is not
      // asked on the `no-live-host` reading - the stop reports an absent
      // host as a forced recycle and the relaunch repairs it. The reading is
      // this arm's own, not the selector's.
      if (!args.force && readingUnderLock.kind === "debt") {
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
      restarted = true;
    } catch (err) {
      if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
        throw await parkForActivation(input, writer, err);
      }
      throw err;
    }
  });
  // The debt cleared under this arm's own lock and nothing was touched. That
  // is the already-delivered world by another route, so it settles through
  // the same closure the other three arms do - which takes its own lock, holds
  // the record to the request, and picks between completing and `superseded`
  // by what this segment is allowed to write. Doing it here rather than
  // verifying inline matters: an activation claim that never restarted has
  // written no phase from which `verifying` is legal, and the record would
  // refuse the write.
  if (!restarted) {
    return settleDeliveredByAnotherActor(
      input,
      writer,
      `host update: ${installed.version} was activated by another actor while this update ran`,
    );
  }
  // The activation arm gates on `restarted` above rather than on an
  // installer-reported start error, so it has none to carry.
  await verifyUnderClaim(input, writer, null);
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
  // A stage can be waiting BESIDE the debt: the bytes for a later version are
  // staged while this park owes the restart onto the one already installed.
  // Named the way the apply arm's park names its own (D6), and read from the
  // very read the PARK write recorded, under the same lock span the busy
  // decision was made in (#1752 round 14).
  const staged = refresh.stagedVersion;
  if (staged === null) return busy;
  return cliError({
    code: CLI_ERROR_CODES.HOST_BUSY,
    message: `${busy.message} Host ${staged} stays staged; it installs on the next update once the host is idle, or now with --force.`,
    details: { stagedVersion: staged },
    exitCode: busy.exitCode,
  });
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
  postSwapError: string | null,
): Promise<void> {
  const { args } = input;
  await writer.phaseWrite("verifying");
  const home = hostHomeDir(args.environment);
  const target = input.claim.record.targetVersion;
  const budgetMs = verifyBudgetFor(postSwapError, args.verifyBudgetMs ?? null);
  const pollMs = args.verifyPollIntervalMs ?? VERIFY_POLL_INTERVAL_MS;
  const deadline = Date.now() + budgetMs;
  let consecutiveRefusals = 0;
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
    // Every attempt, at DEBUG: the whole shape the deadline will otherwise
    // summarise into one token, so a support log has the sequence and not just
    // the last frame. No pid and no path - `runningDiagnosis` already names
    // the pid outcome as a fixed string.
    args.logger.debug("Host update verify leg observed an unhealthy host", {
      environment: args.environment,
      targetVersion: target,
      installedKind: installed.kind,
      runningKind: running.kind,
      diagnosis: verifyDiagnosisToken(observation, target),
    });
    // Q19: a host that ANSWERED and refused this client ends the leg now.
    //
    // Two consecutive refusals, not one. The messenger below this already
    // revalidates and retries a bearer once, so a single `UNAUTHORIZED` can be
    // the tail of a token rotation this run is about to win. Two readings a
    // poll apart cost 500 ms and rule that out, and nothing else can produce
    // two in a row except a host that has decided.
    //
    // The counter RESETS on any other reading, which is the whole point of
    // counting rather than latching: a host that refuses once and then goes
    // quiet is restarting, and a restart gets its budget.
    //
    // WHAT THIS DOES NOT COVER, and why not. Only a host whose `pid.json`
    // carries the start stamp ever reaches the RPC at all; an older one is
    // already `pid-start-stamp-missing` two gates up and still burns the whole
    // budget. That reading looks equally terminal - a pid record does not grow
    // a field while we poll - but it is NOT: mid-restart the path can still
    // hold the OLD host's record, which the new host is about to replace. So
    // the stamp check is exactly the transient case the budget exists for, and
    // shortening it would report a failure against a host that was seconds
    // from being healthy. The refusal is the opposite: an answer.
    consecutiveRefusals =
      observation.runningDiagnosis === "host-refuses-authenticated-rpc"
        ? consecutiveRefusals + 1
        : 0;
    const refused = consecutiveRefusals >= VERIFY_REFUSAL_STREAK_TO_STOP;
    if (refused || Date.now() >= deadline) {
      // The REASON, carried into the message rather than thrown away with the
      // observation (Linux E13). The legacy `probeHostHealth` rendered four
      // diagnoses and this leg rendered none, so a failed update said "not
      // healthy" and nothing said why - the 1.2.0 shape. It rides `message`
      // because that is the field the record's `error` already has: the
      // string the shell prints and the string `update-attempt.json` retains
      // are then the same string, with no schema change and nothing to keep
      // in step.
      const diagnosis = verifyDiagnosisToken(observation, target);
      // WHAT the operator has to fix, which is not the same question as what
      // the probe saw (Mac item 6, Q6). A refused service start and a health
      // timeout look identical in the probe - no host, no RPC - and have
      // different remedies: `host service install` versus investigating the
      // host itself. The run knew the start had errored 65 ms after the swap
      // and said nothing.
      // A refusal is REPORTED as a refusal, at every layer. Saying
      // `verify-timeout` here would be the Q11 mistake in the other direction:
      // nothing timed out - the leg stopped early precisely because the host
      // gave a definite answer - and a record that says otherwise sends the
      // operator to look for a slow host instead of a rejected client.
      //
      // The remedy names RE-ENROLMENT rather than a retry, which the lane's
      // measurement made necessary rather than nice: the rolled-back host
      // reads a different `host-id` path than the modern one, adopts an id
      // `enrollment.json` does not name, and that id PERSISTS - one on the
      // matrix box survived five intervening installs across four hours. So
      // the refusal is durable, not transient, and an operator told to try
      // again loops on it forever. `host doctor` is named because it is
      // observational; `host ensure` is NOT, and would be the wrong pointer -
      // the "registered" it converges is the OS service, not enrollment.
      const message = refused
        ? `host update: applied ${target}, and the host is up at its recorded endpoint but REFUSED this client's authenticated call, so the update could not be verified: ${observation.runningRefusal ?? diagnosis}. The bytes ARE committed at ${target}. This is an admission failure, not a slow start, and it does NOT clear by itself: the host has to be re-enrolled before any update can be verified, and every retry until then fails here in the same way. Run 'traycer host doctor' to see the host's enrollment state.`
        : postSwapError === null
          ? `host update: applied ${target} but the host did not become healthy at that version: ${diagnosis}`
          : `host update: applied ${target} but the service start failed, so the host never came up: ${postSwapError}. The bytes ARE committed at ${target}; run 'traycer host service install' and then 'traycer host service start'. (probe: ${diagnosis})`;
      await writer.fail({
        code: refused
          ? "host-refuses-rpc"
          : postSwapError === null
            ? "verify-timeout"
            : "service-start-failed",
        message,
        phase: "verifying",
      });
      throw cliError({
        code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
        message,
        details: {
          environment: args.environment,
          version: target,
          diagnosis,
          postSwapError,
          // The host's OWN words, which is the only fact here the operator
          // cannot reconstruct from the token. Null on every other path.
          refusal: observation.runningRefusal,
        },
        exitCode: 1,
      });
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  const committed = await input.complete();
  if (committed.kind !== "committed") {
    // The update WORKED. Reaching this line is only possible past the loop's
    // `break`, whose condition is the strictest in the file - installed
    // verified AT the target, running verified AT the target, host-home-bound
    // - so the host is demonstrably serving the new version right now, and
    // what failed is that we could not write down that it concluded (Q11).
    //
    // This used to fall through to the health-failure arm above: a
    // `verify-timeout` record and `E_HOST_UPDATE_HEALTH_CHECK_FAILED`. The
    // record stamp is the half that mattered - the exit code never leaves the
    // shell, but the record is mirrored onto `host.status.operation.error`,
    // and `phase: "failed"` is what renders the red card. It told the operator
    // their update failed while their host ran the new version, and it told
    // them so in the SAME record vocabulary as a genuine timeout twenty lines
    // up, so nothing downstream could tell the two apart.
    //
    // NOTHING is written here - not the record, not the marker. That is the
    // whole fix, and it generalises `supersede()`'s round-14 rule one case
    // further: never stamp `failed` over a host that is verified healthy at
    // the target. The record is LEFT where the verify loop had it, and the
    // shape it is left in - a verify-side phase, an executor that is about to
    // die, `host.status` running exactly this `targetVersion` - is itself the
    // signal a client reads as "finalizing". Stamping over it would destroy
    // the evidence rather than add to it.
    //
    // Both refusal kinds take this arm and leave disk BYTE-IDENTICAL. That is
    // deliberate, not laziness: `rejected` (the intent was refused - a fenced
    // path, a fail-closed store) and `durability-unverified` (the medium
    // itself is broken - a symlinked record path, a roundtrip mismatch) are
    // one situation to the operator, and on `durability-unverified` a
    // consolation write would travel the same broken path and fail the same
    // way. Distinguishing them on disk would only manufacture two renderings
    // of one truth.
    //
    // WHO concludes it (Q11's reconciler citation), pinned rather than
    // asserted - "Q11: the NEXT run concludes the record it could not" runs it.
    //
    // The record this arm leaves behind is `verifying`, `execution: "active"`,
    // with no live holder - which is precisely the shape recovery exists for.
    // The next run takes the recovery lock, observes bytes installed at the
    // target AND a host positively bound to this home running it, and that
    // exact pair is `decideAttemptRecovery`'s `terminalize-complete`
    // (`shared/host-update/transition.ts:385`): it bypasses the ordinary
    // `verifying -> complete` edge because it holds the same substantive proof
    // the edge would have demanded. `afterTerminalizingRecovery` then writes
    // the terminal, the selector finds nothing left to do, and the run releases
    // `recovered-complete` at exit 0 with the marker withdrawn.
    //
    // Note it is NOT the `activate` continuation, which is the plausible-
    // sounding wrong answer: `recoveryContinuation` is only consulted once the
    // installed-and-running pair has already failed to hold.
    //
    // The exit stays non-zero all the same - the attempt did not durably
    // conclude, and a script that polls the record must not read this run as
    // done - which is why it needs its own code rather than the health-check
    // one it used to borrow. Nothing timed out here and the health check is
    // the thing that had just PASSED.
    throw cliError({
      code: CLI_ERROR_CODES.HOST_UPDATE_RECORD_NOT_CONCLUDED,
      message: `host update: ${target} is installed and the host is running it. The update itself is done - only the completion write for the attempt record was refused, and the next run will conclude the record.`,
      details: {
        environment: args.environment,
        version: target,
        // HOW the write was refused. Reported for the operator and for logs;
        // both kinds take the identical path above.
        outcome: committed.kind,
      },
      exitCode: 1,
    });
  }
  await input.mirror.record(committed.record);
}

/**
 * The one token the verify leg's failure carries, chosen from a CLOSED set.
 *
 * The INSTALLED leg is tested first because it is the running leg's premise: a
 * host cannot be serving what the record does not say is placed, and reporting
 * the running symptom over an installed cause would send the reader after the
 * wrong thing. Only when the bytes are demonstrably the target does the
 * running leg's own diagnosis answer.
 *
 * Every arm returns a fixed string. Nothing read from disk and nothing the
 * host reported about itself is interpolated, so the token is always safe to
 * print, to persist in the record, and for the matrix to assert on.
 */
function verifyDiagnosisToken(
  observation: AttemptRecoveryEvidenceObservation,
  target: string,
): string {
  const { installed, running } = observation.evidence;
  if (installed.kind === "absent") return "install-record-absent";
  if (installed.kind === "unreadable") return "install-record-unreadable";
  if (installed.kind === "missing") return "install-bytes-missing";
  if (installed.version !== target) return "installed-version-mismatch";
  // The bytes are placed and they are the right ones, so everything left is
  // about the process.
  if (running.kind === "verified") {
    return running.version === target
      ? "running-not-host-home-bound"
      : "running-version-mismatch";
  }
  if (running.kind === "unbound") return "running-unbound";
  if (running.kind === "foreign") return "running-foreign";
  // `absent` and `unreadable` each collapse several causes that no DECISION
  // may branch on. The observation kept them apart for exactly this line.
  return observation.runningDiagnosis;
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
    return {
      legacy: segment.result,
      releasedReason: null,
      foreignRuntimeVersion: selection.foreignRuntimeVersion,
      // An executed arm reports through its own result; the running state is
      // the release path's question.
      runningVersion: null,
    };
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
    await clearStaleFailedMarker(
      args.logger,
      args.environment,
      selection.planActivationReading.installedVersion,
    );
  }
  const installed =
    selection.installedUnderLock ??
    (await readHostInstallRecord(args.environment));
  if (installed === null) throw hostNotInstalled(args.environment);
  // The RUNNING state, read here and nowhere earlier: this is the one exit
  // that reports on a host it did not touch, and every fact it has so far is
  // about bytes (Q5 defect 3).
  const reading = await classifyActivationAgainst(args.environment, installed);
  const runningVersion = runningVersionOf(reading);
  // Q16, the sibling aftercare to the stale-`failed` clear above and owed for
  // the same reason: a release CONCLUDED a record, and the coarse marker
  // describing that work is still saying `updating`.
  //
  // Why it is reachable at all: a run that recovers and releases never enters
  // `runArm`, so the marker mirror - whose `complete()` is what clears the
  // marker on the executed path - never runs. The record ends `complete` and
  // the marker keeps announcing an update in flight, over a host that is
  // serving the target. That is the same "a client renders a state the durable
  // truth contradicts" defect as a `failed` over a healthy host, one field
  // over, and it is the one Q11 leaves behind by design: that arm deliberately
  // writes nothing, so the marker it left is THIS path's to clear.
  //
  // Only on `recovered-complete`. A `recovered-failed` marker is not
  // contradicted by anything read here, and `nothing-to-do` is the arm above.
  if (reason === "recovered-complete" && runningVersion !== null) {
    await clearConcludedUpdatingMarker(
      args.logger,
      args.environment,
      runningVersion,
    );
  }
  // A BOUND verb that declined its work over a host that is not running has
  // not left things "as they are" - it has left an outage, and exit 0 makes
  // that reading authoritative to the dispatching host, the reconciler and
  // the GUI alike. The plain `install` verb is deliberately not held to this:
  // its own no-op arms are the up-to-date path every healthy machine takes,
  // and a stopped host is not this command's to report on when nobody asked
  // it to change one.
  if (args.intent !== null && runningVersion === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
      message: `host update: the attempt was not claimed (${reason}) and no host is running; ${installed.version} is installed but nothing is serving it`,
      details: {
        environment: args.environment,
        reason,
        installedVersion: installed.version,
        intent: args.intent,
      },
      exitCode: 1,
    });
  }
  return {
    legacy: projectNoOp(installed),
    releasedReason: reason,
    foreignRuntimeVersion: selection.foreignRuntimeVersion,
    runningVersion,
  };
}

/** The version a LIVE host is serving, or `null` when none is. */
function runningVersionOf(reading: ActivationReading): string | null {
  switch (reading.kind) {
    case "activated":
      return reading.installedVersion;
    case "debt":
      return reading.runningVersion;
    case "foreign-runtime":
      // A live host, but not one this command reasons about by version. It is
      // running, which is the question this answers.
      return reading.runningVersion;
    case "no-live-host":
    case "no-install":
      return null;
  }
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
 *   is the whole test. It carries `installedVersion` because it NAMES a
 *   record: an explicit request is held to its version on every reading that
 *   names one (`installedVersionMismatch`), and this is one of them - the
 *   record another actor committed does not become this run's to accept just
 *   because the process on top of it is a dev build;
 * - `activated`: the committed archive is what is running, carrying the
 *   record's catalog `version` so a caller can ask WHICH archive;
 * - `debt`: the record and the process disagree.
 */
type ActivationReading =
  | { readonly kind: "no-install" }
  | { readonly kind: "no-live-host"; readonly installedVersion: string }
  | {
      readonly kind: "foreign-runtime";
      readonly installedVersion: string;
      /**
       * The non-release string the live host publishes. Main's reading does
       * not carry it because main's only answer for this cell is a silent
       * no-op; the executor has to SAY what it left alone (D-51), and a
       * `runningVersion: null` in that sentence is the one thing the decision
       * ruled out.
       */
      readonly runningVersion: string;
    }
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
  return classifyActivationAgainst(environment, installed);
}

/**
 * The same reading, taken against an install record the CALLER already holds.
 *
 * Two sites need this rather than `readActivationState`: the settlement and
 * the activation arm both decide UNDER a mutation lock, and both must decide
 * against ONE record - the one they validated and will project - rather than
 * against whatever a second read finds. `readActivationState` reads the record
 * itself, so using it there would reintroduce the very gap the lock was taken
 * to close (cold review B, C1): the record can move between the read the
 * decision used and the read the projection used, and the run then reports a
 * version nobody asked for.
 *
 * The classification is byte-for-byte the one above; only the source of
 * `installed` differs, and `no-install` is excluded from the return because
 * the caller has already answered that question.
 */
async function classifyActivationAgainst(
  environment: Environment,
  installed: HostInstallRecord,
): Promise<Exclude<ActivationReading, { readonly kind: "no-install" }>> {
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
  // Catalog-version domain (a record with no runtime stamp yet): the
  // release-version policy applies. A running version that is not a release
  // version is not a host this command reasons about.
  if (!isValidHostVersion(running.version)) {
    return {
      kind: "foreign-runtime",
      installedVersion: installed.version,
      runningVersion: running.version,
    };
  }
  // A release host publishes exactly its catalog version (the build stamps
  // `src/config.ts`'s version into the binary and into the archive's
  // `version.json` alike), so a registry record's string IS what an activated
  // host of that record publishes (an own-build record from `host ensure`
  // names the CLI's version and relies on its runtime stamp, which its
  // archive always carries): identity is the STRING here as in the
  // runtime-stamp domain, and another build of the same release (`2.0.0+bar`
  // running under a `2.0.0+foo` record) is DEBT - the committed artifact is
  // not the one serving. The comparator's build-metadata-blind "equal" would
  // read it as activated, and every consumer keyed on `activated` - the debt
  // gate, `targetObservedRunning`'s withdrawal, the stale-failed clear -
  // would then treat an artifact that never ran as delivered. The comparator
  // is kept for what it is for: a record it cannot ORDER (`local-*`; the
  // running version passed the SemVer guard above) is not this command's debt
  // to collect and stays activated by policy.
  if (running.version === installed.version) {
    return { kind: "activated", installedVersion: installed.version };
  }
  const comparison = compareHostVersions(running.version, installed.version);
  if (!comparison.comparable) {
    return { kind: "activated", installedVersion: installed.version };
  }
  return {
    kind: "debt",
    installedVersion: installed.version,
    runningVersion: running.version,
  };
}

/**
 * Whether the running host has been OBSERVED serving `targetVersion`: the
 * install record names it and the live process is at the record
 * (`readActivationState` -> `activated`, with its identity verdict). Used by
 * the marker's failure arm to withhold a `failed` for a target another actor
 * has since delivered. Never throws: a reading that cannot be taken is "not
 * observed", and the stamp lands - a failure that cannot be contradicted is
 * reported, not swallowed.
 *
 * "Names it" is STRING identity of the record with the target, the grain the
 * version binding uses (`installedVersionMismatch`) and the rule the host's
 * `isStaleUpdateProgress` applies to the same marker: `2.0.0+foo` is another
 * artifact than `2.0.0+bar`, and a run for one that finds the other running
 * was not delivered - its failure stands, whatever the catalog comparator
 * (build-metadata-blind, and right for ORDERING) would call equal. Another
 * actor delivering the same registry artifact writes the same string, so a
 * real match is never defeated. The activation reading above it keeps the
 * comparator for its own question: running-vs-record is a runtime-stamp
 * question, record-vs-target is an artifact one.
 */
/**
 * The record error codes whose marker stamp is UNCONDITIONAL.
 *
 * A set with a name, rather than a disjunction of literals, because of how the
 * second member got here. Q6 split `service-start-failed` out of
 * `verify-timeout` to say WHY a host never came back, and the split silently
 * changed behaviour: this predicate keyed on the one literal, so the new code
 * would have become suppressible by the observed-running check - the very
 * `pid.json` reading the caller's comment explains is not evidence of health.
 * The ablation for that extension came back GREEN; nothing pinned it.
 *
 * Membership is the shared property, not the spelling: **the bytes are
 * committed and the host did not come back**. Such a failure is disturbed by
 * construction, so the observed-running suppressions below it - which read a
 * `pid.json` that a host up but not yet answering already fills in AT the
 * target - would withhold the only signal a 1.2.x host ever shows for a failed
 * update. A third code of that class belongs here; adding one elsewhere and
 * forgetting this line is the trap the name exists to make visible.
 */
const UNCONDITIONALLY_STAMPED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "verify-timeout",
  "service-start-failed",
  // Q19, and the third code the docblock above predicted. It has the class's
  // property exactly: the bytes are committed and the host did not come back
  // USABLE. The suppression this membership defeats would be at its most wrong
  // here, because a host that refuses the CLI's authenticated call is very
  // likely serving `pid.json` at the target - so the observed-running check
  // would read "healthy", withhold the stamp, and leave the operator with a
  // machine nothing can update and no signal saying so.
  "host-refuses-rpc",
]);

function isUnconditionallyStampedFailure(
  error: HostUpdateAttemptRecord["error"],
): boolean {
  return (
    error !== null && UNCONDITIONALLY_STAMPED_FAILURE_CODES.has(error.code)
  );
}

async function targetObservedRunning(
  environment: Environment,
  targetVersion: string,
): Promise<boolean> {
  try {
    const reading = await readActivationState(environment);
    return (
      reading.kind === "activated" && reading.installedVersion === targetVersion
    );
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
  /**
   * Whether this run has begun to disturb the host - the actuator-reported
   * boundary, never inferred from a phase label. Read by `writeFailure` to
   * choose the terminal: only a PRE-disruption refusal can be a superseded
   * request. The mirror owns the flag because it is the same fact its own
   * restore/withdraw rules turn on, and one owner beats two that can drift.
   */
  readonly disturbed: boolean;
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
    displaced !== null && updateProgressRecordHasProvenLiveWriter(displaced)
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
            // PROVEN live, not the fail-open reading (#1752 rounds 12-14).
            // Retention is what authorises RE-PLANTING this record over an
            // empty path later, and the fail-open answer is wrong for that: a
            // record with no writer id is one the host daemon renders
            // FOREVER (its dead-writer suppression needs a pid to check), and
            // one whose liveness probe merely failed belongs to a writer who
            // re-asserts its own marker under the lock anyway.
            const writerLive = updateProgressRecordHasProvenLiveWriter(onDisk);
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

  /**
   * The attempt's target was outgrown by another actor's newer install
   * (D-46). The marker follows main's round-14 rule verbatim: this run's own
   * record is WITHDRAWN by conditional delete and nothing is created. Not a
   * `failed`: neither stale-failed rule - this file's `clearStaleFailedMarker`
   * or the host's `isStaleUpdateProgress` - clears a `failed` whose target is
   * not the running version, so one stamped here would render "Update to X
   * failed" in red over a host serving Y until some later update happened to
   * do work.
   *
   * A LIVE writer's record this run took over is put BACK instead, exactly as
   * a park does and for the same reason: this run did no disruptive work, so
   * that writer's `updating` is what the path should hold. `disturbed` is not
   * consulted - `writeFailure` already refused to route a post-disruption
   * error here.
   */
  async function supersededByAnotherActor(): Promise<void> {
    if (own === null) return;
    const restoreTo = liveDisplacedRecord();
    if (restoreTo !== null) {
      const restored = await replaceUpdateProgressMarkerIfUnchanged(
        environment,
        own,
        restoreTo,
      );
      logConditionalMarkerOutcome(logger, environment, {
        outcome: restored,
        done: "Host update was superseded - a newer host than the target it announced is installed; the progress marker it took over was restored to its previous writer",
        moved:
          "Host update was superseded - a newer host than the target it announced is installed; the progress marker it took over was not restored - another updater owns it now",
        gone: "Host update was superseded - a newer host than the target it announced is installed; the progress marker it took over was not restored - the path is empty",
        failed:
          "Host update was superseded - a newer host than the target it announced is installed; the progress marker it took over could not be restored and stays until the next update supersedes it",
      });
      return;
    }
    const withdrawn = await deleteUpdateProgressMarkerIfUnchanged(
      environment,
      own,
    );
    logConditionalMarkerOutcome(logger, environment, {
      outcome: withdrawn,
      done: "Host update was superseded - a newer host than the target it announced is installed; nothing was wrong and the progress marker was withdrawn",
      moved:
        "Host update was superseded - a newer host than the target it announced is installed; the progress marker was left in place - another updater owns it now",
      gone: "Host update was superseded - a newer host than the target it announced is installed; found no progress marker to withdraw",
      failed:
        "Host update was superseded - a newer host than the target it announced is installed; its progress marker could not be withdrawn and stays until the next update supersedes it",
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
    // Nothing routes a Q11 completion-write refusal here, and that is by
    // construction rather than by luck: that arm writes no terminal record at
    // all, so no `failed` phase ever reaches this mirror to be stamped. The
    // marker's vocabulary is `updating` / `failed` / absent and it has no word
    // for "the update worked but our paperwork did not" - which is exactly why
    // the refusal arm declines to say anything here instead of picking the
    // least wrong word.
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
    const unconditional = isUnconditionallyStampedFailure(record.error);
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
    get disturbed(): boolean {
      return disturbed;
    },
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
            await supersededByAnotherActor();
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
 *
 * "Contradicts" is the rule the host's `isStaleUpdateProgress` applies to the
 * same marker: a `failed` is stale when the version it NAMES is the one now
 * running - STRING identity, the artifact grain (see `targetObservedRunning`).
 * A `failed` for another target is not contradicted by this reading and is
 * left alone; it may still be exactly true. `observedInstalledVersion` is the
 * INSTALL RECORD the `activated` reading named, never the runtime stamp: the
 * host compares against the runtime version it publishes, and a staging host's
 * `staging.<epoch>.<sha>` would never match a catalog target here.
 */
async function clearStaleFailedMarker(
  logger: ILogger,
  environment: Environment,
  observedInstalledVersion: string,
): Promise<void> {
  const marker = await readUpdateProgressMarker(environment);
  if (marker === null || marker.state !== "failed") return;
  if (marker.targetVersion !== observedInstalledVersion) {
    logger.info(
      "Host update left the failed progress marker alone - it names a target the running host has not been observed at",
      {
        environment,
        failedTargetVersion: marker.targetVersion,
        observedInstalledVersion,
      },
    );
    return;
  }
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

/**
 * Remove an `updating` progress marker for work that has demonstrably
 * CONCLUDED (Q16).
 *
 * The executed path clears its own marker through the mirror's `complete()`.
 * The recovery path has no mirror to run: it terminalizes the interrupted
 * record and releases before `runArm` is ever entered, so the marker the
 * INTERRUPTED run published outlives the record it described. Left alone it is
 * rendered forever - the coarse marker carries no liveness, and the host
 * daemon's dead-writer suppression needs a pid a marker may not carry - which
 * is a Desktop card reading "updating" beside a record that says `complete`.
 *
 * Three conditions, each of which is a way of being wrong if dropped:
 *
 *  - the marker is `updating`. A `failed` is the sibling function's business
 *    and answers to a different rule;
 *  - it names the version now RUNNING. That is what makes it concluded rather
 *    than in flight, and it is the same string-identity test at the same
 *    artifact grain the stale-`failed` clear uses;
 *  - no writer is PROVEN live on it. The CAS below proves only that the bytes
 *    did not change between the read and the delete, never whose live work
 *    they are, so a third updater that republished this exact target still
 *    owns its marker and the version test alone would erase it.
 *
 * That third condition is the WEAKER of the two liveness predicates in
 * `update-progress-marker.ts`, deliberately - cold review B corrected an
 * earlier version of this comment that claimed the opposite, and the claim is
 * worth stating right because it reads backwards. `writerLiveness` answers
 * `unknown` for a null writer id, an unparseable one, or a failed probe, and
 * `hasProvenLiveWriter` is `=== "live"`, so **unknown ⇒ delete**.
 * `!updateProgressRecordHasLiveWriter` is the strict predicate; this is not
 * it. Nor is it a contrast with the takeover, which uses this same reading
 * (`liveDisplacedRecord`) for the same directional effect.
 *
 * What makes the weaker reading safe here is the VERSION test above it, not a
 * risk appetite. The only marker this can delete is one naming the version the
 * host is observed RUNNING, so a live third updater holding it is by
 * construction working toward a version already being served: it takes the
 * lock next and finds nothing to do. The "blind update" the strict predicate
 * would protect is one that was going to conclude as redundant anyway.
 */
async function clearConcludedUpdatingMarker(
  logger: ILogger,
  environment: Environment,
  observedRunningVersion: string,
): Promise<void> {
  const marker = await readUpdateProgressMarker(environment);
  if (marker === null || marker.state !== "updating") return;
  if (marker.targetVersion !== observedRunningVersion) {
    logger.info(
      "Host update left the updating progress marker alone - it names a target the running host has not been observed at",
      {
        environment,
        markerTargetVersion: marker.targetVersion,
        observedRunningVersion,
      },
    );
    return;
  }
  if (updateProgressRecordHasProvenLiveWriter(marker)) {
    logger.info(
      "Host update left the updating progress marker alone - another updater is proven to be acting on it",
      { environment, markerTargetVersion: marker.targetVersion },
    );
    return;
  }
  const outcome = await deleteUpdateProgressMarkerIfUnchanged(
    environment,
    marker,
  );
  if (outcome === "cleared") {
    logger.info(
      "Host update cleared the progress marker for an update it concluded on the recovery path",
      { environment, targetVersion: marker.targetVersion },
    );
  } else if (outcome === "failed") {
    logger.info(
      "Host update left the progress marker alone - the concluded-update clear could not be written",
      { environment, outcome },
    );
  } else {
    logger.info(
      "Host update left the progress marker alone - it changed under the concluded-update check",
      { environment, outcome },
    );
  }
}
