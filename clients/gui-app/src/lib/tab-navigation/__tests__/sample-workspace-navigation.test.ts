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
  getTabNavigationDiagnostics,
  tabNavigationController,
  type TabNavigationEnvelope,
} from "@/lib/tab-navigation";
import { existingEpicTabIntent } from "@/lib/tab-navigation/intents";
import { ensureSampleWorkspaceTab } from "@/lib/customize/enter-exit";
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

const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };
const SAMPLE_PATH = "/sample-workspace";
const HISTORY_ENVELOPE_KEY = "__traycerTabNavigation";

type NavigateMock = Mock<(options: NavigateOptions) => Promise<void>>;

interface DeferredNavigate {
  readonly asNavigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  resolve: (index: number) => Promise<void>;
  envelopeAt: (index: number) => TabNavigationEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDestination(
  destination: Record<string, unknown>,
): TabNavigationEnvelope["destination"] | null {
  if (destination.kind === "tab" && typeof destination.refKey === "string")
    return { kind: "tab", refKey: destination.refKey };
  if (destination.kind === "route" && typeof destination.pathname === "string")
    return { kind: "route", pathname: destination.pathname };
  return null;
}

function readEnvelope(value: unknown): TabNavigationEnvelope | null {
  if (!isRecord(value)) return null;
  const { sessionId, token, serial, destination, targetRefKey, intentKind } =
    value;
  if (typeof sessionId !== "string" || typeof token !== "string") return null;
  if (typeof serial !== "number" || typeof targetRefKey !== "string")
    return null;
  if (!isRecord(destination)) return null;
  const kind = readDestination(destination);
  if (kind === null) return null;
  switch (intentKind) {
    case "activate-push":
    case "focus-replace":
    case "repair-replace":
    case "external-replace":
    case "landing-replace":
      return {
        sessionId,
        token,
        serial,
        destination: kind,
        targetRefKey,
        intentKind,
      };
    default:
      return null;
  }
}

function makeDeferredNavigate(): DeferredNavigate {
  const resolvers: Array<() => void> = [];
  const calls: NavigateOptions[] = [];
  const mock: NavigateMock = vi.fn((options: NavigateOptions) => {
    calls.push(options);
    return new Promise<void>((resolve) => resolvers.push(resolve));
  });
  const asNavigate: UseNavigateResult<string> = ((options: NavigateOptions) =>
    mock(options)) as UseNavigateResult<string>;
  return {
    asNavigate,
    calls,
    resolve: async (index) => {
      resolvers[index]?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    envelopeAt: (index) => {
      const state = calls[index]?.state;
      if (typeof state !== "function")
        throw new Error("navigate state is not an updater");
      const next: HistoryState = state({
        key: undefined,
        __TSR_key: undefined,
        __TSR_index: 0,
      });
      const envelope = isRecord(next)
        ? readEnvelope(next[HISTORY_ENVELOPE_KEY])
        : null;
      if (envelope === null)
        throw new Error("navigate options carry no envelope");
      return envelope;
    },
  };
}

function commitInternal(
  navigate: UseNavigateResult<string>,
  pathname: string,
  envelope: TabNavigationEnvelope,
  index: number,
): void {
  tabNavigationController.observeLocation(
    {
      pathname,
      state: {
        __TSR_key: `key-${index}`,
        __TSR_index: index,
        [HISTORY_ENVELOPE_KEY]: envelope,
      },
      search: undefined,
    },
    "PUSH",
    navigate,
  );
}

function focusedRefKey(): string | null {
  const state = useTabsStore.getState();
  const active = state.items.find((item) => item.id === state.activeItemId);
  return active?.kind === "tab" ? tabRefKey(active.ref) : null;
}

function seedEpicActive(): {
  readonly ref: TabRef;
  readonly pathname: string;
  readonly epicId: string;
  readonly tabId: string;
} {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-a", "A");
  const ref: TabRef = { kind: "epic", id: tabId };
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState({ ...layout, stripOrder: flattenLayoutRefs(layout) });
  return {
    ref,
    pathname: epicPathname({ epicId: "epic-a", tabId }),
    epicId: "epic-a",
    tabId,
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

describe("sample workspace tab navigation", () => {
  it("ensure + activate selects the sample tab and routes to /sample-workspace, not Settings", async () => {
    const epic = seedEpicActive();
    const nav = makeDeferredNavigate();

    activateTabIntent(
      nav.asNavigate,
      ensureSampleWorkspaceTab({ kind: "none" }),
      undefined,
    );

    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]).toMatchObject({ to: SAMPLE_PATH });
    const envelope = nav.envelopeAt(0);
    expect(envelope.intentKind).toBe("activate-push");
    expect(envelope.targetRefKey).toBe(tabRefKey(SAMPLE_REF));
    expect(envelope.destination).toEqual({
      kind: "tab",
      refKey: tabRefKey(SAMPLE_REF),
    });

    const repairs = getTabNavigationDiagnostics().repairCount;
    commitInternal(nav.asNavigate, SAMPLE_PATH, envelope, 1);
    await nav.resolve(0);

    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairs);
    expect(useTabsStore.getState().systemTabs.settings).toBeNull();
    expect(nav.calls).toHaveLength(1);
    // The epic tab is still there, just not selected.
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) => item.kind === "tab" && item.ref.id === epic.ref.id,
        ),
    ).toBe(true);
  });

  it("switching away and back keeps the tab and never repairs", async () => {
    const epic = seedEpicActive();
    const nav = makeDeferredNavigate();
    const repairs = getTabNavigationDiagnostics().repairCount;

    activateTabIntent(
      nav.asNavigate,
      ensureSampleWorkspaceTab({ kind: "none" }),
      undefined,
    );
    commitInternal(nav.asNavigate, SAMPLE_PATH, nav.envelopeAt(0), 1);
    await nav.resolve(0);

    activateTabIntent(
      nav.asNavigate,
      existingEpicTabIntent({
        epicId: epic.epicId,
        tabId: epic.tabId,
        focus: undefined,
      }),
      undefined,
    );
    expect(focusedRefKey()).toBe(tabRefKey(epic.ref));
    commitInternal(nav.asNavigate, epic.pathname, nav.envelopeAt(1), 2);
    await nav.resolve(1);
    expect(focusedRefKey()).toBe(tabRefKey(epic.ref));
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
        ),
    ).toBe(true);

    activateTabIntent(
      nav.asNavigate,
      ensureSampleWorkspaceTab({ kind: "none" }),
      undefined,
    );
    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    commitInternal(nav.asNavigate, SAMPLE_PATH, nav.envelopeAt(2), 3);
    await nav.resolve(2);

    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    expect(getTabNavigationDiagnostics().repairCount).toBe(repairs);
    expect(useTabsStore.getState().systemTabs.settings).toBeNull();
    // Still exactly one sample tab.
    expect(
      useTabsStore
        .getState()
        .items.filter(
          (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
        ),
    ).toHaveLength(1);
  });

  it("an external visit to /sample-workspace selects the existing tab", () => {
    seedEpicActive();
    ensureSampleWorkspaceTab({ kind: "none" });
    const nav = makeDeferredNavigate();

    tabNavigationController.observeLocation(
      {
        pathname: SAMPLE_PATH,
        state: { __TSR_key: "ext", __TSR_index: 1 },
        search: undefined,
      },
      "PUSH",
      nav.asNavigate,
    );

    expect(focusedRefKey()).toBe(tabRefKey(SAMPLE_REF));
    expect(useTabsStore.getState().systemTabs.settings).toBeNull();
  });

  it("an external visit to /sample-workspace with NO tab is corrected away and creates nothing", () => {
    const epic = seedEpicActive();
    const nav = makeDeferredNavigate();

    tabNavigationController.observeLocation(
      {
        pathname: SAMPLE_PATH,
        state: { __TSR_key: "ext", __TSR_index: 1 },
        search: undefined,
      },
      "PUSH",
      nav.asNavigate,
    );

    expect(focusedRefKey()).not.toBe(tabRefKey(SAMPLE_REF));
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
        ),
    ).toBe(false);
    expect(nav.calls).toHaveLength(1);
    expect(nav.envelopeAt(0).intentKind).toBe("landing-replace");
    // Landed back on something real (the still-existing epic tab).
    expect(
      useTabsStore
        .getState()
        .items.some(
          (item) => item.kind === "tab" && item.ref.id === epic.ref.id,
        ),
    ).toBe(true);
  });
});
