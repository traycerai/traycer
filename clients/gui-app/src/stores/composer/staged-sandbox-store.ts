import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type {
  StageConfiguration,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";

/**
 * What a composer surface has picked and not yet started: a new sandbox to
 * create, or a resting sandbox of the person's to wake. A pick only stages;
 * the first action (the send, or the terminal open) creates or wakes it.
 *
 * A stage belongs to the draft in front of the person, so it lives in memory
 * only: a reload or a restart starts with nothing staged.
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
 *   connected; the composer is resubmitting on it.
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
  | { readonly kind: "credits"; readonly shortfallMc: number | null }
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
  | { readonly kind: "settings"; readonly code: string }
  /** The budget ran out with the sandbox still on its way. */
  | { readonly kind: "timed-out"; readonly step: StagedSandboxStep }
  /** The sandbox is up; no usable provider runs agents on it. */
  | { readonly kind: "no-provider" };

export interface StagedSandbox {
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
}

interface StagedSandboxStoreState {
  /** Keyed by the composer surface's host-pin key. */
  readonly bySurface: Readonly<Partial<Record<string, StagedSandbox>>>;
  /** Stages a pick, replacing whatever the surface had staged. */
  readonly stage: (surfaceKey: string, target: StagedSandboxTarget) => void;
  /** Drops the stage: another pick, or the handoff completed. */
  readonly clear: (surfaceKey: string) => void;
  /** Rewrites the staged target in place (the shape sheet's Use this shape). */
  readonly setTarget: (surfaceKey: string, target: StagedSandboxTarget) => void;
  /**
   * Starts an action: a new `clientRequestId` when `fresh` (a send, or Retry
   * creation after a terminal failure) or when the stage has none, else the
   * one it holds (a repeat of the same send). Returns the id, `null` when
   * nothing is staged.
   */
  readonly begin: (
    surfaceKey: string,
    fresh: boolean,
    now: number,
  ) => string | null;
  readonly report: (
    surfaceKey: string,
    patch: Partial<
      Pick<
        StagedSandbox,
        | "phase"
        | "ownerId"
        | "createdSandboxId"
        | "createdHostId"
        | "step"
        | "stepAt"
        | "failure"
      >
    >,
  ) => void;
  /** Back to staged with the draft kept (Cancel and keep the draft). */
  readonly cancel: (surfaceKey: string) => void;
  /** Drops every stage: the account changed. */
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
  };
}

export const useStagedSandboxStore = create<StagedSandboxStoreState>()(
  (set, get) => ({
    bySurface: {},
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
    setTarget: (surfaceKey, target) =>
      set((state) => ({
        bySurface: withStage(state.bySurface, surfaceKey, (stage) => ({
          ...stage,
          target,
        })),
      })),
    begin: (surfaceKey, fresh, now) => {
      const stage = get().bySurface[surfaceKey];
      if (stage === undefined) return null;
      const clientRequestId =
        fresh || stage.clientRequestId === null
          ? uuidv4()
          : stage.clientRequestId;
      set((state) => ({
        bySurface: withStage(state.bySurface, surfaceKey, (current) => ({
          ...current,
          phase: "creating",
          clientRequestId,
          createdSandboxId: fresh ? null : current.createdSandboxId,
          createdHostId: fresh ? null : current.createdHostId,
          startedAt: now,
          step: "creating",
          stepAt: now,
          failure: null,
        })),
      }));
      return clientRequestId;
    },
    report: (surfaceKey, patch) =>
      set((state) => ({
        bySurface: withStage(state.bySurface, surfaceKey, (stage) => ({
          ...stage,
          ...patch,
        })),
      })),
    cancel: (surfaceKey) =>
      set((state) => ({
        bySurface: withStage(state.bySurface, surfaceKey, (stage) => ({
          ...stage,
          phase: "staged",
          startedAt: null,
          stepAt: null,
          failure: null,
        })),
      })),
    clearAll: () => set({ bySurface: {} }),
  }),
);

/** The stage a surface holds, or `null`. */
export function useStagedSandbox(surfaceKey: string): StagedSandbox | null {
  return useStagedSandboxStore((s) => s.bySurface[surfaceKey] ?? null);
}

export function readStagedSandbox(surfaceKey: string): StagedSandbox | null {
  return useStagedSandboxStore.getState().bySurface[surfaceKey] ?? null;
}
