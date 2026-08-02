import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  LandingTerminalHost,
  LandingTerminalPaneAnchor,
} from "@/components/home/terminal-panel/landing-terminal-host";
import {
  MAX_RETAINED_TOP_LEVEL_SURFACES,
  TopLevelTabHost,
} from "@/components/layout/top-level-tab-host";
import {
  TopLevelSurfaceActivationContext,
  type TopLevelSurfaceActivator,
} from "@/components/layout/top-level-surface-activation-context";
import { activateHostedTopLevelSurface } from "@/components/epic-canvas/surface-host/hosted-top-level-activation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { tabRefKey, type StripItem } from "@/stores/tabs/layout";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { resetTileSurfaceMembershipForTesting } from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";

const stableTileSurfaceHostTestState = vi.hoisted(() => ({ enabled: false }));

vi.mock(
  "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch",
  () => ({
    get STABLE_TILE_SURFACE_HOST_ENABLED() {
      return stableTileSurfaceHostTestState.enabled;
    },
  }),
);

// The wiring test below only cares whether a real pointerdown/focus event on
// a hosted record's DOM reaches `activateHostedTopLevelSurface` - not that
// the real ChatTile/ChatMessages chain renders (that needs a real Epic
// session handle the synthetic environment fixture cannot supply). Stub the
// body the same way `stable-tile-surface-host.test.tsx` uses a synthetic
// body renderer.
vi.mock(
  "@/components/epic-canvas/surface-host/hosted-chat-surface-body",
  () => ({
    renderHostedChatSurfaceBody: () => (
      <div data-testid="hosted-wiring-body-stub" />
    ),
  }),
);

vi.mock("@/components/epic-tabs/epic-surface", async () => {
  const React = await import("react");
  const { usePaneActivationFocusIntent } =
    await import("@/components/epic-canvas/pane-activation");
  const { usePaneFocused } =
    await import("@/components/epic-tabs/pane-visibility-context");

  function MockEpicSurface(props: {
    readonly epicId: string;
    readonly tabId: string;
  }) {
    const focused = usePaneFocused();
    const focusIntent = usePaneActivationFocusIntent();
    const primaryRef = React.useRef<HTMLInputElement | null>(null);
    const previouslyFocusedRef = React.useRef(false);
    React.useEffect(() => {
      const newlyFocused = focused && !previouslyFocusedRef.current;
      previouslyFocusedRef.current = focused;
      if (!newlyFocused) return;
      if (focusIntent.shouldYieldAutoFocus()) return;
      primaryRef.current?.focus();
    }, [focusIntent, focused]);

    return (
      <div data-testid={`epic-surface-content-${props.tabId}`}>
        <input
          aria-label={`Action ${props.tabId}`}
          data-epic-id={props.epicId}
          data-testid={`epic-surface-body-${props.tabId}`}
          defaultValue={props.tabId}
        />
        <input aria-label={`Primary ${props.tabId}`} ref={primaryRef} />
        <div data-testid={`blank-surface-${props.tabId}`} />
      </div>
    );
  }

  return { EpicSurface: MockEpicSurface };
});

vi.mock("@/components/home/landing-draft-surface", () => ({
  LandingDraftSurface: () => <div data-testid="draft-surface-body" />,
}));

vi.mock("@/components/epics/history-surface", () => ({
  HistorySurface: () => <div data-testid="history-surface-body" />,
}));

vi.mock("@/components/settings/settings-surface", () => ({
  SettingsSurface: () => <div data-testid="settings-surface-body" />,
}));

// The host wraps the panel in the gesture provider (the single live-value
// reader); project the draft the host resolved onto the provider so this test
// verifies the single-mount projection without the provider's live wiring.
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-gesture-provider",
  () => ({
    LandingTerminalGestureProvider: (props: {
      readonly draftId: string | null;
      readonly children: ReactNode;
    }) => (
      <div data-draft-id={props.draftId ?? ""} data-testid="landing-terminal">
        {props.children}
      </div>
    ),
  }),
);
vi.mock("@/components/home/terminal-panel/landing-terminal-panel", () => ({
  LandingTerminalPanel: () => <div data-testid="landing-terminal-panel-body" />,
}));

const EPIC_A: TabRef = { kind: "epic", id: "epic-a" };
const EPIC_B: TabRef = { kind: "epic", id: "epic-b" };
const DRAFT_A: TabRef = { kind: "draft", id: "draft-a" };
const DRAFT_B: TabRef = { kind: "draft", id: "draft-b" };
const HISTORY: TabRef = { kind: "history", id: "history" };
const SETTINGS: TabRef = { kind: "settings", id: "settings" };

function surfaceRef(key: TabRef): HTMLElement {
  return screen.getByTestId(`top-level-surface-${key.kind}-${key.id}`);
}

function activatingHost(left: TabRef, right: TabRef): ReactNode {
  return (
    <TopLevelSurfaceActivationContext.Provider
      value={(tab) => {
        setSplit(left, right, tab.id === right.id ? "right" : "left");
      }}
    >
      <TopLevelTabHost />
    </TopLevelSurfaceActivationContext.Provider>
  );
}

function seedSources(refs: ReadonlyArray<TabRef>): void {
  for (const ref of refs) {
    if (ref.kind === "epic") {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, ref.id, `Epic ${ref.id}`);
      continue;
    }
    if (ref.kind === "draft") {
      useLandingDraftStore.getState().createDraftWithId(ref.id, null);
    }
  }

  useTabsStore.setState((state) => ({
    ...state,
    systemTabs: {
      history: refs.some((ref) => ref.kind === "history")
        ? { id: "history", kind: "history", name: "History", lastPath: null }
        : null,
      settings: refs.some((ref) => ref.kind === "settings")
        ? {
            id: "settings",
            kind: "settings",
            name: "Settings",
            lastPath: null,
          }
        : null,
    },
  }));
}

function setSplit(left: TabRef, right: TabRef, focusedSide: "left" | "right") {
  useTabsStore.setState((state) => ({
    ...state,
    items: [
      {
        kind: "split",
        id: "pair",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide,
        routeBackingSide: focusedSide,
        leftRatio: 0.5,
      },
    ],
    activeItemId: "pair",
    stripOrder: [left, right],
  }));
}

function setSplitAlongside(
  left: TabRef,
  right: TabRef,
  focusedSide: "left" | "right",
  refs: ReadonlyArray<TabRef>,
) {
  const paired = new Set([left.id, right.id]);
  useTabsStore.setState((state) => ({
    ...state,
    items: [
      {
        kind: "split",
        id: "pair",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide,
        routeBackingSide: focusedSide,
        leftRatio: 0.5,
      },
      ...refs
        .filter((ref) => !paired.has(ref.id))
        .map((ref) => ({
          kind: "tab" as const,
          id: `tab:${ref.kind}:${ref.id}`,
          ref,
        })),
    ],
    activeItemId: "pair",
    stripOrder: refs,
  }));
}

function setSingle(ref: TabRef, refs: ReadonlyArray<TabRef>) {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((candidate) => ({
      kind: "tab" as const,
      id: `tab:${candidate.kind}:${candidate.id}`,
      ref: candidate,
    })),
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: refs,
  }));
}

describe("<TopLevelTabHost />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  });

  it.each([
    ["Epic/Epic", EPIC_A, EPIC_B],
    ["Epic/draft", EPIC_A, DRAFT_A],
    ["Epic/History", EPIC_A, HISTORY],
    ["Epic/Settings", EPIC_A, SETTINGS],
    ["draft/draft", DRAFT_A, DRAFT_B],
    ["draft/History", DRAFT_A, HISTORY],
    ["draft/Settings", DRAFT_A, SETTINGS],
    ["History/Settings", HISTORY, SETTINGS],
  ])("renders %s as two visible slots", (_name, left, right) => {
    seedSources([left, right]);
    setSplit(left, right, "left");

    render(<TopLevelTabHost />);

    expect(surfaceRef(left).dataset.visible).toBe("true");
    expect(surfaceRef(left).dataset.focused).toBe("true");
    expect(surfaceRef(left).className).toContain("flex");
    expect(surfaceRef(left).className).toContain("h-full");
    expect(surfaceRef(left).className).toContain("flex-col");
    expect(surfaceRef(right).dataset.visible).toBe("true");
    expect(surfaceRef(right).dataset.focused).toBe("false");
  });

  it("keeps split partner keys mounted while swapping their slots", () => {
    seedSources([EPIC_A, DRAFT_A]);
    setSplit(EPIC_A, DRAFT_A, "left");
    render(<TopLevelTabHost />);

    const epicBefore = surfaceRef(EPIC_A);
    const draftBefore = surfaceRef(DRAFT_A);

    act(() => setSplit(DRAFT_A, EPIC_A, "right"));

    expect(surfaceRef(EPIC_A)).toBe(epicBefore);
    expect(surfaceRef(DRAFT_A)).toBe(draftBefore);
    expect(surfaceRef(EPIC_A).dataset.focused).toBe("true");
  });

  it("keeps pointer and keyboard focus on the control that activates a split partner", () => {
    seedSources([EPIC_A, EPIC_B]);
    setSplit(EPIC_A, EPIC_B, "left");
    render(activatingHost(EPIC_A, EPIC_B));

    const action = screen.getByRole("textbox", { name: "Action epic-b" });
    act(() => {
      action.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, composed: true }),
      );
      action.focus();
    });

    expect(surfaceRef(EPIC_B).dataset.focused).toBe("true");
    expect(document.activeElement).toBe(action);

    act(() => setSplit(EPIC_A, EPIC_B, "left"));
    act(() => action.focus());

    expect(surfaceRef(EPIC_B).dataset.focused).toBe("true");
    expect(document.activeElement).toBe(action);
  });

  it("retains primary autofocus for blank top-level surface activation", () => {
    seedSources([EPIC_A, EPIC_B]);
    setSplit(EPIC_A, EPIC_B, "left");
    render(activatingHost(EPIC_A, EPIC_B));

    act(() => {
      screen
        .getByTestId("blank-surface-epic-b")
        .dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, composed: true }),
        );
    });

    expect(surfaceRef(EPIC_B).dataset.focused).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Primary epic-b" }),
    );
  });

  it("keeps a body instance and its local value across single-to-split-to-swap", async () => {
    seedSources([EPIC_A, DRAFT_A]);
    setSingle(EPIC_A, [EPIC_A, DRAFT_A]);
    render(<TopLevelTabHost />);

    const bodyBefore = await screen.findByTestId("epic-surface-body-epic-a");
    bodyBefore.setAttribute("data-local-value", "retained");

    act(() => setSplit(EPIC_A, DRAFT_A, "left"));
    act(() => setSplit(DRAFT_A, EPIC_A, "right"));

    const bodyAfter = screen.getByTestId("epic-surface-body-epic-a");
    expect(bodyAfter).toBe(bodyBefore);
    expect(bodyAfter.dataset.localValue).toBe("retained");
  });

  it("pins both active split members and evicts hidden surfaces by global MRU", async () => {
    const refs = Array.from({ length: 6 }, (_value, index) => ({
      kind: "epic" as const,
      id: `epic-${index}`,
    }));
    seedSources(refs);
    setSingle(refs[0], refs);
    render(<TopLevelTabHost />);

    for (const ref of refs.slice(1)) {
      act(() => setSingle(ref, refs));
    }

    await waitFor(() => {
      expect(screen.getAllByTestId(/^top-level-surface-epic-/)).toHaveLength(
        MAX_RETAINED_TOP_LEVEL_SURFACES,
      );
    });
    expect(screen.queryByTestId("top-level-surface-epic-0")).toBeNull();

    act(() => setSplitAlongside(refs[4], refs[5], "right", refs));

    await waitFor(() => {
      expect(surfaceRef(refs[4]).dataset.visible).toBe("true");
      expect(surfaceRef(refs[5]).dataset.visible).toBe("true");
      expect(screen.getAllByTestId(/^top-level-surface-epic-/)).toHaveLength(
        MAX_RETAINED_TOP_LEVEL_SURFACES,
      );
    });
  });

  it("evicts and reconstructs mixed-kind bodies while keeping an empty chooser side free", async () => {
    const refs = [EPIC_A, DRAFT_A, HISTORY, SETTINGS, EPIC_B, DRAFT_B];
    seedSources(refs);
    setSingle(EPIC_A, refs);
    render(<TopLevelTabHost />);

    const evictedBody = await screen.findByTestId("epic-surface-body-epic-a");
    refs.slice(1).forEach((ref) => {
      act(() => setSingle(ref, refs));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("epic-surface-body-epic-a")).toBeNull();
    });

    act(() => setSingle(EPIC_A, refs));

    await waitFor(() => {
      expect(screen.getByTestId("epic-surface-body-epic-a")).not.toBe(
        evictedBody,
      );
    });

    act(() => {
      useTabsStore.setState((state) => ({
        ...state,
        items: [
          {
            kind: "split",
            id: "chooser",
            left: { kind: "tab", ref: EPIC_A },
            right: { kind: "empty" },
            focusedSide: "right",
            routeBackingSide: "left",
            leftRatio: 0.5,
          },
          ...refs
            .filter((ref) => ref !== EPIC_A)
            .map((ref) => ({
              kind: "tab" as const,
              id: `tab:${ref.kind}:${ref.id}`,
              ref,
            })),
        ],
        activeItemId: "chooser",
        stripOrder: refs,
      }));
    });

    expect(screen.getByTestId("top-level-fillable-slot-right")).not.toBeNull();
    expect(screen.getAllByTestId(/^top-level-surface-/)).toHaveLength(5);
  });

  it("mounts exactly one landing terminal panel for a draft/draft split", () => {
    seedSources([DRAFT_A, DRAFT_B]);
    setSplit(DRAFT_A, DRAFT_B, "right");

    render(<LandingTerminalHost />);

    expect(screen.getAllByTestId("landing-terminal")).toHaveLength(1);
    expect(screen.getByTestId("landing-terminal").dataset.draftId).toBe(
      DRAFT_B.id,
    );
  });

  it("mounts landing terminal chrome for a standalone New Task tab", () => {
    seedSources([DRAFT_A]);
    setSingle(DRAFT_A, [DRAFT_A]);

    render(<LandingTerminalHost />);

    expect(screen.getByTestId("landing-terminal").dataset.draftId).toBe(
      DRAFT_A.id,
    );
  });

  it("keeps the landing terminal bound to the visible draft beside a focused chooser", () => {
    seedSources([DRAFT_A]);
    useTabsStore.setState((state) => ({
      ...state,
      items: [
        {
          kind: "split",
          id: "chooser",
          left: { kind: "tab", ref: DRAFT_A },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "chooser",
      stripOrder: [DRAFT_A],
    }));

    render(<LandingTerminalHost />);

    expect(screen.getByTestId("landing-terminal").dataset.draftId).toBe(
      DRAFT_A.id,
    );
  });

  it("keeps one gesture provider mounted while the panel portals between panes", () => {
    seedSources([DRAFT_A, DRAFT_B]);
    setSplit(DRAFT_A, DRAFT_B, "left");

    render(
      <>
        <LandingTerminalHost />
        <LandingTerminalPaneAnchor draftId={DRAFT_A.id} />
        <LandingTerminalPaneAnchor draftId={DRAFT_B.id} />
      </>,
    );

    const provider = screen.getByTestId("landing-terminal");
    expect(provider.dataset.draftId).toBe(DRAFT_A.id);
    expect(
      screen
        .getByTestId(`landing-terminal-anchor-${DRAFT_A.id}`)
        .contains(screen.getByTestId("landing-terminal-panel-body")),
    ).toBe(true);

    act(() => setSplit(DRAFT_A, DRAFT_B, "right"));

    // The provider node survives the focus change: only the panel's DOM moves
    // between panes, so the captured-gesture state the provider owns (pending
    // gesture, generation, open-episode draft) is never destroyed mid-flight.
    expect(screen.getByTestId("landing-terminal")).toBe(provider);
    expect(provider.dataset.draftId).toBe(DRAFT_B.id);
    expect(
      screen
        .getByTestId(`landing-terminal-anchor-${DRAFT_B.id}`)
        .contains(screen.getByTestId("landing-terminal-panel-body")),
    ).toBe(true);
  });
});

describe("activateHostedTopLevelSurface (design-review F3: hosted pointer/focus reaches its OWN owning top-level tab)", () => {
  afterEach(() => cleanup());

  function buildHostedRecord(
    instanceId: string,
    paneId: string,
    viewTabId: string,
  ): HTMLDivElement {
    const record = document.createElement("div");
    record.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, instanceId);
    record.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, paneId);
    record.setAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE, viewTabId);
    return record;
  }

  it("activates the hosted record's OWN owning epic tab, not a fixed one", () => {
    const tabA: HeaderTab = {
      kind: "epic",
      id: "epic-a",
      epicId: "epic-a",
      route: "/epic/epic-a",
      name: "Epic A",
      icon: null,
      canClose: true,
      canDuplicate: true,
      canOpenInNewWindow: true,
    };
    const tabB: HeaderTab = { ...tabA, id: "epic-b", epicId: "epic-b" };
    const tabsByRefKey = new Map([
      [tabRefKey(tabA), tabA],
      [tabRefKey(tabB), tabB],
    ]);
    const activeItem: StripItem = {
      kind: "tab",
      id: "tab:epic:epic-a",
      ref: { kind: "epic", id: "epic-a" },
    };
    const record = buildHostedRecord("inst-chat-b", "p1", "epic-b");
    document.body.appendChild(record);
    const activate = vi.fn();

    activateHostedTopLevelSurface(record, false, {
      tabsByRefKey,
      activeItem,
      activate,
    });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(tabB);
    record.remove();
  });

  it("does not re-activate the already-focused owning tab", () => {
    const tabA: HeaderTab = {
      kind: "epic",
      id: "epic-a",
      epicId: "epic-a",
      route: "/epic/epic-a",
      name: "Epic A",
      icon: null,
      canClose: true,
      canDuplicate: true,
      canOpenInNewWindow: true,
    };
    const tabsByRefKey = new Map([[tabRefKey(tabA), tabA]]);
    const activeItem: StripItem = {
      kind: "tab",
      id: "tab:epic:epic-a",
      ref: { kind: "epic", id: "epic-a" },
    };
    const record = buildHostedRecord("inst-chat-a", "p1", "epic-a");
    document.body.appendChild(record);
    const activate = vi.fn();

    activateHostedTopLevelSurface(record, false, {
      tabsByRefKey,
      activeItem,
      activate,
    });

    expect(activate).not.toHaveBeenCalled();
    record.remove();
  });

  it("respects defaultPrevented, a null activator, and a target outside any hosted record", () => {
    const tabA: HeaderTab = {
      kind: "epic",
      id: "epic-a",
      epicId: "epic-a",
      route: "/epic/epic-a",
      name: "Epic A",
      icon: null,
      canClose: true,
      canDuplicate: true,
      canOpenInNewWindow: true,
    };
    const tabsByRefKey = new Map([[tabRefKey(tabA), tabA]]);
    const activeItem: StripItem | null = null;
    const record = buildHostedRecord("inst-chat-a", "p1", "epic-a");
    document.body.appendChild(record);
    const activate = vi.fn();

    activateHostedTopLevelSurface(record, true, {
      tabsByRefKey,
      activeItem,
      activate,
    });
    expect(activate).not.toHaveBeenCalled();

    activateHostedTopLevelSurface(record, false, {
      tabsByRefKey,
      activeItem,
      activate: null,
    });
    expect(activate).not.toHaveBeenCalled();

    const outside = document.createElement("div");
    document.body.appendChild(outside);
    activateHostedTopLevelSurface(outside, false, {
      tabsByRefKey,
      activeItem,
      activate,
    });
    expect(activate).not.toHaveBeenCalled();

    record.remove();
    outside.remove();
  });
});

/**
 * Design-review F3: `activateHostedTopLevelSurface`'s own unit tests above
 * prove its routing logic, but not that a real hosted pointerdown reaches it
 * at all - that depends on the `onPointerDownCapture`/`onFocusCapture` JSX
 * wiring on `TopLevelTabHost`'s hosted-plane wrapper (a sibling of every
 * physical top-level surface wrapper, so it cannot inherit their own
 * handlers). This renders the REAL `TopLevelTabHost` with the switch on and a
 * REAL hosted record (real membership + registry, synthetic environment -
 * the same fixture seam `stable-tile-surface-host.test.tsx` uses), then fires
 * a genuine `pointerdown` on it to prove the wiring itself, not just the
 * function it calls.
 */
describe("TopLevelTabHost hosted-plane wiring (design-review F3: real pointerdown reaches activateHostedTopLevelSurface)", () => {
  const EPIC_A: TabRef = { kind: "epic", id: "epic-a" };
  const EPIC_B: TabRef = { kind: "epic", id: "epic-b" };
  const CHAT_INSTANCE_ID = "hosted-wiring-chat";
  const PANE_ID = "p1";

  beforeEach(() => {
    window.localStorage.clear();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
    stableTileSurfaceHostTestState.enabled = true;
  });

  afterEach(() => {
    cleanup();
    stableTileSurfaceHostTestState.enabled = false;
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
  });

  it("activates epic-b when a real pointerdown lands on its hosted record, while epic-a stays the physically focused surface", async () => {
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(EPIC_A.id, EPIC_A.id, "Epic A");
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(EPIC_B.id, EPIC_B.id, "Epic B");
    const stripItems = [EPIC_A, EPIC_B].map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    }));
    // The MRU retention policy only retains a background surface once it has
    // been active at least once (`advanceTopLevelSurfaceRecency` only adds
    // active keys). Visit B first so it enters recency, matching how a real
    // "open in background then switch away" sequence would leave B eligible
    // for the surface-host membership while A is the focused surface.
    useTabsStore.setState((state) => ({
      ...state,
      items: stripItems,
      activeItemId: `tab:${EPIC_B.kind}:${EPIC_B.id}`,
      stripOrder: [EPIC_A, EPIC_B],
    }));
    useTabsStore.setState((state) => ({
      ...state,
      activeItemId: `tab:${EPIC_A.kind}:${EPIC_A.id}`,
    }));
    useEpicCanvasStore.setState((state) => ({
      ...state,
      canvasByTabId: {
        ...state.canvasByTabId,
        [EPIC_B.id]: {
          root: pane(PANE_ID, [CHAT_INSTANCE_ID]),
          activePaneId: PANE_ID,
          tilesByInstanceId: {
            [CHAT_INSTANCE_ID]: {
              id: CHAT_INSTANCE_ID,
              instanceId: CHAT_INSTANCE_ID,
              type: "chat" as const,
              name: "Hosted wiring chat",
              hostId: TEST_HOST_ID,
            },
          },
          sizesByGroupId: {},
        },
      },
    }));

    const activate = vi.fn<TopLevelSurfaceActivator>();
    render(
      <TopLevelSurfaceActivationContext.Provider value={activate}>
        <TopLevelTabHost />
      </TopLevelSurfaceActivationContext.Provider>,
    );

    expect(surfaceRef(EPIC_A).dataset.focused).toBe("true");

    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment(CHAT_INSTANCE_ID, {
          placement: {
            epicId: EPIC_B.id,
            viewTabId: EPIC_B.id,
            paneId: PANE_ID,
            hostId: TEST_HOST_ID,
          },
        }),
      );
    });

    const hostedRecord = await waitFor(() => {
      const element = document.querySelector(
        `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}="${CHAT_INSTANCE_ID}"]`,
      );
      if (element === null) throw new Error("hosted record not yet published");
      return element;
    });
    expect(hostedRecord.getAttribute(HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE)).toBe(
      EPIC_B.id,
    );

    // A real pointerdown on the hosted record - not a direct function call -
    // must reach the wrapper's onPointerDownCapture and activate epic-b.
    fireEvent.pointerDown(hostedRecord);

    expect(activate).toHaveBeenCalledTimes(1);
    const [activatedTab] = activate.mock.calls[0];
    expect(activatedTab.id).toBe(EPIC_B.id);
  });
});
