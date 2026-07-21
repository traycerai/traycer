/**
 * T3 rev-3 adversarial verification (frozen provenance-design §9).
 *
 * Net-new race/ledger tests only — no production edits. Drives the real
 * controller, coordinator, and stores; fakes only the navigate promise /
 * router-commit boundaries.
 *
 * Out of scope (parent addendum): user-navigation 15s timeout / blocker
 * cancel-hang machinery — gui-app has no navigation blockers. Every case
 * below maps to a reachable current-app trigger (header/list activation,
 * history observe, Windows hydration release, prepared empty-draft swap,
 * repair/corrective replace, coordinator activateTab/restoreTabActivation).
 */
import "../../../../__tests__/test-browser-apis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  __resetTabNavigationHydrationForTesting,
  activateTabIntent,
  completeEpicMigrationIntent,
  getTabNavigationDiagnostics,
  resourceEpicTabIntent,
  tabNavigationController,
  type TabNavigationEnvelope,
} from "@/lib/tab-navigation";
import {
  existingEpicTabIntent,
  historyTabIntent,
  openEpicFromListIntent,
  settingsTabIntent,
} from "@/lib/tab-navigation/intents";
import { epicPathname } from "@/lib/routes";
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
  type SplitStripItem,
} from "@/stores/tabs/layout";
import {
  getTabCommandLedger,
  subscribeToTabCommandLedger,
  tabCommandCoordinator,
} from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

const HISTORY_ENVELOPE_KEY = "__traycerTabNavigation";

type NavigateMock = Mock<(options: NavigateOptions) => Promise<void>>;

type ParsedHistoryState = HistoryState & {
  readonly key: string | undefined;
  readonly __TSR_key: string | undefined;
  readonly __TSR_index: number;
};

interface ObservedEnvelope {
  readonly token: string;
  readonly targetRefKey: string | null;
  readonly intentKind: string;
  readonly sessionId: string | null;
  readonly serial: number | null;
  readonly destination: unknown;
}

interface DeferredNavigate {
  readonly mock: NavigateMock;
  readonly asNavigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  resolve: (index: number) => Promise<void>;
  reject: (index: number) => Promise<void>;
  envelopeAt: (index: number) => ObservedEnvelope;
  lastEnvelope: () => ObservedEnvelope;
  optionsAt: (index: number) => NavigateOptions;
  lastOptions: () => NavigateOptions;
}

function emptyParsedHistoryState(): ParsedHistoryState {
  return {
    key: undefined,
    __TSR_key: undefined,
    __TSR_index: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObservedEnvelope(value: unknown): ObservedEnvelope | null {
  if (!isRecord(value)) return null;
  const token = value.token;
  if (typeof token !== "string" || token.length === 0) return null;
  const intentKind = value.intentKind;
  if (typeof intentKind !== "string" || intentKind.length === 0) return null;
  const targetRefKey =
    typeof value.targetRefKey === "string" ? value.targetRefKey : null;
  const sessionId =
    typeof value.sessionId === "string" ? value.sessionId : null;
  const serial = typeof value.serial === "number" ? value.serial : null;
  return {
    token,
    targetRefKey,
    intentKind,
    sessionId,
    serial,
    destination: value.destination ?? null,
  };
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

function makeDeferredNavigate(): DeferredNavigate {
  const resolvers: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const calls: NavigateOptions[] = [];
  const mock: NavigateMock = vi.fn((options: NavigateOptions) => {
    calls.push(options);
    return new Promise<void>((resolve, reject) => {
      resolvers.push({ resolve, reject });
    });
  });
  const asNavigate: UseNavigateResult<string> = ((options: NavigateOptions) =>
    mock(options)) as UseNavigateResult<string>;
  return {
    mock,
    asNavigate,
    calls,
    resolve: async (index) => {
      const entry = resolvers[index];
      expect(entry, `missing navigate promise ${index}`).toBeDefined();
      entry.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    reject: async (index) => {
      const entry = resolvers[index];
      expect(entry, `missing navigate promise ${index}`).toBeDefined();
      entry.reject(new Error("navigation cancelled"));
      await Promise.resolve();
      await Promise.resolve();
    },
    envelopeAt: (index) => {
      const options = calls[index];
      expect(options, `missing navigate call ${index}`).toBeDefined();
      return envelopeFromNavigateOptions(options);
    },
    lastEnvelope: () => {
      expect(calls.length).toBeGreaterThan(0);
      return envelopeFromNavigateOptions(calls[calls.length - 1]);
    },
    optionsAt: (index) => {
      const options = calls[index];
      expect(options, `missing navigate call ${index}`).toBeDefined();
      return options;
    },
    lastOptions: () => {
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1];
    },
  };
}

function locationState(
  envelope: ObservedEnvelope | TabNavigationEnvelope | null,
  key: string,
  index: number,
): Record<string, unknown> {
  return envelope === null
    ? { __TSR_key: key, __TSR_index: index }
    : { __TSR_key: key, __TSR_index: index, [HISTORY_ENVELOPE_KEY]: envelope };
}

function commitInternal(args: {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: string;
  readonly envelope: ObservedEnvelope | TabNavigationEnvelope;
  readonly action: "PUSH" | "REPLACE";
  readonly key: string;
  readonly index: number;
  readonly search: Readonly<Record<string, unknown>> | undefined;
}): void {
  tabNavigationController.observeLocation(
    {
      pathname: args.pathname,
      state: locationState(args.envelope, args.key, args.index),
      search: args.search,
    },
    args.action,
    args.navigate,
  );
}

function commitExternal(args: {
  readonly navigate: UseNavigateResult<string>;
  readonly pathname: string;
  readonly action: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
  readonly key: string;
  readonly index: number;
  readonly search: Readonly<Record<string, unknown>> | undefined;
}): void {
  tabNavigationController.observeLocation(
    {
      pathname: args.pathname,
      state: locationState(null, args.key, args.index),
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

function openEpic(
  epicId: string,
  name: string,
): { readonly tabId: string; readonly ref: TabRef; readonly pathname: string } {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
  return {
    tabId,
    ref: { kind: "epic", id: tabId },
    pathname: epicPathname({ epicId, tabId }),
  };
}

function epicIntent(epicId: string, tabId: string) {
  return existingEpicTabIntent({
    epicId,
    tabId,
    focus: undefined,
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

function findSplitItem(id: string): SplitStripItem | null {
  const item = useTabsStore.getState().items.find((entry) => entry.id === id);
  return item?.kind === "split" ? item : null;
}

interface LedgerSnapshot {
  readonly source: "tabs" | "canvas" | "drafts" | "ledger";
  readonly placedKeys: ReadonlyArray<string>;
  readonly stripKeys: ReadonlyArray<string>;
  readonly sourceKeys: ReadonlyArray<string>;
  readonly reservedKeys: ReadonlyArray<string>;
  readonly pendingKeys: ReadonlyArray<string>;
  readonly suppressionDepth: number;
}

interface LedgerCapture {
  readonly snapshots: LedgerSnapshot[];
  readonly dispose: () => void;
  readonly assertAllSafe: () => void;
}

const activeLedgerCaptures = new Set<LedgerSnapshot[]>();

function layoutFromTabsState(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

function currentVisibleSourceKeys(): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState();
  const epicKeys = canvas.openTabOrder.flatMap((tabId) =>
    canvas.tabsById[tabId] === undefined ? [] : [`epic:${tabId}`],
  );
  const draftKeys = useLandingDraftStore
    .getState()
    .drafts.map((draft) => `draft:${draft.id}`);
  return [...epicKeys, ...draftKeys];
}

function assertUniqueKeys(keys: ReadonlyArray<string>, label: string): void {
  expect(new Set(keys).size, `${label} contains a duplicate`).toBe(keys.length);
}

function assertLedgerSnapshotSafe(snapshot: LedgerSnapshot): void {
  assertUniqueKeys(snapshot.placedKeys, "layout refs");
  assertUniqueKeys(snapshot.stripKeys, "strip projection");
  assertUniqueKeys(snapshot.sourceKeys, "visible source refs");
  snapshot.sourceKeys.forEach((key) => {
    expect(
      snapshot.placedKeys.includes(key) ||
        snapshot.reservedKeys.includes(key) ||
        snapshot.pendingKeys.includes(key),
      `${snapshot.source} exposed ${key} without placement/reservation/removal (depth=${snapshot.suppressionDepth})`,
    ).toBe(true);
  });
}

function recordLedgerSnapshot(source: LedgerSnapshot["source"]): void {
  if (activeLedgerCaptures.size === 0) return;
  const ledger = getTabCommandLedger();
  const snapshot: LedgerSnapshot = {
    source,
    placedKeys: flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey),
    stripKeys: useTabsStore.getState().stripOrder.map(tabRefKey),
    sourceKeys: currentVisibleSourceKeys(),
    reservedKeys: [...ledger.reservedAdditions.keys()],
    pendingKeys: [...ledger.pendingRemovals.keys()],
    suppressionDepth: ledger.suppressionDepth,
  };
  activeLedgerCaptures.forEach((snapshots) => snapshots.push(snapshot));
}

// These subscriptions are installed at module evaluation, before any test
// installs the production reconciliation subscriber. That ordering is
// intentional: an arbitrary source-store observer can run before the
// coordinator's repair listener, so the permanent guard must see the raw
// source callback rather than a post-repair sample.
useTabsStore.subscribe(() => recordLedgerSnapshot("tabs"));
useEpicCanvasStore.subscribe(() => recordLedgerSnapshot("canvas"));
useLandingDraftStore.subscribe(() => recordLedgerSnapshot("drafts"));
subscribeToTabCommandLedger(() => recordLedgerSnapshot("ledger"));

function captureLedgerSnapshots(): LedgerCapture {
  const snapshots: LedgerSnapshot[] = [];
  activeLedgerCaptures.add(snapshots);
  return {
    snapshots,
    dispose: () => {
      activeLedgerCaptures.delete(snapshots);
    },
    assertAllSafe: () => {
      expect(snapshots.length).toBeGreaterThan(0);
      snapshots.forEach(assertLedgerSnapshotSafe);
    },
  };
}

function expectUnplacedSourceWasReserved(
  capture: LedgerCapture,
  ref: TabRef,
): void {
  const key = tabRefKey(ref);
  expect(
    capture.snapshots.some(
      (snapshot) =>
        snapshot.sourceKeys.includes(key) &&
        !snapshot.placedKeys.includes(key) &&
        snapshot.reservedKeys.includes(key),
    ),
    `expected a source-visible, unplaced, reservation-covered snapshot for ${key}`,
  ).toBe(true);
}

function expectLedgerReleased(): void {
  const ledger = getTabCommandLedger();
  expect(ledger.reservedAdditions.size).toBe(0);
  expect(ledger.pendingRemovals.size).toBe(0);
  expect(ledger.suppressionDepth).toBe(0);
  expect(ledger.reconciliationDirty).toBe(false);
}

interface EmptyLedgerFailureSubscription {
  readonly dispose: () => void;
  readonly throwCount: () => number;
}

function throwOnceWhenLedgerClears(
  error: Error,
): EmptyLedgerFailureSubscription {
  let count = 0;
  const unsubscribe = subscribeToTabCommandLedger(() => {
    const ledger = getTabCommandLedger();
    if (
      count === 0 &&
      ledger.suppressionDepth === 0 &&
      ledger.reservedAdditions.size === 0 &&
      ledger.pendingRemovals.size === 0
    ) {
      count += 1;
      throw error;
    }
  });
  return {
    dispose: unsubscribe,
    throwCount: () => count,
  };
}

function runAndCaptureError(run: () => void): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

function expectPrimaryAndCleanupError(
  thrown: unknown,
  primary: Error,
  cleanup: Error,
): void {
  expect(thrown).toBe(primary);
  if (!(thrown instanceof Error)) {
    throw new Error("expected coordinator command to throw an Error");
  }
  expect(thrown.cause).toBe(cleanup);
  expectLedgerReleased();
}

function releaseHydration(navigate: UseNavigateResult<string>): void {
  // Reachable app trigger: Windows snapshot hydration → setHydrationReady.
  tabNavigationController.setHydrationReady(true, navigate);
}

function requireSerial(envelope: ObservedEnvelope): number {
  expect(
    envelope.serial,
    "rev3 envelope must carry serial (spec §1)",
  ).not.toBeNull();
  if (envelope.serial === null) {
    throw new Error("serial missing");
  }
  return envelope.serial;
}

function requireSessionId(envelope: ObservedEnvelope): string {
  expect(
    envelope.sessionId,
    "rev3 envelope must carry sessionId (spec §1)",
  ).not.toBeNull();
  if (envelope.sessionId === null) {
    throw new Error("sessionId missing");
  }
  return envelope.sessionId;
}

function epicTabIdFromEnvelope(envelope: ObservedEnvelope): string {
  if (
    isRecord(envelope.destination) &&
    envelope.destination.kind === "tab" &&
    typeof envelope.destination.refKey === "string"
  ) {
    const refKey = envelope.destination.refKey;
    const prefix = "epic:";
    expect(refKey.startsWith(prefix)).toBe(true);
    return refKey.slice(prefix.length);
  }
  if (
    envelope.targetRefKey !== null &&
    envelope.targetRefKey.startsWith("epic:")
  ) {
    return envelope.targetRefKey.slice("epic:".length);
  }
  throw new Error("prepared-swap envelope missing epic destination");
}

function craftUntrackedEnvelope(args: {
  readonly sessionId: string;
  readonly serial: number;
  readonly targetRefKey: string;
  readonly intentKind: string;
}): ObservedEnvelope {
  return {
    token: `untracked-${args.serial}-${args.targetRefKey}`,
    sessionId: args.sessionId,
    serial: args.serial,
    targetRefKey: args.targetRefKey,
    intentKind: args.intentKind,
    destination: {
      kind: "tab",
      refKey: args.targetRefKey,
    },
  };
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

/**
 * Pre-hydration suite start. The live app constructs the controller with
 * hydrationReady=false until Windows snapshot hydration calls
 * setHydrationReady(true). Prefer resetForTesting() leaves ready=false so
 * these tests share the same gate; when reset forces ready=true the first
 * materialization/navigate assertion fails for that reason.
 */
function resetForPreHydration(): void {
  resetStores();
  __resetTabNavigationHydrationForTesting();
}

describe("T3 rev-3 adversarial: authority clock & compaction", () => {
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

  // Trigger: internal B pending (delayed navigate task) → A commits → B
  // promise settles → its full record compacts → late B history delivery.
  it("delayed B settles after A commits; compacted late B self-classifies stale and repairs (not external-focus)", async () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA = nav.envelopeAt(1);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA,
      action: "PUSH",
      key: "key-a",
      index: 1,
      search: undefined,
    });
    await nav.resolve(1);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // B settles while superseded; a later external commit allows compaction.
    await nav.resolve(0);
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "PUSH",
      key: "key-a-advance",
      index: 2,
      search: undefined,
    });
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-late-compacted",
      index: 0,
      search: undefined,
    });
    expect(
      focusedRefKey(),
      "compacted late B must not steal focus (must repair to A)",
    ).toBe(tabRefKey(a.ref));
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.lastEnvelope().intentKind).toMatch(/repair|external-replace/);
  });

  // Trigger: hand-crafted current-session envelope after live authority exists
  // (simulates compacted/untracked delivery still carrying session+serial).
  it("current-session untracked serial < authority → stale repair", () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA = nav.envelopeAt(0);
    const sessionId = requireSessionId(envA);
    const serialA = requireSerial(envA);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA,
      action: "PUSH",
      key: "key-a",
      index: 1,
      search: undefined,
    });

    const authority = getTabNavigationDiagnostics().authoritySerial;
    expect(authority).toBeGreaterThanOrEqual(serialA);
    expect(authority).toBeGreaterThanOrEqual(1);

    const below = craftUntrackedEnvelope({
      sessionId,
      serial: authority - 1,
      targetRefKey: tabRefKey(b.ref),
      intentKind: "activate-push",
    });
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: below,
      action: "PUSH",
      key: "key-untracked-below",
      index: 0,
      search: undefined,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("current-session untracked serial === authority + matching destination → cache refresh / no-op", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA = nav.envelopeAt(0);
    const sessionId = requireSessionId(envA);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA,
      action: "PUSH",
      key: "key-a",
      index: 1,
      search: undefined,
    });
    const authority = getTabNavigationDiagnostics().authoritySerial;
    const same = craftUntrackedEnvelope({
      sessionId,
      serial: authority,
      targetRefKey: tabRefKey(a.ref),
      intentKind: "activate-push",
    });
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    const callsBefore = nav.calls.length;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: same,
      action: "REPLACE",
      key: "key-same-serial",
      index: 1,
      search: undefined,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore);
    expect(nav.calls.length).toBe(callsBefore);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("current-session untracked serial > authority → invalid/external (never silent ACK)", () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA = nav.envelopeAt(0);
    const sessionId = requireSessionId(envA);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA,
      action: "PUSH",
      key: "key-a",
      index: 1,
      search: undefined,
    });
    const authority = getTabNavigationDiagnostics().authoritySerial;
    const forged = craftUntrackedEnvelope({
      sessionId,
      serial: authority + 10,
      targetRefKey: tabRefKey(b.ref),
      intentKind: "activate-push",
    });
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: forged,
      action: "PUSH",
      key: "key-forged",
      index: 2,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
  });

  it("a live envelope whose source disappeared resolves externally instead of ACKing into a permanent skeleton", () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envelope = nav.envelopeAt(0);
    expect(tabCommandCoordinator.removeMovedRef(b.ref)).toBe(true);
    expect(useEpicCanvasStore.getState().tabsById[b.tabId]).toBeUndefined();

    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope,
      action: "PUSH",
      key: "key-b-after-source-removal",
      index: 1,
      search: undefined,
    });

    const correction = nav.lastEnvelope();
    expect(correction.intentKind).toBe("external-replace");
    expect(correction.targetRefKey).not.toBe(tabRefKey(b.ref));
    expect(focusedRefKey()).toBe(correction.targetRefKey);
  });
});

describe("T3 rev-3 adversarial: corrective ignoreBlocker + finite failure", () => {
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

  // Trigger: stale internal commit after supersession → owned repair-replace.
  it("corrective navigations pass ignoreBlocker: true", () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);

    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale",
      index: 1,
      search: undefined,
    });
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(
      Reflect.get(nav.lastOptions(), "ignoreBlocker"),
      "corrective repair must pass ignoreBlocker: true (spec §2)",
    ).toBe(true);
  });

  // Trigger: repair promise rejects twice before ACK (router abort).
  it("first correction reject retries once; second reject records terminal resolutionFailure and starts no third navigation", async () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);

    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale",
      index: 1,
      search: undefined,
    });
    const firstCorrectionIndex = nav.calls.length - 1;
    expect(nav.envelopeAt(firstCorrectionIndex).intentKind).toBe(
      "repair-replace",
    );

    await nav.reject(firstCorrectionIndex);
    expect(nav.calls.length).toBe(firstCorrectionIndex + 2);
    const retryIndex = firstCorrectionIndex + 1;
    expect(nav.envelopeAt(retryIndex).intentKind).toBe("repair-replace");
    expect(nav.envelopeAt(retryIndex).token).not.toBe(
      nav.envelopeAt(firstCorrectionIndex).token,
    );
    expect(Reflect.get(nav.optionsAt(retryIndex), "ignoreBlocker")).toBe(true);

    const callsBeforeTerminal = nav.calls.length;
    await nav.reject(retryIndex);
    expect(nav.calls.length).toBe(callsBeforeTerminal);
    expect(getTabNavigationDiagnostics().resolutionFailure).toBe(true);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Trigger: second delayed history delivery of the same stale entry after
  // the first repair has ACKed (no permanent repaired latch).
  it("second stale delivery after repair ACK starts a second repair", async () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA = nav.envelopeAt(1);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA,
      action: "PUSH",
      key: "key-a",
      index: 1,
      search: undefined,
    });
    await nav.resolve(1);

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale-1",
      index: 0,
      search: undefined,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    const repair1 = nav.lastEnvelope();
    expect(repair1.intentKind).toBe("repair-replace");

    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: repair1,
      action: "REPLACE",
      key: "key-repair-1",
      index: 1,
      search: undefined,
    });
    await nav.resolve(nav.calls.length - 1);

    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale-2",
      index: 0,
      search: undefined,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 2);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Trigger: external commit of a landing/non-tab route with no layout member
  // → owned landing-replace correction uses destination.kind === "route".
  it("owned landing correction uses route destination and ignoreBlocker", () => {
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    // Unknown invalid tab route forces owned landing correction.
    commitExternal({
      navigate: nav.asNavigate,
      pathname: "/epics/missing-epic/missing-tab",
      action: "PUSH",
      key: "key-invalid-tab",
      index: 1,
      search: undefined,
    });

    // Either synchronous landing (no nav) with empty layout, or an owned
    // landing-replace / external-replace with route destination.
    if (nav.calls.length === 0) {
      expect(focusedRefKey()).toBeNull();
      return;
    }
    const env = nav.lastEnvelope();
    expect(
      env.intentKind === "landing-replace" ||
        env.intentKind === "external-replace" ||
        env.intentKind === "repair-replace",
    ).toBe(true);
    expect(Reflect.get(nav.lastOptions(), "ignoreBlocker")).toBe(true);
    if (isRecord(env.destination)) {
      expect(
        env.destination.kind === "route" || env.destination.kind === "tab",
      ).toBe(true);
    }
  });
});

describe("T3 rev-3 adversarial: permanent observer & hydration queue", () => {
  beforeEach(async () => {
    resetForPreHydration();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
  });

  // Trigger: RootComponent mount placement (source contract).
  it("TabNavigationRouteBridge is mounted outside HostReadyGate (continuous history subscription)", () => {
    const rootPath = resolve(
      __dirname,
      "../../../routes/root-route-components.tsx",
    );
    const source = readFileSync(rootPath, "utf8");
    const bridgeIdx = source.indexOf("<TabNavigationRouteBridge");
    const gateOpenIdx = source.indexOf("<HostReadyGate");
    const gateCloseIdx = source.indexOf("</HostReadyGate>");
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(gateOpenIdx).toBeGreaterThan(-1);
    expect(gateCloseIdx).toBeGreaterThan(gateOpenIdx);
    const bridgeInsideGate =
      bridgeIdx > gateOpenIdx && bridgeIdx < gateCloseIdx;
    expect(
      bridgeInsideGate,
      "TabNavigationRouteBridge must mount outside HostReadyGate (spec §3)",
    ).toBe(false);
  });

  // Trigger: permanent history observer sees PUSH-away then BACK to same key
  // (same as TabNavigationRouteBridge.subscribe → observeLocation).
  it("continuous observer: PUSH-away then BACK to the original key focuses the committed member", () => {
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
    releaseHydration(nav.asNavigate);

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "REPLACE",
      key: "key-original-a",
      index: 0,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    commitExternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      action: "PUSH",
      key: "key-away-b",
      index: 1,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "key-original-a",
      index: 0,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("remount classifies a compacted current-session stale envelope and repairs", () => {
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
    releaseHydration(nav.asNavigate);

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const stale = nav.envelopeAt(0);
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const authority = nav.envelopeAt(1);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: authority,
      action: "PUSH",
      key: "key-authority",
      index: 1,
      search: undefined,
    });

    tabNavigationController.setLocationReader(() => ({
      pathname: b.pathname,
      state: locationState(stale, "key-stale-remount", 0),
      search: undefined,
    }));
    const repairs = getTabNavigationDiagnostics().repairCount;
    tabNavigationController.synchronizeInitialLocation();

    expect(getTabNavigationDiagnostics().repairCount).toBe(repairs + 1);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Trigger: deep-link Settings/History before Windows hydration completes,
  // then setHydrationReady (Windows bridge).
  it("pre-hydration external Settings/History is queued latest-wins, key-revalidated, then materialized", () => {
    const nav = makeDeferredNavigate();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: "/settings/providers",
      action: "PUSH",
      key: "key-settings-prehydrate",
      index: 1,
      search: { tab: "providers" },
    });
    // Pre-hydration: must NOT materialize/focus yet.
    expect(
      useTabsStore.getState().systemTabs.settings,
      "Settings must not materialize before hydration (reset should leave hydrationReady=false)",
    ).toBeNull();
    expect(focusedRefKey()).not.toBe("settings:settings");

    // Latest-wins single queuedExternal slot → History replaces Settings.
    commitExternal({
      navigate: nav.asNavigate,
      pathname: "/epics",
      action: "PUSH",
      key: "key-history-prehydrate",
      index: 2,
      search: undefined,
    });
    expect(useTabsStore.getState().systemTabs.history).toBeNull();

    tabNavigationController.setLocationReader(() => ({
      pathname: "/epics",
      state: locationState(null, "key-history-prehydrate", 2),
      search: undefined,
    }));
    releaseHydration(nav.asNavigate);

    expect(useTabsStore.getState().systemTabs.history).not.toBeNull();
    expect(focusedRefKey()).toBe("history:history");
    expect(useTabsStore.getState().systemTabs.settings).toBeNull();
  });

  // Trigger: user activations (header/palette) before hydration, then release.
  it("pre-hydration user activations are latest-wins and do not allocate a serial until hydration", () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);

    expect(
      nav.calls.length,
      "pre-hydration activations must not navigate/allocate serial yet",
    ).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    releaseHydration(nav.asNavigate);

    expect(nav.calls.length).toBe(1);
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(b.ref));
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(requireSerial(nav.lastEnvelope())).toBeGreaterThan(0);
  });

  it("pre-hydration /draft/new creates and routes one draft only after hydration", () => {
    const nav = makeDeferredNavigate();
    const location = {
      pathname: "/draft/new",
      state: locationState(null, "key-draft-new", 1),
      search: undefined,
    };
    tabNavigationController.observeLocation(
      location,
      "REPLACE",
      nav.asNavigate,
    );
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(nav.calls).toHaveLength(0);

    tabNavigationController.setLocationReader(() => location);
    releaseHydration(nav.asNavigate);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(nav.calls).toHaveLength(1);
    expect(nav.lastEnvelope().intentKind).toBe("external-replace");
    expect(nav.lastEnvelope().targetRefKey?.startsWith("draft:")).toBe(true);
  });

  it("pre-hydration stale /draft/new returns to restored membership without minting", () => {
    useTabsStore.setState({
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: "/epics",
        },
        settings: null,
      },
      stripOrder: [{ kind: "history", id: "history" }],
    });
    const nav = makeDeferredNavigate();
    const location = {
      pathname: "/draft/new",
      state: locationState(null, "key-draft-new-restored", 1),
      search: undefined,
    };
    tabNavigationController.observeLocation(
      location,
      "REPLACE",
      nav.asNavigate,
    );
    tabNavigationController.setLocationReader(() => location);
    releaseHydration(nav.asNavigate);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(nav.calls).toHaveLength(1);
    expect(nav.lastEnvelope().intentKind).toBe("landing-replace");
    expect(nav.lastOptions().to).toBe("/");
  });
});

describe("T3 rev-3 adversarial: prepared Draft→Epic split swap", () => {
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

  function seedDraftCompanionSplit(): {
    readonly draftId: string;
    readonly draftRef: TabRef;
    readonly companion: { readonly tabId: string; readonly ref: TabRef };
    readonly splitId: string;
  } {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const draftRef: TabRef = { kind: "draft", id: draftId };
    const companion = openEpic("epic-companion", "Companion");
    const splitId = "split-draft-companion";
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: splitId,
          left: { kind: "tab", ref: draftRef },
          right: { kind: "tab", ref: companion.ref },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: splitId,
      systemTabs: { history: null, settings: null },
    });
    return { draftId, draftRef, companion, splitId };
  }

  // Trigger: epic-list open with replaceEmptyDraftId from a focused empty draft.
  it("rejected prepared swap preserves exact split structure", async () => {
    const { draftId, draftRef, companion, splitId } = seedDraftCompanionSplit();
    const nav = makeDeferredNavigate();
    const splitBefore = findSplitItem(splitId);

    activateTabIntent(
      nav.asNavigate,
      openEpicFromListIntent({
        epicId: "epic-to-swap-in",
        focus: undefined,
        name: "Swapped Epic",
        replaceEmptyDraftId: draftId,
      }),
      undefined,
    );
    await nav.reject(0);

    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);
    const splitAfter = findSplitItem(splitId);
    expect(splitAfter).not.toBeNull();
    expect(splitAfter?.left).toEqual({ kind: "tab", ref: draftRef });
    expect(splitAfter?.right).toEqual({ kind: "tab", ref: companion.ref });
    expect(splitAfter?.leftRatio).toBe(splitBefore?.leftRatio);
    expect(splitAfter?.focusedSide).toBe("left");
  });

  it("ACK performs in-place replaceDraftWithEpic once; draft membership ends", async () => {
    const { draftId, companion } = seedDraftCompanionSplit();
    const nav = makeDeferredNavigate();

    activateTabIntent(
      nav.asNavigate,
      openEpicFromListIntent({
        epicId: "epic-to-swap-in",
        focus: undefined,
        name: "Swapped Epic",
        replaceEmptyDraftId: draftId,
      }),
      undefined,
    );
    // Prepared id is stamped on the envelope before source exists.
    const env = nav.envelopeAt(0);
    const swapTabId = epicTabIdFromEnvelope(env);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: epicPathname({ epicId: "epic-to-swap-in", tabId: swapTabId }),
      envelope: env,
      action: "PUSH",
      key: "key-swap-ack",
      index: 1,
      search: undefined,
    });
    await nav.resolve(0);

    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(false);
    expect(useTabsStore.getState().stripOrder).toContainEqual({
      kind: "epic",
      id: swapTabId,
    });
    expect(useTabsStore.getState().stripOrder).toContainEqual(companion.ref);
  });

  it("superseded prepared-swap token never runs placement on late commit or remount re-ACK", async () => {
    const { draftId, draftRef, companion, splitId } = seedDraftCompanionSplit();
    const nav = makeDeferredNavigate();

    activateTabIntent(
      nav.asNavigate,
      openEpicFromListIntent({
        epicId: "epic-to-swap-in",
        focus: undefined,
        name: "Swapped Epic",
        replaceEmptyDraftId: draftId,
      }),
      undefined,
    );
    const envSwap = nav.envelopeAt(0);
    const swapTabId = epicTabIdFromEnvelope(envSwap);

    activateTabIntent(nav.asNavigate, settingsTabIntent("general"), undefined);
    const envSettings = nav.envelopeAt(1);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: "/settings/general",
      envelope: envSettings,
      action: "PUSH",
      key: "key-settings",
      index: 1,
      search: undefined,
    });
    await nav.resolve(1);
    expect(focusedRefKey()).toBe("settings:settings");

    commitInternal({
      navigate: nav.asNavigate,
      pathname: epicPathname({
        epicId: "epic-to-swap-in",
        tabId: swapTabId,
      }),
      envelope: envSwap,
      action: "PUSH",
      key: "key-swap-late",
      index: 0,
      search: undefined,
    });
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);

    tabNavigationController.setLocationReader(() => ({
      pathname: "/settings/general",
      state: locationState(envSettings, "key-settings", 1),
      search: undefined,
    }));
    tabNavigationController.synchronizeInitialLocation();
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);
    const split = findSplitItem(splitId);
    if (split !== null) {
      expect(split.left).toEqual({ kind: "tab", ref: draftRef });
      expect(split.right).toEqual({ kind: "tab", ref: companion.ref });
    }
  });
});

describe("T3 rev-3 adversarial: coordinator ledger & structural restore", () => {
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

  it("fresh Epic is covered in every ledger/layout/source snapshot", () => {
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "epic",
      epicId: "epic-fresh",
      tabId: null,
      name: "Fresh",
    });
    capture.dispose();

    expect(activation).not.toBeNull();
    if (activation === null) throw new Error("expected activation");
    capture.assertAllSafe();
    expectUnplacedSourceWasReserved(capture, activation.ref);
    expectLedgerReleased();
    expect(focusedRefKey()).toBe(tabRefKey(activation.ref));
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      activation.ref.id,
    ]);
  });

  it("fresh Draft is covered in every ledger/layout/source snapshot", () => {
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const draftId = "draft-fresh-1";
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "draft",
      draftId,
      settings: null,
      create: true,
    });
    capture.dispose();

    expect(activation).not.toBeNull();
    if (activation === null) throw new Error("expected activation");
    capture.assertAllSafe();
    expectUnplacedSourceWasReserved(capture, activation.ref);
    expectLedgerReleased();
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);
  });

  it("system-tab materialization reserves before the tabs store places it", () => {
    const ref: TabRef = { kind: "settings", id: "settings" };
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "system",
      systemKind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
    capture.dispose();

    expect(activation?.ref).toEqual(ref);
    capture.assertAllSafe();
    expect(
      capture.snapshots.some(
        (snapshot) =>
          snapshot.reservedKeys.includes(tabRefKey(ref)) &&
          !snapshot.placedKeys.includes(tabRefKey(ref)),
      ),
    ).toBe(true);
    expect(
      capture.snapshots.some((snapshot) =>
        snapshot.placedKeys.includes(tabRefKey(ref)),
      ),
    ).toBe(true);
    expectLedgerReleased();
  });

  it("an open Epic missing from layout is repaired under reservation", () => {
    const missing = openEpic("epic-repaired", "Repaired");
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "ref",
      ref: missing.ref,
    });
    capture.dispose();

    expect(activation?.ref).toEqual(missing.ref);
    capture.assertAllSafe();
    expectUnplacedSourceWasReserved(capture, missing.ref);
    expectLedgerReleased();
  });

  it("an open Draft missing from layout is repaired under reservation", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const ref: TabRef = { kind: "draft", id: draftId };
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "draft",
      draftId,
      settings: null,
      create: false,
    });
    capture.dispose();

    expect(activation?.ref).toEqual(ref);
    capture.assertAllSafe();
    expectUnplacedSourceWasReserved(capture, ref);
    expectLedgerReleased();
  });

  it("pure Epic resolution reopens a retained closed tab under reservation", () => {
    const retained = openEpic("epic-retained", "Retained");
    useEpicCanvasStore.getState().closeTab(retained.tabId);
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    expect(
      useEpicCanvasStore.getState().tabsById[retained.tabId],
    ).toBeDefined();
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(
      retained.tabId,
    );
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "epic",
      epicId: "epic-retained",
      tabId: null,
      name: undefined,
    });
    capture.dispose();

    expect(activation?.ref).toEqual(retained.ref);
    capture.assertAllSafe();
    expectUnplacedSourceWasReserved(capture, retained.ref);
    expect(focusedRefKey()).toBe(tabRefKey(retained.ref));
    expectLedgerReleased();
  });

  it("an already-placed ref uses an empty reservation and adds no membership", () => {
    const placed = openEpic("epic-placed", "Placed");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(placed.ref), ref: placed.ref }],
      activeItemId: tabItemId(placed.ref),
      systemTabs: { history: null, settings: null },
    });
    const beforeKeys = flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey);
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "ref",
      ref: placed.ref,
    });
    capture.dispose();

    expect(activation?.ref).toEqual(placed.ref);
    capture.assertAllSafe();
    expect(
      capture.snapshots.every(
        (snapshot) =>
          !snapshot.reservedKeys.includes(tabRefKey(placed.ref)) &&
          snapshot.placedKeys.filter((key) => key === tabRefKey(placed.ref))
            .length === 1,
      ),
    ).toBe(true);
    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual(
      beforeKeys,
    );
    expectLedgerReleased();
  });

  it("migrated-epic reopens a retained Phase ref under reservation before placement", () => {
    const phase = openEpic("phase-source", "Phase");
    useEpicCanvasStore.getState().closeTab(phase.tabId);
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "migrated-epic",
      sourceEpicId: "phase-source",
      epicId: "epic-canonical",
      tabId: phase.tabId,
    });
    capture.dispose();

    expect(activation?.ref).toEqual(phase.ref);
    capture.assertAllSafe();
    expectUnplacedSourceWasReserved(capture, phase.ref);
    expect(useEpicCanvasStore.getState().tabsById[phase.tabId]?.epicId).toBe(
      "epic-canonical",
    );
    expectLedgerReleased();
  });

  it("migrated-epic canonical reapplication reserves nothing and adds no membership", () => {
    const canonical = openEpic("epic-canonical", "Canonical");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "tab",
          id: tabItemId(canonical.ref),
          ref: canonical.ref,
        },
      ],
      activeItemId: tabItemId(canonical.ref),
      systemTabs: { history: null, settings: null },
    });
    const beforeKeys = flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey);
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "migrated-epic",
      sourceEpicId: "phase-source",
      epicId: "epic-canonical",
      tabId: canonical.tabId,
    });
    capture.dispose();

    expect(activation?.ref).toEqual(canonical.ref);
    capture.assertAllSafe();
    expect(
      capture.snapshots.every(
        (snapshot) =>
          !snapshot.reservedKeys.includes(tabRefKey(canonical.ref)) &&
          snapshot.placedKeys.filter((key) => key === tabRefKey(canonical.ref))
            .length === 1,
      ),
    ).toBe(true);
    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual(
      beforeKeys,
    );
    expectLedgerReleased();
  });

  it("migrated-epic rejects a third-owner ref without publishing ledger or mutating stores", () => {
    const thirdOwner = openEpic("epic-third-owner", "Third owner");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "tab",
          id: tabItemId(thirdOwner.ref),
          ref: thirdOwner.ref,
        },
      ],
      activeItemId: tabItemId(thirdOwner.ref),
      systemTabs: { history: null, settings: null },
    });
    const layoutBefore = useTabsStore.getState().items;
    const canvasBefore = useEpicCanvasStore.getState();
    const capture = captureLedgerSnapshots();
    const activation = tabCommandCoordinator.activateTab({
      kind: "migrated-epic",
      sourceEpicId: "phase-source",
      epicId: "epic-canonical",
      tabId: thirdOwner.tabId,
    });
    capture.dispose();

    expect(activation).toBeNull();
    expect(capture.snapshots).toHaveLength(0);
    expect(useTabsStore.getState().items).toBe(layoutBefore);
    expect(useEpicCanvasStore.getState()).toBe(canvasBefore);
    expect(
      useEpicCanvasStore.getState().tabsById[thirdOwner.tabId]?.epicId,
    ).toBe("epic-third-owner");
    expectLedgerReleased();
  });

  it("fresh source failure preserves T2 error precedence and releases the ledger", () => {
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const state = useLandingDraftStore.getState();
    const create = vi
      .spyOn(state, "createDraftWithId")
      .mockImplementation(() => {
        throw new Error("source-create-failure");
      });

    expect(() =>
      tabCommandCoordinator.activateTab({
        kind: "draft",
        draftId: "draft-failure",
        settings: null,
        create: true,
      }),
    ).toThrow("source-create-failure");
    expect(create).toHaveBeenCalledTimes(1);
    expectLedgerReleased();
  });

  it("activateTab preserves projection-primary/EMPTY-ledger-cause precedence and cleanup", () => {
    const epic = openEpic("epic-projection", "Projection");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(epic.ref), ref: epic.ref }],
      activeItemId: tabItemId(epic.ref),
      systemTabs: { history: null, settings: null },
    });
    const primary = new Error("activate projection failure");
    const cleanup = new Error("activate EMPTY-ledger failure");
    let primaryThrows = 0;
    const capture = captureLedgerSnapshots();
    const unsubscribePrimary = useEpicCanvasStore.subscribe(
      (next, previous) => {
        if (
          primaryThrows > 0 ||
          previous.activeTabId !== epic.tabId ||
          next.activeTabId !== null ||
          getTabCommandLedger().suppressionDepth === 0
        ) {
          return;
        }
        primaryThrows += 1;
        throw primary;
      },
    );
    const cleanupFailure = throwOnceWhenLedgerClears(cleanup);
    const thrown = runAndCaptureError(() => {
      tabCommandCoordinator.activateTab({
        kind: "system",
        systemKind: "settings",
        name: "Settings",
        lastPath: "/settings/general",
      });
    });
    unsubscribePrimary();
    cleanupFailure.dispose();
    capture.dispose();

    expect(primaryThrows).toBe(1);
    expect(cleanupFailure.throwCount()).toBe(1);
    expectPrimaryAndCleanupError(thrown, primary, cleanup);
    capture.assertAllSafe();
  });

  it("restoreTabActivation preserves projection-primary/EMPTY-ledger-cause precedence and cleanup", () => {
    const epic = openEpic("epic-restore", "Restore");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(epic.ref), ref: epic.ref }],
      activeItemId: tabItemId(epic.ref),
      systemTabs: { history: null, settings: null },
    });
    const activation = tabCommandCoordinator.activateTab({
      kind: "system",
      systemKind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
    expect(activation).not.toBeNull();
    if (activation === null) throw new Error("expected Settings activation");
    expect(useEpicCanvasStore.getState().activeTabId).toBeNull();

    const primary = new Error("restore projection failure");
    const cleanup = new Error("restore EMPTY-ledger failure");
    let primaryThrows = 0;
    const capture = captureLedgerSnapshots();
    const unsubscribePrimary = useEpicCanvasStore.subscribe(
      (next, previous) => {
        if (
          primaryThrows > 0 ||
          previous.activeTabId !== null ||
          next.activeTabId !== epic.tabId ||
          getTabCommandLedger().suppressionDepth === 0
        ) {
          return;
        }
        primaryThrows += 1;
        throw primary;
      },
    );
    const cleanupFailure = throwOnceWhenLedgerClears(cleanup);
    const thrown = runAndCaptureError(() => {
      tabCommandCoordinator.restoreTabActivation(activation);
    });
    unsubscribePrimary();
    cleanupFailure.dispose();
    capture.dispose();

    expect(primaryThrows).toBe(1);
    expect(cleanupFailure.throwCount()).toBe(1);
    expectPrimaryAndCleanupError(thrown, primary, cleanup);
    capture.assertAllSafe();
    expect(focusedRefKey()).toBe(tabRefKey(epic.ref));
  });

  it("migrated-epic preserves projection-primary/EMPTY-ledger-cause precedence and cleanup", () => {
    const phase = openEpic("phase-error", "Phase");
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const draftRef: TabRef = { kind: "draft", id: draftId };
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(draftRef), ref: draftRef },
        { kind: "tab", id: tabItemId(phase.ref), ref: phase.ref },
      ],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
    });
    const primary = new Error("migration projection failure");
    const cleanup = new Error("migration EMPTY-ledger failure");
    let primaryThrows = 0;
    const capture = captureLedgerSnapshots();
    const unsubscribePrimary = useLandingDraftStore.subscribe(
      (next, previous) => {
        if (
          primaryThrows > 0 ||
          previous.activeDraftId !== draftId ||
          next.activeDraftId !== null ||
          getTabCommandLedger().suppressionDepth === 0
        ) {
          return;
        }
        primaryThrows += 1;
        throw primary;
      },
    );
    const cleanupFailure = throwOnceWhenLedgerClears(cleanup);
    const thrown = runAndCaptureError(() => {
      tabCommandCoordinator.activateTab({
        kind: "migrated-epic",
        sourceEpicId: "phase-error",
        epicId: "epic-after-error",
        tabId: phase.tabId,
      });
    });
    unsubscribePrimary();
    cleanupFailure.dispose();
    capture.dispose();

    expect(primaryThrows).toBe(1);
    expect(cleanupFailure.throwCount()).toBe(1);
    expectPrimaryAndCleanupError(thrown, primary, cleanup);
    capture.assertAllSafe();
    expect(useEpicCanvasStore.getState().tabsById[phase.tabId]?.epicId).toBe(
      "epic-after-error",
    );
  });

  // Trigger: restore after layout structure changed (e.g. user split while nav pending).
  it("restoreTabActivation refuses after structural layout change (returns false, keeps newer state)", () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });

    const activation = tabCommandCoordinator.activateTab({
      kind: "ref",
      ref: b.ref,
    });
    expect(activation).not.toBeNull();
    if (activation === null) throw new Error("expected activation");
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-structural",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "tab", ref: b.ref },
          focusedSide: "right",
          routeBackingSide: "right",
          leftRatio: 0.4,
        },
      ],
      activeItemId: "split-structural",
      systemTabs: { history: null, settings: null },
    });

    const restored = tabCommandCoordinator.restoreTabActivation(activation);
    expect(restored).toBe(false);
    expect(useTabsStore.getState().activeItemId).toBe("split-structural");
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(getTabCommandLedger().reservedAdditions.size).toBe(0);
  });

  it("restoreTabActivation succeeds when structure still matches owned selection", () => {
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

    const activation = tabCommandCoordinator.activateTab({
      kind: "ref",
      ref: b.ref,
    });
    expect(activation).not.toBeNull();
    if (activation === null) throw new Error("expected activation");

    const restored = tabCommandCoordinator.restoreTabActivation(activation);
    expect(restored).toBe(true);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) =>
            item.kind === "tab" &&
            item.ref.kind === "epic" &&
            item.ref.id === b.tabId,
        ),
    ).toBe(true);
  });
});

describe("T3 rev-3 adversarial: Resource Monitor nested + Phase completion", () => {
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

  // Trigger: Resource Monitor opens an owner whose Epic has no tab yet.
  it("Resource Monitor resolves the tab before preparing its nested target", () => {
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    activateTabIntent(
      nav.asNavigate,
      resourceEpicTabIntent({
        epicId: "epic-resource",
        tabId: null,
        name: "Resource owner",
        focus: {
          focusedAt: 100,
          focusArtifactId: "chat-resource",
          focusThreadId: undefined,
          migrationSource: undefined,
        },
        preparation: {
          kind: "open-tile",
          node: {
            id: "chat-resource",
            instanceId: "tile-resource",
            type: "chat",
            name: "Resource chat",
            hostId: "host-resource",
          },
        },
        includeNestedFocus: true,
      }),
      undefined,
    );
    expect(nav.calls.length).toBe(1);
    const resolved = useEpicCanvasStore
      .getState()
      .resolveTabIdForEpic("epic-resource");
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error("expected resolved resource tab");
    expect(
      useEpicCanvasStore.getState().canvasByTabId[resolved]?.tilesByInstanceId[
        "tile-resource"
      ],
    ).toBeDefined();
    const search = nav.lastOptions().search;
    expect(search).toBeDefined();
    if (isRecord(search)) {
      expect(search.focusPaneId).toBeTypeOf("string");
      expect(search.focusTileInstanceId).toBe("tile-resource");
    } else {
      expect(search).toBeTruthy();
    }
    expect(nav.lastEnvelope().targetRefKey).toBe(
      tabRefKey({ kind: "epic", id: resolved }),
    );
  });

  // Trigger: Phase completion returns a different Epic id while another tab
  // for the source Phase is the MRU candidate.
  it("Phase completion migrates and activates the exact route tab, not Epic MRU", () => {
    const first = openEpic("epic-phase", "Phase Epic");
    const second = openEpic("epic-phase", "Phase Epic other tab");
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(first.ref), ref: first.ref },
        { kind: "tab", id: tabItemId(second.ref), ref: second.ref },
      ],
      activeItemId: tabItemId(first.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(
      nav.asNavigate,
      completeEpicMigrationIntent({
        sourceEpicId: "epic-phase",
        epicId: "epic-migrated",
        tabId: first.tabId,
        focus: {
          focusedAt: 123,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
        },
        nestedFocus: null,
      }),
      { replace: true },
    );
    expect(useEpicCanvasStore.getState().tabsById[first.tabId]?.epicId).toBe(
      "epic-migrated",
    );
    expect(useEpicCanvasStore.getState().tabsById[second.tabId]?.epicId).toBe(
      "epic-phase",
    );
    expect(focusedRefKey()).toBe(tabRefKey(first.ref));
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(first.ref));
    expect(nav.lastOptions().params).toEqual({
      epicId: "epic-migrated",
      tabId: first.tabId,
    });
    expect(nav.lastOptions().replace).toBe(true);
  });
});

describe("T3 rev-3 adversarial: external supersede + POP + envelope fields", () => {
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

  it("external supersedes pending then late internal commit repairs (URL/layout agreement)", () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "PUSH",
      key: "key-external-a",
      index: 1,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-late",
      index: 0,
      search: undefined,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Trigger: browser Back during pending / acknowledged-unsettled activation.
  it("POP during pending and during acknowledged-unsettled focuses external authority", async () => {
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

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "key-pop-pending",
      index: 0,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    await nav.reject(0);

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB2 = nav.envelopeAt(nav.calls.length - 1);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB2,
      action: "PUSH",
      key: "key-b-ack",
      index: 1,
      search: undefined,
    });
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "key-pop-ack",
      index: 0,
      search: undefined,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("history intent materializes system tab through controller activation", () => {
    const nav = makeDeferredNavigate();
    activateTabIntent(nav.asNavigate, historyTabIntent(), undefined);
    expect(useTabsStore.getState().systemTabs.history).not.toBeNull();
    expect(focusedRefKey()).toBe("history:history");
    expect(nav.calls.length).toBe(1);
  });

  it("issued envelopes carry sessionId, serial, and destination union", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const env = nav.envelopeAt(0);
    expect(requireSessionId(env).length).toBeGreaterThan(0);
    expect(requireSerial(env)).toBeGreaterThan(0);
    expect(env.destination).not.toBeNull();
    expect(isRecord(env.destination) && env.destination.kind === "tab").toBe(
      true,
    );
  });

  it("diagnostics.authoritySerial never decreases across ACK and external POP", () => {
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

    const auth0 = getTabNavigationDiagnostics().authoritySerial;

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    const auth1 = getTabNavigationDiagnostics().authoritySerial;
    expect(auth1).toBeGreaterThanOrEqual(auth0);

    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b",
      index: 1,
      search: undefined,
    });
    const auth2 = getTabNavigationDiagnostics().authoritySerial;
    expect(auth2).toBeGreaterThanOrEqual(auth1);

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "key-pop",
      index: 0,
      search: undefined,
    });
    const auth3 = getTabNavigationDiagnostics().authoritySerial;
    expect(auth3).toBeGreaterThanOrEqual(auth2);
  });
});
