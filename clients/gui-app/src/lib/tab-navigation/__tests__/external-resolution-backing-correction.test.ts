/**
 * External-resolution regression: a same-tab commit must not enter the tab
 * command coordinator, and a correction must aim at the layout rather than at
 * the literal landing.
 *
 * The defect these cover is a two-phase chain. First the URL drifts silently:
 * `resolveExternalEpic` re-activated the routed tab for EVERY un-enveloped
 * commit, including the search-only replaces the epic canvas issues to record
 * tile focus, and when that activation failed - a re-entrant commit observed
 * while a coordinator transaction is open throws - the controller replaced a
 * live epic URL with `/`. Nothing on screen moved, because the strip renders
 * from the layout store. Then the drift became visible: the Settings overlay
 * pushes onto whatever the URL currently is, so closing it popped back onto
 * that stale `/` and the stepped-landing resolver minted a fresh Home draft -
 * a phantom "Start Page" tab in place of the epic the user was on.
 *
 * Drives the real controller, coordinator, and stores; fakes only the router
 * commit boundary.
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
  type MockInstance,
} from "vitest";
import {
  __resetTabNavigationControllerForTesting,
  getTabNavigationDiagnostics,
  tabNavigationController,
  type TabNavigationEnvelope,
  type TabNavigationLocation,
} from "@/lib/tab-navigation";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
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
import {
  getTabCommandLedger,
  subscribeToTabCommandLedger,
  tabCommandCoordinator,
  type CoordinatedTabActivation,
  type CoordinatedTabActivationTarget,
} from "@/stores/tabs/tab-command-coordinator";
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

type ActivateTab = (
  target: CoordinatedTabActivationTarget,
) => CoordinatedTabActivation | null;

interface ObservedEnvelope {
  readonly token: string;
  readonly intentKind: string;
  readonly destination: TabNavigationEnvelope["destination"] | null;
}

interface DeferredNavigate {
  readonly asNavigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  lastEnvelope: () => ObservedEnvelope;
  lastOptions: () => NavigateOptions;
}

function emptyParsedHistoryState(): ParsedHistoryState {
  return { key: undefined, __TSR_key: undefined, __TSR_index: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const state = options.state;
  expect(typeof state).toBe("function");
  if (typeof state !== "function") {
    throw new Error("expected navigate state updater function");
  }
  const nextState: HistoryState = state(emptyParsedHistoryState());
  const envelope = isRecord(nextState)
    ? readObservedEnvelope(nextState[HISTORY_ENVELOPE_KEY])
    : null;
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
    lastEnvelope: () => {
      expect(calls.length).toBeGreaterThan(0);
      return envelopeFromNavigateOptions(calls[calls.length - 1]);
    },
    lastOptions: () => {
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1];
    },
  };
}

function locationState(key: string, index: number): Record<string, unknown> {
  return { __TSR_key: key, __TSR_index: index };
}

function commitExternal(args: {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: string;
  readonly action: "PUSH" | "REPLACE" | "BACK";
  readonly key: string;
  readonly index: number;
  readonly search: Readonly<Record<string, unknown>> | undefined;
}): void {
  tabNavigationController.observeLocation(
    {
      pathname: args.pathname,
      state: locationState(args.key, args.index),
      search: args.search,
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

function focusedRefKey(): string | null {
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  if (active === undefined) return null;
  if (active.kind === "tab") return tabRefKey(active.ref);
  const side = active.focusedSide === "left" ? active.left : active.right;
  return side.kind === "tab" ? tabRefKey(side.ref) : null;
}

function stripLength(): number {
  return useTabsStore.getState().items.length;
}

/** Stubs the coordinator's activation boundary with the failure it really has. */
function failEveryActivation(): MockInstance<ActivateTab> {
  return vi
    .spyOn(tabCommandCoordinator, "activateTab")
    .mockImplementation(() => {
      throw new Error("Tab commands cannot be re-entered during a transaction");
    });
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

describe("external epic resolution: same-tab commits skip the coordinator", () => {
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

  // Trigger: `use-epic-route-synchronization` replaces its own route to record
  // tile focus, observed while a tab command transaction is open. This is the
  // REAL re-entrancy, driven from the coordinator's own ledger notification -
  // no stubbing - so the throw is the production one.
  it("a re-entrant, search-only commit on the active tab neither activates nor corrects", () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(a.ref), ref: a.ref },
        { kind: "tab", id: tabItemId(b.ref), ref: b.ref },
      ],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      key: "key-a-initial",
      index: 0,
      search: undefined,
    });
    expect(nav.calls).toHaveLength(0);

    const activateSpy = vi.spyOn(tabCommandCoordinator, "activateTab");
    let reentered = false;
    let activationsDuringReentry = -1;
    let navigationsDuringReentry = -1;
    const dispose = subscribeToTabCommandLedger(() => {
      if (reentered || getTabCommandLedger().suppressionDepth === 0) return;
      reentered = true;
      const activationsBefore = activateSpy.mock.calls.length;
      const navigationsBefore = nav.calls.length;
      commitExternal({
        navigate: nav.asNavigate,
        pathname: a.pathname,
        action: "REPLACE",
        key: "key-a-tile-focus",
        index: 0,
        search: TILE_FOCUS_SEARCH,
      });
      activationsDuringReentry =
        activateSpy.mock.calls.length - activationsBefore;
      navigationsDuringReentry = nav.calls.length - navigationsBefore;
    });

    try {
      // Any command opens the transaction the canvas replace lands inside of.
      tabCommandCoordinator.activateTab({ kind: "ref", ref: b.ref });
    } finally {
      dispose();
    }

    expect(reentered, "the ledger never opened a transaction").toBe(true);
    // The fast path is the whole point: the coordinator is never re-entered,
    // so there is no throw to mistake for an unresolvable location.
    expect(activationsDuringReentry).toBe(0);
    // ...and therefore no correction, so the epic URL is retained.
    expect(navigationsDuringReentry).toBe(0);
    expect(nav.calls.some((options) => options.to === "/")).toBe(false);
    expect(getTabNavigationDiagnostics().resolutionFailure).toBe(false);
  });

  // Same commit, coordinator failing for any reason at all (a structural lock,
  // a raced identity resolution): the fast path must not consult it.
  it("a search-only commit on the active tab is resolved without the coordinator", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    const activateSpy = failEveryActivation();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      key: "key-a-tile-focus",
      index: 0,
      search: TILE_FOCUS_SEARCH,
    });

    expect(activateSpy).not.toHaveBeenCalled();
    expect(nav.calls).toHaveLength(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });
});

describe("landing correction aims at the layout, not the literal landing", () => {
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

  // Trigger: an external commit naming a KNOWN tab that is not the active one,
  // whose activation fails. The location is unresolvable, but the strip is
  // still showing A - correcting to `/` would point the URL at nothing on
  // screen.
  it("corrects to the layout's backing tab when a known non-active tab fails to activate", () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(a.ref), ref: a.ref },
        { kind: "tab", id: tabItemId(b.ref), ref: b.ref },
      ],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    failEveryActivation();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      action: "PUSH",
      key: "key-b-external",
      index: 1,
      search: undefined,
    });

    expect(nav.calls).toHaveLength(1);
    const envelope = nav.lastEnvelope();
    expect(envelope.intentKind).toBe("landing-replace");
    expect(envelope.destination).toEqual({
      kind: "tab",
      refKey: tabRefKey(a.ref),
    });
    expect(nav.lastOptions().to).not.toBe("/");
    expect(nav.lastOptions().params).toEqual({
      epicId: "epic-a",
      tabId: a.tabId,
    });
  });

  // The correction is aimed at a ref, and the intent for that ref must be
  // built from the ref - not from the location that just failed. A Settings
  // tab restored from a snapshot has no entry in the controller's route cache
  // yet, so the fallback is the only thing standing between the user and a
  // silently reset section.
  it("corrects to the Settings tab's remembered sub-route, not the failing path's section", () => {
    const settingsRef: TabRef = { kind: "settings", id: "settings" };
    useTabsStore.setState({
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/providers",
        },
      },
    });
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(settingsRef), ref: settingsRef }],
      activeItemId: tabItemId(settingsRef),
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/providers",
        },
      },
    });
    const nav = makeDeferredNavigate();

    // `/draft/new` with restored tabs is `resolveDraftEntry`'s correction
    // path - no coordinator stub needed, and no route cache is populated.
    expect(hasRestoredTabs()).toBe(true);
    commitExternal({
      navigate: nav.asNavigate,
      pathname: "/draft/new",
      action: "REPLACE",
      key: "key-draft-new",
      index: 0,
      search: undefined,
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.lastEnvelope().intentKind).toBe("landing-replace");
    expect(nav.lastOptions().to).toBe("/settings/providers");
  });

  // The Epic half of the same defect: an uncached backing ref must not inherit
  // the focus search of the DIFFERENT epic route that failed.
  it("corrects to an uncached epic backing tab without inheriting foreign focus search", () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(a.ref), ref: a.ref },
        { kind: "tab", id: tabItemId(b.ref), ref: b.ref },
      ],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    failEveryActivation();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      action: "PUSH",
      key: "key-b-focused-external",
      index: 1,
      search: { focusArtifactId: "artifact-owned-by-b", focusedAt: 1234 },
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.lastEnvelope().destination).toEqual({
      kind: "tab",
      refKey: tabRefKey(a.ref),
    });
    const search = nav.lastOptions().search;
    expect(isRecord(search)).toBe(true);
    if (!isRecord(search)) throw new Error("unreachable");
    expect(search.focusArtifactId).toBeUndefined();
    expect(search.focusedAt).toBeUndefined();
  });

  // The degrade path: with nothing on the strip there is no backing route to
  // aim at, so the correction is still the landing.
  it("still corrects to the landing when the layout is empty", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    failEveryActivation();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "PUSH",
      key: "key-a-external",
      index: 1,
      search: undefined,
    });

    expect(nav.calls).toHaveLength(1);
    const envelope = nav.lastEnvelope();
    expect(envelope.intentKind).toBe("landing-replace");
    expect(envelope.destination).toEqual({ kind: "route", pathname: "/" });
    expect(nav.lastOptions().to).toBe("/");
  });
});

/**
 * The chain, end to end, through a router that actually applies what the
 * controller asks for. Without a committing router the drift cannot happen,
 * and without the drift the phantom mint cannot be reproduced.
 */
interface AppliedHistory {
  push: (pathname: string, search: Record<string, unknown> | undefined) => void;
  replace: (
    pathname: string,
    search: Record<string, unknown> | undefined,
  ) => void;
  /** The overlay push: `to: "."` keeps whatever pathname is current. */
  pushOverlay: (search: Record<string, unknown>) => void;
  back: () => void;
  currentPathname: () => string;
  depth: () => number;
}

function pathnameForDestination(
  destination: TabNavigationEnvelope["destination"],
): string {
  if (destination.kind === "route") return destination.pathname;
  const separator = destination.refKey.indexOf(":");
  const kind = destination.refKey.slice(0, separator);
  const id = destination.refKey.slice(separator + 1);
  if (kind === "draft") return draftPathname(id);
  if (kind === "history") return "/epics";
  if (kind === "settings") return "/settings/general";
  const tab = useEpicCanvasStore.getState().tabsById[id];
  expect(tab, `no canvas tab for ${destination.refKey}`).toBeDefined();
  if (tab === undefined) throw new Error("unreachable");
  return epicPathname({ epicId: tab.epicId, tabId: id });
}

function makeAppliedHistory(): AppliedHistory {
  const entries: TabNavigationLocation[] = [];
  let index = -1;
  let serial = 0;
  let applied = 0;

  const current = (): TabNavigationLocation => {
    const entry = entries[index];
    expect(entry, "history is empty").toBeDefined();
    return entry;
  };

  /** The router's own entry-state seed, before the controller's updater. */
  const nextParsedState = (): ParsedHistoryState => {
    serial += 1;
    const key = `key-${serial}`;
    return { key, __TSR_key: key, __TSR_index: index + 1 };
  };

  const commit = (
    pathname: string,
    search: Record<string, unknown> | undefined,
    state: unknown,
    replace: boolean,
  ): TabNavigationLocation => {
    const entry: TabNavigationLocation = { pathname, search, state };
    if (replace && index >= 0) entries[index] = entry;
    else {
      entries.splice(index + 1, entries.length, entry);
      index = entries.length - 1;
    }
    return entry;
  };

  const navigate: UseNavigateResult<string> = ((options: NavigateOptions) => {
    applied += 1;
    // A correction that keeps issuing corrections is a defect in its own
    // right; fail loudly rather than hang the suite.
    expect(applied, "router applied too many chained navigations").toBeLessThan(
      12,
    );
    const destination = envelopeFromNavigateOptions(options).destination;
    expect(destination).not.toBeNull();
    if (destination === null) throw new Error("unreachable");
    const state = options.state;
    if (typeof state !== "function") throw new Error("unreachable");
    const requested = options.search;
    const search =
      typeof requested === "function"
        ? requested(current().search ?? {})
        : requested;
    const entry = commit(
      pathnameForDestination(destination),
      isRecord(search) ? search : undefined,
      // The envelope round-trips through the router untouched: the state the
      // controller wrote is exactly the state the next observation reads.
      state(nextParsedState()),
      options.replace === true,
    );
    tabNavigationController.observeLocation(
      entry,
      options.replace === true ? "REPLACE" : "PUSH",
      navigate,
    );
    return Promise.resolve();
  }) as UseNavigateResult<string>;

  tabNavigationController.setLocationReader(() => current());

  const external = (
    pathname: string,
    search: Record<string, unknown> | undefined,
    replace: boolean,
  ): void => {
    const entry = commit(pathname, search, nextParsedState(), replace);
    tabNavigationController.observeLocation(
      entry,
      replace ? "REPLACE" : "PUSH",
      navigate,
    );
  };

  return {
    depth: () => applied,
    currentPathname: () => current().pathname,
    push: (pathname, search) => external(pathname, search, false),
    replace: (pathname, search) => external(pathname, search, true),
    pushOverlay: (search) => external(current().pathname, search, false),
    back: () => {
      expect(index).toBeGreaterThan(0);
      index -= 1;
      tabNavigationController.observeLocation(current(), "BACK", navigate);
    },
  };
}

describe("closing the Settings overlay over a populated strip", () => {
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

  it("mints no landing draft and leaves the strip untouched", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const history = makeAppliedHistory();
    history.push(a.pathname, undefined);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);

    // Phase 1 of the chain: the canvas REPLACES its own route to record tile
    // focus while the coordinator refuses every command.
    const activateSpy = failEveryActivation();
    history.replace(a.pathname, { ...TILE_FOCUS_SEARCH });
    activateSpy.mockRestore();
    expect(history.currentPathname()).toBe(a.pathname);

    // Phase 2: Settings pushes its overlay flag onto the CURRENT entry, and
    // closing pops it.
    history.pushOverlay({ settingsOverlay: true });
    expect(history.currentPathname()).toBe(a.pathname);
    history.back();

    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(stripLength()).toBe(1);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    expect(history.currentPathname()).toBe(a.pathname);
  });

  // Negative exemplar: stepping back onto a REAL landing entry is a genuine
  // request for Home, and Home on this shell is a draft. That mint must
  // survive the fix.
  it("still mints Home when the user genuinely steps back onto the landing", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const history = makeAppliedHistory();
    history.push("/", undefined);
    history.push(a.pathname, undefined);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);

    history.back();

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });
});
