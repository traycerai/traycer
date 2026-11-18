/**
 * The card's Open opens the task on the host the card was admitted on, even
 * when the window's effective host is another one, and never migrates a task
 * that is already bound elsewhere. Real card, real token, real Open, real
 * coordinator; only the router's navigate is stubbed (the suite has no router).
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouter: () => null,
}));
// The controller holds an activation until the router has hydrated; this
// suite has no router, so the navigate it would issue is issued at once.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: (go: (intent: unknown) => void, intent: unknown) =>
    go(intent),
}));
vi.mock("@/components/sandbox/sandbox-frame", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sandbox/sandbox-frame")
  >()),
  SandboxFrame: (
    await import("@/components/sandbox/__tests__/artifact-frame-browser-driver")
  ).ArtifactFrameBrowserDriver,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);

import {
  EPIC_ID,
  HOST_ID,
  SURFACE,
  admittedHandle,
  deliverSnapshot,
  firstToken,
  installReaderCardHarness,
  intersectIn,
  openShownTaskTab,
  seen,
  showCardAlone,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { setTestEffectiveHost } from "@/lib/registries/test-support/epic-session-controller-test-support";
import {
  __resetTabNavigationControllerForTesting,
  __resetTabNavigationHydrationForTesting,
  tabNavigationController,
} from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

installReaderCardHarness();

beforeEach(() => {
  // The router is hydrated: an Open runs at once, not queued behind it.
  __resetTabNavigationControllerForTesting();
});

const WINDOW_HOST = "host-window";

function tabsOfTask() {
  return Object.values(useEpicCanvasStore.getState().tabsById).flatMap((tab) =>
    tab !== undefined && tab.epicId === EPIC_ID ? [tab] : [],
  );
}

function tilesOfTask() {
  const state = useEpicCanvasStore.getState();
  return tabsOfTask().flatMap((tab) =>
    Object.values(
      state.canvasByTabId[tab.tabId]?.tilesByInstanceId ?? {},
    ).flatMap((tile) => (tile === undefined ? [] : [tile])),
  );
}

describe("Open on a card admitted on another host than the window's", () => {
  it("opens the task's tab on the card's host with a tile on it, and the reader keeps its handle", async () => {
    setTestEffectiveHost(WINDOW_HOST, true);
    await showCardAlone(SURFACE, "row-1");
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    const handle = admittedHandle();
    const constructionsBefore = seen.constructions;

    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));

    await waitFor(() => expect(tabsOfTask()).toHaveLength(1));
    expect(getEpicSessionController().readEpicHostId(EPIC_ID)).toBe(HOST_ID);
    expect(tilesOfTask()).toMatchObject([
      { id: "artifact-rollout", type: "html", hostId: HOST_ID },
    ]);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
    expect(seen.constructions).toBe(constructionsBefore);
    expect(screen.getByTestId("artifact-frame-driver")).toBeTruthy();
  });

  it("an Open queued behind hydration rechecks its lifetime when it runs, and never migrates a task bound elsewhere in the meantime", async () => {
    setTestEffectiveHost(HOST_ID, true);
    await showCardAlone(SURFACE, "row-1");
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    // The router has not hydrated: the Open the person presses is queued.
    __resetTabNavigationHydrationForTesting();
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    expect(tabsOfTask()).toHaveLength(0);
    // Meanwhile the task is opened on another host by an ordinary tab, which
    // fences the card's reader.
    setTestEffectiveHost(WINDOW_HOST, true);
    openShownTaskTab();
    await waitFor(() =>
      expect(screen.queryByTestId("artifact-frame-driver")).toBeNull(),
    );
    const tabsBefore = tabsOfTask().length;

    tabNavigationController.setHydrationReady(true, navigate);

    expect(tabsOfTask()).toHaveLength(tabsBefore);
    expect(getEpicSessionController().readEpicHostId(EPIC_ID)).toBe(
      WINDOW_HOST,
    );
    expect(tilesOfTask().some((tile) => tile.hostId === HOST_ID)).toBe(false);
  });
});

describe("an Open queued behind router hydration", () => {
  /** A loaded card on the window's own host whose Open is pressed before the router has hydrated. */
  async function queueOpen() {
    setTestEffectiveHost(HOST_ID, true);
    const view = await showCardAlone(SURFACE, "row-1");
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    __resetTabNavigationHydrationForTesting();
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    expect(tabsOfTask()).toHaveLength(0);
    return view;
  }

  it("opens the task once hydration lands while the card still holds its lifetime", async () => {
    await queueOpen();

    tabNavigationController.setHydrationReady(true, navigate);

    await waitFor(() => expect(tabsOfTask()).toHaveLength(1));
    expect(tilesOfTask()).toMatchObject([
      { id: "artifact-rollout", type: "html", hostId: HOST_ID },
    ]);
  });

  it("opens nothing when the card was withdrawn meanwhile, with no host change to blame", async () => {
    const view = await queueOpen();
    intersectIn(view.container, false);
    expect(firstToken().read().kind).toBe("closed");

    tabNavigationController.setHydrationReady(true, navigate);

    expect(tabsOfTask()).toHaveLength(0);
    expect(tilesOfTask()).toHaveLength(0);
    expect(getEpicSessionController().readEpicHostId(EPIC_ID)).toBeNull();
  });
});
