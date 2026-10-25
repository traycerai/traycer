import {
  MutationObserver as QueryMutationObserver,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  SandboxControlFailure,
  SandboxCreateFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
  type SandboxCreateRequest,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxCreateFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { SandboxCreateError } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { sandboxListQueryOptions } from "@/hooks/sandboxes/use-sandbox-list-query";
import { teamEnvironmentQueryOptions } from "@/hooks/sandboxes/use-team-environment-query";
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
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  handoffOwnerLive,
  readStagedSandbox,
  refusedBeforeCreate,
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

export interface StagedSandboxRunDeps {
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
  readonly wake: (hostId: string) => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Each surface's live run in this window, by the `clientRequestId` it
 * drives: a repeat of that send joins it, and a new send replaces it (the
 * old run sees it is no longer current and stops).
 */
const running = new Map<string, string>();

/** Whether a run in this window is driving the surface's stage. */
export function stagedRunActive(surfaceKey: string): boolean {
  return running.has(surfaceKey);
}

/**
 * Phase 1 of the composer's two-phase handoff (sandboxes plan D1): create the
 * staged sandbox (or wake the staged resting one), then wait until it is
 * awake, its settings applied (`guestConfigured !== false`) and its host
 * connected. Then it pins the surface to the new host and moves the stage to
 * `handoff`; phase 2, the surface's own resubmit, runs from there.
 *
 * Owned by the store, not by a component: the composer may unmount, and the
 * stage, its idempotency key and the draft outlive it. An action on a stage
 * that may have an accepted create behind it reuses the key, so the server
 * answers with the row it already made; `fresh` (`stagedCreateNeedsFreshKey`,
 * or Retry creation after a terminal failure) mints a new one.
 */
export async function runStagedSandbox(
  surfaceKey: string,
  fresh: boolean,
  request: StagedRunRequest,
  deps: StagedSandboxRunDeps,
): Promise<void> {
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null || stage.phase === "handoff") return;
  if (
    !fresh &&
    stage.clientRequestId !== null &&
    running.get(surfaceKey) === stage.clientRequestId
  ) {
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
    .begin(surfaceKey, fresh, deps.now(), request.resume);
  if (clientRequestId === null) return;
  running.set(surfaceKey, clientRequestId);
  try {
    const started =
      sandboxAlreadyMade(stage, fresh) ??
      (await startTarget(
        { surfaceKey, clientRequestId, ...request },
        stage.target,
        deps,
      ));
    if (started === null) return;
    await settle({
      surfaceKey,
      clientRequestId,
      started,
      deps,
      budgetFrom: readStagedSandbox(surfaceKey)?.startedAt ?? deps.now(),
    });
  } finally {
    if (running.get(surfaceKey) === clientRequestId) running.delete(surfaceKey);
  }
}

/**
 * The new sandbox this key already made, if any. It is read, never created
 * again: a repeat or a resume after a reload waits on that row, and a row
 * that failed or is gone stops the wait rather than naming the key a second
 * time.
 */
function sandboxAlreadyMade(
  stage: StagedSandbox,
  fresh: boolean,
): StartedSandbox | null {
  if (
    fresh ||
    stage.target.kind !== "new" ||
    stage.createdSandboxId === null ||
    stage.createdHostId === null
  ) {
    return null;
  }
  return { sandboxId: stage.createdSandboxId, hostId: stage.createdHostId };
}

/**
 * Wakes the sandbox of a stage already handed off, which rested while its
 * send waited for the agent there: the send is the wake (it resumes on the
 * person's next action, and the send is still that action). Under the same
 * stage and key, back to its wake step on the line, then the wait as before;
 * the send is delivered only once the agent is ready, as ever.
 */
export async function rewakeStagedSandbox(
  surfaceKey: string,
  deps: StagedSandboxRunDeps,
): Promise<void> {
  const stage = readStagedSandbox(surfaceKey);
  if (
    stage === null ||
    stage.phase !== "handoff" ||
    stage.clientRequestId === null ||
    stage.createdSandboxId === null ||
    stage.createdHostId === null ||
    running.has(surfaceKey)
  ) {
    return;
  }
  const { clientRequestId } = stage;
  const started = {
    sandboxId: stage.createdSandboxId,
    hostId: stage.createdHostId,
  };
  const now = deps.now();
  // The line's clock restarts with the wake: the wait it times is this one.
  useStagedSandboxStore.getState().report(surfaceKey, {
    phase: "creating",
    startedAt: now,
    step: "booting",
    stepAt: now,
    failure: null,
  });
  running.set(surfaceKey, clientRequestId);
  try {
    const awake = await deps.wake(started.hostId);
    if (!stillCurrent(surfaceKey, clientRequestId)) return;
    if (!awake) {
      fail(surfaceKey, { kind: "failed", code: "wake", step: "booting" });
      return;
    }
    await settle({
      surfaceKey,
      clientRequestId,
      started,
      deps,
      budgetFrom: now,
    });
  } finally {
    if (running.get(surfaceKey) === clientRequestId) running.delete(surfaceKey);
  }
}

interface StartedSandbox {
  readonly sandboxId: string;
  readonly hostId: string;
}

/** Whether the run is still the one the stage holds (not cancelled or retried). */
function stillCurrent(surfaceKey: string, clientRequestId: string): boolean {
  const stage = readStagedSandbox(surfaceKey);
  return (
    stage !== null &&
    stage.phase === "creating" &&
    stage.clientRequestId === clientRequestId
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
  /** The name a create falls back to when the sheet set none. */
  readonly fallbackName: string;
  /** The task the surface is in; `null` on the landing composer. */
  readonly taskId: string | null;
  /**
   * Takes up a run a reload stopped, keeping its step and times; `false` for
   * a send, Keep waiting or Retry, which start the wait again.
   */
  readonly resume: boolean;
}

/** Which run a step belongs to, and what its create adds. */
interface StagedRun extends StagedRunRequest {
  readonly surfaceKey: string;
  readonly clientRequestId: string;
}

async function startTarget(
  run: StagedRun,
  target: StagedSandboxTarget,
  deps: StagedSandboxRunDeps,
): Promise<StartedSandbox | null> {
  const { surfaceKey, clientRequestId, fallbackName, taskId } = run;
  if (target.kind === "existing") {
    useStagedSandboxStore.getState().report(surfaceKey, {
      createdSandboxId: target.sandboxId,
      createdHostId: target.hostId,
      step: "booting",
      stepAt: deps.now(),
    });
    const awake = await deps.wake(target.hostId);
    if (!stillCurrent(surfaceKey, clientRequestId)) return null;
    if (!awake) {
      fail(surfaceKey, { kind: "failed", code: "wake", step: "booting" });
      return null;
    }
    return { sandboxId: target.sandboxId, hostId: target.hostId };
  }
  const environmentId = await environmentIdFor(target, deps);
  if (!stillCurrent(surfaceKey, clientRequestId)) return null;
  if (environmentId === undefined) {
    fail(surfaceKey, { kind: "unavailable" });
    return null;
  }
  const request: SandboxCreateRequest = {
    os: target.shape.os,
    cpus: target.shape.cpus,
    memoryMb: target.shape.memoryMb,
    diskMb: target.shape.diskMb,
    region: target.shape.region,
    displayName: target.name.length > 0 ? target.name : fallbackName,
    idleMinutes: target.shape.idleMinutes,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    environmentId,
    // The shape's `null` is "never"; on a create `null` is the configuration's
    // default and `0` is never.
    destroyAfterRestingMinutes: target.shape.destroyAfterRestingMinutes ?? 0,
    // The surface's task; on the landing composer the task does not exist
    // yet, since it is created on the new host in phase 2.
    createdByTaskId: taskId,
    clientRequestId,
  };
  const result = await createSandbox(request, deps);
  if (!stillCurrent(surfaceKey, clientRequestId)) return null;
  if (result.kind !== "ok") {
    fail(
      surfaceKey,
      createFailure(
        result,
        target.configuration.kind === "team"
          ? target.configuration.teamName
          : null,
      ),
    );
    return null;
  }
  const { sandboxId, hostId } = result.accepted;
  useStagedSandboxStore.getState().report(surfaceKey, {
    createdSandboxId: sandboxId,
    createdHostId: hostId,
    step: "booting",
    stepAt: deps.now(),
  });
  return { sandboxId, hostId };
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
  request: SandboxCreateRequest,
  deps: StagedSandboxRunDeps,
): Promise<SandboxCreateFetchResult> {
  const { auth, directory, queryClient } = deps;
  const context = { userId: signedInUserId() };
  const observer = new QueryMutationObserver<SandboxCreateFetchResult>(
    queryClient,
    {
      mutationKey: sandboxMutationKeys.create(deps.userId),
      mutationFn: () => auth.createSandbox(request),
      onSettled: (result) => {
        if (!settledForStartingAccount(context)) return;
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

/** A refused create, as the line or the inline refusal says it. */
export function createFailure(
  failure: SandboxControlFailure,
  teamName: string | null,
): StagedSandboxFailure {
  if (failure.kind === "refused") {
    if (failure.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT) {
      return failure.reason === "unverified"
        ? { kind: "unverified" }
        : { kind: "credits", shortfallMc: failure.shortfallMc };
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
  };
}

/**
 * The stage's key rule for a create sent outside a stage (a row's Retry): a
 * fresh key only after a refusal answered before anything was created, or
 * when nothing was sent. Any other error may follow an accepted create, so
 * the next press reuses the key and the server joins that create.
 */
export function createErrorNeedsFreshKey(error: Error): boolean {
  if (!(error instanceof SandboxCreateError)) return false;
  return (
    error.failure === null ||
    refusedBeforeCreate(createFailure(error.failure, null), null)
  );
}

/**
 * Waits for the sandbox to be ready for the handoff, reporting each step:
 * booting until awake, applying until the settings verdict, delivering once
 * the host is connected. A failed row, settings that did not apply, or the
 * budget running out stop it with the failure on the line.
 */
async function settle(input: {
  readonly surfaceKey: string;
  readonly clientRequestId: string;
  readonly started: StartedSandbox;
  readonly deps: StagedSandboxRunDeps;
  readonly budgetFrom: number;
}): Promise<void> {
  const { surfaceKey, clientRequestId, started, deps, budgetFrom } = input;
  const deadline = budgetFrom + STAGED_CREATE_BUDGET_MS;
  while (deps.now() < deadline) {
    if (!stillCurrent(surfaceKey, clientRequestId)) return;
    const row = await readRow(deps, started.sandboxId);
    if (!stillCurrent(surfaceKey, clientRequestId)) return;
    const verdict = row === undefined ? null : settleVerdict(row);
    if (verdict !== null && verdict.kind === "failure") {
      fail(surfaceKey, verdict.failure);
      return;
    }
    if (verdict !== null) {
      report(surfaceKey, "applying", deps.now());
      void deps.directory.refresh();
      if (
        dialableHostEndpoint(deps.directory.findById(started.hostId)) !== null
      ) {
        report(surfaceKey, "delivering", deps.now());
        handOff(surfaceKey, started.hostId);
        return;
      }
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  if (!stillCurrent(surfaceKey, clientRequestId)) return;
  fail(surfaceKey, {
    kind: "timed-out",
    step: readStagedSandbox(surfaceKey)?.step ?? "booting",
  });
}

/**
 * One read of the sandbox's row: the row, `null` when the list answered
 * without it (it is gone), or `undefined` when the read failed, which says
 * nothing about the sandbox.
 */
async function readRow(
  deps: StagedSandboxRunDeps,
  sandboxId: string,
): Promise<SandboxSummary | null | undefined> {
  // The list query every surface reads, read fresh: the Sandboxes page and
  // the pickers see the new row as the wait does.
  const response = await deps.queryClient
    .fetchQuery({
      ...sandboxListQueryOptions(deps.auth, deps.userId, true),
      staleTime: 0,
    })
    .catch(() => undefined);
  if (response === undefined || response === null) return undefined;
  return response.sandboxes.find((row) => row.id === sandboxId) ?? null;
}

type SettleVerdict =
  | { readonly kind: "awake" }
  | { readonly kind: "failure"; readonly failure: StagedSandboxFailure };

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
            failure: { kind: "settings", code: row.failureCode ?? "settings" },
          }
        : { kind: "awake" };
    default:
      return null;
  }
}

/**
 * Phase 2's start: the surface is pinned to the new host and the stage moves
 * to `handoff`; the surface resubmits once its placement resolves there. A
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
