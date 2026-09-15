import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  BRANCH_TOUR_ORDER,
  firstStepOf,
  isTourId,
  nextStepOf,
  TOUR_STEP_IDS,
  type OnboardingBranch,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";

/**
 * The onboarding flow's PROGRESS: where the welcome modal is, which chain of
 * tours the user is on, and how far through each tour they are. Persisted per
 * install (machine-local, like the feature announcements), because finishing
 * the welcome modal is a fact about this install, not about the account.
 *
 * This store is the one authority for that progress. The welcome modal, the
 * tour host and Settings ▸ Onboarding all read it and call the actions
 * below; none of them keeps a second copy. What it deliberately does NOT
 * hold is anything transient about a running tour — a spotlight target, a
 * DOM handle, a generation counter — those stay in the tour host, since a
 * persisted DOM reference is a lie on the next launch.
 *
 * The old first-run tour persisted `completedAt` under a different key. That
 * key is migrated once at module load (`migrateLegacyOnboardingKey`) into a
 * state that says "welcome done, chain skipped, `legacyCompleted`", so a user
 * who finished the old tour is not greeted again, and Settings can say so.
 */

export type ModalStatus = "pending" | "in-progress" | "done" | "skipped";
export type ChainStatus =
  | "pending"
  | "active"
  | "paused"
  | "completed"
  | "skipped";
/** `single` is a Settings replay: the chain ends after its one tour. */
export type ChainScope = "branch" | "single";
export type TourStatus = "available" | "active" | "done" | "bypassed";
export type AdvanceReason = "next" | "auto" | "detour";

export interface TourProgress {
  readonly status: TourStatus;
  /** The step the tour is on; `null` reads as the tour's first step. */
  readonly stepId: string | null;
  readonly completedAt: number | null;
}

/**
 * Where the chain is playing: the draft or epic the tours point at, the tab
 * and host they run on, and the attempt the tour host is waiting on. Owned
 * by the flow, written by the tour host; Settings never reconstructs it.
 */
export interface OnboardingContext {
  readonly draftId: string | null;
  readonly epicId: string | null;
  readonly tabId: string | null;
  readonly hostId: string | null;
  readonly attemptId: string | null;
}

export interface OnboardingFlowData {
  readonly modal: ModalStatus;
  readonly modalPage: 1 | 2;
  readonly branch: OnboardingBranch | null;
  readonly chain: ChainStatus;
  readonly chainScope: ChainScope;
  readonly activeTourId: TourId | null;
  readonly tours: Readonly<Record<TourId, TourProgress>>;
  readonly context: OnboardingContext | null;
  /** Finished the OLD first-run tour before this build existed. */
  readonly legacyCompleted: boolean;
  /**
   * A REAL chain end (completed or skipped from an active or paused chain)
   * that the completion toast has not yet acknowledged. Persisted, so a
   * toast held at the moment the chain ended (the flow busy, no Settings
   * bridge yet) survives a reload; the legacy migration never sets it, so
   * an old-tour completer's synthetic `skipped` chain never toasts.
   */
  readonly completionPending: boolean;
}

interface OnboardingFlowActions {
  readonly startModal: () => void;
  readonly setModalPage: (page: 1 | 2) => void;
  readonly pauseModal: () => void;
  readonly finishModal: (branch: OnboardingBranch) => void;
  readonly skipModal: () => void;
  readonly setContext: (partial: Partial<OnboardingContext>) => void;
  readonly advance: (
    expectedTourId: TourId,
    expectedStepId: string,
    reason: AdvanceReason,
  ) => void;
  readonly pauseChain: () => void;
  readonly resumeChain: () => void;
  readonly skipChain: () => void;
  readonly completeChain: () => void;
  readonly replayTour: (tourId: TourId) => void;
  readonly showWelcomeModalAgain: () => void;
  /** The completion toast showed (or was claimed elsewhere). */
  readonly acknowledgeCompletion: () => void;
}

/**
 * In memory, not persisted: the count of chain-level activations this
 * session - a chain start, resume, pause, end or replay that actually
 * changed the flow. The tour host keys everything that closes over "the
 * current run" on it (an old Joyride callback, a receipt announced before
 * a replay), because the persisted fields cannot tell a same-tour replay of
 * an unanchored lesson (context already null) from no change at all.
 */
export interface OnboardingFlowSession {
  readonly activationRevision: number;
}

export type OnboardingFlowState = OnboardingFlowData &
  OnboardingFlowSession &
  OnboardingFlowActions;

const AVAILABLE_TOUR: TourProgress = {
  status: "available",
  stepId: null,
  completedAt: null,
};

const EMPTY_CONTEXT: OnboardingContext = {
  draftId: null,
  epicId: null,
  tabId: null,
  hostId: null,
  attemptId: null,
};

/**
 * Spelled out per tour rather than built over `TOUR_IDS`, so the record is
 * typed without a cast and a tour added to the catalogue is a compile error
 * here until it is listed.
 */
function toursFrom(
  build: (id: TourId) => TourProgress,
): Record<TourId, TourProgress> {
  return {
    "add-folder": build("add-folder"),
    "terminal-mode": build("terminal-mode"),
    "submit-prompt": build("submit-prompt"),
    "task-panels": build("task-panels"),
    history: build("history"),
  };
}

export const INITIAL_FLOW: OnboardingFlowData = {
  modal: "pending",
  modalPage: 1,
  branch: null,
  chain: "pending",
  chainScope: "branch",
  activeTourId: null,
  tours: toursFrom(() => AVAILABLE_TOUR),
  context: null,
  legacyCompleted: false,
  completionPending: false,
};

/** What the migration writes for an install that finished the old tour. */
const LEGACY_COMPLETED_STATE: OnboardingFlowData = {
  ...INITIAL_FLOW,
  modal: "done",
  chain: "skipped",
  chainScope: "single",
  legacyCompleted: true,
};

// ── Pure transitions ────────────────────────────────────────────────────────

function withTour(
  data: OnboardingFlowData,
  tourId: TourId,
  progress: TourProgress,
): Readonly<Record<TourId, TourProgress>> {
  return { ...data.tours, [tourId]: progress };
}

/** "Activate tour T": on its first step, and the chain's active tour. */
function activate(
  data: OnboardingFlowData,
  tourId: TourId,
): OnboardingFlowData {
  return {
    ...data,
    activeTourId: tourId,
    tours: withTour(data, tourId, {
      status: "active",
      stepId: firstStepOf(tourId),
      completedAt: null,
    }),
  };
}

function completeChainOf(data: OnboardingFlowData): OnboardingFlowData {
  const active = data.activeTourId;
  const tours =
    active !== null && data.tours[active].status === "active"
      ? withTour(data, active, {
          status: "done",
          stepId: null,
          completedAt: Date.now(),
        })
      : data.tours;
  return {
    ...data,
    chain: "completed",
    activeTourId: null,
    tours,
    completionPending: true,
  };
}

/** The next `available` tour after `after` in the branch order, if any. */
function nextAvailableTour(
  data: OnboardingFlowData,
  after: TourId,
): TourId | null {
  if (data.branch === null) return null;
  const order = BRANCH_TOUR_ORDER[data.branch];
  const index = order.indexOf(after);
  if (index < 0) return null;
  for (const candidate of order.slice(index + 1)) {
    if (data.tours[candidate].status === "available") return candidate;
  }
  return null;
}

/**
 * A user who reached the task panels on their own, from one of the two tours
 * that lead there. The tour they left is finished - `done` for terminal-mode,
 * `bypassed` for submit-prompt - and anything the chain would have shown
 * between it and the panels is bypassed: shown as replayable, never counted
 * as done. A Settings replay ends on its own tour and never jumps.
 */
function detourFlow(
  data: OnboardingFlowData,
  fromTourId: TourId,
): OnboardingFlowData {
  if (fromTourId !== "terminal-mode" && fromTourId !== "submit-prompt") {
    return data;
  }
  const finished: TourProgress = {
    status: fromTourId === "terminal-mode" ? "done" : "bypassed",
    stepId: null,
    completedAt: fromTourId === "terminal-mode" ? Date.now() : null,
  };
  const afterFinish: OnboardingFlowData = {
    ...data,
    tours: withTour(data, fromTourId, finished),
  };
  if (data.chainScope === "single" || data.branch === null) {
    return completeChainOf(afterFinish);
  }
  return activate(
    { ...afterFinish, tours: bypassBetween(afterFinish, fromTourId) },
    "task-panels",
  );
}

/**
 * Every tour strictly between `from` and task-panels in the branch order
 * that is not already done becomes bypassed.
 */
function bypassBetween(
  data: OnboardingFlowData,
  from: TourId,
): Readonly<Record<TourId, TourProgress>> {
  if (data.branch === null) return data.tours;
  const order = BRANCH_TOUR_ORDER[data.branch];
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf("task-panels");
  if (fromIndex < 0 || toIndex <= fromIndex) return data.tours;
  let tours = data.tours;
  for (const between of order.slice(fromIndex + 1, toIndex)) {
    if (tours[between].status === "done") continue;
    tours = { ...tours, [between]: { ...AVAILABLE_TOUR, status: "bypassed" } };
  }
  return tours;
}

/** The tour is finished; the chain moves on, or ends. */
function finishTourFlow(
  data: OnboardingFlowData,
  tourId: TourId,
): OnboardingFlowData {
  const afterFinish: OnboardingFlowData = {
    ...data,
    tours: withTour(data, tourId, {
      status: "done",
      stepId: null,
      completedAt: Date.now(),
    }),
  };
  if (data.chainScope === "single") return completeChainOf(afterFinish);
  const following = nextAvailableTour(afterFinish, tourId);
  return following === null
    ? completeChainOf(afterFinish)
    : activate(afterFinish, following);
}

function advanceFlow(
  data: OnboardingFlowData,
  expectedTourId: TourId,
  expectedStepId: string,
  reason: AdvanceReason,
): OnboardingFlowData {
  if (data.chain !== "active" || data.activeTourId !== expectedTourId) {
    return data;
  }
  const current = data.tours[expectedTourId];
  const currentStep = current.stepId ?? firstStepOf(expectedTourId);
  if (currentStep !== expectedStepId) return data;
  if (reason === "detour") return detourFlow(data, expectedTourId);
  const next = nextStepOf(expectedTourId, currentStep);
  if (next === null) return finishTourFlow(data, expectedTourId);
  return {
    ...data,
    tours: withTour(data, expectedTourId, { ...current, stepId: next }),
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

const ONBOARDING_FLOW_PERSIST_KEY = persistKey(STORE_KEYS.onboardingFlow);

/**
 * The deleted first-run tour's key, spelled out: it is no longer in
 * `STORE_KEYS` (the leaf is retired), and this module is the one place that
 * may read it.
 */
export const LEGACY_ONBOARDING_PERSIST_KEY = persistKey("onboarding");

const MODAL_STATUSES: ReadonlyArray<ModalStatus> = [
  "pending",
  "in-progress",
  "done",
  "skipped",
];
const CHAIN_STATUSES: ReadonlyArray<ChainStatus> = [
  "pending",
  "active",
  "paused",
  "completed",
  "skipped",
];
const CHAIN_SCOPES: ReadonlyArray<ChainScope> = ["branch", "single"];
const TOUR_STATUSES: ReadonlyArray<TourStatus> = [
  "available",
  "active",
  "done",
  "bypassed",
];
const BRANCHES: ReadonlyArray<OnboardingBranch> = ["no-sessions", "sessions"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneOf<T extends string>(
  options: ReadonlyArray<T>,
  value: unknown,
  fallback: T,
): T {
  return options.find((option) => option === value) ?? fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function persistedTour(tourId: TourId, value: unknown): TourProgress {
  if (!isRecord(value)) return AVAILABLE_TOUR;
  const stepId =
    typeof value.stepId === "string" &&
    TOUR_STEP_IDS[tourId].some((step) => step === value.stepId)
      ? value.stepId
      : null;
  const completedAt =
    typeof value.completedAt === "number" && Number.isFinite(value.completedAt)
      ? value.completedAt
      : null;
  return {
    status: oneOf(TOUR_STATUSES, value.status, "available"),
    stepId,
    completedAt,
  };
}

function persistedContext(value: unknown): OnboardingContext | null {
  if (!isRecord(value)) return null;
  return {
    draftId: stringOrNull(value.draftId),
    epicId: stringOrNull(value.epicId),
    tabId: stringOrNull(value.tabId),
    hostId: stringOrNull(value.hostId),
    attemptId: stringOrNull(value.attemptId),
  };
}

/**
 * Field by field, each bad value falling back to ITS default: one corrupt
 * field must not reset a user's whole progress. `tours` is rebuilt over the
 * catalogue, so a tour a later build retired is dropped and one it added
 * starts available. The one cross-field invariant - the active tour is the
 * one the chain names - is repaired afterwards rather than by dropping
 * either field.
 */
function persistedFlowData(persistedState: unknown): OnboardingFlowData {
  if (!isRecord(persistedState)) return INITIAL_FLOW;
  const rawTours = isRecord(persistedState.tours) ? persistedState.tours : {};
  const rawActive = persistedState.activeTourId;
  const activeTourId =
    typeof rawActive === "string" && isTourId(rawActive) ? rawActive : null;
  const rawBranch = persistedState.branch;
  const branch =
    typeof rawBranch === "string"
      ? (BRANCHES.find((candidate) => candidate === rawBranch) ?? null)
      : null;
  const data: OnboardingFlowData = {
    modal: oneOf(MODAL_STATUSES, persistedState.modal, INITIAL_FLOW.modal),
    modalPage: persistedState.modalPage === 2 ? 2 : 1,
    branch,
    chain: oneOf(CHAIN_STATUSES, persistedState.chain, INITIAL_FLOW.chain),
    chainScope: oneOf(
      CHAIN_SCOPES,
      persistedState.chainScope,
      INITIAL_FLOW.chainScope,
    ),
    activeTourId,
    tours: toursFrom((id) => persistedTour(id, rawTours[id])),
    context: persistedContext(persistedState.context),
    legacyCompleted: persistedState.legacyCompleted === true,
    completionPending: persistedState.completionPending === true,
  };
  // The one cross-field invariant: a running (active or paused) chain names
  // an active tour. Two ways a blob breaks it - the id names a tour that is
  // not active, or there is no usable id at all (missing, or a tour a later
  // build retired, which validation turned into null) - and both get the
  // same repair, because a running chain with no selectable step is one that
  // can neither advance nor resume, and never settles. A valid paused
  // checkpoint - id, step and context - is kept exactly.
  const hasActiveTour =
    data.activeTourId !== null &&
    data.tours[data.activeTourId].status === "active";
  if (hasActiveTour) return data;
  const chainRunning = data.chain === "active" || data.chain === "paused";
  if (data.activeTourId === null && !chainRunning) return data;
  return {
    ...data,
    activeTourId: null,
    chain: chainRunning ? "pending" : data.chain,
  };
}

/**
 * Adopt the deleted tour's record, once. A user who finished it must not be
 * greeted by the welcome modal, so their `completedAt` becomes a settled
 * flow with `legacyCompleted` set; everything else about the old key is
 * dropped. The old key is removed either way, so this runs to completion
 * exactly once per install.
 *
 * A module-level function run BEFORE `create(...)`, not a `merge` or
 * `onRehydrateStorage`: zustand persists a merged state only on a version
 * bump, and the store constant is in its TDZ inside those callbacks - a
 * state seeded there would be lost on the next launch, and the old key could
 * not be removed safely.
 */
export function migrateLegacyOnboardingKey(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): "seeded" | "dropped" | "none" {
  const legacy = storage.getItem(LEGACY_ONBOARDING_PERSIST_KEY);
  if (legacy === null) return "none";
  storage.removeItem(LEGACY_ONBOARDING_PERSIST_KEY);
  if (storage.getItem(ONBOARDING_FLOW_PERSIST_KEY) !== null) return "dropped";
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return "dropped";
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return "dropped";
  const completedAt = parsed.state.completedAt;
  if (typeof completedAt !== "number" || !Number.isFinite(completedAt)) {
    return "dropped";
  }
  storage.setItem(
    ONBOARDING_FLOW_PERSIST_KEY,
    JSON.stringify({ state: LEGACY_COMPLETED_STATE, version: 1 }),
  );
  return "seeded";
}

if (typeof localStorage !== "undefined") {
  migrateLegacyOnboardingKey(localStorage);
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * The data fields alone - what persists, and what a surface that reads the
 * whole flow (Settings ▸ Onboarding) selects with `useShallow`, so it
 * re-renders on a field changing rather than on every store write.
 */
export function selectOnboardingFlowData(
  state: OnboardingFlowState,
): OnboardingFlowData {
  return dataOf(state);
}

function dataOf(state: OnboardingFlowState): OnboardingFlowData {
  return {
    modal: state.modal,
    modalPage: state.modalPage,
    branch: state.branch,
    chain: state.chain,
    chainScope: state.chainScope,
    activeTourId: state.activeTourId,
    tours: state.tours,
    context: state.context,
    legacyCompleted: state.legacyCompleted,
    completionPending: state.completionPending,
  };
}

export const useOnboardingFlowStore = create<OnboardingFlowState>()(
  persist(
    (set) => {
      // Every action is a pure transition over the data; returning the SAME
      // data object is how a no-op stays a no-op (zustand skips equal state).
      // A transition that moves the chain (its status, its scope, or a
      // replay's context reset - an `advance` that finishes the chain
      // included) is a chain-level activation and takes one more revision
      // in the same write; `activate` forces that for the actions that are
      // activations by definition even when the persisted fields look alike.
      const write = (
        transition: (data: OnboardingFlowData) => OnboardingFlowData,
        forceActivation: boolean,
      ): void => {
        set((state) => {
          const before = dataOf(state);
          const after = transition(before);
          if (after === before) return state;
          const moved =
            forceActivation ||
            after.chain !== before.chain ||
            after.chainScope !== before.chainScope ||
            (before.context !== null && after.context === null);
          return moved
            ? { ...after, activationRevision: state.activationRevision + 1 }
            : after;
        });
      };
      const update = (
        transition: (data: OnboardingFlowData) => OnboardingFlowData,
      ): void => {
        write(transition, false);
      };
      const activateChain = (
        transition: (data: OnboardingFlowData) => OnboardingFlowData,
      ): void => {
        write(transition, true);
      };
      return {
        ...INITIAL_FLOW,
        activationRevision: 0,
        startModal: () =>
          update((data) =>
            data.modal === "done" || data.modal === "skipped"
              ? data
              : { ...data, modal: "in-progress" },
          ),
        setModalPage: (page) =>
          update((data) =>
            data.modalPage === page ? data : { ...data, modalPage: page },
          ),
        // Esc on the welcome modal. Nothing changes: `modal` stays
        // `in-progress` on its page, which is exactly what brings the modal
        // back on the next launch. The action exists so the modal's three
        // exits - pause, finish, skip - are three calls on one surface.
        pauseModal: () => undefined,
        finishModal: (branch) =>
          activateChain((data) =>
            activate(
              {
                ...data,
                modal: "done",
                branch,
                chain: "active",
                chainScope: "branch",
              },
              BRANCH_TOUR_ORDER[branch][0],
            ),
          ),
        skipModal: () =>
          activateChain((data) =>
            activate(
              {
                ...data,
                modal: "skipped",
                branch: "no-sessions",
                chain: "active",
                chainScope: "branch",
              },
              "add-folder",
            ),
          ),
        setContext: (partial) =>
          update((data) => ({
            ...data,
            context: { ...(data.context ?? EMPTY_CONTEXT), ...partial },
          })),
        advance: (expectedTourId, expectedStepId, reason) =>
          update((data) =>
            advanceFlow(data, expectedTourId, expectedStepId, reason),
          ),
        pauseChain: () =>
          activateChain((data) =>
            data.chain === "active" ? { ...data, chain: "paused" } : data,
          ),
        resumeChain: () =>
          activateChain((data) =>
            data.chain === "paused" && data.activeTourId !== null
              ? { ...data, chain: "active" }
              : data,
          ),
        skipChain: () =>
          activateChain((data) => {
            if (data.chain !== "active" && data.chain !== "paused") return data;
            const tours =
              data.activeTourId === null
                ? data.tours
                : withTour(data, data.activeTourId, AVAILABLE_TOUR);
            return {
              ...data,
              chain: "skipped",
              activeTourId: null,
              tours,
              completionPending: true,
            };
          }),
        completeChain: () =>
          activateChain((data) =>
            data.chain === "active" || data.chain === "paused"
              ? completeChainOf(data)
              : data,
          ),
        replayTour: (tourId) =>
          activateChain((data) => {
            const previous = data.activeTourId;
            const released =
              previous === null || previous === tourId
                ? data.tours
                : withTour(data, previous, AVAILABLE_TOUR);
            return activate(
              {
                ...data,
                tours: released,
                chain: "active",
                chainScope: "single",
                context: null,
              },
              tourId,
            );
          }),
        showWelcomeModalAgain: () =>
          update((data) => ({ ...data, modal: "pending", modalPage: 1 })),
        acknowledgeCompletion: () =>
          update((data) =>
            data.completionPending
              ? { ...data, completionPending: false }
              : data,
          ),
      };
    },
    {
      ...basePersistOptions(ONBOARDING_FLOW_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...persistedFlowData(persistedState),
      }),
      partialize: dataOf,
    },
  ),
);

// ── Selectors ───────────────────────────────────────────────────────────────

/** The flow has nothing left to show on its own: modal answered, chain over. */
export function selectOnboardingSettled(data: OnboardingFlowData): boolean {
  return (
    (data.modal === "done" || data.modal === "skipped") &&
    (data.chain === "completed" || data.chain === "skipped")
  );
}

/** The welcome modal should open on this launch. */
export function selectFirstRunModalDue(data: OnboardingFlowData): boolean {
  return data.modal === "pending" || data.modal === "in-progress";
}

export function selectChainResumable(data: OnboardingFlowData): boolean {
  return data.chain === "paused" && data.activeTourId !== null;
}

export interface ActiveStep {
  readonly tourId: TourId;
  readonly stepId: string;
}

/** The step the tour host should show; a persisted `null` is the first. */
export function selectActiveStep(data: OnboardingFlowData): ActiveStep | null {
  const tourId = data.activeTourId;
  if (tourId === null) return null;
  return { tourId, stepId: data.tours[tourId].stepId ?? firstStepOf(tourId) };
}
