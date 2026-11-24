import { stagedSandboxName } from "@/lib/sandboxes/staged-sandbox-name";
import { v4 as uuidv4 } from "uuid";
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
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import {
  sandboxSettingsFailed,
  sandboxSettingsReady,
  sandboxSettingsSteps,
} from "@traycer/protocol/host/sandbox-settings";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  knownSandboxRowCurrent,
  knownSandboxRowQueryOptions,
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
  useStagedSandboxStore,
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

interface StagedRunIdentity {
  readonly surfaceKey: string;
  readonly clientRequestId: string;
  readonly createKey: string;
  readonly attemptId: string | undefined;
  readonly attemptRetryId: string | undefined;
  readonly userId: string | null;
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
  return run !== undefined && (stage === null || stageMatchesRun(stage, run));
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
  const stage = readStagedSandbox(surfaceKey);
  if (
    stage === null ||
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
    userId: signedInUserId(),
  };
  running.set(surfaceKey, attempt);
  try {
    await drivePreparedRun(
      {
        ...request,
        ...attempt,
        retryCreate: active.lastRetryCreate,
      },
      stage,
      sandboxAlreadyMade(active, request.resume),
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
      userId: run.userId,
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
      ? await prepareCreate(
          stage.target,
          deps,
          attempt?.budgetMs ?? null,
          run.retryCreate,
        )
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
  retryCreate: SandboxCreateRequest | undefined,
): Promise<PreparedCreate | null> {
  const environmentId =
    retryCreate === undefined
      ? await environmentIdFor(target, deps)
      : retryCreate.environmentId;
  if (environmentId === undefined) return null;
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
  if (boundary === null) return false;
  const answered = await deps.wake(started.hostId, stagedWakeGesture(stage));
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
  await Promise.all([
    deps.queryClient.cancelQueries({
      queryKey: knownRow.queryKey,
      exact: true,
    }),
    deps.queryClient.cancelQueries({
      queryKey: sandboxQueryKeys.list(deps.auth, deps.userId),
      exact: true,
    }),
  ]);
  return completed !== null && stillCurrent(run);
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
  // The pending strip can prove a credit refusal while this run is reading.
  if (stage?.failure?.kind === "failed" && stage.failure.code === "credit-gate")
    return false;
  return (
    signedInUserId() === run.userId &&
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
}

/** Which run a step belongs to, and what its create adds. */
interface StagedRun
  extends Omit<StagedRunRequest, "createKey">, StagedRunIdentity {
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
  if (
    holdPendingSandboxStageObservation(
      surfaceKey,
      run.attemptId,
      run.attemptRetryId,
      run.attemptRetryId,
    ) === null
  )
    return null;
  const result = await createSandbox(run, request, deps);
  if (result === null || !stillCurrent(run)) return null;
  return recordStageCreateAnswer(surfaceKey, request, result, {
    teamName:
      target.configuration.kind === "team"
        ? target.configuration.teamName
        : null,
    now: deps.now(),
  });
}

function recordStageCreateAnswer(
  surfaceKey: string,
  request: SandboxCreateRequest,
  result: SandboxCreateFetchResult,
  context: { readonly teamName: string | null; readonly now: number },
): StartedSandbox | null {
  if (result.kind !== "ok") {
    const retryCreate = sandboxRetryAfterRefusal(result, request);
    const failure = createFailure(result, context.teamName);
    const beforeReservation = createRefusedBeforeReservation(result);
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure: retryCreate === null ? failure : { ...failure, retryCreate },
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

/** Only a refusal before reservation releases the previous create's wait budget. */
function createRefusedBeforeReservation(
  failure: SandboxControlFailure,
): boolean {
  return (
    failure.kind === "refused" &&
    failure.sandboxId === undefined &&
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
  deps: StagedSandboxRunDeps,
): Promise<SandboxCreateFetchResult | null> {
  const { auth, directory, queryClient } = deps;
  const context = { userId: run.userId };
  const observer = new QueryMutationObserver<SandboxCreateFetchResult | null>(
    queryClient,
    {
      mutationKey: sandboxMutationKeys.create(run.userId),
      // TanStack can suspend on onMutate. Commit the body at the fenced POST.
      mutationFn: () =>
        stillCurrent(run) &&
        saveStagedCreateRequest(run.surfaceKey, request) &&
        stillCurrent(run)
          ? auth.createSandbox(request)
          : Promise.resolve(null),
      onSettled: (result) => {
        if (result === null || !settledForStartingAccount(context)) return;
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
    .catch((error: unknown): SandboxCreateFetchResult => ({
      kind: "network-error",
      detail: error instanceof Error ? error.message : String(error),
    }))
    .finally(unsubscribe);
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
  const verdict = settleVerdict(row);
  if (verdict === null) return "waiting";
  if (verdict.kind === "failure") {
    const failure = verdict.failure;
    if (failure.kind === "failed") {
      fail(surfaceKey, {
        ...failure,
        sandboxId: started.sandboxId,
        ...(row === null ? {} : { retryCreate: sandboxRetryCreate(row) }),
      });
    } else {
      fail(surfaceKey, failure);
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

/** A connected host must prove configuration delivery before its message is handed off. */
async function settleSettings(
  input: SandboxSettlement,
  observed: StagedRowObservation,
): Promise<"waiting" | "finished"> {
  const { surfaceKey, started, deps } = input;
  const settings = await deps.readSettings(started.hostId);
  if (!stillCurrent(input)) return "finished";
  if (settings === null) return "waiting";
  const row = readCurrentStageRow(input, observed);
  if (row === undefined || settleVerdict(row)?.kind !== "awake")
    return "waiting";
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
  handOff(surfaceKey, started.hostId);
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
function handOff(surfaceKey: string, hostId: string): void {
  useSurfaceHostSelectionStore.getState().setSelection(surfaceKey, hostId);
  const stage = readStagedSandbox(surfaceKey);
  if (
    stage !== null &&
    (!stage.sendTaken || !handoffOwnerLive(surfaceKey, stage.ownerId))
  ) {
    if (stage.openTerminal) {
      useLandingPanelStore.getState().requestTerminal(surfaceKey, hostId);
    }
    useStagedSandboxStore.getState().clear(surfaceKey);
    return;
  }
  useStagedSandboxStore.getState().report(surfaceKey, { phase: "handoff" });
}
