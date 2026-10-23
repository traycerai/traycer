import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type {
  StageConfiguration,
  StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";

/**
 * What a composer surface has picked and not yet started: a new sandbox to
 * create, or a resting sandbox of the person's to wake. A pick only stages;
 * the first action (the send, or the terminal open) creates or wakes it.
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
   * The create's idempotency key: minted at the first send and reused by
   * every repeat (a reload, Keep waiting, a second click), so the server
   * answers with the same row. Retry creation after a terminal failure
   * mints a new one. `null` before the first send, and on a wake.
   */
  readonly clientRequestId: string | null;
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
   * Starts the first action: the `clientRequestId` the stage already holds,
   * or a new one when `fresh` (Retry creation after a terminal failure) or
   * when it has none. Returns the id, `null` when nothing is staged.
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
        | "createdSandboxId"
        | "createdHostId"
        | "step"
        | "stepAt"
        | "failure"
      >
    >,
  ) => void;
  /** Back to staged with the draft and the key kept (Cancel and keep the draft). */
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
    createdSandboxId: null,
    createdHostId: null,
    startedAt: null,
    step: "creating",
    stepAt: null,
    failure: null,
  };
}

/**
 * A stage read back from storage. A create or wake that was running when the
 * app closed has no driver any more: it comes back `staged` with its key, so
 * the next send repeats the create with the same id and the server answers
 * with the row it already made.
 */
function rehydratedStage(stage: StagedSandbox): StagedSandbox {
  if (stage.phase === "staged") return stage;
  return {
    ...stage,
    phase: "staged",
    startedAt: null,
    stepAt: null,
    failure: null,
  };
}

export const useStagedSandboxStore = create<StagedSandboxStoreState>()(
  persist(
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
    {
      ...basePersistOptions(persistKey(STORE_KEYS.stagedSandbox)),
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ bySurface: state.bySurface }),
      merge: (persisted, current) => {
        const stored =
          typeof persisted === "object" &&
          persisted !== null &&
          "bySurface" in persisted &&
          typeof persisted.bySurface === "object" &&
          persisted.bySurface !== null
            ? (persisted.bySurface as StagedSandboxStoreState["bySurface"])
            : {};
        const bySurface: Record<string, StagedSandbox> = {};
        for (const [key, stage] of Object.entries(stored)) {
          if (stage !== undefined) bySurface[key] = rehydratedStage(stage);
        }
        return { ...current, bySurface };
      },
    },
  ),
);

/** The stage a surface holds, or `null`. */
export function useStagedSandbox(surfaceKey: string): StagedSandbox | null {
  return useStagedSandboxStore((s) => s.bySurface[surfaceKey] ?? null);
}

export function readStagedSandbox(surfaceKey: string): StagedSandbox | null {
  return useStagedSandboxStore.getState().bySurface[surfaceKey] ?? null;
}
