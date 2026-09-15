import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useReducedMotion } from "motion/react";
import { useNavigate } from "@tanstack/react-router";
import {
  ACTIONS,
  EVENTS,
  STATUS,
  type EventData,
  type Step,
} from "react-joyride";
import { useShallow } from "zustand/react/shallow";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { activateTabIntent, openOrFocusEpicIntent } from "@/lib/tab-navigation";
import {
  selectPresentedModalCount,
  useModalPresenceStore,
} from "@/components/ui/modal-presence";
import {
  buildTourSteps,
  TASK_PANELS_UNBOUND_BODY,
  TOUR_LESSONS,
  tourLessonTitle,
  type TourStepAction,
} from "@/components/onboarding/tour/tour-steps";
import {
  getActivationToken,
  startActivationWatch,
  subscribeActivation,
} from "@/components/onboarding/tour/tour-activation";
import { useLiveBrowserGuestPresent } from "@/components/onboarding/tour/use-live-browser-guest-present";
import {
  createTargetTracker,
  cssAttributeValue,
  observeTourTargets,
  resolveAnchor,
  resolveHistoryRow,
  resolveLatestHistoryEpicId,
  resolvePanelTarget,
  type TargetSnapshot,
  type TargetTracker,
  type TourSurfaceScope,
} from "@/components/onboarding/tour/tour-targets";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  selectActiveStep,
  useOnboardingFlowStore,
  type ActiveStep,
  type AdvanceReason,
  type ChainStatus,
  type OnboardingContext,
} from "@/stores/onboarding/onboarding-flow-store";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import {
  BRANCH_TOUR_ORDER,
  type OnboardingBranch,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";
import {
  useLandingReceiptsStore,
  type LandingReceipt,
} from "@/stores/onboarding/landing-receipts-store";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import {
  sessionImportRunFor,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";
import { tabRefKey } from "@/stores/tabs/layout";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";

/**
 * The spotlight tour's controller: everything that decides WHAT Joyride
 * shows and what the flow store does about Joyride's events. The flow store
 * (`onboarding-flow-store.ts`) stays the one progress authority - this hook
 * never keeps a second copy of the step, only in-memory presentation state
 * (which node, whether the card is anchored, a renderer epoch) that a
 * persisted DOM handle could never be.
 *
 * Shape, in one breath: the active tour and its branch order give a
 * controlled `stepIndex`; a scoped resolver picks the target node and bumps
 * an `epoch` (the `<Joyride>` key) whenever the CHOSEN node changes so the
 * card re-presents (spike finding F5); `run` drops while any modal is
 * presented and resumes one macrotask later (F2); Joyride's events are
 * mapped to the store's guarded actions (`advance` / `pauseChain` /
 * `skipChain`) with the stale-event guards the spike measured (F1, F3); and
 * each lesson's own success predicate auto-advances from real store facts -
 * a new folder path, a terminal composer mode, an accepted-create receipt, a
 * user-opened epic - never from clicks or routes.
 */

export type TourPresentation =
  | "idle"
  | "resolving"
  | "presenting"
  | "unanchored"
  | "modal-suspended";

export interface OnboardingTourController {
  /** Joyride's `run`. */
  readonly run: boolean;
  /** Joyride's `steps` (one per tour of the chain's order). */
  readonly steps: Step[];
  /** Joyride's controlled `stepIndex`. */
  readonly stepIndex: number;
  /** `key` for `<Joyride>`: a new value re-presents the active lesson. */
  readonly rendererKey: string;
  readonly presentation: TourPresentation;
  /** A counted modal or the folder picker owns the screen (and Esc). */
  readonly modalSuspended: boolean;
  /**
   * A live local browser guest is on screen: the lesson stays, as the
   * unanchored card, since no dim can cover a native view.
   */
  readonly spotlightSuspended: boolean;
  readonly reducedMotion: boolean;
  readonly onEvent: (data: EventData) => void;
  /** Polite live-region text for the step that just presented. */
  readonly announcement: string | null;
}

type SuspensionState = "suspended" | "clearing" | "settled";

function readSuspended(): boolean {
  return (
    selectPresentedModalCount(useModalPresenceStore.getState()) > 0 ||
    useRemoteFolderPickerStore.getState().open
  );
}

interface SuspensionGate {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SuspensionState;
  /** Watch the modal count and the picker; returns stop. */
  readonly start: () => () => void;
}

/**
 * "A counted modal or the folder picker owns the screen", plus the one
 * macrotask of grace after it stops (spike finding F2): Radix handles the
 * Escape that closes a modal in a document capture listener, React flushes
 * the resulting commit in the microtask checkpoint between listeners, and a
 * `run=true` in that commit would re-arm Joyride's body keydown listener in
 * time for the SAME keydown to bubble to it and pause the tour. An external
 * store, like the target tracker, so the React side only reads it.
 */
function createSuspensionGate(): SuspensionGate {
  let state: SuspensionState = readSuspended() ? "suspended" : "settled";
  const listeners = new Set<() => void>();
  const publish = (next: SuspensionState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    start: () => {
      let timer: number | null = null;
      const onChange = (): void => {
        if (readSuspended()) {
          if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
          publish("suspended");
          return;
        }
        if (state === "settled" || timer !== null) return;
        publish("clearing");
        timer = window.setTimeout(() => {
          timer = null;
          publish("settled");
        }, 0);
      };
      const unsubscribeModals = useModalPresenceStore.subscribe(onChange);
      const unsubscribePicker = useRemoteFolderPickerStore.subscribe(onChange);
      onChange();
      return () => {
        unsubscribeModals();
        unsubscribePicker();
        if (timer !== null) window.clearTimeout(timer);
      };
    },
  };
}

const LANDING_TOURS: ReadonlyArray<TourId> = [
  "add-folder",
  "terminal-mode",
  "submit-prompt",
  "history",
];

/**
 * Esc / Pause tour in THIS window's lifetime. The flow store persists the
 * paused checkpoint; this keeps the host that mounts the tour from resuming
 * it in the same launch (resume is next-launch-only, ticket 4).
 */
let dismissedThisLaunch = false;

export function wasTourDismissedThisLaunch(): boolean {
  return dismissedThisLaunch;
}

export function resetTourDismissalForTests(): void {
  dismissedThisLaunch = false;
}

function trackStep(
  tour: TourId,
  step: string,
  action: "next" | "auto" | "skip" | "pause",
): void {
  Analytics.getInstance().track(AnalyticsEvent.OnboardingTourStep, {
    tour,
    step,
    action,
  });
}

function chainOrder(
  scope: "branch" | "single",
  branch: OnboardingBranch | null,
  active: TourId | null,
): ReadonlyArray<TourId> {
  if (active === null) return [];
  if (scope === "single" || branch === null) return [active];
  const order = BRANCH_TOUR_ORDER[branch];
  return order.includes(active) ? order : [active];
}

function refKey(ref: TabRef | null): string | null {
  return ref === null ? null : tabRefKey(ref);
}

/** The epic header tab for a focused epic ref, for its epic id and host. */
function epicTabFor(ref: TabRef): {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
} | null {
  if (ref.kind !== "epic") return null;
  const tab = getHeaderTabs().find(
    (candidate) => candidate.kind === "epic" && candidate.id === ref.id,
  );
  if (tab === undefined || tab.kind !== "epic") return null;
  return { epicId: tab.epicId, tabId: tab.id, hostId: tab.hostId };
}

function epicSurfaceMounted(tabId: string): boolean {
  return (
    document.querySelector(
      `[data-epic-surface="${cssAttributeValue(tabId)}"]`,
    ) !== null
  );
}

function receiptMatchesContext(
  receipt: LandingReceipt,
  context: OnboardingContext,
): boolean {
  return (
    receipt.attemptId === context.attemptId &&
    receipt.draftId === context.draftId &&
    (context.hostId === null || receipt.hostId === context.hostId)
  );
}

interface FlowSlice {
  readonly chain: ChainStatus;
  readonly chainScope: "branch" | "single";
  readonly branch: OnboardingBranch | null;
  readonly activeTourId: TourId | null;
  readonly stepId: string | null;
  readonly context: OnboardingContext | null;
}

interface LessonContext {
  readonly draftId: string | null;
  readonly tabId: string | null;
  readonly hostId: string | null;
  readonly attemptId: string | null;
}

function useFlowSlice(): FlowSlice {
  return useOnboardingFlowStore(
    useShallow((state) => ({
      chain: state.chain,
      chainScope: state.chainScope,
      branch: state.branch,
      activeTourId: state.activeTourId,
      stepId: selectActiveStep(state)?.stepId ?? null,
      context: state.context,
    })),
  );
}

/** "A counted modal or the picker owns the screen", settled one task later. */
function useSuspension(): SuspensionState {
  const [gate] = useState(createSuspensionGate);
  useEffect(() => gate.start(), [gate]);
  return useSyncExternalStore(
    gate.subscribe,
    gate.getSnapshot,
    gate.getSnapshot,
  );
}

/** See `tour-activation.ts`. */
function useActivationToken(): number {
  useEffect(() => {
    startActivationWatch();
  }, []);
  return useSyncExternalStore(
    subscribeActivation,
    getActivationToken,
    getActivationToken,
  );
}

function useTourPresence(chainActive: boolean): void {
  const setTourBusy = useOnboardingPresenceStore((state) => state.setTourBusy);
  useEffect(() => {
    setTourBusy(chainActive);
    return () => {
      setTourBusy(false);
    };
  }, [chainActive, setTourBusy]);
}

/** Which draft / epic the lessons are about, captured from the focused ref. */
function useContextCapture(
  chainActive: boolean,
  activeTourId: TourId | null,
  lesson: LessonContext,
): void {
  const focusedRef = useTabsStore(useShallow(selectHostFocusedRef));
  const setContext = useOnboardingFlowStore((state) => state.setContext);
  const { draftId, tabId } = lesson;
  useEffect(() => {
    if (!chainActive || activeTourId === null || focusedRef === null) return;
    if (LANDING_TOURS.includes(activeTourId)) {
      if (draftId === null && focusedRef.kind === "draft") {
        setContext({ draftId: focusedRef.id });
      }
      return;
    }
    if (activeTourId === "task-panels" && tabId === null) {
      const tab = epicTabFor(focusedRef);
      if (tab !== null) setContext(tab);
    }
  }, [chainActive, activeTourId, draftId, tabId, focusedRef, setContext]);
}

interface LessonInputs {
  readonly folders: ReadonlyArray<string> | null;
  readonly composerMode: "chat" | "terminal" | null;
  readonly receipt: LandingReceipt | undefined;
  readonly dispatchSequence: number;
  readonly pendingAttempt: boolean;
  readonly historyEpicIds: ReadonlyArray<string>;
}

/** The real store facts the lesson predicates read. */
function useLessonInputs(lesson: LessonContext): LessonInputs {
  const { draftId, hostId, attemptId } = lesson;
  const draft = useLandingDraftStore(
    useShallow((state) =>
      draftId === null
        ? null
        : (state.drafts.find((candidate) => candidate.id === draftId) ?? null),
    ),
  );
  const draftFolders = draft?.workspace.folders ?? null;
  const bucketFolders = useWorkspaceFoldersStore((state) =>
    draftFolders === null
      ? selectWorkspaceFoldersBucket(state, hostId).folders
      : null,
  );
  const composerMode = draft === null ? null : draft.composerMode;
  const receipt = useLandingReceiptsStore((state) =>
    attemptId === null ? undefined : state.byAttemptId[attemptId],
  );
  const dispatchSequence = useLandingReceiptsStore(
    (state) => state.dispatchSequence,
  );
  const pendingAttempt = useLandingReceiptsStore(
    (state) => attemptId !== null && attemptId in state.dispatchedByAttemptId,
  );
  const importedEpicIds = useSessionImportRunStore(
    useShallow((state) => {
      const run = sessionImportRunFor(state, hostId);
      const ids: string[] = [];
      for (const entry of run.outcomes.values()) {
        if (entry.outcome.kind === "imported") ids.push(entry.outcome.epicId);
      }
      return ids;
    }),
  );
  const unseenEpicIds = useImportedUnseenStore(
    useShallow((state) => Object.keys(state.unseen)),
  );
  const historyEpicIds = useMemo(
    () => [...importedEpicIds, ...unseenEpicIds],
    [importedEpicIds, unseenEpicIds],
  );
  return {
    folders: draftFolders ?? bucketFolders,
    composerMode,
    receipt,
    dispatchSequence,
    pendingAttempt,
    historyEpicIds,
  };
}

function resolveLessonTarget(
  tourId: TourId,
  lesson: LessonContext,
  historyEpicIds: ReadonlyArray<string>,
): HTMLElement | null {
  if (tourId === "task-panels") {
    if (lesson.tabId === null) return null;
    return resolvePanelTarget({ kind: "epic", tabId: lesson.tabId });
  }
  if (lesson.draftId === null) return null;
  const scope: TourSurfaceScope = { kind: "draft", draftId: lesson.draftId };
  if (tourId === "add-folder") {
    // The bare Add button only renders while the draft has no folder; with
    // one bound, the lesson points at the workspace summary that opens the
    // picker (the copy still reads "Add a folder"; the predicate is the
    // same new-path check either way).
    return (
      resolveAnchor(scope, "landing-folder-add") ??
      resolveAnchor(scope, "landing-workspace-summary")
    );
  }
  if (tourId === "submit-prompt") {
    // While the composer is in terminal mode Send is not rendered; the mode
    // switch is the alternate presentation target of the same step.
    return (
      resolveAnchor(scope, "landing-send") ??
      resolveAnchor(scope, "landing-terminal-switch")
    );
  }
  if (tourId === "history") {
    // The first imported/unseen ROW, once mounted (decision 19): unrelated
    // rows already in the list are not the lesson's, and the list itself
    // is taller than the viewport, so the card anchors to the row.
    return resolveHistoryRow(scope, historyEpicIds);
  }
  return resolveAnchor(scope, TOUR_LESSONS[tourId].anchor);
}

interface TargetTracking {
  readonly tracker: TargetTracker;
  readonly target: TargetSnapshot;
  readonly lessonKey: string | null;
}

/**
 * One tracked lesson at a time, keyed by lesson + context so a new lesson
 * (or a new draft/tab for it) starts fresh under a new renderer epoch.
 */
function useTargetTracking(
  active: ActiveStep | null,
  chainActive: boolean,
  lesson: LessonContext,
  historyEpicIds: ReadonlyArray<string>,
): TargetTracking {
  const [tracker] = useState(createTargetTracker);
  const target = useSyncExternalStore(
    tracker.subscribe,
    tracker.getSnapshot,
    tracker.getSnapshot,
  );
  const { draftId, tabId } = lesson;
  const lessonKey =
    chainActive && active !== null
      ? `${active.tourId}|${active.stepId}|${draftId ?? ""}|${tabId ?? ""}`
      : null;
  useEffect(() => {
    if (lessonKey === null || active === null) {
      tracker.reset();
      return undefined;
    }
    const tourId = active.tourId;
    return tracker.track(lessonKey, () =>
      resolveLessonTarget(tourId, lesson, historyEpicIds),
    );
    // `historyEpicIds` re-resolves the history row when imports land.
  }, [lessonKey, active, lesson, tracker, historyEpicIds]);
  return { tracker, target, lessonKey };
}

/** What the unanchored card says and offers when the lesson has no task. */
interface UnboundPresentation {
  readonly content: string;
  readonly action: TourStepAction | null;
}

interface StepsInput {
  readonly order: ReadonlyArray<TourId>;
  readonly activeTourId: TourId | null;
  readonly target: TargetSnapshot;
  readonly lessonKey: string | null;
  readonly unbound: UnboundPresentation | null;
  readonly spotlightSuspended: boolean;
  /** This renderer's anchored card has presented (see `usePresented`). */
  readonly presented: boolean;
}

function buildSteps(input: StepsInput): Step[] {
  const {
    order,
    activeTourId,
    target,
    lessonKey,
    unbound,
    spotlightSuspended,
    presented,
  } = input;
  if (activeTourId === null) return [];
  // Anchored only on a node resolved for THIS lesson/context, and only
  // while a spotlight can be drawn. Anything else - a snapshot from the
  // previous lesson, no node yet, a node Joyride refused, a live browser
  // guest the dim cannot cover - is the unanchored card at once: the same
  // lesson, centred, no dim, Next / Skip / Esc live. Never a bare dim while
  // a target is missing (an anchor that mounts later re-presents under a
  // new epoch).
  const fresh = target.key === lessonKey;
  const node =
    fresh && !target.unanchored && !spotlightSuspended ? target.node : null;
  if (node === null) {
    return buildTourSteps(order, activeTourId, {
      kind: "unanchored",
      content: unbound?.content ?? null,
      action: unbound?.action ?? null,
    });
  }
  return buildTourSteps(order, activeTourId, {
    kind: "anchored",
    target: () => node,
    presented,
  });
}

/**
 * Whether the CURRENT renderer's anchored card has presented - per
 * renderer key, so it is false again for every replacement: a new node,
 * a spotlight suspended or restored around the same node. Until it is
 * true the anchored step hides its overlay: the dim follows the card, so
 * Joyride's own target wait and scroll transit (should it disagree with
 * the resolver after all) are a blank moment, never a bare dim. Only an
 * ANCHORED tooltip counts - the centred card of a suspended or missing
 * target presents too, and must not pre-arm the dim for the renderer
 * that replaces it.
 */
function usePresented(rendererKey: string): {
  readonly presented: boolean;
  readonly markPresented: (rendererKey: string) => void;
} {
  const [state, setState] = useState<{
    readonly key: string;
    readonly presented: boolean;
  }>({ key: rendererKey, presented: false });
  // Adjusted during render, not remembered per key: a spotlight restored
  // around the same node reuses its key, and that replacement renderer
  // starts unpresented like any other.
  if (state.key !== rendererKey)
    setState({ key: rendererKey, presented: false });
  const markPresented = useCallback((key: string) => {
    setState((current) =>
      current.key === key && !current.presented
        ? { key, presented: true }
        : current,
    );
  }, []);
  return {
    presented: state.key === rendererKey && state.presented,
    markPresented,
  };
}

/**
 * Opens (or focuses) an epic tab through the tab-navigation seam: what
 * Next on the history lesson and "Open latest task" do. The two places
 * the tour opens a task on the user's behalf, both on a gesture of theirs
 * - never to satisfy an anchor on its own.
 */
function useOpenEpicTab(): (epicId: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (epicId: string) => {
      activateTabIntent(
        navigate,
        openOrFocusEpicIntent({ epicId, focus: undefined }),
        undefined,
      );
    },
    [navigate],
  );
}

/**
 * The most recent task in the context draft's history list, tracked while
 * `enabled` (the panels lesson with no task bound), for "Open latest task".
 * A string snapshot, so the DOM observer only re-renders on a change.
 */
function useLatestHistoryEpicId(
  draftId: string | null,
  enabled: boolean,
): string | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? observeTourTargets(listener) : () => undefined,
    [enabled],
  );
  const getSnapshot = useCallback(
    () =>
      enabled && draftId !== null
        ? resolveLatestHistoryEpicId({ kind: "draft", draftId })
        : null,
    [enabled, draftId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Focus origin, restored on pause / end only; chain-end analytics. */
function useFocusOriginAndChainEnd(run: boolean, flow: FlowSlice): void {
  const originRef = useRef<HTMLElement | null>(null);
  const previousRun = useRef(false);
  useEffect(() => {
    if (run && !previousRun.current) {
      const activeElement = document.activeElement;
      originRef.current =
        activeElement instanceof HTMLElement &&
        activeElement.closest("#react-joyride-portal") === null
          ? activeElement
          : null;
    }
    previousRun.current = run;
  }, [run]);
  const previousChain = useRef<ChainStatus>(flow.chain);
  const { chain, branch } = flow;
  useEffect(() => {
    const before = previousChain.current;
    previousChain.current = chain;
    if (before !== "active" || chain === "active") return;
    if ((chain === "completed" || chain === "skipped") && branch !== null) {
      Analytics.getInstance().track(AnalyticsEvent.OnboardingChainEnded, {
        reason: chain,
        branch,
      });
    }
    const origin = originRef.current;
    originRef.current = null;
    if (origin === null) return;
    requestAnimationFrame(() => {
      if (origin.isConnected && origin.checkVisibility()) {
        origin.focus({ preventScroll: true });
      }
    });
  }, [chain, branch]);
}

type GuardedAdvance = (
  tourId: TourId,
  expectedStepId: string,
  reason: AdvanceReason,
) => boolean;

function useGuardedAdvance(): GuardedAdvance {
  return useCallback((tourId, expectedStepId, reason) => {
    const store = useOnboardingFlowStore.getState();
    const current = selectActiveStep(store);
    if (
      store.chain !== "active" ||
      current === null ||
      current.tourId !== tourId ||
      current.stepId !== expectedStepId
    ) {
      return false;
    }
    store.advance(tourId, expectedStepId, reason);
    const after = selectActiveStep(useOnboardingFlowStore.getState());
    const advanced =
      useOnboardingFlowStore.getState().chain !== "active" ||
      after === null ||
      after.tourId !== tourId ||
      after.stepId !== expectedStepId;
    if (advanced) {
      trackStep(tourId, expectedStepId, reason === "detour" ? "auto" : reason);
    }
    return advanced;
  }, []);
}

/** The step this renderer's events are for is still the flow's active step. */
function eventIsCurrent(data: EventData, active: ActiveStep): boolean {
  if (data.step.id !== active.tourId) return false;
  const current = selectActiveStep(useOnboardingFlowStore.getState());
  return (
    useOnboardingFlowStore.getState().chain === "active" &&
    current !== null &&
    current.tourId === active.tourId &&
    current.stepId === active.stepId
  );
}

function handleStepAfter(
  data: EventData,
  active: ActiveStep,
  guardedAdvance: GuardedAdvance,
  onHistoryNext: () => void,
): void {
  // F1: a suspension (`run` -> false) emits step:after with the LAST
  // tracked action and status "paused". Only a running step counts.
  if (data.status !== STATUS.RUNNING) return;
  if (data.action === ACTIONS.NEXT) {
    const advanced = guardedAdvance(active.tourId, active.stepId, "next");
    if (advanced && active.tourId === "history") onHistoryNext();
  } else if (data.action === ACTIONS.CLOSE) {
    dismissedThisLaunch = true;
    trackStep(active.tourId, active.stepId, "pause");
    useOnboardingFlowStore.getState().pauseChain();
  }
}

function handleTourEnd(data: EventData, active: ActiveStep): void {
  // F3: Skip emits no step:after; tour:end/skipped is the signal. A
  // finished tour:end is Joyride's own bookkeeping after the last Next
  // already advanced the flow, and changes nothing.
  if (data.status !== STATUS.SKIPPED) return;
  trackStep(active.tourId, active.stepId, "skip");
  useOnboardingFlowStore.getState().skipChain();
}

interface EventAdapter {
  readonly onEvent: (data: EventData) => void;
  readonly announcement: string | null;
}

/**
 * Joyride's events mapped to the flow store's guarded actions. Each handler
 * closes over the activation token, the renderer epoch and the ids it was
 * built for: a late event from a replaced renderer, a stale replay or
 * another lesson reaches no store action.
 */
interface EventAdapterInput {
  readonly active: ActiveStep | null;
  readonly activation: number;
  readonly tracking: TargetTracking;
  readonly rendererKey: string;
  readonly markPresented: (rendererKey: string) => void;
  readonly guardedAdvance: GuardedAdvance;
  readonly onHistoryNext: () => void;
}

function useEventAdapter(input: EventAdapterInput): EventAdapter {
  const {
    active,
    activation,
    tracking,
    rendererKey,
    markPresented,
    guardedAdvance,
    onHistoryNext,
  } = input;
  const { tracker, target } = tracking;
  const epoch = target.epoch;
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const onEvent = useCallback(
    (data: EventData) => {
      if (getActivationToken() !== activation || active === null) return;
      if (tracker.getSnapshot().epoch !== epoch) return;
      if (!eventIsCurrent(data, active)) return;
      if (data.type === EVENTS.TOOLTIP) {
        // The centred card is `placement: "center"`; only the anchored
        // one arms this renderer's dim.
        if (data.step.placement !== "center") markPresented(rendererKey);
        setAnnouncement(
          `Step ${data.index + 1} of ${data.size}: ${tourLessonTitle(active.tourId)}`,
        );
      } else if (data.type === EVENTS.TARGET_NOT_FOUND) {
        // F4: Joyride refused a node the resolver accepted, and upstream
        // would leave a full dim with no card. Same lesson, centred card,
        // no cutout; progress untouched.
        tracker.markUnanchored();
      } else if (data.type === EVENTS.STEP_AFTER) {
        handleStepAfter(data, active, guardedAdvance, onHistoryNext);
      } else if (data.type === EVENTS.TOUR_END) {
        handleTourEnd(data, active);
      }
    },
    [
      activation,
      epoch,
      active,
      rendererKey,
      markPresented,
      guardedAdvance,
      onHistoryNext,
      tracker,
    ],
  );
  return { onEvent, announcement };
}

/**
 * Next on the history lesson with no epic on screen: the panels lesson
 * that follows needs a task, so the imported one the card pointed at (else
 * the first imported/unseen id) is opened. The user chose to move on from
 * "open a task to keep going" - a gesture, not an anchor pulling them
 * somewhere. An epic already focused (one the lesson ignored at entry) is
 * left as the panels lesson's task instead.
 */
function useHistoryNext(
  tracking: TargetTracking,
  historyEpicIds: ReadonlyArray<string>,
  openEpicTab: (epicId: string) => void,
): () => void {
  const { target, lessonKey } = tracking;
  const rowEpicId =
    target.key === lessonKey ? (target.node?.dataset.epicId ?? null) : null;
  return useCallback(() => {
    const focused = selectHostFocusedRef(useTabsStore.getState());
    if (focused !== null && focused.kind === "epic") return;
    const epicId = rowEpicId ?? historyEpicIds.at(0) ?? null;
    if (epicId !== null) openEpicTab(epicId);
  }, [rowEpicId, historyEpicIds, openEpicTab]);
}

interface PredicateArgs {
  readonly chainActive: boolean;
  readonly chainScope: "branch" | "single";
  readonly active: ActiveStep | null;
  readonly activation: number;
  readonly lesson: LessonContext;
  readonly context: OnboardingContext | null;
  readonly inputs: LessonInputs;
  readonly guardedAdvance: GuardedAdvance;
}

/**
 * add-folder: a path absent at lesson entry is now present. Baseline per
 * activation + lesson + context; a picker suspension keeps it, a new
 * context / replay / relaunch resets it. Length is not the signal (the
 * 50-folder cap can keep the count equal while a path changes; a re-added
 * existing path is not new).
 */
function useFolderPredicate(args: PredicateArgs): void {
  const { chainActive, active, activation, lesson, inputs, guardedAdvance } =
    args;
  const { folders, pendingAttempt } = inputs;
  const baselineRef = useRef<{
    key: string;
    paths: ReadonlySet<string>;
  } | null>(null);
  const key =
    chainActive && active?.tourId === "add-folder"
      ? `${activation}|${lesson.draftId ?? ""}|${lesson.hostId ?? ""}`
      : null;
  useEffect(() => {
    if (key === null) {
      baselineRef.current = null;
      return;
    }
    if (baselineRef.current?.key !== key) {
      baselineRef.current = { key, paths: new Set(folders ?? []) };
      return;
    }
    if (active === null || pendingAttempt || folders === null) return;
    const baseline = baselineRef.current.paths;
    if (!folders.some((path) => !baseline.has(path))) return;
    guardedAdvance(active.tourId, active.stepId, "auto");
  }, [key, folders, pendingAttempt, active, guardedAdvance]);
}

/**
 * terminal-mode: the bound draft's composer is in terminal mode. Never
 * resets the mode. In the branch chain, already there at entry counts too
 * (the user did the thing during an earlier lesson). A Settings replay of
 * the one lesson needs a CHANGE after activation - a composer left in
 * Terminal would otherwise complete the replay in the tick it started,
 * with no card ever shown - so it advances only on a switch INTO terminal
 * mode observed since entry; Next still acknowledges.
 */
function useTerminalModePredicate(args: PredicateArgs): void {
  const {
    chainActive,
    chainScope,
    active,
    activation,
    lesson,
    inputs,
    guardedAdvance,
  } = args;
  const { composerMode, pendingAttempt } = inputs;
  const baselineRef = useRef<{ key: string; sawOtherMode: boolean } | null>(
    null,
  );
  const key =
    chainActive && active?.tourId === "terminal-mode"
      ? `${activation}|${lesson.draftId ?? ""}`
      : null;
  useEffect(() => {
    if (key === null || active === null) {
      baselineRef.current = null;
      return;
    }
    const baseline =
      baselineRef.current?.key === key
        ? baselineRef.current
        : { key, sawOtherMode: false };
    baselineRef.current = baseline;
    // Only an OBSERVED chat mode arms the switch: `null` is a draft record
    // not loaded yet (a saved id restored before its draft), and a record
    // that then arrives in terminal mode is where the user left it, not a
    // switch they made.
    if (composerMode === null) return;
    if (composerMode !== "terminal") {
      baseline.sawOtherMode = true;
      return;
    }
    if (pendingAttempt) return;
    if (chainScope === "single" && !baseline.sawOtherMode) return;
    guardedAdvance(active.tourId, active.stepId, "auto");
  }, [key, chainScope, active, pendingAttempt, composerMode, guardedAdvance]);
}

/**
 * Attempt capture: a landing create announced for THIS draft on THIS host
 * while a lesson that waits on it is active. Both landing lessons wait on
 * both kinds: a Start is the A2 detour, a sent prompt during the mode
 * lesson completes mode AND prompt.
 */
function useAttemptCapture(args: PredicateArgs): void {
  const { chainActive, active, lesson, inputs } = args;
  const { draftId, hostId, attemptId } = lesson;
  const { dispatchSequence } = inputs;
  const setContext = useOnboardingFlowStore((state) => state.setContext);
  useEffect(() => {
    if (!chainActive || active === null || draftId === null) return;
    if (
      active.tourId !== "submit-prompt" &&
      active.tourId !== "terminal-mode"
    ) {
      return;
    }
    const latest = Object.values(
      useLandingReceiptsStore.getState().dispatchedByAttemptId,
    ).at(-1);
    if (latest === undefined || latest.draftId !== draftId) return;
    // The lesson is bound to a host for life: an attempt on another host is
    // not this lesson's, however the draft matches.
    if (hostId !== null && latest.hostId !== hostId) return;
    if (latest.attemptId === attemptId) return;
    setContext({ attemptId: latest.attemptId, hostId: latest.hostId });
  }, [
    chainActive,
    active,
    draftId,
    hostId,
    attemptId,
    dispatchSequence,
    setContext,
  ]);
}

/**
 * Accepted receipts: prompt-accepted completes the prompt lesson (and,
 * arriving during the mode lesson, completes mode and prompt both - the
 * user sent a real prompt); tui-accepted (accepted Start) detours mode or
 * prompt to the panels. Every id must match; a receipt is consumed once.
 */
function useReceiptPredicate(args: PredicateArgs): void {
  const { chainActive, active, context, inputs, guardedAdvance } = args;
  const { receipt } = inputs;
  const setContext = useOnboardingFlowStore((state) => state.setContext);
  useEffect(() => {
    if (!chainActive || active === null || context === null) return;
    if (receipt === undefined || !receiptMatchesContext(receipt, context))
      return;
    const tourId = active.tourId;
    if (tourId !== "terminal-mode" && tourId !== "submit-prompt") return;
    useLandingReceiptsStore.getState().consume(receipt.attemptId);
    setContext({
      epicId: receipt.epicId,
      tabId: receipt.tabId,
      hostId: receipt.hostId,
      attemptId: null,
    });
    if (receipt.kind === "tui-accepted") {
      guardedAdvance(tourId, active.stepId, "detour");
      return;
    }
    guardedAdvance(tourId, active.stepId, "auto");
    if (tourId !== "terminal-mode") return;
    const following = selectActiveStep(useOnboardingFlowStore.getState());
    if (following !== null && following.tourId === "submit-prompt") {
      guardedAdvance(following.tourId, following.stepId, "auto");
    }
  }, [chainActive, active, context, receipt, setContext, guardedAdvance]);
}

/**
 * history: the user opened a task - the focused ref became an epic that
 * was NOT focused at lesson entry, and its surface is mounted. A restored
 * unrelated epic already focused at entry is not that.
 */
function useHistoryPredicate(args: PredicateArgs): void {
  const { chainActive, active, activation, lesson, guardedAdvance } = args;
  const setContext = useOnboardingFlowStore((state) => state.setContext);
  const baselineRef = useRef<string | null>(null);
  const key =
    chainActive && active?.tourId === "history"
      ? `${activation}|${lesson.draftId ?? ""}`
      : null;
  useEffect(() => {
    if (key === null || active === null) {
      baselineRef.current = null;
      return undefined;
    }
    baselineRef.current ??=
      refKey(selectHostFocusedRef(useTabsStore.getState())) ?? "";
    const check = (): void => {
      const focused = selectHostFocusedRef(useTabsStore.getState());
      if (focused === null || focused.kind !== "epic") return;
      if (refKey(focused) === baselineRef.current) return;
      if (!epicSurfaceMounted(focused.id)) return;
      const tab = epicTabFor(focused);
      if (tab === null) return;
      setContext(tab);
      guardedAdvance(active.tourId, active.stepId, "auto");
    };
    check();
    const unsubscribe = useTabsStore.subscribe(check);
    const stopObserving = observeTourTargets(check);
    return () => {
      unsubscribe();
      stopObserving();
    };
  }, [key, active, setContext, guardedAdvance]);
}

interface PresentationInput {
  readonly chainActive: boolean;
  readonly active: ActiveStep | null;
  readonly modalSuspended: boolean;
  readonly spotlightSuspended: boolean;
  readonly tracking: TargetTracking;
  readonly presented: boolean;
}

function presentationOf(input: PresentationInput): TourPresentation {
  const {
    chainActive,
    active,
    modalSuspended,
    spotlightSuspended,
    tracking,
    presented,
  } = input;
  if (!chainActive || active === null) return "idle";
  if (modalSuspended) return "modal-suspended";
  const { target, lessonKey } = tracking;
  if (target.key !== lessonKey) return "resolving";
  if (spotlightSuspended || target.unanchored || target.node === null) {
    return "unanchored";
  }
  return presented ? "presenting" : "resolving";
}

export function useOnboardingTourController(): OnboardingTourController {
  const flow = useFlowSlice();
  const { context, activeTourId, stepId } = flow;
  const chainActive = flow.chain === "active";
  const lesson = useMemo<LessonContext>(
    () => ({
      draftId: context?.draftId ?? null,
      tabId: context?.tabId ?? null,
      hostId: context?.hostId ?? null,
      attemptId: context?.attemptId ?? null,
    }),
    [context],
  );
  const active = useMemo<ActiveStep | null>(
    () =>
      activeTourId === null || stepId === null
        ? null
        : { tourId: activeTourId, stepId },
    [activeTourId, stepId],
  );
  const reducedMotion = useReducedMotion() === true;
  const suspension = useSuspension();
  const modalSuspended = suspension === "suspended";
  const run = chainActive && active !== null && suspension === "settled";
  const activation = useActivationToken();

  useTourPresence(chainActive);
  useContextCapture(chainActive, activeTourId, lesson);
  const inputs = useLessonInputs(lesson);
  const tracking = useTargetTracking(
    active,
    chainActive,
    lesson,
    inputs.historyEpicIds,
  );

  const order = useMemo(
    () => chainOrder(flow.chainScope, flow.branch, activeTourId),
    [flow.chainScope, flow.branch, activeTourId],
  );
  const stepIndex = Math.max(
    0,
    activeTourId === null ? 0 : order.indexOf(activeTourId),
  );
  const { target, lessonKey } = tracking;
  const openEpicTab = useOpenEpicTab();
  // The panels lesson with no task bound: the card says so and, when the
  // history list (or an import) names one, offers to open the latest.
  const panelsUnbound =
    chainActive && activeTourId === "task-panels" && lesson.tabId === null;
  const latestListedEpicId = useLatestHistoryEpicId(
    lesson.draftId,
    panelsUnbound,
  );
  const latestEpicId = panelsUnbound
    ? (latestListedEpicId ?? inputs.historyEpicIds.at(0) ?? null)
    : null;
  const unbound = useMemo<UnboundPresentation | null>(
    () =>
      panelsUnbound
        ? {
            content: TASK_PANELS_UNBOUND_BODY,
            action:
              latestEpicId === null
                ? null
                : {
                    label: "Open latest task",
                    run: () => {
                      openEpicTab(latestEpicId);
                    },
                  },
          }
        : null,
    [panelsUnbound, latestEpicId, openEpicTab],
  );
  const spotlightSuspended = useLiveBrowserGuestPresent();
  // Joyride neither moves nor drops a card on its own (F5): the renderer
  // is replaced whenever the chosen node changes AND whenever the
  // spotlight is suspended or restored around the same node.
  const rendererKey = `${target.epoch}:${spotlightSuspended ? "suspended" : "spotlit"}`;
  const { presented, markPresented } = usePresented(rendererKey);
  const steps = useMemo(
    () =>
      buildSteps({
        order,
        activeTourId,
        target,
        lessonKey,
        unbound,
        spotlightSuspended,
        presented,
      }),
    [
      order,
      activeTourId,
      target,
      lessonKey,
      unbound,
      spotlightSuspended,
      presented,
    ],
  );

  useFocusOriginAndChainEnd(run, flow);
  const guardedAdvance = useGuardedAdvance();
  const onHistoryNext = useHistoryNext(
    tracking,
    inputs.historyEpicIds,
    openEpicTab,
  );
  const { onEvent, announcement } = useEventAdapter({
    active,
    activation,
    tracking,
    rendererKey,
    markPresented,
    guardedAdvance,
    onHistoryNext,
  });
  const predicateArgs: PredicateArgs = {
    chainActive,
    chainScope: flow.chainScope,
    active,
    activation,
    lesson,
    context,
    inputs,
    guardedAdvance,
  };
  useFolderPredicate(predicateArgs);
  useTerminalModePredicate(predicateArgs);
  useAttemptCapture(predicateArgs);
  useReceiptPredicate(predicateArgs);
  useHistoryPredicate(predicateArgs);

  return {
    run,
    steps,
    stepIndex,
    rendererKey,
    presentation: presentationOf({
      chainActive,
      active,
      modalSuspended,
      spotlightSuspended,
      tracking,
      presented,
    }),
    modalSuspended,
    spotlightSuspended,
    reducedMotion,
    onEvent,
    announcement,
  };
}
