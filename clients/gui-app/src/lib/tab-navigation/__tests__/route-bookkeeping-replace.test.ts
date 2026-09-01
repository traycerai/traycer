/**
 * Route-bookkeeping regression: a same-tab search-only replace the epic
 * canvas fires to record tile focus (`replaceNestedFocusRoute` in
 * `use-epic-route-synchronization.ts`) carries no activation envelope, so it
 * used to be indistinguishable from a genuine external navigation. Issued
 * `void navigate(...)` from an effect, it can commit LATE - after the user
 * activated another tab - and the controller then read it as the user going
 * back to the epic, re-activating it and silently swallowing whatever the
 * user had just done (the staging 2026-08-31 "Start Page click does
 * nothing" defect).
 *
 * The fix marks that replace's history state
 * (`applyRouteBookkeeping`/`isRouteBookkeepingState`,
 * `@/lib/tab-navigation/route-bookkeeping`) so the controller can classify
 * "this tab recording its own view state" apart from "the user went
 * somewhere" - see `TabNavigationController.observeLocation`'s bookkeeping
 * branch, checked after history-step classification and before envelope
 * matching, and `resolveBookkeepingLocation`.
 *
 * Drives the real controller, coordinator, and stores; fakes only the router
 * commit boundary - same harness shape as
 * `external-resolution-backing-correction.test.ts`.
 */
import type {
  HistoryState,
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  __resetTabNavigationControllerForTesting,
  activateTabIntent,
  draftTabIntent,
  existingEpicTabIntent,
  getTabNavigationDiagnostics,
  tabNavigationController,
  type TabNavigationEnvelope,
} from "@/lib/tab-navigation";
import {
  applyRouteBookkeeping,
  isRouteBookkeepingState,
} from "@/lib/tab-navigation/route-bookkeeping";
import { draftPathname, epicPathname } from "@/lib/routes";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  tabItemId,
  tabRefKey,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

const HISTORY_ENVELOPE_KEY = "__traycerTabNavigation";

/** The search the epic canvas replaces onto its own route to record focus. */
const TILE_FOCUS_SEARCH = {
  focusPaneId: "pane-1",
  focusTileInstanceId: "tile-instance-1",
};

type ParsedHistoryState = HistoryState & {
  readonly key: string | undefined;
  readonly __TSR_key: string | undefined;
  readonly __TSR_index: number;
};

type NavigateMock = Mock<(options: NavigateOptions) => Promise<void>>;

interface ObservedEnvelope {
  readonly token: string;
  readonly intentKind: string;
  readonly destination: TabNavigationEnvelope["destination"] | null;
}

interface DeferredNavigate {
  readonly asNavigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  lastOptions: () => NavigateOptions;
}

let stateSerial = 0;

function freshParsedState(): ParsedHistoryState {
  stateSerial += 1;
  const key = `key-${stateSerial}`;
  return { key, __TSR_key: key, __TSR_index: stateSerial };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyStateUpdater(
  options: NavigateOptions,
  base: ParsedHistoryState,
): Record<string, unknown> {
  const state = options.state;
  expect(typeof state).toBe("function");
  if (typeof state !== "function") {
    throw new Error("expected navigate state updater function");
  }
  const result: HistoryState = state(base);
  expect(isRecord(result)).toBe(true);
  if (!isRecord(result)) {
    throw new Error("expected navigate state updater result");
  }
  return result;
}

/** A plain, un-enveloped external commit's history state (no marker). */
function externalState(): Record<string, unknown> {
  // Spread into a fresh literal: the interface has no index signature, so it
  // is not directly assignable to Record<string, unknown>.
  return { ...freshParsedState() };
}

/** A same-tab bookkeeping commit's history state, built the same way
 * production builds it - never by re-deriving the marker key locally. */
function bookkeepingState(): Record<string, unknown> {
  return applyStateUpdater(applyRouteBookkeeping({}), freshParsedState());
}

function readDestination(
  value: unknown,
): TabNavigationEnvelope["destination"] | null {
  if (!isRecord(value)) return null;
  if (value.kind === "tab" && typeof value.refKey === "string") {
    return { kind: "tab", refKey: value.refKey };
  }
  if (value.kind === "route" && typeof value.pathname === "string") {
    return { kind: "route", pathname: value.pathname };
  }
  return null;
}

function readObservedEnvelope(value: unknown): ObservedEnvelope | null {
  if (!isRecord(value)) return null;
  const token = value.token;
  const intentKind = value.intentKind;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof intentKind !== "string" || intentKind.length === 0) return null;
  return { token, intentKind, destination: readDestination(value.destination) };
}

function envelopeFromNavigateOptions(
  options: NavigateOptions,
): ObservedEnvelope {
  const nextState = applyStateUpdater(options, freshParsedState());
  const envelope = readObservedEnvelope(nextState[HISTORY_ENVELOPE_KEY]);
  expect(envelope).not.toBeNull();
  if (envelope === null) {
    throw new Error("navigate options missing TabNavigationEnvelope");
  }
  return envelope;
}

/** Records what the controller asked the router for; never commits it. */
function makeDeferredNavigate(): DeferredNavigate {
  const calls: NavigateOptions[] = [];
  const mock: NavigateMock = vi.fn((options: NavigateOptions) => {
    calls.push(options);
    return new Promise<void>(() => undefined);
  });
  const asNavigate: UseNavigateResult<string> = ((options: NavigateOptions) =>
    mock(options)) as UseNavigateResult<string>;
  return {
    asNavigate,
    calls,
    lastOptions: () => {
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1];
    },
  };
}

function commitExternal(args: {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: string;
  readonly action: "PUSH" | "REPLACE" | "BACK";
  readonly search: Readonly<Record<string, unknown>> | undefined;
}): void {
  tabNavigationController.observeLocation(
    { pathname: args.pathname, state: externalState(), search: args.search },
    args.action,
    args.navigate,
  );
}

function commitMarked(args: {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: string;
  readonly action: "PUSH" | "REPLACE" | "BACK";
  readonly search: Readonly<Record<string, unknown>> | undefined;
}): void {
  tabNavigationController.observeLocation(
    { pathname: args.pathname, state: bookkeepingState(), search: args.search },
    args.action,
    args.navigate,
  );
}

/** Commits the exact envelope-carrying state the router would have applied
 * for a pending navigation's recorded options - the round trip the real
 * router does via its own state updater, reused here verbatim. */
function commitAcknowledgement(args: {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: string;
  readonly action: "PUSH" | "REPLACE";
  readonly options: NavigateOptions;
}): void {
  tabNavigationController.observeLocation(
    {
      pathname: args.pathname,
      state: applyStateUpdater(args.options, freshParsedState()),
      search: undefined,
    },
    args.action,
    args.navigate,
  );
}

function seedCommittedLayout(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({
    ...layout,
    stripOrder: flattenLayoutRefs(layout),
  });
}

interface OpenedEpic {
  readonly tabId: string;
  readonly ref: TabRef;
  readonly pathname: string;
}

function openEpic(epicId: string, name: string): OpenedEpic {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
  return {
    tabId,
    ref: { kind: "epic", id: tabId },
    pathname: epicPathname({ epicId, tabId }),
  };
}

function seedEpicAndDraftLayout(a: OpenedEpic, draftRef: TabRef): void {
  seedCommittedLayout({
    version: 2,
    items: [
      { kind: "tab", id: tabItemId(a.ref), ref: a.ref },
      { kind: "tab", id: tabItemId(draftRef), ref: draftRef },
    ],
    activeItemId: tabItemId(a.ref),
    systemTabs: { history: null, settings: null },
  });
}

function focusedRefKey(): string | null {
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  if (active === undefined) return null;
  if (active.kind === "tab") return tabRefKey(active.ref);
  const side = active.focusedSide === "left" ? active.left : active.right;
  return side.kind === "tab" ? tabRefKey(side.ref) : null;
}

function createDraft(id: string): TabRef {
  const draftId = useLandingDraftStore.getState().createDraftWithId(id, null);
  return { kind: "draft", id: draftId };
}

/** Activates a draft tab through the controller and commits the router-side
 * acknowledgement, matching the real activate -> navigate -> observe cycle
 * (case 2's flow), so cases 3-5 can start from an acknowledged draft. */
function activateDraftAndAcknowledge(
  nav: DeferredNavigate,
  draftRef: TabRef,
): void {
  const activated = activateTabIntent(
    nav.asNavigate,
    draftTabIntent(draftRef.id),
    undefined,
  );
  expect(activated).toBe(true);
  expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);
  expect(focusedRefKey()).toBe(tabRefKey(draftRef));

  commitAcknowledgement({
    navigate: nav.asNavigate,
    pathname: draftPathname(draftRef.id),
    action: "PUSH",
    options: nav.lastOptions(),
  });

  expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
  expect(focusedRefKey()).toBe(tabRefKey(draftRef));
}

function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  __resetTabSyncCoordinatorForTesting();
  __resetTabNavigationControllerForTesting();
}

describe("route bookkeeping: a marked replace cannot swallow user intent", () => {
  beforeEach(async () => {
    resetStores();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
  });

  it("a marked replace of the currently focused tab's own route is inert externally", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: undefined,
    });

    const activateSpy = vi.spyOn(tabCommandCoordinator, "activateTab");
    const activateCallsBefore = activateSpy.mock.calls.length;
    const navCallsBefore = nav.calls.length;

    commitMarked({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: TILE_FOCUS_SEARCH,
    });

    expect(activateSpy.mock.calls.length - activateCallsBefore).toBe(0);
    expect(nav.calls.length).toBe(navCallsBefore);
    expect(getTabNavigationDiagnostics().resolutionFailure).toBe(false);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("a stale marked replace does not supersede a pending activation", () => {
    const a = openEpic("epic-a", "A");
    const draftRef = createDraft("draft-1");
    seedEpicAndDraftLayout(a, draftRef);
    const nav = makeDeferredNavigate();

    // Seed current location = A, exactly as the tab was actually showing.
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    const activated = activateTabIntent(
      nav.asNavigate,
      draftTabIntent(draftRef.id),
      undefined,
    );
    expect(activated).toBe(true);
    expect(focusedRefKey()).toBe(tabRefKey(draftRef));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);

    const navCallsBeforeMarkedCommit = nav.calls.length;
    commitMarked({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: TILE_FOCUS_SEARCH,
    });

    // The stale bookkeeping replace must not touch the pending activation.
    expect(focusedRefKey()).toBe(tabRefKey(draftRef));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);
    expect(nav.calls.length).toBe(navCallsBeforeMarkedCommit);

    // Now the draft's own navigation commits, the way the router would.
    commitAcknowledgement({
      navigate: nav.asNavigate,
      pathname: draftPathname(draftRef.id),
      action: "PUSH",
      options: nav.lastOptions(),
    });

    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(draftRef));
    expect(getTabNavigationDiagnostics().resolutionFailure).toBe(false);
  });

  it("a stale marked replace with nothing pending repairs the URL, not the layout", () => {
    const a = openEpic("epic-a", "A");
    const draftRef = createDraft("draft-1");
    seedEpicAndDraftLayout(a, draftRef);
    const nav = makeDeferredNavigate();
    activateDraftAndAcknowledge(nav, draftRef);

    const navCallsBefore = nav.calls.length;
    commitMarked({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: TILE_FOCUS_SEARCH,
    });

    // No snap-back: the layout keeps showing the draft.
    expect(focusedRefKey()).toBe(tabRefKey(draftRef));
    expect(nav.calls.length).toBe(navCallsBefore + 1);
    const envelope = envelopeFromNavigateOptions(nav.lastOptions());
    expect(envelope.intentKind).toBe("repair-replace");
    expect(envelope.destination).toEqual({
      kind: "tab",
      refKey: tabRefKey(draftRef),
    });
  });

  // Negative exemplar: an UNMARKED stale replace is a genuine external
  // commit, and today's semantics (re-activate the routed tab) must survive.
  it("an unmarked stale replace keeps today's external semantics", () => {
    const a = openEpic("epic-a", "A");
    const draftRef = createDraft("draft-1");
    seedEpicAndDraftLayout(a, draftRef);
    const nav = makeDeferredNavigate();
    activateDraftAndAcknowledge(nav, draftRef);

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: TILE_FOCUS_SEARCH,
    });

    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("a BACK step onto a marked entry is still user intent", () => {
    const a = openEpic("epic-a", "A");
    const draftRef = createDraft("draft-1");
    seedEpicAndDraftLayout(a, draftRef);
    const nav = makeDeferredNavigate();
    activateDraftAndAcknowledge(nav, draftRef);

    commitMarked({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      search: undefined,
    });

    // The marker only suppresses classification for arrivals, never history
    // steps: the user genuinely stepped back onto A.
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Re-activating the ALREADY-ACTIVE tab issues a `focus-replace`, so a
  // bookkeeping commit for that same tab arrives with a navigation pending.
  // Seizing authority there would supersede it, and its own commit would then
  // read as stale and be repaired away - losing the search it was carrying.
  it("a marked replace does not supersede a pending navigation to that same tab", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: undefined,
    });

    const activated = activateTabIntent(
      nav.asNavigate,
      existingEpicTabIntent({
        epicId: "epic-a",
        tabId: a.tabId,
        focus: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
        },
      }),
      undefined,
    );
    expect(activated).toBe(true);
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);
    const pendingOptions = nav.lastOptions();
    const navigationsBefore = nav.calls.length;

    commitMarked({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      search: TILE_FOCUS_SEARCH,
    });

    // Still owned by its issuer, and no correction was manufactured.
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);
    expect(nav.calls.length - navigationsBefore).toBe(0);

    // ...so when it lands it is acknowledged, not repaired as stale.
    commitAcknowledgement({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      options: pendingOptions,
    });
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    expect(nav.calls.length - navigationsBefore).toBe(0);
    expect(getTabNavigationDiagnostics().resolutionFailure).toBe(false);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });
});

describe("route-bookkeeping marker construction", () => {
  it("round-trips through isRouteBookkeepingState", () => {
    const options = applyRouteBookkeeping({});
    const state = options.state;
    expect(typeof state).toBe("function");
    if (typeof state !== "function") {
      throw new Error("expected navigate state updater function");
    }
    expect(isRouteBookkeepingState(state({ __TSR_index: 0 }))).toBe(true);
    expect(isRouteBookkeepingState({})).toBe(false);
  });

  it("composes a caller-supplied state updater instead of dropping it", () => {
    const options = applyRouteBookkeeping({
      state: (previous) => ({ ...previous, carried: "value" }),
    });
    const state = options.state;
    if (typeof state !== "function") {
      throw new Error("expected navigate state updater function");
    }
    const result = state({ __TSR_index: 0 });
    expect(isRouteBookkeepingState(result)).toBe(true);
    expect(result).toMatchObject({ carried: "value", __TSR_index: 0 });
  });
});
