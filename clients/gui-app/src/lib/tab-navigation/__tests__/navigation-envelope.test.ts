/**
 * T3 TabNavigationController envelope lifecycle.
 *
 * Drives the controller directly via `activateTabIntent` /
 * `tabNavigationController.observeLocation` — no production edits, no
 * full AppShell. Fakes only the navigate promise boundary.
 */
import "../../../../__tests__/test-browser-apis";
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
  activatePreparedPairTabIntent,
  activateTabIntent,
  getTabNavigationDiagnostics,
  tabNavigationController,
  type TabNavigationEnvelope,
  type TabNavigationLocation,
} from "@/lib/tab-navigation";
import {
  draftTabIntent,
  existingEpicTabIntent,
  newDraftTabIntent,
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
} from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

/** Local mirror of the controller's private selection snapshot shape. */
interface TabSelectionSnapshot {
  readonly activeItemId: string | null;
  readonly focusedSide: "left" | "right" | null;
}

const HISTORY_ENVELOPE_KEY = "__traycerTabNavigation";

/**
 * Mirror of `@tanstack/history` ParsedHistoryState. The router stamps
 * `__TSR_index` on every entry; NavigateOptions state updaters accept this
 * shape. Not re-exported from `@tanstack/react-router`.
 */
type ParsedHistoryState = HistoryState & {
  readonly key: string | undefined;
  readonly __TSR_key: string | undefined;
  readonly __TSR_index: number;
};

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

function readIntentKind(
  value: unknown,
): TabNavigationEnvelope["intentKind"] | null {
  switch (value) {
    case "activate-push":
    case "focus-replace":
    case "repair-replace":
    case "external-replace":
    case "landing-replace":
      return value;
    default:
      return null;
  }
}

function readEnvelope(value: unknown): TabNavigationEnvelope | null {
  if (!isRecord(value)) return null;
  const sessionId = value.sessionId;
  const token = value.token;
  const serial = value.serial;
  const destination = readDestination(value.destination);
  const targetRefKey = value.targetRefKey;
  const intentKind = readIntentKind(value.intentKind);
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof serial !== "number" || !Number.isSafeInteger(serial)) return null;
  if (destination === null) return null;
  if (typeof targetRefKey !== "string" || targetRefKey.length === 0) {
    return null;
  }
  if (intentKind === null) return null;
  return {
    sessionId,
    token,
    serial,
    destination,
    targetRefKey,
    intentKind,
  };
}

type NavigateMock = Mock<(options: NavigateOptions) => Promise<void>>;

interface DeferredNavigate {
  readonly mock: NavigateMock;
  readonly asNavigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  resolve: (index: number) => Promise<void>;
  reject: (index: number) => Promise<void>;
  envelopeAt: (index: number) => TabNavigationEnvelope;
  lastEnvelope: () => TabNavigationEnvelope;
}

function envelopeFromNavigateOptions(
  options: NavigateOptions,
): TabNavigationEnvelope {
  const state = options.state;
  expect(typeof state).toBe("function");
  if (typeof state !== "function") {
    throw new Error("expected navigate state updater function");
  }
  // Call with a typed ParsedHistoryState fixture — same shape the router
  // supplies. No cast: state is already a function on NavigateOptions.
  const nextState: HistoryState = state(emptyParsedHistoryState());
  const envelope = isRecord(nextState)
    ? readEnvelope(nextState[HISTORY_ENVELOPE_KEY])
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
  // Vitest Mock is structurally narrower than UseNavigateResult; wrap so
  // callers get the navigate fn without asserting through unknown.
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
  };
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

function locationState(
  envelope: TabNavigationEnvelope | null,
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
  readonly envelope: TabNavigationEnvelope;
  readonly action: "PUSH" | "REPLACE";
  readonly key: string;
  readonly index: number;
}): void {
  tabNavigationController.observeLocation(
    {
      pathname: args.pathname,
      state: locationState(args.envelope, args.key, args.index),
      search: undefined,
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
}): void {
  tabNavigationController.observeLocation(
    {
      pathname: args.pathname,
      state: locationState(null, args.key, args.index),
      search: undefined,
    },
    args.action,
    args.navigate,
  );
}

function activeSelection(): TabSelectionSnapshot {
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  return {
    activeItemId: state.activeItemId,
    focusedSide: active?.kind === "split" ? active.focusedSide : null,
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

function activeSplitFocusedSide(): "left" | "right" | null {
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  if (active?.kind !== "split") return null;
  return active.focusedSide;
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

describe("TabNavigationController envelope lifecycle", () => {
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

  it("rapid A→B→A supersedes older tokens; final selection is A; late A commit repairs", async () => {
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
    const envA1 = nav.envelopeAt(0);
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(1);
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA2 = nav.envelopeAt(2);

    expect(envA1.token).not.toBe(envB.token);
    expect(envB.token).not.toBe(envA2.token);
    // Superseded records compact immediately; the self-classifying envelope
    // carries enough session+serial provenance to repair after compaction.
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // Late commit of superseded first A: must not leave layout on B; repair.
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA1,
      action: "PUSH",
      key: "key-a1",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.calls.length).toBe(4);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // Authoritative final A commit acks.
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA2,
      action: "PUSH",
      key: "key-a2",
      index: 2,
    });
    await nav.resolve(2);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("same-href replace acknowledges via settle and compacts without losing provenance", async () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    // Reader stands in for the live history entry. Elision updates state
    // without firing observeLocation; settle reads via setLocationReader.
    let liveLocation: TabNavigationLocation = {
      pathname: a.pathname,
      state: locationState(null, "key-seed", 0),
      search: undefined,
    };
    tabNavigationController.setLocationReader(() => liveLocation);

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), {
      replace: true,
    });
    const envelope = nav.envelopeAt(0);
    expect(envelope.intentKind).toBe("focus-replace");
    expect(envelope.targetRefKey).toBe(tabRefKey(a.ref));
    expect(nav.calls[0]?.replace).toBe(true);

    // Elided same-href replace: history state gains the envelope, no location
    // event. It reuses the SAME index (a REPLACE, not a forward PUSH).
    liveLocation = {
      pathname: a.pathname,
      state: locationState(envelope, "key-same", 0),
      search: undefined,
    };
    await nav.resolve(0);
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);

    // A later forward PUSH (strictly higher index) proves the router moved
    // past this entry - only then does the token retire.
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "PUSH",
      key: "key-next",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
  });

  it("canonical same-ref commit is internal (acks without re-activating)", async () => {
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
    const envelope = nav.envelopeAt(0);

    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope,
      action: "PUSH",
      key: "key-canon",
      index: 1,
    });
    await nav.resolve(0);

    // Internal ack must not spawn a repair or any second navigation - the one
    // activation navigate is all there is, and focus is A.
    expect(nav.calls.length).toBe(1);
    expect(getTabNavigationDiagnostics().repairCount).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);

    // A later forward PUSH (activating B, strictly higher index) proves the
    // router moved past this entry - only then does A's token retire.
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: nav.envelopeAt(1),
      action: "PUSH",
      key: "key-b",
      index: 2,
    });
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
  });

  it("different-ref redirect retires the token and processes as external", async () => {
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
    const envelope = nav.envelopeAt(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // Commit carries the token but lands on B's path → external focus B.
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope,
      action: "PUSH",
      key: "key-redir",
      index: 1,
    });
    await nav.resolve(0);

    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
  });

  it("cancel restores prior selection when the token still owns it", async () => {
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

    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    await nav.reject(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
  });

  // Cold review #2: snapshot must precede new-draft creation/activation so a
  // rejected navigate restores Settings (or Epic), not the draft just minted.
  it("rejecting newDraftTabIntent from Settings restores the true pre-creation selection", async () => {
    const nav = makeDeferredNavigate();

    activateTabIntent(
      nav.asNavigate,
      settingsTabIntent("providers"),
      undefined,
    );
    const envSettings = nav.envelopeAt(0);
    commitInternal({
      navigate: nav.asNavigate,
      pathname: "/settings/providers",
      envelope: envSettings,
      action: "PUSH",
      key: "key-settings-prior",
      index: 1,
    });
    await nav.resolve(0);
    expect(focusedRefKey()).toBe("settings:settings");
    const priorSelection = activeSelection();
    const draftsBefore = useLandingDraftStore.getState().drafts.length;

    activateTabIntent(nav.asNavigate, newDraftTabIntent(null), undefined);
    expect(useLandingDraftStore.getState().drafts.length).toBe(
      draftsBefore + 1,
    );
    expect(focusedRefKey()?.startsWith("draft:")).toBe(true);

    await nav.reject(1);
    // Restore also runs the legacy compat projection (round 4): focus lands
    // back on Settings, and the just-created draft is no longer the active
    // source-projection draft, without crashing.
    expect(focusedRefKey()).toBe("settings:settings");
    expect(activeSelection()).toEqual(priorSelection);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
  });

  it("rejecting newDraftTabIntent from an Epic restores the pre-creation epic selection", async () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    const priorSelection = activeSelection();
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    activateTabIntent(nav.asNavigate, newDraftTabIntent(null), undefined);
    expect(focusedRefKey()?.startsWith("draft:")).toBe(true);

    await nav.reject(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    expect(activeSelection()).toEqual(priorSelection);
  });

  it("cancel preserves newer selection when ownership moved on", async () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    const c = openEpic("epic-c", "C");
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(a.ref), ref: a.ref },
        { kind: "tab", id: tabItemId(b.ref), ref: b.ref },
        { kind: "tab", id: tabItemId(c.ref), ref: c.ref },
      ],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    activateTabIntent(nav.asNavigate, epicIntent("epic-c", c.tabId), undefined);
    expect(focusedRefKey()).toBe(tabRefKey(c.ref));

    // First activation cancelled after supersession — must not restore A.
    await nav.reject(0);
    expect(focusedRefKey()).toBe(tabRefKey(c.ref));
  });

  it("stale superseded commit issues repair-replace to the backing route", async () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-ab",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "tab", ref: b.ref },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-ab",
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    const envA = nav.envelopeAt(0);
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(1);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(activeSplitFocusedSide()).toBe("right");
    // Focusing populated B advances routeBackingSide to right.
    const [active] = useTabsStore.getState().items;
    expect(active.kind).toBe("split");
    if (active.kind !== "split") {
      throw new Error("expected active strip item to be a split");
    }
    expect(active.routeBackingSide).toBe("right");

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    // A's own stale entry finally lands - the first-ever real commit in this
    // history, so it is a genuine forward PUSH (index 1).
    commitInternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      envelope: envA,
      action: "PUSH",
      key: "key-stale",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);

    const repairEnvelope = nav.lastEnvelope();
    expect(repairEnvelope.intentKind).toBe("repair-replace");
    // Latest authoritative backing is B (right), not the stale A entry.
    expect(repairEnvelope.targetRefKey).toBe(tabRefKey(b.ref));
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    // The repair-replace's own entry commits, reusing the SAME index (a
    // REPLACE never advances the router's history index).
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: repairEnvelope,
      action: "REPLACE",
      key: "key-repair",
      index: 1,
    });
    await nav.resolve(nav.calls.length - 1);
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);

    // B's own real entry also lands (out-of-order relative to the repair),
    // reusing the same index too (still a REPLACE, not a push).
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "REPLACE",
      key: "key-b",
      index: 1,
    });
    await nav.resolve(1);
    // A's own original promise settles last. Only the second repair remains
    // live; compacted origin records are classified from their envelopes.
    await nav.resolve(0);
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    // A genuine later external PUSH establishes a newer serial authority and
    // compacts the still-live correction record.
    commitExternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      action: "PUSH",
      key: "key-forward",
      index: 2,
    });
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
  });

  it("POP while a commit is pending supersedes and applies external focus", async () => {
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
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "key-pop",
      index: 0,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    await nav.reject(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("Back to a retired-token entry is treated as external", async () => {
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
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b",
      index: 1,
    });
    await nav.resolve(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);

    // Re-affirm B through an external PUSH. The acknowledged B record already
    // compacted; this commit establishes a newer external serial authority.
    commitExternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      action: "PUSH",
      key: "key-b-forward",
      index: 2,
    });
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);

    // History still carries the now-retired envelope; Back must
    // external-focus A regardless - a POP is unconditionally external, live
    // token or not.
    tabNavigationController.observeLocation(
      {
        pathname: a.pathname,
        state: locationState(envB, "key-retired-back", 0),
        search: undefined,
      },
      "BACK",
      nav.asNavigate,
    );
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("unknown token on a location is external (no live registry entry)", () => {
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
    const diagnostics = getTabNavigationDiagnostics();
    const ghost: TabNavigationEnvelope = {
      sessionId: diagnostics.sessionId,
      token: "tab-navigation-ghost",
      serial: diagnostics.authoritySerial,
      // Deliberately disagree with the committed B URL. Only external
      // classification focuses B; a naive "current-session = owned ACK"
      // implementation would accept the ghost as A and leave A focused.
      destination: { kind: "tab", refKey: tabRefKey(a.ref) },
      targetRefKey: tabRefKey(a.ref),
      intentKind: "activate-push",
    };
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: ghost,
      action: "PUSH",
      key: "key-ghost",
      index: 1,
    });
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
  });

  // Cold review #1: settle must not retire a superseded token before its
  // delayed history entry can still commit and be repaired.
  it("superseded token remains repairable when its promise settles before delayed commit", async () => {
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
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // B's full record is already compacted; its envelope still classifies.
    await nav.resolve(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-delayed",
      index: 1,
    });

    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Cold review #1: newer intent must supersede acknowledged-but-unsettled,
  // and a later commit of that superseded token must repair — not re-apply B.
  it("newer intent supersedes acknowledged unsettled token; later same/second-key commits repair", () => {
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
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-1",
      index: 1,
    });
    // ACK completes rollback/placement ownership, so the full record compacts
    // even while the navigate promise remains open.
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    // B must be superseded even though it was already acknowledged.

    // Same-key re-delivery of the superseded acknowledged entry must repair
    // back to A — not process B as external and steal focus.
    const repairBeforeSameKey = getTabNavigationDiagnostics().repairCount;
    // Same-key redelivery of the exact same committed entry - not a new
    // logical push, so it reuses that entry's own index (1).
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-1",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(
      repairBeforeSameKey + 1,
    );
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("second-key commit of a superseded acknowledged token repairs instead of external focus", () => {
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
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-1",
      index: 1,
    });

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    // Redirect / second history key carrying the SAME token's own entry -
    // not a new logical push, so it reuses that entry's own index (1).
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-2",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("POP supersedes an acknowledged unsettled token", async () => {
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
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-ack",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);

    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "key-pop-ack",
      index: 0,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    await nav.resolve(0);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Cold review #3: repair must rebuild the exact latest authoritative route,
  // not the stale committing pathname (Settings subsections).
  it("stale Settings general commit repairs to exact /settings/providers when providers is authoritative", () => {
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, settingsTabIntent("general"), undefined);
    const envGeneral = nav.envelopeAt(0);
    activateTabIntent(
      nav.asNavigate,
      settingsTabIntent("providers"),
      undefined,
    );
    const envProviders = nav.envelopeAt(1);
    expect(nav.calls[1]?.to).toBe("/settings/providers");
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/providers",
    );

    commitInternal({
      navigate: nav.asNavigate,
      pathname: "/settings/providers",
      envelope: envProviders,
      action: "PUSH",
      key: "key-providers",
      index: 1,
    });

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    const callsBefore = nav.calls.length;
    // The general entry's own OLDER commit, at the (lower) index it was
    // originally created at - not a new push.
    commitInternal({
      navigate: nav.asNavigate,
      pathname: "/settings/general",
      envelope: envGeneral,
      action: "PUSH",
      key: "key-general-stale",
      index: 0,
    });

    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.calls.length).toBe(callsBefore + 1);
    const repairCall = nav.calls[nav.calls.length - 1];
    expect(repairCall.replace).toBe(true);
    expect(repairCall.to).toBe("/settings/providers");
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe("settings:settings");
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/providers",
    );
  });

  // F2 (closure): open-epic-from-list must resolve/create INSIDE the controller,
  // after its snapshot, so a rejected navigation restores the genuine prior tab
  // - not the just-opened epic.
  it("rejecting an open-epic-from-list navigation restores the genuine prior tab", async () => {
    const prior = openEpic("epic-prior", "Prior");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(prior.ref), ref: prior.ref }],
      activeItemId: tabItemId(prior.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    // The epic list opens a not-yet-open epic; the controller resolves + selects
    // it. Fail-before: with pre-resolution outside the controller the snapshot
    // captured the already-selected epic, so this rejection "restored" the epic.
    activateTabIntent(
      nav.asNavigate,
      openEpicFromListIntent({
        epicId: "epic-opened",
        focus: undefined,
        name: "Opened",
        replaceEmptyDraftId: null,
      }),
      undefined,
    );
    // The freshly resolved epic is now selected (not the prior tab).
    expect(focusedRefKey()).not.toBe(tabRefKey(prior.ref));

    await nav.reject(0);
    // The rejection restores the true pre-command selection: the prior tab.
    expect(focusedRefKey()).toBe(tabRefKey(prior.ref));
  });

  // F3 (closure): repair must replay the EXACT committed route - including the
  // committed search (overlay-cleared / canonically normalized) - not a
  // freshly-derived tabRouteOptions(intent) that reintroduces stale search.
  it("stale superseded commit repairs to the exact committed search, not a stale one", () => {
    seedCommittedLayout({
      version: 2,
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    // Older settings navigation carrying a STALE overlay flag in its own entry.
    activateTabIntent(nav.asNavigate, settingsTabIntent("general"), undefined);
    const envStale = nav.envelopeAt(0);
    // Newer, authoritative settings navigation whose committed entry has the
    // overlay cleared. Its ack is what repair must reproduce.
    activateTabIntent(
      nav.asNavigate,
      settingsTabIntent("providers"),
      undefined,
    );
    const envAuthoritative = nav.envelopeAt(1);
    const authoritativeSearch = {
      settingsOverlay: undefined,
      tab: "providers",
    };
    tabNavigationController.observeLocation(
      {
        pathname: "/settings/providers",
        state: locationState(envAuthoritative, "key-auth", 1),
        search: authoritativeSearch,
      },
      "PUSH",
      nav.asNavigate,
    );

    // The stale general entry commits late, carrying the (lower) index its
    // own entry was originally created at, still carrying its overlay flag.
    const callsBefore = nav.calls.length;
    tabNavigationController.observeLocation(
      {
        pathname: "/settings/general",
        state: locationState(envStale, "key-stale", 0),
        search: { settingsOverlay: true },
      },
      "PUSH",
      nav.asNavigate,
    );

    expect(nav.calls.length).toBe(callsBefore + 1);
    const repairCall = nav.calls[nav.calls.length - 1];
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    // Repair reproduces the AUTHORITATIVE committed search, so the stale overlay
    // flag can never leak back in.
    expect(repairCall.search).toEqual(authoritativeSearch);
    expect(repairCall.to).toBe("/settings/providers");
  });

  // F6 (closure, most serious): an envelope-free external PUSH must supersede a
  // still-PENDING internal token, so a late internal commit repairs to the
  // external authority instead of acknowledging - URL and layout must agree.
  it("external PUSH supersedes a pending internal token; late internal commit repairs (no URL/layout divergence)", () => {
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

    // Internal B is requested but has NOT committed yet (promise still open).
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    // A genuine external PUSH to A lands first and focuses A - the first-ever
    // commit in this history, so a genuine forward push (index 1).
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "PUSH",
      key: "key-external-a",
      index: 1,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // B's internal entry commits late, carrying the (lower) index its own
    // entry was originally created at (0, before A's external push).
    // Because the external PUSH superseded it, it must repair to A (the
    // authority), not acknowledge and leave URL=B with layout=A.
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-late",
      index: 0,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    const repairCall = nav.calls[nav.calls.length - 1];
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    // Repair targets A (URL will resolve to A's route), so the URL agrees with
    // the layout instead of leaving URL=B / layout=A.
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(repairCall.replace).toBe(true);
    expect(repairCall.params).toEqual({ epicId: "epic-a", tabId: a.tabId });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // F1a: supersession compacts B's full record immediately. Its entry remains
  // self-classifying because B's envelope serial is lower than A's authority
  // serial; promise settlement cannot turn the delayed entry into an external
  // focus steal. Each distinct stale observation gets one correlated repair.
  it("F1a: compacted superseded token remains self-classifying after settle and repairs each stale observation", async () => {
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

    // 1. Activate B and allocate its authority serial.
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    // 2. Activate A. Its newer serial supersedes and compacts B's record.
    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // 3. B's own promise settles without a commit. The compacted envelope, not
    // a retained token record, still carries enough provenance to classify it.
    await nav.resolve(0);
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(1);

    // 4. B's delayed entry commits and its lower serial triggers one repair.
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale-1",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // A second exact entry key is another stale observation and receives its
    // own repair; it must still never steal focus.
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale-2",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 2);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // F1b: a rejected repair receives the one finite retry. A later distinct
  // stale observation can supersede that retry and start its own correction;
  // no permanent repaired/in-flight latch may swallow it.
  it("F1b: a rejected repair does not latch stale delivery correction", async () => {
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
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale-1",
      index: 1,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    const firstRepairCallIndex = nav.calls.length - 1;
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");

    // The repair navigation itself is REJECTED (e.g. the router aborted it).
    await nav.reject(firstRepairCallIndex);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // A later stale delivery of B's compacted envelope must still correct.
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-stale-2",
      index: 1,
    });
    // First rejection starts the single finite retry; this second exact stale
    // observation supersedes that retry and starts its own correction.
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 3);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // F6/remount: a bridge (re)mount must treat a LIVE-but-uncommitted internal
  // token the same way a mid-session external PUSH does - supersede it, adopt
  // the external location as authority, and repair any later stale commit to
  // that authority instead of acknowledging it internally (which would leave
  // URL=B, layout=A). A naive remount handler that skips
  // `supersedePending()` for pending-but-uncommitted tokens would instead let
  // B's late commit acknowledge internally and steal focus back to B.
  it("F6/remount: a live pending token across a bridge remount supersedes and repairs to the external authority", () => {
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

    // B is requested but never committed - its navigate promise stays open
    // across the simulated remount below.
    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    const envB = nav.envelopeAt(0);
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    // The bridge remounts: the router's live location is now an ENTIRELY
    // external entry (envelope-free) sitting on A, at a strictly higher index
    // than anything this controller instance has observed.
    tabNavigationController.setLocationReader(() => ({
      pathname: a.pathname,
      state: locationState(null, "key-remount", 1),
      search: undefined,
    }));
    tabNavigationController.synchronizeInitialLocation();

    expect(focusedRefKey()).toBe(tabRefKey(a.ref));

    // B's own entry finally commits late, carrying its own (lower,
    // pre-remount) index. It must repair to A - not acknowledge internally
    // and steal focus back to B, which would leave the URL (B) and layout (A)
    // disagreeing.
    const repairBefore = getTabNavigationDiagnostics().repairCount;
    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: envB,
      action: "PUSH",
      key: "key-b-late",
      index: 0,
    });
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairBefore + 1);
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe(tabRefKey(a.ref));
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // F3 (rejected route-cache): a REJECTED same-ref request must never poison
  // the route cache repair reads from - `rememberRoute` is only ever called
  // from `acknowledge()` (a successful commit), never speculatively on
  // request. A controller that cached search on REQUEST rather than ACK would
  // leak the rejected request's search into the next repair.
  it("F3: a rejected same-ref request does not poison the repair route cache", async () => {
    const nav = makeDeferredNavigate();

    // A commits with canonical search S - this ack is what repair must
    // reproduce.
    activateTabIntent(
      nav.asNavigate,
      settingsTabIntent("providers"),
      undefined,
    );
    const envA1 = nav.envelopeAt(0);
    const committedSearchS = { tab: "providers", settingsOverlay: undefined };
    tabNavigationController.observeLocation(
      {
        pathname: "/settings/providers",
        state: locationState(envA1, "key-a1", 1),
        search: committedSearchS,
      },
      "PUSH",
      nav.asNavigate,
    );

    // B (a different section, same settings ref) supersedes A1.
    activateTabIntent(nav.asNavigate, settingsTabIntent("general"), undefined);
    const envB = nav.envelopeAt(1);

    // A NEW same-ref-A request, carrying a DIFFERENT search override,
    // supersedes B in turn - but this request is REJECTED.
    activateTabIntent(nav.asNavigate, settingsTabIntent("providers"), {
      search: { settingsOverlay: true },
    });
    const rejectedCallIndex = nav.calls.length - 1;
    await nav.reject(rejectedCallIndex);

    // B's stale entry finally commits (a genuine later push - the rejected
    // request never consumed a history index).
    const callsBefore = nav.calls.length;
    tabNavigationController.observeLocation(
      {
        pathname: "/settings/general",
        state: locationState(envB, "key-b-stale", 2),
        search: { tab: "general" },
      },
      "PUSH",
      nav.asNavigate,
    );

    expect(nav.calls.length).toBe(callsBefore + 1);
    const repairCall = nav.calls[nav.calls.length - 1];
    expect(nav.lastEnvelope().intentKind).toBe("repair-replace");
    expect(nav.lastEnvelope().targetRefKey).toBe("settings:settings");
    // Repair reproduces the last COMMITTED search (from A1's ack) - never the
    // rejected request's search, and never B's own stale search.
    expect(repairCall.search).toEqual(committedSearchS);
    expect(repairCall.to).toBe("/settings/providers");
  });
});

describe("empty focus / startup preservation", () => {
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

  // Cold review #6: startup / same-location layout sync may preserve empty
  // focus; later envelope-free PUSH/REPLACE is real external navigation and
  // must focus the backing member (Core Flow 4).
  it.each([
    { action: "PUSH" as const, key: "key-empty-push" },
    { action: "REPLACE" as const, key: "key-empty-replace" },
  ])(
    "later envelope-free $action to the backing member focuses it (does not keep empty focus)",
    ({ action, key }) => {
      const a = openEpic("epic-a", "A");
      seedCommittedLayout({
        version: 2,
        items: [
          {
            kind: "split",
            id: "split-empty",
            left: { kind: "tab", ref: a.ref },
            right: { kind: "empty" },
            focusedSide: "right",
            routeBackingSide: "left",
            leftRatio: 0.5,
          },
        ],
        activeItemId: "split-empty",
        systemTabs: { history: null, settings: null },
      });
      const nav = makeDeferredNavigate();

      // Establish a prior location so this is not the initial startup sync.
      commitExternal({
        navigate: nav.asNavigate,
        pathname: a.pathname,
        action: "REPLACE",
        key: "key-startup",
        index: 0,
      });
      // Re-seed empty focus after any startup handling.
      seedCommittedLayout({
        version: 2,
        items: [
          {
            kind: "split",
            id: "split-empty",
            left: { kind: "tab", ref: a.ref },
            right: { kind: "empty" },
            focusedSide: "right",
            routeBackingSide: "left",
            leftRatio: 0.5,
          },
        ],
        activeItemId: "split-empty",
        systemTabs: { history: null, settings: null },
      });
      expect(activeSplitFocusedSide()).toBe("right");

      // PUSH is a genuine forward step (higher index); REPLACE reuses the
      // same index as the prior startup entry.
      commitExternal({
        navigate: nav.asNavigate,
        pathname: a.pathname,
        action: action,
        key: key,
        index: action === "PUSH" ? 1 : 0,
      });
      expect(activeSplitFocusedSide()).toBe("left");
      expect(focusedRefKey()).toBe(tabRefKey(a.ref));
    },
  );

  it("retryCurrentLocation preserves empty focus when path still backs the group", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-empty",
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();
    // Seed currentLocation via a prior observe, then re-assert empty focus
    // so retry is a same-location layout/render sync — not a new external nav.
    tabNavigationController.observeLocation(
      {
        pathname: a.pathname,
        state: locationState(null, "key-start", 0),
        search: undefined,
      },
      "REPLACE",
      nav.asNavigate,
    );
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-empty",
      systemTabs: { history: null, settings: null },
    });
    expect(activeSplitFocusedSide()).toBe("right");

    tabNavigationController.synchronizeInitialLocation();
    expect(activeSplitFocusedSide()).toBe("right");
  });

  it("external route to a different restored ref focuses that ref", () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        { kind: "tab", id: tabItemId(b.ref), ref: b.ref },
      ],
      activeItemId: "split-empty",
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      action: "PUSH",
      key: "key-other",
      index: 1,
    });
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(b.ref));
  });

  it("startup sync is a no-op while empty focus keeps the backing ref", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-empty",
      systemTabs: { history: null, settings: null },
    });
    // A bridge (re)mount replays the current committed location as a startup
    // sync; because that location still backs the empty side's member, saved
    // empty focus must survive.
    tabNavigationController.setLocationReader(() => ({
      pathname: a.pathname,
      state: locationState(null, "key-start", 0),
      search: undefined,
    }));
    const before = activeSelection();
    tabNavigationController.synchronizeInitialLocation();
    expect(activeSelection()).toEqual(before);
    expect(activeSplitFocusedSide()).toBe("right");
  });
});

describe("activateTabIntent / navigateToTabIntent seam", () => {
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

  it("within-split activation uses replace (focus-replace)", () => {
    const a = openEpic("epic-a", "A");
    const b = openEpic("epic-b", "B");
    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-ab",
          left: { kind: "tab", ref: a.ref },
          right: { kind: "tab", ref: b.ref },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-ab",
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, epicIntent("epic-b", b.tabId), undefined);
    expect(nav.calls[0]?.replace).toBe(true);
    expect(nav.envelopeAt(0).intentKind).toBe("focus-replace");
    expect(activeSplitFocusedSide()).toBe("right");
  });

  it("cross-strip activation pushes (activate-push)", () => {
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
    expect(nav.calls[0]?.replace).not.toBe(true);
    expect(nav.envelopeAt(0).intentKind).toBe("activate-push");
  });

  it("prepared pairing captures the pre-pair item and pushes the focused member", () => {
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

    expect(
      activatePreparedPairTabIntent(
        nav.asNavigate,
        {
          left: a.ref,
          right: b.ref,
          focusedRef: b.ref,
          splitId: "split-ab",
          leftRatio: 0.5,
        },
        epicIntent("epic-b", b.tabId),
        undefined,
      ),
    ).toBe(true);

    expect(nav.calls[0]?.replace).not.toBe(true);
    expect(nav.envelopeAt(0).intentKind).toBe("activate-push");
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));
    expect(useTabsStore.getState().activeItemId).toBe("split-ab");

    commitInternal({
      navigate: nav.asNavigate,
      pathname: b.pathname,
      envelope: nav.envelopeAt(0),
      action: "PUSH",
      key: "pair-b",
      index: 1,
    });
    commitExternal({
      navigate: nav.asNavigate,
      pathname: a.pathname,
      action: "BACK",
      key: "pair-a",
      index: 0,
    });
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  it("rejected prepared pairing retains members but restores the prior owner", async () => {
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

    activatePreparedPairTabIntent(
      nav.asNavigate,
      {
        left: a.ref,
        right: b.ref,
        focusedRef: b.ref,
        splitId: "split-ab",
        leftRatio: 0.5,
      },
      epicIntent("epic-b", b.tabId),
      undefined,
    );
    expect(focusedRefKey()).toBe(tabRefKey(b.ref));

    await nav.reject(0);

    expect(useTabsStore.getState().items).toEqual([
      expect.objectContaining({ id: "split-ab", kind: "split" }),
    ]);
    expect(focusedRefKey()).toBe(tabRefKey(a.ref));
  });

  // Cold review #7: re-activating the already-active ordinary tab must replace
  // (same as within-split), not push a dead same-href history step.
  it("re-activating the active ordinary tab uses replace and does not push history", () => {
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a.ref), ref: a.ref }],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, epicIntent("epic-a", a.tabId), undefined);
    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.replace).toBe(true);
    expect(nav.envelopeAt(0).intentKind).toBe("focus-replace");
    expect(nav.envelopeAt(0).targetRefKey).toBe(tabRefKey(a.ref));
  });

  it("draft activation clears through the seam and envelopes the draft ref", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const a = openEpic("epic-a", "A");
    seedCommittedLayout({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(a.ref), ref: a.ref },
        {
          kind: "tab",
          id: tabItemId({ kind: "draft", id: draftId }),
          ref: { kind: "draft", id: draftId },
        },
      ],
      activeItemId: tabItemId(a.ref),
      systemTabs: { history: null, settings: null },
    });
    const nav = makeDeferredNavigate();

    activateTabIntent(nav.asNavigate, draftTabIntent(draftId), undefined);
    expect(nav.envelopeAt(0).targetRefKey).toBe(`draft:${draftId}`);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(draftId);
    expect(focusedRefKey()).toBe(`draft:${draftId}`);
  });
});

// T10 Area 3: a new desktop window opened via
// `deps.bridge.requestNew(tab.route)` for a History/Settings tab boots with
// a truly EMPTY layout (`resetStores()` below matches that exactly) and an
// initial router location equal to the source tab's route. That is
// architecturally identical to any other cold external navigation this
// controller already resolves - `resolveExternalSystem` (reached through
// the same `observeLocation` classification `TabNavigationRouteBridge` uses
// at boot) materializes the system tab and focuses it. These tests prove
// that path exists and stays wired for history/settings specifically -
// "copy" new-window semantics need no new production code, only this
// coverage.
describe("T10 Area 3: external boot into a system-tab route (new-window copy)", () => {
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

  it("materializes and focuses the History tab from a cold external boot into /epics", () => {
    const nav = makeDeferredNavigate();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: "/epics",
      action: "PUSH",
      key: "key-boot-history",
      index: 0,
    });

    expect(useTabsStore.getState().systemTabs.history).not.toBeNull();
    expect(focusedRefKey()).toBe("history:history");
    // No draft/epic source store was touched by this boot resolution.
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });

  it("materializes and focuses the Settings tab from a cold external boot into /settings/providers", () => {
    const nav = makeDeferredNavigate();

    commitExternal({
      navigate: nav.asNavigate,
      pathname: "/settings/providers",
      action: "PUSH",
      key: "key-boot-settings",
      index: 0,
    });

    expect(useTabsStore.getState().systemTabs.settings).not.toBeNull();
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/providers",
    );
    expect(focusedRefKey()).toBe("settings:settings");
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });
});
