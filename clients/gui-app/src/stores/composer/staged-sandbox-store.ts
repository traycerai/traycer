import type {
  SandboxCreateRequest,
  SandboxRateLimit,
} from "@traycer/protocol/host/sandbox-control";
import type { SandboxSettingsSteps } from "@traycer/protocol/host/sandbox-settings";
import type { PendingStageRetryAction } from "@/lib/sandboxes/pending-sandbox-send-transition";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import type {
  StageConfiguration,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  sandboxCreateKey,
  sandboxCreateKeyForPress,
} from "@/lib/sandboxes/sandbox-create-key";
import type {
  ReturnedSandboxDraft,
  ReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createPendingStageStorage,
  pendingStageAttemptCurrent,
  readPendingStageAttempt,
  readPendingStageRecord,
  removeAcknowledgedStageRetry,
  requestPendingStageRetry,
  type PendingStagePress,
  type PendingStageRetryRequest,
} from "@/lib/sandboxes/pending-stage-storage";

/**
 * What a composer surface has picked and not yet started: a new sandbox to
 * create, or a resting sandbox of the person's to wake. A pick only stages;
 * the first action (the send, or the terminal open) creates or wakes it.
 *
 * A stage belongs to the draft in front of the person, so it lives in memory
 * only: a reload or a restart starts with nothing staged. The one exception is
 * a send already handed to its task ({@link PENDING_SEND_SURFACE_PREFIX}): its
 * stage is persisted, so a reload observes the same create, under the same
 * key, and never makes a second sandbox.
 */
export type StagedSandboxTarget =
  | {
      readonly kind: "new";
      readonly configuration: StageConfiguration;
      readonly shape: StageShape;
      readonly name: string;
      /** The class's wake string, or `null` for a class this build does not know. */
      readonly wakeString: string | null;
    }
  | {
      readonly kind: "existing";
      readonly hostId: string;
      readonly sandboxId: string;
      readonly name: string;
      readonly configuration: StageConfiguration;
      /** Resume a suspended sandbox, or start a stopped one. */
      readonly verb: "resume" | "start";
    };

/**
 * - `staged`: picked, nothing created.
 * - `creating`: the first action ran; the create or wake is under way.
 * - `handoff`: the sandbox is awake, its settings applied and its host
 *   connected; its pending send or composer action may proceed there.
 */
export type StagedSandboxPhase = "staged" | "creating" | "handoff";

/** The setup line's step: the last one reported, and since when. */
export type StagedSandboxStep =
  | "creating"
  | "booting"
  | "applying"
  | "delivering";

/** Why the first action stopped short, said on the line or above the draft. */
type StagedSandboxFailureDetail =
  | {
      readonly kind: "credits";
      readonly shortfallMc: number | null;
      readonly creditSource?: "personal" | "team-allowance" | "team" | null;
    }
  | { readonly kind: "unverified" }
  | { readonly kind: "shape" }
  | { readonly kind: "unavailable" }
  /** Refused for any other reason; the sentence is the refusal copy. */
  | {
      readonly kind: "refused";
      readonly message: string;
    }
  /** Failed after the create was accepted, or the wake failed. */
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly step: StagedSandboxStep;
    }
  /** Awake, but the configuration's settings did not apply. */
  | {
      readonly kind: "settings";
      readonly code: string;
      readonly steps?: SandboxSettingsSteps | null;
    }
  /** The budget ran out with the sandbox still on its way. */
  | { readonly kind: "timed-out"; readonly step: StagedSandboxStep }
  /** A reload's run found the sandbox at rest: nobody asked it to wake. */
  | { readonly kind: "rested" }
  /** The sandbox is up, and runs no agent the send can take. */
  | { readonly kind: "no-provider" }
  /** The sandbox is up; its own Traycer Inference switch is off. */
  | { readonly kind: "traycer-off" }
  /** The sandbox is up, but its catalogue does not offer the requested agent. */
  | { readonly kind: "agent-not-offered"; readonly harnessId: GuiHarnessId }
  /**
   * The sandbox is up; the requested agent's install there failed. `detail`
   * is the host's own sentence for it.
   */
  | { readonly kind: "agent-setup-failed"; readonly detail: string }
  /** The sandbox is up; the send handed to it stopped short of its create. */
  | { readonly kind: "not-sent" };

export type StagedSandboxFailure = StagedSandboxFailureDetail & {
  readonly sandboxId?: string;
  readonly retryCreate?: SandboxCreateRequest;
  readonly retryRowVerified?: true;
  /** A current exact by-ID read could not reach the accepted row. */
  readonly acceptedRowNotFound?: true;
  readonly rowlessCreateRefusal?: {
    readonly createKey: string;
    readonly attemptId: string | undefined;
  };
};

interface StagedCreateRetryRow {
  readonly sandboxId: string;
  readonly failure: StagedSandboxFailure;
}

export interface StagedSandbox {
  /** The original create bound and this driver's post-preflight clock; absent on legacy stages. */
  readonly createAttempt?: {
    readonly budgetMs: number;
    readonly startedAt: number;
  } | null;
  /** The create's latest quota wait, refreshed by accepted and polled rows. */
  readonly rateLimit?: SandboxRateLimit | null;
  /** A same-account window asks the exclusive owner to retry this stage. */
  readonly retryRequest?: PendingStageRetryRequest;
  /** Only the owner acknowledges a mailbox request after executing its retry. */
  readonly retryHandledId?: string;
  readonly target: StagedSandboxTarget;
  readonly phase: StagedSandboxPhase;
  /**
   * The stage's identity and create key, assigned when the stage is picked.
   * Legacy stages persisted before a create started may still carry `null`.
   */
  readonly clientRequestId: string | null;
  /** The POST a reload or Keep waiting repeats. Older stages only have the base key. */
  readonly lastCreateKey?: string;
  /** Local attempt identity; the server key can repeat after a rowless refusal. */
  readonly attemptId?: string;
  /** Receipt that committed this attempt, independent of later stale acknowledgements. */
  readonly attemptRetryId?: string;
  /** The exact create request selected for that key, including the first POST. */
  readonly lastRetryCreate?: SandboxCreateRequest;
  /** A named refusal selected for Retry whose row still needs to be read. */
  readonly createRetryRow?: StagedCreateRetryRow;
  readonly returnedDraft?: ReturnedSandboxDraft;
  /**
   * The draft whose send started the action, where a surface holds several
   * (the landing composer's drafts share one window pin): only its composer
   * resubmits in phase 2. `null` before the first send, and on a surface
   * with one draft.
   */
  readonly ownerId: string | null;
  /** The created (or woken) sandbox, once the server named it. */
  readonly createdSandboxId: string | null;
  readonly createdHostId: string | null;
  /** When the first action ran (epoch ms); `null` while staged. */
  readonly startedAt: number | null;
  readonly step: StagedSandboxStep;
  /** When `step` was last reported (epoch ms). */
  readonly stepAt: number | null;
  readonly failure: StagedSandboxFailure | null;
  /**
   * A terminal agent's Start the stage took, launched on the new host in
   * phase 2 in place of a send; `null` when it took a send. Kept with the
   * stage, so a composer that remounts meanwhile still launches it.
   */
  readonly terminalLaunch: TerminalAgentLaunch | null;
  /**
   * A folderless terminal was asked for on the sandbox (a row's Open
   * terminal, the landing panel's `+`): the landing panel opens it on the
   * handoff, once the sandbox is awake. Cleared when it is asked for.
   */
  readonly openTerminal: boolean;
  /**
   * A send or a terminal agent's Start took the stage, so phase 2 resubmits
   * the surface's draft. `false` while it is only staged, or when an explicit
   * terminal ask started it alone: that handoff opens the terminal and sends
   * nothing.
   */
  readonly sendTaken: boolean;
}

/** A stage can replace a failed create while a failed wake keeps its sandbox. */
export function stagedFailedSandboxId(stage: StagedSandbox): string | null {
  if (stage.target.kind !== "new") return null;
  const { failure } = stage;
  if (failure?.acceptedRowNotFound === true) return null;
  if (failure?.sandboxId !== undefined) return failure.sandboxId;
  // Older builds marked "gone" from list omission alone.
  return failure?.kind === "failed" &&
    failure.code !== "wake" &&
    failure.code !== "gone"
    ? stage.createdSandboxId
    : null;
}

export function stagedCreateRetryPayload(
  stage: StagedSandbox,
  key: string | null,
): SandboxCreateRequest | undefined {
  const failed = stage.failure?.retryCreate;
  if (failed !== undefined && failed.clientRequestId === key) return failed;
  const last = stage.lastRetryCreate;
  return last?.clientRequestId === key ? last : undefined;
}

export function stagedCreateRetryRow(
  stage: StagedSandbox,
  key: string | null,
): StagedCreateRetryRow | undefined {
  if (key === null || stage.lastRetryCreate?.clientRequestId === key)
    return undefined;
  const pending = stage.createRetryRow;
  if (
    pending !== undefined &&
    sandboxCreateKey("retry", pending.sandboxId) === key
  )
    return pending;
  const { failure } = stage;
  const sandboxId = stagedFailedSandboxId(stage);
  if (
    failure === null ||
    sandboxId === null ||
    sandboxCreateKey("retry", sandboxId) !== key
  )
    return undefined;
  // Older direct refusals could carry the attempted body under the row's retry key.
  if (
    failure.retryCreate !== undefined &&
    (failure.kind === "failed" || failure.retryRowVerified === true)
  )
    return undefined;
  return { sandboxId, failure };
}

function stagedAttemptPayload(
  stage: StagedSandbox,
  key: string,
  pressed: SandboxCreateRequest | undefined,
): SandboxCreateRequest | undefined {
  const saved = stage.lastRetryCreate;
  if (key === stagedCreateAttemptKey(stage) && saved?.clientRequestId === key)
    return saved;
  return pressed?.clientRequestId === key
    ? pressed
    : stagedCreateRetryPayload(stage, key);
}

export function newStagedSandboxKey(): string {
  return sandboxCreateKey("stage", uuidv4());
}

export function stagedCreateAttemptKey(stage: StagedSandbox): string | null {
  return stage.lastCreateKey ?? stage.clientRequestId;
}

/** Cancel can start over when the exact create is known to have ended. */
export function stagedCancelStartsOver(
  surfaceKey: string,
  stage: StagedSandbox,
): boolean {
  return (
    (stage.target.kind === "new" &&
      stage.failure?.acceptedRowNotFound === true) ||
    stagedFailedSandboxId(stage) !== null ||
    stagedCreateRefusedWithoutRow(surfaceKey, stage)
  );
}

/** Only a current, recorded pre-reservation refusal proves a new key is safe. */
export function stagedCreateRefusedWithoutRow(
  surfaceKey: string,
  stage: StagedSandbox,
): boolean {
  const proof = stage.failure?.rowlessCreateRefusal;
  if (
    proof === undefined ||
    stage.target.kind !== "new" ||
    stage.createdSandboxId !== null ||
    stage.createdHostId !== null ||
    stagedCreateAttemptKey(stage) !== proof.createKey ||
    stage.attemptId !== proof.attemptId
  )
    return false;
  if (!surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) return true;
  const durable = readPendingStageAttempt(
    surfaceKey,
    stage.clientRequestId,
    proof.createKey,
    proof.attemptId,
  );
  return (
    durable?.createdSandboxId === null &&
    durable.createdHostId === null &&
    JSON.stringify(durable.failure) === JSON.stringify(stage.failure)
  );
}

/** The key for the failure shown in the window where Retry was pressed. */
export function stagedRetryKey(stage: StagedSandbox): string | null {
  if (stage.target.kind !== "new" || stage.clientRequestId === null)
    return null;
  return sandboxCreateKeyForPress(
    stage.clientRequestId,
    stagedFailedSandboxId(stage),
    stage.lastCreateKey ?? null,
  );
}

/**
 * The stage's sandbox rested on its own while its delivery waited: it had
 * woken (the settings step is reported only once its row reads awake, and a
 * handoff only once it is ready) and is listed suspended or stopped now.
 * Nobody asked for that rest, so nothing wakes it and the delivery is over.
 * A send, Keep waiting or Retry starts the wait again from its first step, so
 * its own wake never reads as one; a reload's run is nobody's gesture, so what
 * it finds at rest counts whatever the step. Settings that didn't apply keep their own
 * line, which says the sandbox's state.
 */
export function stagedSandboxRested(
  stage: StagedSandbox,
  resting: boolean,
): boolean {
  if (!resting || stage.failure?.kind === "settings") return false;
  if (stage.phase === "handoff" || stage.failure?.kind === "rested")
    return true;
  return (
    stage.phase === "creating" &&
    (stage.step === "applying" || stage.step === "delivering")
  );
}

interface RestoredSandboxPick extends ReturnedSandbox {
  readonly returnedDraft?: ReturnedSandboxDraft;
}

interface StagedSandboxStoreState {
  /** Keyed by the composer surface's host-pin key. */
  readonly bySurface: Readonly<Partial<Record<string, StagedSandbox>>>;
  /**
   * Counts `clearAll` teardowns, and nothing else: a stage gone with one was
   * not sent or replaced, so a shown draft's returned sandbox is put back.
   */
  readonly teardowns: number;
  /** Stages a pick, replacing whatever the surface had staged. */
  readonly stage: (surfaceKey: string, target: StagedSandboxTarget) => void;
  /** Restages a returned draft's pick under its existing create key. */
  readonly restore: (surfaceKey: string, returned: RestoredSandboxPick) => void;
  /** Drops the stage: another pick, or the handoff completed. */
  readonly clear: (surfaceKey: string) => void;
  /**
   * Moves a surface's stage, as it stands, to another key: a send handed to
   * its task takes the composer's stage (its key included, so a create the
   * server may have accepted is named again) and the composer stages nothing.
   */
  readonly adopt: (fromSurfaceKey: string, toSurfaceKey: string) => void;
  /** Updates the staged target while retaining its identity. */
  readonly setTarget: (surfaceKey: string, target: StagedSandboxTarget) => void;
  /**
   * Starts an action and returns the stage's identity, or `null` if no
   * stage exists. `resume` keeps the step and times of an interrupted run.
   */
  readonly begin: (
    surfaceKey: string,
    now: number,
    options: PendingStagePress & {
      readonly resume: boolean;
      readonly retryRequestId?: string;
    },
  ) => string | null;
  readonly acknowledgeRetry: (
    surfaceKey: string,
    requestId: string,
    clearFailure: boolean,
  ) => boolean;
  /**
   * Takes up the run still driving the stage's key after a Cancel: back to
   * `creating` with its step and times as that run left them.
   */
  readonly rejoin: (surfaceKey: string) => void;
  readonly report: (
    surfaceKey: string,
    patch: Partial<
      Pick<
        StagedSandbox,
        | "phase"
        | "clientRequestId"
        | "lastCreateKey"
        | "lastRetryCreate"
        | "createRetryRow"
        | "ownerId"
        | "createdSandboxId"
        | "createdHostId"
        | "startedAt"
        | "step"
        | "stepAt"
        | "failure"
        | "rateLimit"
        | "terminalLaunch"
        | "openTerminal"
        | "sendTaken"
        | "retryHandledId"
        | "createAttempt"
      >
    >,
  ) => void;
  /** Keeps the draft. A person's start-over action restages a failed pick. */
  readonly cancel: (surfaceKey: string, restageFailed: boolean) => void;
  readonly requestRetry: (
    surfaceKey: string,
    userId: string | null,
    action: PendingStageRetryAction,
    press: PendingStagePress,
  ) => Promise<string | null>;
  /**
   * The account changed: drops every composer's stage. A send's stage stays:
   * it may name a create the server accepted, and is that send's only record
   * of it. Only its own account's driver reads it again.
   */
  readonly clearAll: () => void;
}

function withStage(
  bySurface: StagedSandboxStoreState["bySurface"],
  surfaceKey: string,
  update: (stage: StagedSandbox) => StagedSandbox,
): StagedSandboxStoreState["bySurface"] {
  const stage = bySurface[surfaceKey];
  if (stage === undefined) return bySurface;
  return { ...bySurface, [surfaceKey]: update(stage) };
}

function observedAttemptMatches(
  stage: StagedSandbox,
  press: PendingStagePress,
): boolean {
  const currentKey = stagedCreateAttemptKey(stage);
  return (
    (press.observedCreateKey === undefined ||
      press.observedCreateKey === currentKey) &&
    (press.observedAttemptId === undefined ||
      press.observedAttemptId === (stage.attemptId ?? null)) &&
    (stage.failure?.acceptedRowNotFound !== true ||
      (press.createKey ?? currentKey) === currentKey)
  );
}

/** Commit a pending attempt before publishing it to the driver. */
function persistPendingStageBegin(
  surfaceKey: string,
  before: StagedSandbox,
  bySurface: StagedSandboxStoreState["bySurface"],
): boolean {
  const next = bySurface[surfaceKey];
  const current = useStagedSandboxStore.getState().bySurface;
  const { storage, name, version } = useStagedSandboxStore.persist.getOptions();
  const durable = readPendingStageAttempt(
    surfaceKey,
    before.clientRequestId,
    stagedCreateAttemptKey(before),
    before.attemptId,
  );
  if (
    next === undefined ||
    current[surfaceKey] !== before ||
    durable === null ||
    storage === undefined ||
    name === undefined
  )
    return false;
  try {
    // The pending-stage adapter writes synchronously. A readback also covers
    // a header write failing after the attempt record committed.
    void storage.setItem(name, {
      state: { bySurface: persistedStages(bySurface) },
      version,
    });
  } catch {
    // Leave the prior stage visible if its record could not advance.
  }
  const saved = readPendingStageRecord(surfaceKey);
  const { retryRequest: _mailbox, ...expected } = next;
  if (
    JSON.stringify(saved) !== JSON.stringify(expected) ||
    useStagedSandboxStore.getState().bySurface !== current
  ) {
    if (JSON.stringify(saved) !== JSON.stringify(durable))
      void useStagedSandboxStore.persist.rehydrate();
    return false;
  }
  try {
    useStagedSandboxStore.setState({ bySurface });
  } catch {
    // The record was verified before publishing the attempt.
  }
  return useStagedSandboxStore.getState().bySurface[surfaceKey] === next;
}

/** A mailbox acknowledgement and the progress it starts share one record. */
function persistStageRetry(
  surfaceKey: string,
  requestId: string,
  bySurface: StagedSandboxStoreState["bySurface"],
): boolean {
  const before = useStagedSandboxStore.getState().bySurface;
  const stage = before[surfaceKey];
  if (
    stage === undefined ||
    !pendingStageAttemptCurrent(
      surfaceKey,
      stage.clientRequestId,
      stagedCreateAttemptKey(stage),
      stage.attemptId,
    )
  )
    return false;
  try {
    useStagedSandboxStore.setState({ bySurface });
  } catch {
    // A failed header write can still leave the new stage record intact.
  }
  if (readPendingStageRecord(surfaceKey)?.retryHandledId === requestId) {
    if (stage.retryRequest?.id === requestId) {
      removeAcknowledgedStageRetry(surfaceKey, stage.retryRequest);
      queueMicrotask(() => void useStagedSandboxStore.persist.rehydrate());
    }
    return true;
  }
  try {
    useStagedSandboxStore.setState({ bySurface: before });
  } catch {
    // The mailbox remains pending in storage.
  }
  return false;
}

function stagedPick({
  target,
  clientRequestId,
  lastCreateKey,
  lastRetryCreate,
  createRetryRowId,
  returnedDraft,
}: RestoredSandboxPick): StagedSandbox {
  return {
    target,
    createAttempt: null,
    phase: "staged",
    clientRequestId: clientRequestId ?? newStagedSandboxKey(),
    ...(lastCreateKey === undefined ? {} : { lastCreateKey }),
    ...(lastRetryCreate !== undefined &&
    lastRetryCreate.clientRequestId === lastCreateKey
      ? { lastRetryCreate }
      : {}),
    ...(createRetryRowId === undefined
      ? {}
      : {
          createRetryRow: {
            sandboxId: createRetryRowId,
            failure: { kind: "unavailable" },
          },
        }),
    ...(returnedDraft === undefined ? {} : { returnedDraft }),
    ownerId: null,
    createdSandboxId: null,
    createdHostId: null,
    startedAt: null,
    step: "creating",
    stepAt: null,
    failure: null,
    terminalLaunch: null,
    openTerminal: false,
    sendTaken: false,
  };
}

/**
 * The surface key of a send handed to its task (`pending-sandbox-sends`):
 * the only stages that are persisted.
 */
export const PENDING_SEND_SURFACE_PREFIX = "pending-send:";

function persistedStages(
  bySurface: StagedSandboxStoreState["bySurface"],
): StagedSandboxStoreState["bySurface"] {
  return Object.fromEntries(
    Object.entries(bySurface).filter(([key]) =>
      key.startsWith(PENDING_SEND_SURFACE_PREFIX),
    ),
  );
}

export const useStagedSandboxStore = create<StagedSandboxStoreState>()(
  persist(
    (set, get) => ({
      bySurface: {},
      teardowns: 0,
      stage: (surfaceKey, target) =>
        get().restore(surfaceKey, { target, clientRequestId: null }),
      restore: (surfaceKey, returned) =>
        set((state) => ({
          bySurface: { ...state.bySurface, [surfaceKey]: stagedPick(returned) },
        })),
      clear: (surfaceKey) =>
        set((state) => {
          if (state.bySurface[surfaceKey] === undefined) return state;
          const next = { ...state.bySurface };
          delete next[surfaceKey];
          return { bySurface: next };
        }),
      adopt: (fromSurfaceKey, toSurfaceKey) =>
        set((state) => {
          const stage = state.bySurface[fromSurfaceKey];
          if (stage === undefined) return state;
          const { returnedDraft: _returned, ...pendingStage } = stage;
          const next = { ...state.bySurface, [toSurfaceKey]: pendingStage };
          delete next[fromSurfaceKey];
          return { bySurface: next };
        }),
      setTarget: (surfaceKey, target) =>
        set((state) => ({
          bySurface: withStage(state.bySurface, surfaceKey, (stage) => ({
            ...stage,
            target,
          })),
        })),
      begin: (surfaceKey, now, options) => {
        const { resume, createKey, retryCreate, retryRequestId } = options;
        const stage = get().bySurface[surfaceKey];
        if (stage === undefined || !observedAttemptMatches(stage, options))
          return null;
        // A legacy pending stage with no key still has its durable send ID.
        const clientRequestId =
          stage.clientRequestId ??
          sandboxCreateKey(
            "stage",
            surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length),
          );
        const previousKey = stage.lastCreateKey ?? clientRequestId;
        const lastCreateKey = createKey ?? previousKey;
        const createRetryRow = stagedCreateRetryRow(stage, lastCreateKey);
        const lastRetryCreate =
          createRetryRow === undefined
            ? stagedAttemptPayload(stage, lastCreateKey, retryCreate)
            : undefined;
        const replacing =
          lastCreateKey !== previousKey && stage.target.kind === "new";
        const resumed = resume && !replacing && stage.startedAt !== null;
        const bySurface = withStage(get().bySurface, surfaceKey, () => ({
          ...stage,
          phase: "creating",
          clientRequestId,
          lastCreateKey,
          attemptId: resumed ? stage.attemptId : uuidv4(),
          attemptRetryId:
            retryRequestId ?? (resumed ? stage.attemptRetryId : undefined),
          lastRetryCreate,
          createRetryRow,
          createdSandboxId: replacing ? null : stage.createdSandboxId,
          createdHostId: replacing ? null : stage.createdHostId,
          createAttempt: replacing ? null : stage.createAttempt,
          rateLimit: replacing ? null : stage.rateLimit,
          startedAt: resumed ? stage.startedAt : now,
          step: resumed ? stage.step : "creating",
          stepAt: resumed ? stage.stepAt : now,
          failure: null,
          ...(retryRequestId === undefined
            ? {}
            : { retryHandledId: retryRequestId }),
        }));
        if (retryRequestId !== undefined) {
          if (!persistStageRetry(surfaceKey, retryRequestId, bySurface))
            return null;
        } else if (surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)) {
          if (!persistPendingStageBegin(surfaceKey, stage, bySurface))
            return null;
        } else set({ bySurface });
        return clientRequestId;
      },
      acknowledgeRetry: (surfaceKey, requestId, clearFailure) =>
        persistStageRetry(
          surfaceKey,
          requestId,
          withStage(get().bySurface, surfaceKey, (stage) => ({
            ...stage,
            retryHandledId: requestId,
            failure: clearFailure ? null : stage.failure,
          })),
        ),
      rejoin: (surfaceKey) =>
        set((state) => ({
          bySurface: withStage(state.bySurface, surfaceKey, (stage) => ({
            ...stage,
            phase: "creating",
          })),
        })),
      report: (surfaceKey, patch) =>
        set((state) => ({
          bySurface: withStage(state.bySurface, surfaceKey, (stage) => ({
            ...stage,
            ...patch,
          })),
        })),
      cancel: (surfaceKey, restageFailed) =>
        set((state) => ({
          bySurface: withStage(state.bySurface, surfaceKey, (stage) => {
            if (!restageFailed || !stagedCancelStartsOver(surfaceKey, stage)) {
              return { ...stage, phase: "staged", failure: null };
            }
            return {
              ...stage,
              phase: "staged",
              clientRequestId: newStagedSandboxKey(),
              lastCreateKey: undefined,
              attemptId: undefined,
              attemptRetryId: undefined,
              lastRetryCreate: undefined,
              createRetryRow: undefined,
              returnedDraft: undefined,
              createdSandboxId: null,
              createdHostId: null,
              createAttempt: null,
              rateLimit: null,
              startedAt: null,
              stepAt: null,
              failure: null,
            };
          }),
        })),
      requestRetry: async (surfaceKey, userId, action, press) => {
        if ((useAuthStore.getState().profile?.userId ?? null) !== userId)
          return null;
        const stage = get().bySurface[surfaceKey];
        if (
          stage === undefined ||
          !surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)
        )
          return null;
        const id = requestPendingStageRetry({
          name: persistKey(STORE_KEYS.stagedSandboxSend),
          surfaceKey,
          userId,
          clientRequestId: stage.clientRequestId,
          sendId: surfaceKey.slice(PENDING_SEND_SURFACE_PREFIX.length),
          action,
          ...press,
          // An observed key belongs to the rendered press. Filling its
          // missing generation from the store can name a later attempt.
          observedAttemptId:
            press.observedCreateKey === undefined &&
            press.observedAttemptId === undefined
              ? (stage.attemptId ?? null)
              : press.observedAttemptId,
          observedCreateKey:
            press.observedCreateKey === undefined
              ? stagedCreateAttemptKey(stage)
              : press.observedCreateKey,
        });
        if (id !== null) await useStagedSandboxStore.persist.rehydrate();
        return id;
      },
      clearAll: () =>
        set((state) => ({
          bySurface: persistedStages(state.bySurface),
          teardowns: state.teardowns + 1,
        })),
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.stagedSandboxSend)),
      storage: createJSONStorage(createPendingStageStorage),
      partialize: (state) => ({ bySurface: persistedStages(state.bySurface) }),
      merge: (persisted, current) => ({
        ...current,
        bySurface: {
          // A different window writes only pending sends. Its snapshot must
          // never erase this window's unsubmitted composer picks.
          ...Object.fromEntries(
            Object.entries(current.bySurface).filter(
              ([key]) => !key.startsWith(PENDING_SEND_SURFACE_PREFIX),
            ),
          ),
          ...(
            persisted as
              | Partial<Pick<StagedSandboxStoreState, "bySurface">>
              | undefined
          )?.bySurface,
        },
      }),
    },
  ),
);

installCrossWindowRehydrate(
  useStagedSandboxStore,
  persistKey(STORE_KEYS.stagedSandboxSend),
);

/**
 * Says when a draft that owns a handoff is gone for good, once its phase 2 is
 * no longer mounted: `onGone` runs then (at once when it already is), and the
 * returned function stops watching. A modal's or a picker's owner is gone as
 * it unmounts ({@link ownerGoneOnUnmount}); a start page's draft is gone when
 * it closes, not when its composer unmounts for a draft switch or eviction.
 */
export type HandoffOwnerWatch = (onGone: () => void) => () => void;

export const ownerGoneOnUnmount: HandoffOwnerWatch = (onGone) => {
  onGone();
  return () => undefined;
};

interface HandoffOwner {
  /** Its mounted phase 2s; a remount holds it again before the release acts. */
  mounted: number;
  /** Set while it is unmounted but not gone. */
  stopWatching: (() => void) | null;
}

const handoffOwners = new Map<string, HandoffOwner>();

function handoffOwnerKey(surfaceKey: string, ownerId: string | null): string {
  return `${surfaceKey}\u0000${ownerId ?? ""}`;
}

/**
 * Whether the draft that sent on a surface is still there to resubmit: its
 * phase 2 mounted, or unmounted but not gone.
 */
export function handoffOwnerLive(
  surfaceKey: string,
  ownerId: string | null,
): boolean {
  return handoffOwners.has(handoffOwnerKey(surfaceKey, ownerId));
}

/**
 * Holds a draft's phase 2 mounted for a surface. Once none is mounted and the
 * draft is gone (`watch`), its send is abandoned, the draft kept: a handoff
 * still waiting on it is cleared (the sandbox stays awake), and a stage still
 * on its way, or stopped short, is left to the surface's next send or line
 * action to claim, with any terminal ask it carries.
 */
export function holdHandoffOwner(
  surfaceKey: string,
  ownerId: string | null,
  watch: HandoffOwnerWatch,
): () => void {
  const key = handoffOwnerKey(surfaceKey, ownerId);
  const owner = handoffOwners.get(key) ?? { mounted: 0, stopWatching: null };
  handoffOwners.set(key, owner);
  owner.mounted += 1;
  owner.stopWatching?.();
  owner.stopWatching = null;
  const gone = (): void => {
    if (handoffOwners.get(key) !== owner || owner.mounted > 0) return;
    handoffOwners.delete(key);
    owner.stopWatching?.();
    owner.stopWatching = null;
    const stage = readStagedSandbox(surfaceKey);
    if (stage === null || !stage.sendTaken || stage.ownerId !== ownerId) return;
    if (stage.phase === "creating") {
      useStagedSandboxStore
        .getState()
        .report(surfaceKey, { sendTaken: false, ownerId: null });
    } else if (stage.phase === "handoff" && stage.failure === null) {
      useStagedSandboxStore.getState().clear(surfaceKey);
    }
  };
  return () => {
    owner.mounted -= 1;
    if (owner.mounted > 0) return;
    // After the commit: a remount holds it again before this runs.
    queueMicrotask(() => {
      if (handoffOwners.get(key) !== owner || owner.mounted > 0) return;
      const stop = watch(gone);
      if (handoffOwners.get(key) === owner && owner.mounted === 0) {
        owner.stopWatching = stop;
      } else {
        stop();
      }
    });
  };
}

/** The stage a surface holds, or `null`. */
export function useStagedSandbox(surfaceKey: string): StagedSandbox | null {
  return useStagedSandboxStore((s) => s.bySurface[surfaceKey] ?? null);
}

/** The terminal agent's Start a surface's stage took, or `null`. */
export function useStagedTerminalLaunch(
  surfaceKey: string | null,
): TerminalAgentLaunch | null {
  return useStagedSandboxStore((s) =>
    surfaceKey === null
      ? null
      : (s.bySurface[surfaceKey]?.terminalLaunch ?? null),
  );
}

export function readStagedSandbox(surfaceKey: string): StagedSandbox | null {
  return useStagedSandboxStore.getState().bySurface[surfaceKey] ?? null;
}

/** A pending send can only POST a body committed to its current stage attempt. */
export function saveStagedCreateRequest(
  surfaceKey: string,
  request: SandboxCreateRequest,
): boolean {
  const stage = readStagedSandbox(surfaceKey);
  const key = request.clientRequestId;
  if (stage === null || key === null || key !== stagedCreateAttemptKey(stage))
    return false;
  const readCurrent = () =>
    surfaceKey.startsWith(PENDING_SEND_SURFACE_PREFIX)
      ? readPendingStageAttempt(
          surfaceKey,
          stage.clientRequestId,
          key,
          stage.attemptId,
        )
      : readStagedSandbox(surfaceKey);
  const current = readCurrent();
  if (current?.phase !== "creating") return false;
  const payload = JSON.stringify(request);
  if (current.lastRetryCreate !== undefined)
    return JSON.stringify(current.lastRetryCreate) === payload;
  try {
    useStagedSandboxStore
      .getState()
      .report(surfaceKey, { lastRetryCreate: request });
  } catch {
    // A header failure may follow a committed stage record. Read back the record.
  }
  const saved = readCurrent();
  return (
    saved?.phase === "creating" &&
    JSON.stringify(saved.lastRetryCreate) === payload
  );
}
