import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED,
  type SandboxCreateRequest,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxCreateFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import type { AuthService } from "@/lib/auth/auth-service";
import type { HostDirectoryService } from "@/lib/host";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
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
   * Wakes a resting sandbox, joining a wake already in flight
   * (`startSandboxWake`); resolves `true` once it is awake.
   */
  readonly wake: (hostId: string) => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Surfaces whose phase 1 is running in this window: one run per surface. */
const running = new Set<string>();

/**
 * Phase 1 of the composer's two-phase handoff (sandboxes plan D1): create the
 * staged sandbox (or wake the staged resting one), then wait until it is
 * awake, its settings applied (`guestConfigured !== false`) and its host
 * connected. Then it pins the surface to the new host and moves the stage to
 * `handoff`; phase 2, the surface's own resubmit, runs from there.
 *
 * Owned by the store, not by a component: the composer may unmount, and the
 * stage, its idempotency key and the draft outlive it. A repeat (a reload,
 * Keep waiting, a second click) reuses the key, so the server answers with
 * the row it already made; `fresh` (Retry creation after a terminal failure)
 * mints a new one.
 */
export async function runStagedSandbox(
  surfaceKey: string,
  fresh: boolean,
  fallbackName: string,
  deps: StagedSandboxRunDeps,
): Promise<void> {
  if (running.has(surfaceKey)) return;
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null || stage.phase === "handoff") return;
  running.add(surfaceKey);
  try {
    const clientRequestId = useStagedSandboxStore
      .getState()
      .begin(surfaceKey, fresh, deps.now());
    if (clientRequestId === null) return;
    const started = await startTarget(
      { surfaceKey, clientRequestId, fallbackName },
      stage.target,
      deps,
    );
    if (started === null) return;
    await settle(surfaceKey, clientRequestId, started, deps);
  } finally {
    running.delete(surfaceKey);
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

/** Which run a step belongs to, and the name a create falls back to. */
interface StagedRun {
  readonly surfaceKey: string;
  readonly clientRequestId: string;
  readonly fallbackName: string;
}

async function startTarget(
  run: StagedRun,
  target: StagedSandboxTarget,
  deps: StagedSandboxRunDeps,
): Promise<StartedSandbox | null> {
  const { surfaceKey, clientRequestId, fallbackName } = run;
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
  const environmentId = await environmentIdFor(target, deps.auth);
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
    // The task does not exist yet: it is created on the new host in phase 2.
    createdByTaskId: null,
    clientRequestId,
  };
  const result = await deps.auth.createSandbox(request);
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
  auth: AuthService,
): Promise<string | null | undefined> {
  if (target.configuration.kind === "personal") return null;
  const answer = await auth.getTeamEnvironment(target.configuration.teamId);
  return answer.kind === "ok" ? answer.environmentId : undefined;
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
 * Waits for the sandbox to be ready for the handoff, reporting each step:
 * booting until awake, applying until the settings verdict, delivering once
 * the host is connected. A failed row, settings that did not apply, or the
 * budget running out stop it with the failure on the line.
 */
async function settle(
  surfaceKey: string,
  clientRequestId: string,
  started: StartedSandbox,
  deps: StagedSandboxRunDeps,
): Promise<void> {
  const startedAt = readStagedSandbox(surfaceKey)?.startedAt ?? deps.now();
  const deadline = startedAt + STAGED_CREATE_BUDGET_MS;
  while (deps.now() < deadline) {
    if (!stillCurrent(surfaceKey, clientRequestId)) return;
    const row = await readRow(deps.auth, started.sandboxId);
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
  auth: AuthService,
  sandboxId: string,
): Promise<SandboxSummary | null | undefined> {
  const result = await auth.listSandboxes();
  if (result.kind !== "ok") return undefined;
  return result.response.sandboxes.find((row) => row.id === sandboxId) ?? null;
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
 * to `handoff`; the surface resubmits once its placement resolves there.
 */
function handOff(surfaceKey: string, hostId: string): void {
  useSurfaceHostSelectionStore.getState().setSelection(surfaceKey, hostId);
  useStagedSandboxStore.getState().report(surfaceKey, { phase: "handoff" });
}
