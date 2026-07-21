/**
 * F2 destructive-swap-in-a-split + compat-projection coverage for the
 * navigation controller. Drives the controller directly via
 * `activateTabIntent` - no production edits, no full AppShell. Fakes only the
 * navigate promise boundary, mirroring the harness patterns established in
 * `navigation-envelope.test.ts` (deferred navigate mock, resetStores,
 * installTabSyncCoordinator, seedCommittedLayout) - duplicated locally here
 * (not imported) so this file has no coupling to that one.
 */
import "../../../../__tests__/test-browser-apis";
import type {
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
  tabNavigationController,
  type TabNavigationEnvelope,
} from "@/lib/tab-navigation";
import {
  draftTabIntent,
  existingEpicTabIntent,
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
  type PersistedTabStripLayout,
  type SplitStripItem,
} from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

type NavigateMock = Mock<(options: NavigateOptions) => Promise<void>>;

const HISTORY_ENVELOPE_KEY = "__traycerTabNavigation";

interface DeferredNavigate {
  readonly asNavigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  resolve: (index: number) => Promise<void>;
  reject: (index: number) => Promise<void>;
  envelopeAt: (index: number) => TabNavigationEnvelope;
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

function envelopeFromNavigateOptions(
  options: NavigateOptions,
): TabNavigationEnvelope {
  const state = options.state;
  expect(typeof state).toBe("function");
  if (typeof state !== "function") {
    throw new Error("expected navigate state updater function");
  }
  const nextState = state({
    key: undefined,
    __TSR_key: undefined,
    __TSR_index: 0,
  });
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
  const asNavigate: UseNavigateResult<string> = ((options: NavigateOptions) =>
    mock(options)) as UseNavigateResult<string>;
  return {
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
  };
}

let commitKeySequence = 0;

/**
 * Simulates the router committing the pending navigate's history entry - the
 * real signal (`TabNavigationRouteBridge` -> `observeLocation`) that
 * acknowledges a pending token and runs any deferred swap. Merely resolving
 * the navigate promise is NOT enough on its own: without a matching committed
 * location, `settle()` has nothing to acknowledge against and just retires
 * the token unacknowledged (mirrors `navigation-envelope.test.ts`'s
 * `commitInternal` helper).
 */
function commitInternal(
  navigate: UseNavigateResult<string>,
  pathname: string,
  envelope: TabNavigationEnvelope,
): void {
  commitKeySequence += 1;
  tabNavigationController.observeLocation(
    {
      pathname,
      state: {
        __TSR_key: `key-${commitKeySequence}`,
        [HISTORY_ENVELOPE_KEY]: envelope,
      },
      search: undefined,
    },
    "PUSH",
    navigate,
  );
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

function seedCommittedLayout(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({ ...layout, stripOrder: flattenLayoutRefs(layout) });
}

function openEpic(
  epicId: string,
  name: string,
): { readonly tabId: string; readonly ref: TabRef } {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
  return { tabId, ref: { kind: "epic", id: tabId } };
}

function findSplitItem(id: string): SplitStripItem | null {
  const item = useTabsStore.getState().items.find((entry) => entry.id === id);
  return item?.kind === "split" ? item : null;
}

describe("F2: destructive empty-draft -> epic swap in a split", () => {
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

  /** LEFT = an empty draft, RIGHT = a real open companion epic. */
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

  it("a REJECTED swap leaves the draft open and the split intact (the destructive close is deferred to ACK)", async () => {
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

    // The new epic activates immediately (ordinary, non-destructive
    // activation) - only the draft close + reposition are deferred.
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);
    const splitBeforeReject = findSplitItem(splitId);
    expect(splitBeforeReject).not.toBeNull();
    expect(splitBeforeReject?.left).toEqual({ kind: "tab", ref: draftRef });
    expect(splitBeforeReject?.right).toEqual({
      kind: "tab",
      ref: companion.ref,
    });

    await nav.reject(0);

    // Rejection never ran the deferred swap: the draft is still open and the
    // split is exactly as it was before - the pre-swap layout is fully
    // reconstructable because the draft was never closed.
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);
    const splitAfterReject = findSplitItem(splitId);
    expect(splitAfterReject).not.toBeNull();
    expect(splitAfterReject?.left).toEqual({ kind: "tab", ref: draftRef });
    expect(splitAfterReject?.right).toEqual({
      kind: "tab",
      ref: companion.ref,
    });
  });

  it("a RESOLVED (acknowledged) swap closes the draft and places the epic at its slot", async () => {
    const { draftId, companion, splitId } = seedDraftCompanionSplit();
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
    expect(
      useEpicCanvasStore.getState().resolveTabIdForEpic("epic-to-swap-in"),
    ).toBeNull();
    const envelope = nav.envelopeAt(0);
    expect(envelope.destination.kind).toBe("tab");
    if (envelope.destination.kind !== "tab") {
      throw new Error("expected prepared swap tab destination");
    }
    const swapTabId = envelope.destination.refKey.slice("epic:".length);
    const swapRef: TabRef = { kind: "epic", id: swapTabId };

    // Simulate the router committing the exact entry the controller
    // requested - the real signal that acknowledges the pending token and
    // runs the deferred swap.
    commitInternal(
      nav.asNavigate,
      epicPathname({ epicId: "epic-to-swap-in", tabId: swapTabId }),
      envelope,
    );
    await nav.resolve(0);

    // The draft is closed and replaced in-place inside the same split.
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(false);
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) =>
            item.kind === "split" &&
            [item.left, item.right].some(
              (side) =>
                side.kind === "tab" &&
                side.ref.kind === "draft" &&
                side.ref.id === draftId,
            ),
        ),
    ).toBe(false);

    const split = findSplitItem(splitId);
    expect(split).not.toBeNull();
    expect(split?.left).toEqual({ kind: "tab", ref: swapRef });
    expect(split?.right).toEqual({ kind: "tab", ref: companion.ref });
    expect(split?.leftRatio).toBe(0.5);
    expect(split?.focusedSide).toBe("left");
    expect(split?.routeBackingSide).toBe("left");

    const stripOrder = useTabsStore.getState().stripOrder;
    expect(stripOrder[0]).toEqual(swapRef);
    expect(stripOrder).toContainEqual(companion.ref);
    expect(useTabsStore.getState().activeItemId).toBe(splitId);
  });
});

describe("compat projection: activeTabId / activeDraftId mirror the focused ref", () => {
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

  it("clears activeTabId when focus leaves an Epic for Settings, then sets activeDraftId (and keeps activeTabId cleared) for a Draft", () => {
    const a = openEpic("epic-a", "A");
    const nav = makeDeferredNavigate();

    activateTabIntent(
      nav.asNavigate,
      existingEpicTabIntent({
        epicId: "epic-a",
        tabId: a.tabId,
        focus: undefined,
      }),
      undefined,
    );
    expect(useEpicCanvasStore.getState().activeTabId).toBe(a.tabId);

    activateTabIntent(nav.asNavigate, settingsTabIntent("general"), undefined);
    // The projection clears activeTabId once the focused ref is not an epic.
    expect(useEpicCanvasStore.getState().activeTabId).toBeNull();

    const draftId = useLandingDraftStore.getState().createDraft(null);
    activateTabIntent(nav.asNavigate, draftTabIntent(draftId), undefined);
    expect(useEpicCanvasStore.getState().activeTabId).toBeNull();
    expect(useLandingDraftStore.getState().activeDraftId).toBe(draftId);
  });
});
