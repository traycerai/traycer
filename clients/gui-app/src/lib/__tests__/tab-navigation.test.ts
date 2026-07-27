/**
 * Tab navigation single-path guard (ticket 12).
 *
 * Every entry point that switches the active tab must funnel through
 * `navigateToTabIntent` so cross-cutting behavior (per-kind store
 * activation, route resolution) lands once. The ESLint rule from
 * ticket 05 blocks raw `setActiveTab` / `setActiveDraft` /
 * `epicTabRoute` outside the seam at compile time; this test locks
 * down the runtime contract: the seam itself wires
 * `descriptor.activate -> router.navigate`, and keybinding dispatch
 * funnels through the router seam (`router.navigateToTabIntent`)
 * instead of bypassing it.
 */
import "../../../__tests__/test-browser-apis";
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
import * as TabNav from "@/lib/tab-navigation";
import {
  dispatchAction,
  matchDigitAction,
  registerBaseLeaderScope,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import {
  existingEpicTabIntent,
  draftTabIntent,
  type TabActivationIntent,
} from "@/lib/tab-navigation/intents";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabItemId } from "@/stores/tabs/layout";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  TabNav.__resetTabNavigationControllerForTesting();
}

// Fire Alt+digit through the leader-scope stack the way the provider does:
// register the base scopes for this router, match the synthetic event,
// run it, then unregister. Returns the dispatch result.
function dispatchEpicDigit(router: KeybindingRouter, digit: number): boolean {
  const unregister = registerBaseLeaderScope(router);
  try {
    const match = matchDigitAction(
      new KeyboardEvent("keydown", {
        code: digit === 0 ? "Digit0" : `Digit${digit}`,
        altKey: true,
      }),
    );
    return match === null ? false : match.run();
  } finally {
    unregister();
  }
}

type NavigateMock = Mock<(options: NavigateOptions) => Promise<void>>;

function makeNavigate(): NavigateMock {
  return vi.fn(() => Promise.resolve());
}

function asNavigate(mock: NavigateMock): UseNavigateResult<string> {
  return mock as UseNavigateResult<string>;
}

interface RecordedRouter {
  readonly router: KeybindingRouter;
  readonly intents: TabActivationIntent[];
  setPathname: (path: string) => void;
}

function buildRecordingRouter(initialPath: string): RecordedRouter {
  const intents: TabActivationIntent[] = [];
  let pathname = initialPath;
  const router: KeybindingRouter = {
    getPathname: () => pathname,
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: (intent) => {
      intents.push(intent);
    },
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
  return {
    router,
    intents,
    setPathname: (next) => {
      pathname = next;
    },
  };
}

describe("tab navigation single-path contract", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
  });

  it("the seam itself activates per-kind state and then routes", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Alpha");
    const navigateMock = makeNavigate();
    const setActiveSpy = vi.spyOn(
      useEpicCanvasStore.getState(),
      "setActiveTab",
    );

    TabNav.navigateToTabIntent(
      asNavigate(navigateMock),
      existingEpicTabIntent({
        epicId: "epic-1",
        tabId,
        focus: undefined,
      }),
      undefined,
    );

    expect(setActiveSpy).toHaveBeenCalledWith(tabId);
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it("activating an epic tab clears the active landing draft marker", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Alpha");
    const navigateMock = makeNavigate();

    expect(useLandingDraftStore.getState().activeDraftId).toBe(draftId);

    TabNav.navigateToTabIntent(
      asNavigate(navigateMock),
      existingEpicTabIntent({
        epicId: "epic-1",
        tabId,
        focus: undefined,
      }),
      undefined,
    );

    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("keybinding `dispatchDigitAction(epic.switch.byDigit)` funnels through router.navigateToTabIntent (epic)", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-2", "Beta");
    useTabsStore.setState({
      stripOrder: [{ kind: "epic", id: tabId }],
      systemTabs: { history: null, settings: null },
    });
    const recorded = buildRecordingRouter("/epics/other/other-tab");

    const handled = dispatchEpicDigit(recorded.router, 1);

    expect(handled).toBe(true);
    expect(recorded.intents).toHaveLength(1);
    expect(recorded.intents[0]).toMatchObject({
      kind: "epic",
      epicId: "epic-2",
      tabId,
    });
  });

  it("keybinding switch to a draft tab also funnels through router.navigateToTabIntent", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useTabsStore.setState({
      stripOrder: [{ kind: "draft", id: draftId }],
      systemTabs: { history: null, settings: null },
    });
    const recorded = buildRecordingRouter("/epics/foo/foo-tab");

    dispatchEpicDigit(recorded.router, 1);

    expect(recorded.intents).toEqual([draftTabIntent(draftId)]);
  });

  it("keybinding switch never invokes the seam directly when bypassing the router seam is impossible", () => {
    // Cross-check: seam spy on the real `TabNav.navigateToTabIntent`
    // must NOT fire when the recording router intercepts the call -
    // proves the dispatch path goes through `router.navigateToTabIntent`
    // (the seam injection point), not the seam function directly.
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-3", "Gamma");
    useTabsStore.setState({
      stripOrder: [{ kind: "epic", id: tabId }],
      systemTabs: { history: null, settings: null },
    });
    const seamSpy = vi.spyOn(TabNav, "navigateToTabIntent").mockReturnValue();
    const recorded = buildRecordingRouter("/");

    dispatchEpicDigit(recorded.router, 1);

    expect(seamSpy).not.toHaveBeenCalled();
    expect(recorded.intents).toHaveLength(1);
  });

  // Cold review #4: empty/fillable focus must still allow strip digit +
  // next/prev traversal, while member-specific close no-ops when host focus
  // is not on a concrete epic member.
  it("fillable empty focus still allows digit strip selection", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-4", "Delta");
    const epicRef = { kind: "epic" as const, id: tabId };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: epicRef },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-empty",
      stripOrder: [epicRef],
      systemTabs: { history: null, settings: null },
    });
    const recorded = buildRecordingRouter(`/epics/epic-4/${tabId}`);

    const handled = dispatchEpicDigit(recorded.router, 1);

    expect(handled).toBe(true);
    expect(recorded.intents).toHaveLength(1);
    expect(recorded.intents[0]).toMatchObject({
      kind: "epic",
      epicId: "epic-4",
      tabId,
    });
  });

  it("fillable empty focus allows epic.next traversal via route backing", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "A");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "B");
    const refA = { kind: "epic" as const, id: a };
    const refB = { kind: "epic" as const, id: b };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: refA },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        { kind: "tab", id: tabItemId(refB), ref: refB },
      ],
      activeItemId: "split-empty",
      stripOrder: [refA, refB],
      systemTabs: { history: null, settings: null },
    });
    const recorded = buildRecordingRouter(`/epics/epic-a/${a}`);

    expect(dispatchAction("epic.next", recorded.router)).toBe(true);
    expect(recorded.intents).toHaveLength(1);
    expect(recorded.intents[0]).toMatchObject({
      kind: "epic",
      epicId: "epic-b",
      tabId: b,
    });
  });

  it("member-specific epic.close no-ops when fillable empty side owns focus", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-5", "Epsilon");
    const epicRef = { kind: "epic" as const, id: tabId };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-empty",
          left: { kind: "tab", ref: epicRef },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-empty",
      stripOrder: [epicRef],
      systemTabs: { history: null, settings: null },
    });
    const recorded = buildRecordingRouter(`/epics/epic-5/${tabId}`);
    const closeSpy = vi.spyOn(useEpicCanvasStore.getState(), "closeTab");

    expect(dispatchAction("epic.close", recorded.router)).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);
    expect(recorded.intents).toHaveLength(0);
  });
});
