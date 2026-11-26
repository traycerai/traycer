import { stagedSandboxName } from "@/lib/sandboxes/staged-sandbox-name";
import { v4 as uuidv4 } from "uuid";
import { startPendingSandboxWake } from "@/lib/sandboxes/sandbox-wake";
import { stageProviderForShape } from "@/lib/sandboxes/sandbox-stage-model";
import { sandboxReadinessContext } from "@/lib/sandboxes/sandbox-readiness";
import {
  MutationObserver as QueryMutationObserver,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  SandboxControlFailure,
  SandboxWakeOutcome,
  SandboxCreateFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
  type SandboxCreateRequest,
  type SandboxListResponse,
  type SandboxSummary,
  type SandboxVerbGesture,
} from "@traycer/protocol/host/sandbox-control";
import {
  pendingSandboxStageRunAllowed,
  holdPendingSandboxStageObservation,
  pendingSandboxStageObservation,
  recordPendingSandboxStageCreated,
  markPendingSandboxStageRowSeen,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { sandboxCreateFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  sandboxRetryAfterRefusal,
  sandboxRetryCreate,
} from "@/lib/sandboxes/sandbox-create-key";
import {
  sandboxListQueryOptions,
  sandboxListReadSentAt,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { teamEnvironmentQueryOptions } from "@/hooks/sandboxes/use-team-environment-query";
import { sandboxCatalogueQueryOptions } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import type { AuthService } from "@/lib/auth/auth-service";
import type { HostDirectoryService } from "@/lib/host";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityEffectSource,
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";
import {
  claimDraftAuthorityEffect,
  readDraftAuthorityRestoredIssue,
  settleDraftAuthorityEffect,
  type DraftAuthorityEffectIntent,
  type DraftAuthorityIssueReceipt,
  type DraftAuthorityRestoredPredecessor,
  type DraftAuthorityRestoredTerminalHandoff,
  type DraftAuthoritySetupAttempt,
} from "@/lib/drafts/draft-authority-pending";
import {
  returnedSandboxWithCreate,
  updateReturnedSandboxRestore,
  type StoredReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import {
  claimPendingSandboxOutboxEffect,
  settlePendingSandboxOutboxEffect,
  verifyPendingSandboxOutboxGrant,
} from "@/lib/sandboxes/pending-sandbox-authority";
import {
  sandboxSettingsFailed,
  sandboxSettingsReady,
  sandboxSettingsSteps,
} from "@traycer/protocol/host/sandbox-settings";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  cancelSandboxWakeReads,
  knownSandboxRowCurrent,
  knownSandboxRowQueryOptions,
  readSandboxRetryCreate,
  sandboxListObservationId,
  sandboxRowDestroySettled,
} from "@/lib/sandboxes/sandbox-row-read";
import type { PendingSandboxObservation } from "@/lib/sandboxes/pending-sandbox-observation";
import { pendingStageAttemptCurrent } from "@/lib/sandboxes/pending-stage-storage";
import {
  handoffOwnerLive,
  PENDING_SEND_SURFACE_PREFIX,
  readStagedSandbox,
  saveStagedCreateRequest,
  stagedCreateAttemptKey,
  STAGED_SANDBOX_READY_WITNESS,
  useStagedSandboxStore,
  type RestoredSandboxReadyWitness,
  type StagedSandbox,
  type StagedSandboxFailure,
  type StagedSandboxStep,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

/**
 * The create's budget: the server's create forward is 300 s, so the wait
 * outlasts it. A wake's own budget is the wake's (`sandbox-wake.ts`); this one
 * then covers the settle that follows it.
 */
export const STAGED_CREATE_BUDGET_MS = 360_000;
/** Past this the line reads "taking longer than usual". */
export const STAGED_TAKING_LONGER_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
/** An optional quote must not hold up the create if its shared read stalls. */
const CATALOGUE_PREFLIGHT_BUDGET_MS = 2_000;

export interface StagedSandboxRunDeps {
  readonly readSettings: (
    hostId: string,
  ) => Promise<EnvironmentStatusResponseV11 | "unsupported" | null>;
  readonly auth: AuthService;
  readonly directory: HostDirectoryService;
  /**
   * The run's requests go through it: the list and the team's environment as
   * the queries every surface reads, the create as a keyed mutation, so the
   * cache sees each answer and the lists refresh when the create settles.
   */
  readonly queryClient: QueryClient;
  /** The account signed in, which the list and environment keys carry. */
  readonly userId: string | null;
  /**
   * Wakes a resting sandbox, joining a wake already in flight
   * (`startSandboxWake`); resolves `true` once it is awake.
   */
  readonly wake: (
    hostId: string,
    gesture: SandboxVerbGesture,
  ) => Promise<boolean | SandboxWakeOutcome | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

interface RestoredStageAuthority {
  readonly actor: DraftAuthorityActor;
  readonly source: Extract<DraftAuthorityEffectSource, { kind: "restored-draft" }>;
  readonly stored: StoredReturnedSandbox;
}

interface StagedRunIdentity {
  readonly surfaceKey: string;
  readonly clientRequestId: string;
  readonly createKey: string;
  readonly attemptId: string | undefined;
  readonly attemptRetryId: string | undefined;
  readonly actor: DraftAuthorityActor;
  readonly userId: string;
  readonly restoredDraftAuthority: RestoredStageAuthority | undefined;
  readonly onStorageRefused: (() => void) | undefined;
  readonly restoredProgress: {
    version: DraftAuthorityVersion;
    receipt: DraftAuthorityIssueReceipt | null;
  } | null;
  readonly retryRefusedCreate: boolean;
}

/** A repeat joins its attempt, and a newer attempt supersedes an old run. */
const running = new Map<string, StagedRunIdentity>();

function stageMatchesRun(
  stage: StagedSandbox,
  run: StagedRunIdentity,
): boolean {
  return (
    stage.clientRequestId === run.clientRequestId &&
    stage.attemptId === run.attemptId &&
    stage.attemptRetryId === run.attemptRetryId &&
    stagedCreateAttemptKey(stage) === run.createKey
  );
}

function pendingStageMatchesStorage(
  surfaceKey: string,
  stage: StagedSandbox,
): boolean {
  return (
    !surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX) ||
    pendingStageAttemptCurrent(
      surfaceKey,
      stage.clientRequestId,
      stagedCreateAttemptKey(stage),
      stage.attemptId,
    )
  );
}

/** Whether a run in this window is driving the surface's stage. */
export function stagedRunActive(surfaceKey: string): boolean {
  const run = running.get(surfaceKey);
  const stage = readStagedSandbox(surfaceKey);
  return (
    run !== undefined &&
    draftAuthorityActorIsCurrent(run.actor) &&
    (stage === null || stageMatchesRun(stage, run))
  );
}

/**
 * Creates or wakes the staged sandbox and waits until it is awake, its
 * settings applied (`guestConfigured !== false`) and its host connected.
 * Then it pins the surface and moves the stage to `handoff`: a pending send's
 * task driver delivers it, or a composer-owned action resubmits there.
 *
 * Owned by the store, not by a component: the composer may unmount, and the
 * stage and the draft outlive it. A re-drive repeats the last create key;
 * an explicit Retry can name the failed row it answers.
 */
export async function runStagedSandbox(
  surfaceKey: string,
  request: StagedRunRequest,
  deps: StagedSandboxRunDeps,
): Promise<void> {
  const restoredDraftAuthority = surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)
    ? undefined
    : request.restoredDraftAuthority;
  const actor = restoredDraftAuthority?.actor ?? captureDraftAuthorityActor();
  const stage = readStagedSandbox(surfaceKey);
  if (
    actor === null ||
    actor.accountId !== deps.userId ||
    !draftAuthorityActorIsCurrent(actor) ||
    stage === null ||
    (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX) &&
      stage.returnedDraft !== undefined &&
      (restoredDraftAuthority === undefined ||
        restoredDraftAuthority.source.returnAccountId !== actor.accountId ||
        restoredDraftAuthority.stored.userId !== actor.accountId)) ||
    stage.phase === "handoff" ||
    !pendingStageMatchesStorage(surfaceKey, stage) ||
    !pendingSandboxStageRunAllowed(surfaceKey)
  )
    return;
  if (stagedRunActive(surfaceKey)) {
    // The run this key drives is still on its way: a repeat joins it, and a
    // send after Cancel takes it up again (it is current once more), rather
    // than a second run racing it on the same key. Its step and times stay
    // as that run left them.
    if (stage.phase !== "creating") {
      useStagedSandboxStore.getState().rejoin(surfaceKey);
    }
    return;
  }
  const clientRequestId = useStagedSandboxStore
    .getState()
    .begin(surfaceKey, deps.now(), request);
  if (clientRequestId === null) return;
  const active = readStagedSandbox(surfaceKey);
  if (active?.clientRequestId !== clientRequestId) return;
  const attempt: StagedRunIdentity = {
    surfaceKey,
    clientRequestId,
    createKey: active.lastCreateKey ?? clientRequestId,
    attemptId: active.attemptId,
    attemptRetryId: active.attemptRetryId,
    actor,
    userId: actor.accountId,
    restoredDraftAuthority,
    onStorageRefused: request.resume ? undefined : request.onStorageRefused,
    restoredProgress: restoredDraftAuthority === undefined
      ? null
      : { version: restoredDraftAuthority.source.draft, receipt: null },
    retryRefusedCreate:
      (request.retryRequestId !== undefined || !request.resume) &&
      (stage.failure?.rowlessCreateRefusal !== undefined ||
        stage.failure?.kind === "refused"),
  };
  running.set(surfaceKey, attempt);
  try {
    let retryCreate = active.lastRetryCreate;
    const retryRow = active.createRetryRow;
    if (retryRow !== undefined && retryCreate === undefined) {
      const resolved = await readSandboxRetryCreate(
        deps.auth,
        retryRow.sandboxId,
        attempt.userId,
      );
      if (!stillCurrent(attempt)) return;
      if (resolved === null) {
        fail(surfaceKey, retryRow.failure);
        return;
      }
      retryCreate = resolved;
    }
    const restored = await restoreAcceptedStageSetup(attempt, deps);
    if (!stillCurrent(attempt)) return;
    await drivePreparedRun(
      {
        ...request,
        ...attempt,
        retryCreate,
      },
      stage,
      restored ?? sandboxAlreadyMade(active, request.resume),
      deps,
    );
  } finally {
    if (running.get(surfaceKey) === attempt) running.delete(surfaceKey);
  }
}

/** The preflight and the accepted run share one resolved environment and attempt budget. */
async function drivePreparedRun(
  run: Omit<StagedRun, "environmentId">,
  stage: StagedSandbox,
  made: StartedSandbox | null,
  deps: StagedSandboxRunDeps,
): Promise<void> {
  const { surfaceKey, clientRequestId } = run;
  const prepared = await prepareRun(run, stage, made, deps);
  if (!stillCurrent(run)) return;
  if (prepared === null) {
    fail(surfaceKey, { kind: "unavailable" });
    return;
  }
  const started = await startStagedRun(
    {
      surfaceKey,
      clientRequestId,
      resume: run.resume,
      createKey: run.createKey,
      attemptId: run.attemptId,
      attemptRetryId: run.attemptRetryId,
      actor: run.actor,
      userId: run.userId,
      restoredDraftAuthority: run.restoredDraftAuthority,
      onStorageRefused: run.onStorageRefused,
      restoredProgress: run.restoredProgress,
      retryRefusedCreate: run.retryRefusedCreate,
      retryCreate: run.retryCreate,
      taskId: run.taskId,
      environmentId: prepared.environmentId,
    },
    stage,
    made,
    deps,
  );
  if (started === null || !stillCurrent(run)) return;
  let budgetFrom = prepared.startedAt;
  if (
    stage.target.kind === "new" &&
    stage.failure?.kind === "failed" &&
    stage.failure.code === "wake"
  ) {
    budgetFrom = deps.now();
    useStagedSandboxStore.getState().report(surfaceKey, {
      createAttempt: { budgetMs: prepared.budgetMs, startedAt: budgetFrom },
    });
  }
  await settle(
    { ...run, started, deps },
    stage.target.kind === "existing" ? deps.now() : budgetFrom,
    prepared.budgetMs,
  );
}

interface PreparedCreate {
  readonly environmentId: string | null;
  readonly budgetMs: number;
}

interface PreparedRun extends PreparedCreate {
  readonly startedAt: number;
}

async function prepareRun(
  run: Omit<StagedRun, "environmentId">,
  stage: StagedSandbox,
  made: StartedSandbox | null,
  deps: StagedSandboxRunDeps,
): Promise<PreparedRun | null> {
  if (stage.target.kind === "existing") {
    return {
      environmentId: null,
      budgetMs: STAGED_CREATE_BUDGET_MS,
      startedAt: deps.now(),
    };
  }
  const attempt = readStagedSandbox(run.surfaceKey)?.createAttempt ?? null;
  const prepared =
    made === null
      ? await prepareCreate(stage.target, deps, attempt?.budgetMs ?? null, run)
      : {
          environmentId: null,
          budgetMs: attempt?.budgetMs ?? STAGED_CREATE_BUDGET_MS,
        };
  if (prepared === null || !stillCurrent(run)) return null;
  const startedAt = run.resume
    ? (attempt?.startedAt ?? stage.startedAt ?? deps.now())
    : deps.now();
  useStagedSandboxStore.getState().report(run.surfaceKey, {
    createAttempt: { budgetMs: prepared.budgetMs, startedAt },
  });
  return { ...prepared, startedAt };
}

async function prepareCreate(
  target: Extract<StagedSandboxTarget, { kind: "new" }>,
  deps: StagedSandboxRunDeps,
  retainedBudgetMs: number | null,
  run: Omit<StagedRun, "environmentId">,
): Promise<PreparedCreate | null> {
  const { retryCreate } = run;
  const environmentId =
    retryCreate === undefined
      ? await environmentIdFor(target, deps)
      : retryCreate.environmentId;
  if (environmentId === undefined) return null;
  if (!stillCurrent(run)) return null;
  if (retainedBudgetMs !== null)
    return { environmentId, budgetMs: retainedBudgetMs };
  if (retryCreate?.region === null)
    return { environmentId, budgetMs: STAGED_CREATE_BUDGET_MS };
  const shape =
    retryCreate?.region === undefined
      ? target.shape
      : { ...retryCreate, region: retryCreate.region };
  let timer: number | null = null;
  const catalogue = await Promise.race([
    deps.queryClient.fetchQuery(
      sandboxCatalogueQueryOptions(
        deps.auth,
        deps.userId,
        true,
        sandboxReadinessContext(environmentId, shape),
      ),
    ),
    new Promise<null>((resolve) => {
      timer = window.setTimeout(
        () => resolve(null),
        CATALOGUE_PREFLIGHT_BUDGET_MS,
      );
    }),
  ])
    .catch(() => null)
    .finally(() => {
      if (timer !== null) window.clearTimeout(timer);
    });
  const entry =
    catalogue === null ? null : stageProviderForShape(catalogue, shape);
  return {
    environmentId,
    budgetMs: Math.max(STAGED_CREATE_BUDGET_MS, entry?.createBudgetMs ?? 0),
  };
}

/**
 * Uses the row already recorded for this attempt. Beginning a retry under
 * a different key clears that row. A resumed wake reads the existing row
 * without issuing a new wake.
 */
function sandboxAlreadyMade(
  stage: StagedSandbox,
  resume: boolean,
): StartedSandbox | null {
  if (
    (stage.target.kind !== "new" && !resume) ||
    stage.createdSandboxId === null ||
    stage.createdHostId === null
  ) {
    return null;
  }
  return { sandboxId: stage.createdSandboxId, hostId: stage.createdHostId };
}

interface StartedSandbox {
  readonly sandboxId: string;
  readonly hostId: string;
}

/** The original action survives a retry or reload with the stage. */
function stagedWakeGesture(stage: StagedSandbox): SandboxVerbGesture {
  return stage.openTerminal || stage.terminalLaunch !== null
    ? "open-terminal"
    : "send";
}

function stagePendingSend(surfaceKey: string) {
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) return null;
  const id = surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length);
  return usePendingSandboxSendStore.getState().sends[id] ?? null;
}

async function claimRestoredStageEffect(
  run: StagedRunIdentity,
  effect: DraftAuthorityEffectIntent,
  checkpoint: StoredReturnedSandbox | undefined,
  initialSetupAttempt: DraftAuthoritySetupAttempt | undefined,
  wake: { readonly target: StartedSandbox; readonly deps: StagedSandboxRunDeps } | undefined,
): Promise<DraftAuthorityIssueReceipt | null> {
  const capture = run.restoredDraftAuthority;
  if (capture === undefined || !stillCurrent(run)) return null;
  const { actor } = capture;
  const source = {
    ...capture.source,
    draft: run.restoredProgress?.version ?? capture.source.draft,
  };
  const prior = await readDraftAuthorityRestoredIssue({ actor, draft: source.draft });
  if (!stillCurrent(run) || (prior.kind !== "current" && prior.kind !== "missing"))
    return null;
  let operationId = `restored:${source.draft.occurrence}:${effect.kind}:${effect.identity}`;
  let expectedIssueGeneration: number | null = null;
  let recovery: "initial" | "exact-replay" | "explicit-retry" = "initial";
  let frozenSource: DraftAuthorityEffectSource = source;
  let setupAttempt = initialSetupAttempt;
  let restoredPredecessor: DraftAuthorityRestoredPredecessor | undefined;
  const isSuccessorCurrent = (): boolean => {
    if (wake === undefined || !stillCurrent(run)) return false;
    const stage = readStagedSandbox(run.surfaceKey);
    return stage?.createdSandboxId === wake.target.sandboxId &&
      stage.createdHostId === wake.target.hostId;
  };
  if (
    wake !== undefined &&
    effect.kind === "wake" &&
    prior.kind === "current" &&
    prior.issue.receipt.effect.kind === "create" &&
    prior.issue.state === "accepted"
  ) {
    const { receipt, acceptance } = prior.issue;
    if (
      acceptance?.hostId !== wake.target.hostId ||
      acceptance.sandboxId !== wake.target.sandboxId ||
      !isSuccessorCurrent()
    )
      return null;
    const witness = await readRestoredWakePredecessor(receipt, wake.target, wake.deps);
    if (witness === null || !isSuccessorCurrent()) return null;
    restoredPredecessor = witness;
    setupAttempt = {
      attemptId: witness.attemptId,
      observationGeneration: witness.observationGeneration,
    };
  } else if (prior.kind === "current" && prior.issue.receipt.effect.identity === effect.identity) {
    const { receipt, state } = prior.issue;
    if (
      effect.kind !== "create" ||
      JSON.stringify(receipt.effect) !== JSON.stringify(effect) ||
      state === "accepted" ||
      state === "terminal"
    )
      return null;
    if (state === "issuing") {
      if (receipt.sessionGeneration === actor.sessionGeneration) return null;
      if (!(await settlePendingSandboxOutboxEffect(actor, receipt, "uncertain")))
        return null;
    }
    if (state === "refused" && !run.retryRefusedCreate) return null;
    operationId = receipt.operationId;
    expectedIssueGeneration = receipt.issueGeneration;
    frozenSource = receipt.source;
    recovery = state === "refused" ? "explicit-retry" : "exact-replay";
    setupAttempt = receipt.setupAttempt ??
      (recovery === "exact-replay" ? undefined : initialSetupAttempt);
  }
  if (!stillCurrent(run)) return null;
  const result = await claimDraftAuthorityEffect({
    actor,
    source: frozenSource,
    operationId,
    effect,
    expectedIssueGeneration,
    recovery,
    ...(checkpoint !== undefined && recovery === "initial" ? { checkpoint } : {}),
    ...(setupAttempt === undefined ? {} : { setupAttempt }),
    ...(restoredPredecessor === undefined
      ? {}
      : { restoredPredecessor, isSuccessorCurrent }),
  });
  if (result.kind !== "committed") {
    if (
      result.kind === "unavailable" &&
      recovery !== "exact-replay" &&
      stillCurrent(run)
    )
      run.onStorageRefused?.();
    return null;
  }
  if (
    await verifyPendingSandboxOutboxGrant(actor, result.receipt) &&
    stillCurrent(run) &&
    (restoredPredecessor === undefined || isSuccessorCurrent())
  ) {
    const progress = run.restoredProgress;
    if (progress !== null) {
      progress.version = result.receipt.checkpointVersion ?? progress.version;
      progress.receipt = result.receipt;
    }
    return result.receipt;
  }
  await settlePendingSandboxOutboxEffect(actor, result.receipt, "uncertain");
  return null;
}

async function readRestoredWakePredecessor(
  claim: DraftAuthorityIssueReceipt,
  target: StartedSandbox,
  deps: StagedSandboxRunDeps,
): Promise<DraftAuthorityRestoredPredecessor | null> {
  const binding = claim.setupAttempt;
  if (binding === undefined) return null;
  const observationGeneration = deps.now();
  if (observationGeneration <= binding.observationGeneration) return null;
  const read = await deps.auth.getSandbox(target.sandboxId);
  if (read.kind !== "ok") return null;
  const { sandbox } = read;
  if (
    sandbox.id !== target.sandboxId ||
    sandbox.hostId !== target.hostId ||
    (sandbox.state !== "stopped" && sandbox.state !== "suspended")
  )
    return null;
  return {
    kind: "signed-rest",
    claim,
    ...target,
    attemptId: binding.attemptId,
    observationGeneration,
    proofId: JSON.stringify([
      "restored-wake", sandbox.hostId, sandbox.id, sandbox.state, observationGeneration,
    ]),
  };
}

async function restoreAcceptedStageSetup(
  run: StagedRunIdentity,
  deps: StagedSandboxRunDeps,
): Promise<StartedSandbox | null> {
  const capture = run.restoredDraftAuthority;
  if (capture === undefined) return null;
  const read = await readDraftAuthorityRestoredIssue({
    actor: capture.actor,
    draft: capture.source.draft,
  });
  if (
    !stillCurrent(run) ||
    read.kind !== "current" ||
    read.issue.state !== "accepted" ||
    read.issue.acceptance === null
  )
    return null;
  const { receipt, acceptance } = read.issue;
  const hasSameCreate =
    receipt.effect.kind === "create"
      ? receipt.effect.identity === run.createKey
      : receipt.effect.kind === "wake" &&
        receipt.restoredPredecessor?.createKey === run.createKey;
  if (!hasSameCreate) return null;
  const stage = readStagedSandbox(run.surfaceKey);
  if (
    stage?.target.kind === "existing" &&
    (stage.target.sandboxId !== acceptance.sandboxId ||
      stage.target.hostId !== acceptance.hostId)
  )
    return null;
  const { sandboxId } = acceptance;
  let hostId = acceptance.hostId;
  if (hostId === null) {
    const row = await deps.auth.getSandbox(sandboxId);
    if (!stillCurrent(run) || row.kind !== "ok" || row.sandbox.id !== sandboxId)
      return null;
    hostId = row.sandbox.hostId;
    const refined = await settleDraftAuthorityEffect({
      actor: run.actor,
      claim: read.issue.receipt,
      outcome: "accepted",
      acceptance: { sandboxId, hostId },
    });
    if (
      (refined.kind !== "committed" && refined.kind !== "replayed") ||
      !stillCurrent(run)
    )
      return null;
  }
  if (run.restoredProgress !== null)
    run.restoredProgress.receipt = receipt;
  useStagedSandboxStore.getState().report(run.surfaceKey, {
    createdSandboxId: sandboxId,
    createdHostId: hostId,
  });
  return { sandboxId, hostId };
}

/** Reports a wake only for the current run, preserving its original action. */
async function wakeCurrentStage(
  run: StagedRunIdentity,
  started: StartedSandbox,
  deps: StagedSandboxRunDeps,
): Promise<boolean> {
  const { surfaceKey, attemptId, attemptRetryId } = run;
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null || !stillCurrent(run)) return false;
  report(surfaceKey, "booting", deps.now());
  const observationId = uuidv4();
  const boundary = holdPendingSandboxStageObservation(
    surfaceKey,
    attemptId,
    attemptRetryId,
    observationId,
  );
  if (boundary === null || !stillCurrent(run)) return false;
  const gesture = stagedWakeGesture(stage);
  const send = stagePendingSend(surfaceKey);
  let claim: DraftAuthorityIssueReceipt | null = null;
  if (send !== null) {
    claim = await claimPendingSandboxOutboxEffect({
      actor: run.actor,
      send,
      operationId: `${send.id}:${run.attemptId ?? run.createKey}:setup-wake`,
      effect: {
        kind: "wake",
        phase: "setup",
        identity: started.sandboxId,
        payload: { ...started, gesture },
      },
      setupAttempt: attemptId === undefined
        ? undefined
        : { attemptId, observationGeneration: boundary },
      canIssue: () => stillCurrent(run),
    });
    if (claim === null || !stillCurrent(run)) return false;
    if (claim.setupAttempt !== undefined)
      useStagedSandboxStore.getState().report(surfaceKey, {
        authoritySetupAttempt: claim.setupAttempt,
      });
  } else if (run.restoredDraftAuthority !== undefined) {
    claim = await claimRestoredStageEffect(
      run,
      {
        kind: "wake",
        phase: "setup",
        identity: `${started.sandboxId}:${run.attemptId ?? run.createKey}`,
        payload: { ...started, gesture },
      },
      undefined,
      attemptId === undefined
        ? undefined
        : { attemptId, observationGeneration: deps.now() },
      { target: started, deps },
    );
    if (claim === null) return false;
  }
  if (!stillCurrent(run)) return false;
  const issuedClaim = claim;
  const answered =
    issuedClaim === null
      ? await deps.wake(started.hostId, gesture)
      : await startPendingSandboxWake(
          deps.queryClient,
          { auth: deps.auth, directory: deps.directory },
          started.hostId,
          gesture,
          {
            sandboxId: started.sandboxId,
            verify: () => verifyPendingSandboxOutboxGrant(run.actor, issuedClaim),
            isCurrent: () => stillCurrent(run),
          },
        );
  if (!stillCurrent(run)) return false;
  const awake =
    answered === true ||
    (typeof answered === "object" && answered?.kind === "awake");
  const observed = pendingSandboxStageObservation(
    surfaceKey,
    awake ? "awake" : "waking",
    {
      kind: "wake-result",
      requestedAt: boundary,
      observationId,
    },
  );
  // A newer request owns settlement. Supersession is not a failed wake.
  if (observed === "unknown") return false;
  if (claim !== null) {
    let outcome: "accepted" | "refused" | "uncertain" = "uncertain";
    if (awake) outcome = "accepted";
    else if (
      typeof answered === "object" &&
      (answered?.kind === "credit-gate" || answered?.kind === "refused")
    )
      outcome = "refused";
    const settled = await settleDraftAuthorityEffect({
      actor: run.actor,
      claim,
      outcome,
      ...(awake ? { acceptance: started } : {}),
    });
    if (settled.kind !== "committed" && settled.kind !== "replayed")
      return false;
  }
  if (!stillCurrent(run)) return false;
  if (!awake) {
    fail(surfaceKey, stagedWakeFailure(answered));
    return false;
  }
  // Reads started during the wake can still describe the resting row.
  const knownRow = stageKnownRowQueryOptions(
    { ...run, started, deps },
    undefined,
  );
  const completed = holdPendingSandboxStageObservation(
    surfaceKey,
    attemptId,
    attemptRetryId,
    uuidv4(),
  );
  if (!stillCurrent(run)) return false;
  await cancelSandboxWakeReads(
    deps.queryClient,
    deps.auth,
    deps.userId,
    knownRow.queryKey,
  );
  if (!stillCurrent(run)) return false;
  if (completed !== null) return true;
  if (
    pendingSandboxStageObservation(surfaceKey, "awake", {
      kind: "wake-result",
      requestedAt: boundary,
      observationId,
    }) !== "unknown"
  ) {
    try {
      fail(surfaceKey, { kind: "failed", code: "wake", step: "booting" });
    } catch {
      // The current stage can offer Retry while storage is unavailable.
    }
  }
  return false;
}

function stagedWakeFailure(
  answered: boolean | SandboxWakeOutcome | null,
): StagedSandboxFailure {
  if (typeof answered === "object" && answered !== null) {
    if (answered.kind === "credit-gate")
      return {
        kind: "credits",
        shortfallMc: answered.shortfallMc,
        creditSource: answered.creditSource ?? null,
      };
    if (answered.kind === "refused")
      return { kind: "credits", shortfallMc: null };
  }
  return { kind: "failed", code: "wake", step: "booting" };
}

/** Whether the run is still the one the stage holds (not cancelled or retried). */
function stillCurrent(run: StagedRunIdentity): boolean {
  const { surfaceKey } = run;
  const stage = readStagedSandbox(surfaceKey);
  if (
    stage?.failure?.kind === "failed" &&
    (stage.failure.sandboxId === stage.createdSandboxId ||
      stage.failure.code === "credit-gate")
  )
    return false;
  return (
    draftAuthorityActorIsCurrent(run.actor) &&
    stage !== null &&
    stage.phase === "creating" &&
    stageMatchesRun(stage, run) &&
    pendingStageMatchesStorage(surfaceKey, stage) &&
    pendingSandboxStageRunAllowed(surfaceKey)
  );
}

function report(
  surfaceKey: string,
  step: StagedSandboxStep,
  now: number,
): void {
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null || stage.step === step) return;
  useStagedSandboxStore.getState().report(surfaceKey, { step, stepAt: now });
}

function fail(surfaceKey: string, failure: StagedSandboxFailure): void {
  useStagedSandboxStore.getState().report(surfaceKey, { failure });
}

/** What the surface's send adds to the create. */
export interface StagedRunRequest {
  /** The task the action belongs to; `null` before one exists. */
  readonly taskId: string | null;
  /**
   * Takes up a run a reload stopped, keeping its step and times; `false` for
   * a send, Keep waiting or Retry, which start the wait again.
   */
  readonly resume: boolean;
  /** The press's chosen key; a re-drive keeps the stage's last attempted key. */
  readonly createKey: string | null;
  readonly retryCreate?: SandboxCreateRequest;
  readonly observedCreateKey?: string | null;
  readonly observedAttemptId?: string | null;
  readonly retryRequestId?: string;
  readonly restoredDraftAuthority?: RestoredStageAuthority;
  readonly onStorageRefused?: () => void;
}

/** Which run a step belongs to, and what its create adds. */
interface StagedRun
  extends Omit<
      StagedRunRequest,
      "createKey" | "restoredDraftAuthority" | "onStorageRefused"
    >,
    StagedRunIdentity {
  readonly environmentId: string | null;
}

/** Reuses a created sandbox and retries its wake before considering a create. */
async function startStagedRun(
  run: StagedRun,
  stage: StagedSandbox,
  made: StartedSandbox | null,
  deps: StagedSandboxRunDeps,
): Promise<StartedSandbox | null> {
  if (made === null)
    return stage.target.kind === "existing"
      ? startExistingTarget(run, stage.target, deps)
      : startCreateTarget(run, stage.target, deps);
  if (
    stage.target.kind === "new" &&
    !recordPendingSandboxStageCreated(run.surfaceKey, made.sandboxId)
  )
    return null;
  if (
    stage.failure?.kind === "failed" &&
    stage.failure.code === "wake" &&
    !(await wakeCurrentStage(run, made, deps))
  ) {
    return null;
  }
  return made;
}

async function startExistingTarget(
  run: StagedRun,
  target: Extract<StagedSandboxTarget, { kind: "existing" }>,
  deps: StagedSandboxRunDeps,
): Promise<StartedSandbox | null> {
  const { surfaceKey } = run;
  useStagedSandboxStore.getState().report(surfaceKey, {
    createdSandboxId: target.sandboxId,
    createdHostId: target.hostId,
    step: "booting",
    stepAt: deps.now(),
  });
  const started = { sandboxId: target.sandboxId, hostId: target.hostId };
  return (await wakeCurrentStage(run, started, deps)) ? started : null;
}

async function startCreateTarget(
  run: StagedRun,
  target: Extract<StagedSandboxTarget, { kind: "new" }>,
  deps: StagedSandboxRunDeps,
): Promise<StartedSandbox | null> {
  const { surfaceKey, taskId, environmentId, createKey } = run;
  // Give an older persisted blank stage one name, retained across retries.
  const name = stagedSandboxName(target.name);
  if (name !== target.name) {
    useStagedSandboxStore.getState().setTarget(surfaceKey, { ...target, name });
  }
  if (!stillCurrent(run)) return null;
  // Older stages without a saved retry payload rebuild the POST from their pick.
  const request: SandboxCreateRequest = run.retryCreate ?? {
    os: target.shape.os,
    cpus: target.shape.cpus,
    memoryMb: target.shape.memoryMb,
    diskMb: target.shape.diskMb,
    region: target.shape.region,
    displayName: name,
    idleMinutes: target.shape.idleMinutes,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    environmentId,
    // The shape's `null` is "never"; on a create `null` is the configuration's
    // default and `0` is never.
    destroyAfterRestingMinutes: target.shape.destroyAfterRestingMinutes ?? 0,
    // The task that owns the run. A pending landing send already created it
    // on its placement host; a landing terminal ask may have no task yet.
    createdByTaskId: taskId,
    clientRequestId: createKey,
  };
  const boundary = holdPendingSandboxStageObservation(
    surfaceKey,
    run.attemptId,
    run.attemptRetryId,
    run.attemptRetryId,
  );
  if (boundary === null) return null;
  const setupAttempt = run.attemptId === undefined
    ? undefined
    : { attemptId: run.attemptId, observationGeneration: boundary };
  const answer = await createSandbox(run, request, setupAttempt, deps);
  if (answer === null || !stillCurrent(run)) return null;
  const { result, claim } = answer;
  const started = recordStageCreateAnswer(run, result, {
    teamName:
      target.configuration.kind === "team"
        ? target.configuration.teamName
        : null,
    now: deps.now(),
  });
  if (claim !== null) {
    const stage = readStagedSandbox(surfaceKey);
    const accepted =
      result.kind === "ok" &&
      (stage?.createdSandboxId === result.accepted.sandboxId ||
        stage?.failure?.sandboxId === result.accepted.sandboxId);
    let outcome: "accepted" | "refused" | "uncertain" = "uncertain";
    if (accepted) outcome = "accepted";
    else if (result.kind === "refused") outcome = "refused";
    if (draftAuthorityActorIsCurrent(run.actor))
      await settleDraftAuthorityEffect({
        actor: run.actor,
        claim,
        outcome,
        ...(accepted
          ? {
              acceptance: {
                sandboxId: result.accepted.sandboxId,
                hostId: result.accepted.hostId,
              },
            }
          : {}),
      });
  }
  return started;
}

function recordStageCreateAnswer(
  run: StagedRunIdentity,
  result: SandboxCreateFetchResult,
  context: { readonly teamName: string | null; readonly now: number },
): StartedSandbox | null {
  const { surfaceKey } = run;
  if (result.kind !== "ok") {
    const retryCreate = sandboxRetryAfterRefusal(result);
    const failure = createFailure(result, context.teamName);
    const beforeReservation = createRefusedBeforeReservation(result);
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure: {
        ...failure,
        ...(retryCreate === null
          ? {}
          : { retryCreate, retryRowVerified: true }),
        ...(beforeReservation
          ? {
              rowlessCreateRefusal: {
                createKey: run.createKey,
                attemptId: run.attemptId,
              },
            }
          : {}),
      },
      ...(beforeReservation ? { createAttempt: null } : {}),
    });
    return null;
  }
  const { sandboxId, hostId, sandbox } = result.accepted;
  const creditRefusal =
    result.joined === true ? stagedCreditRefusal(sandbox) : null;
  if (creditRefusal !== null) {
    fail(surfaceKey, creditRefusal);
    return null;
  }
  if (!recordPendingSandboxStageCreated(surfaceKey, sandboxId)) return null;
  useStagedSandboxStore.getState().report(surfaceKey, {
    createdSandboxId: sandboxId,
    createdHostId: hostId,
    rateLimit: sandbox.rateLimit ?? null,
    step: "booting",
    stepAt: context.now,
  });
  if (sandbox.state === "failed" || sandbox.state === "destroyed") {
    if (
      presentAcceptedSandboxSetupFailure(surfaceKey, sandboxId, sandbox) ||
      surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)
    )
      return null;
    const verdict = settleVerdict(sandbox);
    if (verdict?.kind === "failure")
      fail(surfaceKey, {
        ...verdict.failure,
        retryCreate: sandboxRetryCreate(sandbox),
      });
    return null;
  }
  return { sandboxId, hostId };
}

/** These exact refusals settle without reserving a row under the attempted key. */
function createRefusedBeforeReservation(
  failure: SandboxControlFailure,
): boolean {
  return (
    failure.kind === "refused" &&
    failure.sandboxId === undefined &&
    failure.sandbox === undefined &&
    failure.uncertainCreateRow !== true &&
    ((failure.status === 400 &&
      failure.code === SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED) ||
      (failure.status === 503 &&
        failure.code === SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE))
  );
}

/**
 * The environment a create goes into: `null` for Personal (the caller's own),
 * the team's id, or `undefined` when the team's could not be read.
 */
async function environmentIdFor(
  target: Extract<StagedSandboxTarget, { kind: "new" }>,
  deps: StagedSandboxRunDeps,
): Promise<string | null | undefined> {
  if (target.configuration.kind === "personal") return null;
  const answer = await deps.queryClient
    .fetchQuery(
      teamEnvironmentQueryOptions(
        deps.auth,
        deps.userId,
        target.configuration.teamId,
        true,
      ),
    )
    .catch(() => null);
  return answer !== null && answer.kind === "ok"
    ? answer.environmentId
    : undefined;
}

interface StagedCreateAnswer {
  readonly result: SandboxCreateFetchResult;
  readonly claim: DraftAuthorityIssueReceipt | null;
}

/**
 * The create, as the app's create mutation runs it (`useSandboxCreate`):
 * keyed, and refreshing the directory and the lists once it settles, a
 * refusal included, since a `502 provider_failed` leaves a `failed` row.
 * The answer comes back as the fetch result; the line words a refusal. A
 * request that threw (the desktop bridge refusing it) reads as a create that
 * could not be confirmed, so the line stops instead of waiting forever.
 */
function createSandbox(
  run: StagedRunIdentity,
  request: SandboxCreateRequest,
  setupAttempt: DraftAuthoritySetupAttempt | undefined,
  deps: StagedSandboxRunDeps,
): Promise<StagedCreateAnswer | null> {
  const { auth, directory, queryClient } = deps;
  const observer = new QueryMutationObserver<StagedCreateAnswer | null>(
    queryClient,
    {
      mutationKey: sandboxMutationKeys.create(run.userId),
      // TanStack can suspend on onMutate. Commit the body at the fenced POST.
      mutationFn: async () => {
        if (!stillCurrent(run)) return null;
        if (!saveStagedCreateRequest(run.surfaceKey, request)) {
          reportCreateSaveFailure(run);
          return null;
        }
        const draft = readStagedSandbox(run.surfaceKey)?.returnedDraft;
        if (!stillCurrent(run)) return null;
        const send = stagePendingSend(run.surfaceKey);
        const effect: DraftAuthorityEffectIntent = {
          kind: "create",
          phase: "setup",
          identity: run.createKey,
          payload: { request },
        };
        let claim: DraftAuthorityIssueReceipt | null = null;
        if (send !== null) {
          claim = await claimPendingSandboxOutboxEffect({
            actor: run.actor,
            send,
            operationId: `${send.id}:setup-create:${request.clientRequestId}`,
            effect,
            retryRefusedSetupCreate: run.retryRefusedCreate,
            setupAttempt,
            canIssue: () => stillCurrent(run),
          });
          if (claim === null || !stillCurrent(run)) return null;
          if (claim.setupAttempt !== undefined)
            useStagedSandboxStore.getState().report(run.surfaceKey, {
              authoritySetupAttempt: claim.setupAttempt,
            });
        } else if (draft !== undefined) {
          const capture = run.restoredDraftAuthority;
          if (capture === undefined || draft.stageId !== run.clientRequestId)
            return null;
          const checkpoint = returnedSandboxWithCreate(capture.stored, draft, request);
          if (checkpoint === null) return null;
          claim = await claimRestoredStageEffect(
            run,
            effect,
            checkpoint,
            run.attemptId === undefined
              ? undefined
              : { attemptId: run.attemptId, observationGeneration: deps.now() },
            undefined,
          );
          if (claim === null) return null;
          if (claim.checkpointVersion !== null)
            updateReturnedSandboxRestore(run.surfaceKey, checkpoint);
        }
        if (
          !stillCurrent(run) ||
          (claim !== null && !(await verifyPendingSandboxOutboxGrant(run.actor, claim))) ||
          !stillCurrent(run)
        )
          return null;
        try {
          return { result: await auth.createSandbox(request), claim };
        } catch (error: unknown) {
          return {
            result: {
              kind: "network-error",
              detail: error instanceof Error ? error.message : String(error),
            },
            claim,
          };
        }
      },
      onSettled: (answer) => {
        if (answer === null || !draftAuthorityActorIsCurrent(run.actor))
          return;
        const result = answer?.result;
        void directory.refresh();
        void queryClient.invalidateQueries({
          queryKey: authQueryKeys.registeredHostsAll(),
        });
        if (
          result !== undefined &&
          result.kind === "refused" &&
          result.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND
        ) {
          void queryClient.invalidateQueries({
            queryKey: sandboxQueryKeys.teamEnvironmentAll(),
          });
        }
      },
    },
  );
  // Subscribed for the mutation's life, so the cache can collect it once it
  // settles.
  const unsubscribe = observer.subscribe(() => undefined);
  return observer
    .mutate()
    .catch((error: unknown): StagedCreateAnswer => ({
      result: {
        kind: "network-error",
        detail: error instanceof Error ? error.message : String(error),
      },
      claim: null,
    }))
    .finally(unsubscribe);
}

function reportCreateSaveFailure(run: StagedRunIdentity): void {
  if (!stillCurrent(run)) return;
  try {
    fail(run.surfaceKey, { kind: "unavailable" });
  } catch {
    // The stage still shows the retry in memory even if storage is unavailable.
  }
}

/** A create failure as shown on the stage's line. */
export function createFailure(
  failure: SandboxControlFailure,
  teamName: string | null,
): StagedSandboxFailure {
  if (failure.kind === "refused") {
    if (failure.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT) {
      const named =
        failure.sandboxId === undefined ? {} : { sandboxId: failure.sandboxId };
      return failure.reason === "unverified"
        ? { kind: "unverified", ...named }
        : {
            kind: "credits",
            shortfallMc: failure.shortfallMc,
            creditSource: failure.creditSource ?? null,
            ...named,
          };
    }
    if (failure.code === SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED) {
      return { kind: "shape" };
    }
    if (failure.code === SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE) {
      return { kind: "unavailable" };
    }
  }
  if (failure.kind === "network-error") return { kind: "unverified" };
  return {
    kind: "refused",
    message: sandboxCreateFailureMessage(failure, teamName),
    ...(failure.kind === "refused" && failure.sandboxId !== undefined
      ? { sandboxId: failure.sandboxId }
      : {}),
  };
}

interface SandboxSettlement extends StagedRunIdentity {
  readonly started: StartedSandbox;
  readonly deps: StagedSandboxRunDeps;
}

/**
 * Waits for the sandbox to be ready for the handoff, reporting each step.
 * Cancellation ends the wait, and its budget ends with a failure on the line.
 */
async function settle(
  input: SandboxSettlement,
  budgetFrom: number,
  budgetMs: number,
): Promise<void> {
  const { surfaceKey, deps } = input;
  const deadline = budgetFrom + budgetMs;
  while (deps.now() < deadline) {
    if (!stillCurrent(input)) return;
    const observed = await observeStageRow(input);
    if (!stillCurrent(input)) return;
    if (observed !== null && (await settleRow(input, observed)) === "finished")
      return;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  if (!stillCurrent(input)) return;
  fail(surfaceKey, {
    kind: "timed-out",
    step: readStagedSandbox(surfaceKey)?.step ?? "booting",
  });
}

/** Applies one fresh lifecycle answer, waking retained sandboxes before handoff. */
async function settleRow(
  input: SandboxSettlement,
  observed: StagedRowObservation,
): Promise<"waiting" | "finished"> {
  const { surfaceKey, started, deps } = input;
  const row = readCurrentStageRow(input, observed);
  if (!stillCurrent(input)) return "finished";
  if (row === undefined) return "waiting";
  useStagedSandboxStore
    .getState()
    .report(surfaceKey, { rateLimit: row?.rateLimit ?? null });
  if (row?.state === "suspended" || row?.state === "stopped") {
    // A run wakes once, for the person's action that started it: only at
    // `creating` has it not woken anything yet, which is how Cancel retains
    // an already-created sandbox after it rested. Any later rest is the
    // sandbox's, or someone's Suspend, and a reload keeps the step it found
    // and is nobody's gesture: the stage records the rest, its send goes
    // back, and a composer stages it to wake on the next one.
    if (readStagedSandbox(surfaceKey)?.step !== "creating") {
      fail(surfaceKey, { kind: "rested" });
      return "finished";
    }
    const awake = await wakeCurrentStage(input, started, deps);
    return awake ? "waiting" : "finished";
  }
  if (presentAcceptedSandboxSetupFailure(surfaceKey, started.sandboxId, row))
    return "finished";
  const verdict = settleVerdict(row);
  if (verdict === null) return "waiting";
  if (verdict.kind === "failure") {
    const failure = verdict.failure;
    if (failure.kind !== "failed") {
      fail(surfaceKey, failure);
    } else if (
      row !== null &&
      !surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)
    ) {
      fail(surfaceKey, {
        ...failure,
        sandboxId: started.sandboxId,
        retryCreate: sandboxRetryCreate(row),
      });
    }
    return "finished";
  }
  report(surfaceKey, "applying", deps.now());
  void deps.directory.refresh();
  if (dialableHostEndpoint(deps.directory.findById(started.hostId)) === null) {
    return "waiting";
  }
  return settleSettings(input, observed);
}

async function restoredHandoffCurrent(run: StagedRunIdentity): Promise<boolean> {
  if (!stillCurrent(run)) return false;
  const progress = run.restoredProgress;
  if (progress === null) return true;
  const { version, receipt } = progress;
  if (receipt === null) return false;
  const read = await readDraftAuthorityRestoredIssue({ actor: run.actor, draft: version });
  return (
    read.kind === "current" &&
    read.issue.state === "accepted" &&
    read.issue.receipt.operationId === receipt.operationId &&
    read.issue.receipt.issueGeneration === receipt.issueGeneration &&
    read.issue.receipt.executorId === receipt.executorId &&
    stillCurrent(run)
  );
}

/** A connected host must prove configuration delivery before its message is handed off. */
async function settleSettings(
  input: SandboxSettlement,
  observed: StagedRowObservation,
): Promise<"waiting" | "finished"> {
  const { surfaceKey, started, deps } = input;
  if (!(await restoredHandoffCurrent(input))) return "finished";
  const settings = await deps.readSettings(started.hostId);
  if (!stillCurrent(input)) return "finished";
  if (settings === null) return "waiting";
  if (!(await restoredHandoffCurrent(input))) return "finished";
  const row = readCurrentStageRow(input, observed);
  if (!stillCurrent(input)) return "finished";
  if (row === undefined) return "waiting";
  if (presentAcceptedSandboxSetupFailure(surfaceKey, started.sandboxId, row))
    return "finished";
  if (settleVerdict(row)?.kind !== "awake") return "waiting";
  if (settings !== "unsupported" && sandboxSettingsFailed(settings.items)) {
    fail(surfaceKey, {
      kind: "settings",
      code: "SBX-0520",
      steps: sandboxSettingsSteps(settings.items),
    });
    return "finished";
  }
  if (
    settings !== "unsupported" &&
    (settings.principal === null ||
      settings.receivedRevision === null ||
      settings.sandboxSettingsOperationId === null ||
      !sandboxSettingsReady(settings.items))
  )
    return "waiting";
  report(surfaceKey, "delivering", deps.now());
  await handOff(input);
  return "finished";
}

interface StagedRowObservation {
  readonly row: SandboxSummary | null;
  readonly observation: PendingSandboxObservation;
  readonly list: SandboxListResponse | null | undefined;
}

function stageList(
  input: SandboxSettlement,
): SandboxListResponse | null | undefined {
  const { auth, userId, queryClient } = input.deps;
  return queryClient.getQueryData(sandboxQueryKeys.list(auth, userId));
}

function listedStageRow(
  list: SandboxListResponse | null | undefined,
  sandboxId: string,
): StagedRowObservation | null {
  const row = list?.sandboxes.find((item) => item.id === sandboxId);
  if (row === undefined) return null;
  return {
    row,
    list,
    observation: {
      kind: "list",
      sentAt: sandboxListReadSentAt(list),
      mountedAt: 0,
    },
  };
}

/** A list omission is a reason to read the known row, not proof it ended. */
async function observeStageRow(
  input: SandboxSettlement,
): Promise<StagedRowObservation | null> {
  const {
    deps,
    started: { sandboxId, hostId },
  } = input;
  const response = await deps.queryClient
    .fetchQuery({
      ...sandboxListQueryOptions(deps.auth, deps.userId, true),
      staleTime: 0,
    })
    .catch(() => undefined);
  if (!stillCurrent(input)) return null;
  const listed = listedStageRow(response, sandboxId);
  if (listed !== null) return listed;
  const omission = sandboxListObservationId(stageList(input));
  const answer = await deps.queryClient
    .fetchQuery({
      ...stageKnownRowQueryOptions(input, omission),
      staleTime: 0,
    })
    .catch(() => null);
  if (answer === null || !stillCurrent(input)) return null;
  const list = stageList(input);
  const { read } = answer;
  if (!knownSandboxRowCurrent(answer, sandboxListObservationId(list), hostId))
    return listedStageRow(list, sandboxId);
  if (read === null) return null;
  return {
    row: read.row,
    list,
    observation: {
      kind: "by-id",
      sandboxId,
      sentAt: read.sentAt,
      mountedAt: 0,
    },
  };
}

function stageKnownRowQueryOptions(
  input: SandboxSettlement,
  omission: number | undefined,
) {
  const { surfaceKey, userId, deps, started, clientRequestId, attemptId } =
    input;
  const sendId = surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)
    ? surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length)
    : undefined;
  const send =
    sendId === undefined
      ? undefined
      : usePendingSandboxSendStore.getState().sends[sendId];
  return knownSandboxRowQueryOptions({
    auth: deps.auth,
    userId,
    sandboxId: started.sandboxId,
    hostId: started.hostId,
    sendId,
    stageId: clientRequestId,
    attemptId,
    observationRequestedAt: send?.observationRequestedAt,
    observationRetryId: send?.observationRetryId,
    stopRequestedAt: send?.stopRequestedAt,
    omission,
  });
}

function readCurrentStageRow(
  input: SandboxSettlement,
  prior: StagedRowObservation,
): SandboxSummary | null | undefined {
  const {
    surfaceKey,
    started: { sandboxId, hostId },
  } = input;
  const observed = latestStageRow(input, prior);
  if (observed === null) return undefined;
  const { row, observation } = observed;
  if (row !== null && row.hostId !== hostId) return undefined;
  let host: "awake" | "ended" | "resting" | "waking" = "waking";
  if (
    row === null ||
    row.state === "failed" ||
    row.state === "destroying" ||
    row.state === "destroyed"
  )
    host = "ended";
  else if (row.state === "awake") host = "awake";
  else if (row.state === "stopped" || row.state === "suspended")
    host = "resting";
  if (
    row !== null &&
    !markPendingSandboxStageRowSeen(surfaceKey, sandboxId, observation)
  )
    return undefined;
  return pendingSandboxStageObservation(surfaceKey, host, observation) ===
    "unknown"
    ? undefined
    : row;
}

function latestStageRow(
  input: SandboxSettlement,
  prior: StagedRowObservation,
): StagedRowObservation | null {
  const list = stageList(input);
  if (prior.list === list) return prior;
  const { sandboxId, hostId } = input.started;
  if (
    prior.observation.kind === "by-id" &&
    sandboxRowDestroySettled(prior.row, hostId)
  )
    return prior;
  return listedStageRow(list, sandboxId);
}

type SettleVerdict =
  | { readonly kind: "awake" }
  | { readonly kind: "failure"; readonly failure: StagedSandboxFailure };

/** An omitted credit-gate row has the same outcome when replayed or read. */
export function stagedCreditRefusal(
  row: SandboxSummary | null,
): StagedSandboxFailure | null {
  if (row?.state !== "destroyed" || row.failureCode !== "credit-gate")
    return null;
  return {
    kind: "failed",
    code: "credit-gate",
    step: "booting",
    sandboxId: row.id,
    retryCreate: sandboxRetryCreate(row),
  };
}

/** Classifies an admitted exact row before the send transfers to its dispatcher. */
export function acceptedSandboxSetupFailure(
  sandboxId: string,
  row: SandboxSummary | null,
): StagedSandboxFailure | null {
  if (row === null)
    return {
      kind: "failed",
      code: "gone",
      step: "booting",
      sandboxId,
      acceptedRowNotFound: true,
    };
  if (row.id !== sandboxId) return null;
  if (row.state === "failed")
    return {
      kind: "failed",
      code: row.failureCode ?? row.state,
      step: "booting",
      sandboxId,
      retryCreate: sandboxRetryCreate(row),
    };
  return stagedCreditRefusal(row);
}

function presentAcceptedSandboxSetupFailure(
  surfaceKey: string,
  sandboxId: string,
  row: SandboxSummary | null,
): boolean {
  const failure = acceptedSandboxSetupFailure(sandboxId, row);
  if (failure === null) return false;
  const stage = readStagedSandbox(surfaceKey);
  if (stage?.createdSandboxId === sandboxId)
    useStagedSandboxStore.getState().presentSetupFailure(
      surfaceKey,
      stage,
      failure,
    );
  return true;
}

/** What a row says about the wait, or `null` while it is on its way. */
export function settleVerdict(
  row: SandboxSummary | null,
): SettleVerdict | null {
  if (row === null) {
    return {
      kind: "failure",
      failure: { kind: "failed", code: "gone", step: "booting" },
    };
  }
  const refusal = stagedCreditRefusal(row);
  if (refusal !== null) return { kind: "failure", failure: refusal };
  switch (row.state) {
    case "failed":
    case "destroying":
    case "destroyed":
      return {
        kind: "failure",
        failure: {
          kind: "failed",
          code: row.failureCode ?? row.state,
          step: "booting",
        },
      };
    case "awake":
      if (row.frozen) {
        return {
          kind: "failure",
          failure: { kind: "credits", shortfallMc: null },
        };
      }
      return row.guestConfigured === false
        ? {
            kind: "failure",
            failure: {
              kind: "settings",
              code: row.failureCode ?? "settings",
              steps: { applied: [], notApplied: ["Sandbox setup"] },
            },
          }
        : { kind: "awake" };
    default:
      return null;
  }
}

/**
 * The surface is pinned to the new host and the stage moves to `handoff`;
 * its pending driver delivers there, or its composer resubmits there. A
 * stage with no send to resubmit ends here, its terminal asked of the landing
 * panel if one was: one only an explicit terminal ask started, or one whose
 * sending draft is gone (its modal's tab or its start page closed meanwhile)
 * with no other send claiming it since.
 */
export function readRestoredSandboxReadyWitness(
  surfaceKey: string,
): RestoredSandboxReadyWitness | null {
  const stage = readStagedSandbox(surfaceKey);
  const witness = stage?.[STAGED_SANDBOX_READY_WITNESS];
  return witness !== undefined &&
    stage?.phase === "handoff" &&
    stage.sendTaken &&
    witness.surfaceKey === surfaceKey &&
    stage.ownerId === witness.ownerId &&
    stage.clientRequestId === witness.clientRequestId &&
    stage.attemptId === witness.attemptId &&
    stage.createdHostId === witness.hostId &&
    stage.createdSandboxId === witness.sandboxId &&
    handoffOwnerLive(surfaceKey, witness.ownerId) &&
    draftAuthorityActorIsCurrent(witness.actor)
    ? witness
    : null;
}

async function handOff(input: SandboxSettlement): Promise<void> {
  const { surfaceKey, started: { hostId, sandboxId }, restoredProgress, actor } = input;
  const before = readStagedSandbox(surfaceKey);
  let witness: RestoredSandboxReadyWitness | undefined;
  if (
    before?.sendTaken === true &&
    handoffOwnerLive(surfaceKey, before.ownerId) &&
    restoredProgress !== null
  ) {
    const { version: draft, receipt: primary } = restoredProgress;
    if (primary === null || input.attemptId === undefined) return;
    const read = await readDraftAuthorityRestoredIssue({ actor, draft });
    if (
      !stillCurrent(input) ||
      read.kind !== "current" ||
      read.issue.state !== "accepted" ||
      read.issue.receipt.operationId !== primary.operationId ||
      read.issue.receipt.issueGeneration !== primary.issueGeneration ||
      read.issue.receipt.executorId !== primary.executorId ||
      read.issue.acceptance?.hostId !== hostId ||
      read.issue.acceptance.sandboxId !== sandboxId
    )
      return;
    witness = Object.freeze({
      actor, draft, primary, surfaceKey, ownerId: before.ownerId,
      clientRequestId: input.clientRequestId, attemptId: input.attemptId,
      hostId, sandboxId,
    });
  }
  if (!stillCurrent(input)) return;
  useSurfaceHostSelectionStore.getState().setSelection(surfaceKey, hostId);
  const stage = readStagedSandbox(surfaceKey);
  if (!stillCurrent(input)) return;
  if (
    witness !== undefined &&
    (stage?.ownerId !== witness.ownerId ||
      stage.createdSandboxId !== sandboxId ||
      stage.createdHostId !== hostId ||
      !handoffOwnerLive(surfaceKey, witness.ownerId))
  )
    return;
  if (
    stage !== null &&
    (!stage.sendTaken || !handoffOwnerLive(surfaceKey, stage.ownerId))
  ) {
    if (stage.openTerminal) {
      const panel = useLandingPanelStore.getState();
      if (restoredProgress === null) panel.requestTerminal(surfaceKey, hostId);
      else if (!stage.sendTaken && restoredProgress.receipt !== null) {
        const { receipt: primary, version: draft } = restoredProgress;
        const handoff: DraftAuthorityRestoredTerminalHandoff = {
          actor,
          draft,
          primary,
          operationId: `${primary.operationId}:landing-open`,
          hostId,
          sandboxId,
          surfaceKey,
        };
        panel.requestRestoredTerminal(handoff);
      }
    }
    useStagedSandboxStore.getState().clear(surfaceKey);
    return;
  }
  useStagedSandboxStore.getState().report(surfaceKey, {
    phase: "handoff",
    ...(witness === undefined ? {} : { [STAGED_SANDBOX_READY_WITNESS]: witness }),
  });
}
