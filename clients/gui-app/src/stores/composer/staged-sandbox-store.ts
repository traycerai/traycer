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
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostPickRequestStore } from "@/stores/composer/host-pick-request-store";
import {
  createPendingStageStorage,
  requestPendingStageRetry,
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
export type StagedSandboxFailure =
  | {
      readonly kind: "credits";
      readonly shortfallMc: number | null;
      readonly creditSource?: "personal" | "team-allowance" | "team" | null;
    }
  | { readonly kind: "unverified" }
  | { readonly kind: "shape" }
  | { readonly kind: "unavailable" }
  /** Refused for any other reason; the sentence is the refusal copy. */
  | { readonly kind: "refused"; readonly message: string }
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

export interface StagedSandbox {
  /** A same-account window asks the exclusive owner to retry this stage. */
  readonly retryRequest?: PendingStageRetryRequest;
  /** Only the owner acknowledges a mailbox request after executing its retry. */
  readonly retryHandledId?: string;
  readonly target: StagedSandboxTarget;
  readonly phase: StagedSandboxPhase;
  /**
   * The create's idempotency key, one per send: minted when a send starts
   * and reused by every repeat of that send (Keep waiting, Retry), so the
   * server answers with the same row. `null` before the first send.
   */
  readonly clientRequestId: string | null;
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

/**
 * A refusal the server answered before anything was created. Any other
 * failure may follow an accepted, billed create (an answer that never came,
 * a sandbox that failed on its way up); so does any failure once a sandbox
 * was accepted, such as one frozen for credits while it settles.
 */
export function refusedBeforeCreate(
  failure: StagedSandboxFailure,
  createdSandboxId: string | null,
): boolean {
  if (createdSandboxId !== null) return false;
  switch (failure.kind) {
    case "credits":
    case "shape":
    case "unavailable":
    case "refused":
      return true;
    case "unverified":
    case "failed":
    case "settings":
    case "timed-out":
    case "rested":
    case "no-provider":
    case "traycer-off":
    case "agent-not-offered":
    case "agent-setup-failed":
    case "not-sent":
      return false;
  }
}

/**
 * Whether the stage's next action takes a new create key: it never started
 * one, the server refused that one before creating anything, or the sandbox
 * that key created failed (naming it again answers with the same failed row).
 * Every other stage may have an accepted, billed create behind it on its way,
 * which the next action names again so the server answers with the same row.
 * A wake failure keeps that sandbox, including one originally picked as New.
 */
export function stagedCreateNeedsFreshKey(stage: StagedSandbox): boolean {
  if (stage.clientRequestId === null) return true;
  if (stage.failure === null) return false;
  if (stage.failure.kind === "failed") {
    return stage.target.kind === "new" && stage.failure.code !== "wake";
  }
  return refusedBeforeCreate(stage.failure, stage.createdSandboxId);
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
  /** Drops the stage: another pick, or the handoff completed. */
  readonly clear: (surfaceKey: string) => void;
  /**
   * Moves a surface's stage, as it stands, to another key: a send handed to
   * its task takes the composer's stage (its key included, so a create the
   * server may have accepted is named again) and the composer stages nothing.
   */
  readonly adopt: (fromSurfaceKey: string, toSurfaceKey: string) => void;
  /** Rewrites the staged target in place (the shape sheet's Use this shape). */
  readonly setTarget: (surfaceKey: string, target: StagedSandboxTarget) => void;
  /**
   * Starts an action: a new `clientRequestId` when `fresh`
   * ({@link stagedCreateNeedsFreshKey}, or Retry creation after a terminal
   * failure) or when the stage has none, else the one it holds. Returns the
   * id, `null` when nothing is staged. `resume` takes up a run a reload
   * stopped: its step and times stay as they were persisted.
   */
  readonly begin: (
    surfaceKey: string,
    fresh: boolean,
    now: number,
    resume: boolean,
  ) => string | null;
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
        | "ownerId"
        | "createdSandboxId"
        | "createdHostId"
        | "startedAt"
        | "step"
        | "stepAt"
        | "failure"
        | "terminalLaunch"
        | "openTerminal"
        | "sendTaken"
        | "retryHandledId"
      >
    >,
  ) => void;
  /** Back to staged with the draft kept (Cancel and keep the draft). */
  readonly cancel: (surfaceKey: string) => void;
  readonly requestRetry: (
    surfaceKey: string,
    userId: string | null,
    action: PendingStageRetryAction,
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

function freshStage(target: StagedSandboxTarget): StagedSandbox {
  return {
    target,
    phase: "staged",
    clientRequestId: null,
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
        set((state) => ({
          bySurface: { ...state.bySurface, [surfaceKey]: freshStage(target) },
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
          const next = { ...state.bySurface, [toSurfaceKey]: stage };
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
      begin: (surfaceKey, fresh, now, resume) => {
        const stage = get().bySurface[surfaceKey];
        if (stage === undefined) return null;
        const clientRequestId =
          fresh || stage.clientRequestId === null
            ? uuidv4()
            : stage.clientRequestId;
        const resumed = resume && !fresh && stage.startedAt !== null;
        set((state) => ({
          bySurface: withStage(state.bySurface, surfaceKey, (current) => ({
            ...current,
            phase: "creating",
            clientRequestId,
            createdSandboxId: fresh ? null : current.createdSandboxId,
            createdHostId: fresh ? null : current.createdHostId,
            startedAt: resumed ? current.startedAt : now,
            step: resumed ? current.step : "creating",
            stepAt: resumed ? current.stepAt : now,
            failure: null,
          })),
        }));
        return clientRequestId;
      },
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
      cancel: (surfaceKey) =>
        set((state) => ({
          bySurface: withStage(state.bySurface, surfaceKey, (stage) => {
            // The key stays while a create may have been accepted, so the next
            // send names it again rather than billing a second sandbox; so do
            // its times, for a send that takes up the run still on its way.
            if (!stagedCreateNeedsFreshKey(stage)) {
              return { ...stage, phase: "staged", failure: null };
            }
            return {
              ...stage,
              phase: "staged",
              clientRequestId: null,
              startedAt: null,
              stepAt: null,
              failure: null,
            };
          }),
        })),
      requestRetry: async (surfaceKey, userId, action) => {
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

/** The host a stage wakes or was created on, while it has one. */
export function stagedHostId(stage: StagedSandbox | null): string | null {
  if (stage === null) return null;
  return stage.target.kind === "existing"
    ? stage.target.hostId
    : stage.createdHostId;
}

/**
 * A stage's fallback action: takes it off the surface, for the host the chip
 * falls back to. A stage on that very host goes nowhere by that, since the
 * surface stages the sandbox it sits on, so the host picker opens instead.
 */
export function leaveStagedSandbox(
  surfaceKey: string,
  fallbackHostId: string | null,
): void {
  const stage = readStagedSandbox(surfaceKey);
  if (stage !== null && stagedHostId(stage) === fallbackHostId) {
    useHostPickRequestStore.getState().request(surfaceKey);
    return;
  }
  useStagedSandboxStore.getState().clear(surfaceKey);
}
