/**
 * The bound on sessions a reader built: a session a card's own acquisition
 * constructed, and that no tab ever joined, is eligible for the cap and for
 * byte eviction the moment its last card lets go, whatever the activity plane
 * says. A session a tab built or joined keeps the plane's arms.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
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

import { act, waitFor, type RenderResult } from "@testing-library/react";
import {
  openTestEpicTab,
  setTestEffectiveHost,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  EPIC_ID,
  HOST_ID,
  deliverSnapshot,
  deliverSnapshotTo,
  detachTaskSurfaces,
  installReaderCardHarness,
  intersectIn,
  lastToken,
  openShownTabs,
  openShownTaskTab,
  presentCardOn,
  registry,
  seen,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
  agentActivityPlaneAnswers,
  agentActivityPlaneReportsEpicTurn,
} from "@/stores/agent-activity-store";
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";

installReaderCardHarness();

const PRESENTED = 2;
const CARDS = DEFAULT_MAX_LIVE_EPICS + 3;

function readerEpic(index: number): string {
  return `reader-${String(index)}`;
}

/** The plane cannot say anything: no slice answers. */
function blindPlane(): void {
  __resetAgentActivityStoreForTests();
  expect(agentActivityPlaneAnswers()).toBe(false);
}

/** The plane answers and reports a turn on every one of `epicIds`. */
function planeReportingTurnsOn(epicIds: readonly string[]): void {
  __setAgentActivityStateForTests(
    Object.fromEntries(
      epicIds.map((epicId) => [epicId, { working: [], turn: ["agent-1"] }]),
    ),
    "cloud",
    "connected",
  );
  for (const epicId of epicIds) {
    expect(agentActivityPlaneReportsEpicTurn(epicId)).toBe(true);
  }
}

/** Presents a card on each reader task, loaded as a real one is while shown. */
async function presentReaderCards(count: number): Promise<RenderResult[]> {
  const views: RenderResult[] = [];
  for (let index = 0; index < count; index += 1) {
    const epicId = readerEpic(index);
    views.push(await presentCardOn(epicId, `row-${String(index)}`));
    deliverSnapshotTo(epicId);
  }
  return views;
}

/** Records the order sessions are disposed in, by task. */
function recordDisposals(epicIds: readonly string[]): string[] {
  const order: string[] = [];
  for (const epicId of epicIds) {
    const handle = registry().peek(epicId);
    if (handle === null) throw new Error(`${epicId} has no live session`);
    const dispose = handle.dispose.bind(handle);
    vi.spyOn(handle, "dispose").mockImplementation(() => {
      order.push(epicId);
      dispose();
    });
  }
  return order;
}

/** All of the first `count - PRESENTED` cards scroll out, one after another. */
function scrollOutAllButLast(views: readonly RenderResult[]): void {
  for (const view of views.slice(0, views.length - PRESENTED)) {
    intersectIn(view.container, false);
  }
}

function expectBoundedToCapPlusPresented(order: readonly string[]): void {
  const epics = Array.from({ length: CARDS }, (_, index) => readerEpic(index));
  const evicted = epics.length - DEFAULT_MAX_LIVE_EPICS;
  // The oldest reader-built sessions made room, oldest first.
  expect(order).toEqual(epics.slice(0, evicted));
  expect(registry().size()).toBe(DEFAULT_MAX_LIVE_EPICS);
  for (const epicId of epics.slice(0, evicted)) {
    expect(registry().peek(epicId)).toBeNull();
  }
  for (const epicId of epics.slice(evicted)) {
    expect(registry().peek(epicId)).not.toBeNull();
  }
  // The cards still presented keep their sessions.
  for (const epicId of epics.slice(CARDS - PRESENTED)) {
    expect(registry().hasReaderDemand(epicId)).toBe(true);
  }
}

describe("sessions a reader built, once their last card lets go", () => {
  it("are bounded to the cap on release while the activity plane is blind", async () => {
    blindPlane();
    const views = await presentReaderCards(CARDS);
    const order = recordDisposals(
      Array.from({ length: CARDS }, (_, index) => readerEpic(index)),
    );
    expect(registry().size()).toBe(CARDS);

    scrollOutAllButLast(views);

    expectBoundedToCapPlusPresented(order);
  });

  it("are bounded to the cap on release while the plane reports a turn on each of them", async () => {
    const epics = Array.from({ length: CARDS }, (_, index) =>
      readerEpic(index),
    );
    planeReportingTurnsOn(epics);
    const views = await presentReaderCards(CARDS);
    const order = recordDisposals(epics);
    expect(registry().size()).toBe(CARDS);

    scrollOutAllButLast(views);

    expectBoundedToCapPlusPresented(order);
  });
});

describe("a session a tab built keeps the activity plane's arms", () => {
  it("survives the cap walk under a blind plane while reader-built sessions over the cap are walked", async () => {
    blindPlane();
    openShownTabs(1, "tab-built");
    deliverSnapshotTo("tab-built-0");
    detachTaskSurfaces();
    expect(registry().isEligibleForCapEviction("tab-built-0")).toBe(false);
    const views = await presentReaderCards(DEFAULT_MAX_LIVE_EPICS + 1);
    const order = recordDisposals(
      Array.from({ length: DEFAULT_MAX_LIVE_EPICS + 1 }, (_, index) =>
        readerEpic(index),
      ),
    );

    for (const view of views) intersectIn(view.container, false);

    // The tab-built session is the oldest and clean, yet blocked: the
    // reader-built ones over the cap go instead, oldest first.
    expect(registry().peek("tab-built-0")).not.toBeNull();
    expect(registry().isEligibleForCapEviction("tab-built-0")).toBe(false);
    expect(order).toEqual([readerEpic(0), readerEpic(1)]);
    expect(registry().size()).toBe(DEFAULT_MAX_LIVE_EPICS);
  });

  it("is kept by a reader-built session a tab joined, after the tab and the card both let go", async () => {
    blindPlane();
    const card = await presentCardOn(EPIC_ID, "row-1");
    deliverSnapshotTo(EPIC_ID);
    openShownTaskTab();
    detachTaskSurfaces();
    intersectIn(card.container, false);
    expect(registry().hasReaderDemand(EPIC_ID)).toBe(false);
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(false);

    const views = await presentReaderCards(DEFAULT_MAX_LIVE_EPICS + 1);
    for (const view of views) intersectIn(view.container, false);

    expect(registry().peek(EPIC_ID)).not.toBeNull();
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(false);
  });
});

describe("byte-budget eviction of sessions a reader built", () => {
  it("takes a released reader-built session under a blind plane, not the tab-built one", async () => {
    blindPlane();
    openShownTabs(1, "tab-built");
    deliverSnapshotTo("tab-built-0");
    detachTaskSurfaces();
    const card = await presentCardOn(EPIC_ID, "row-1");
    deliverSnapshotTo(EPIC_ID);
    intersectIn(card.container, false);
    expect(registry().hasReaderDemand(EPIC_ID)).toBe(false);

    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(true);
    expect(registry().isEligibleForCapEviction("tab-built-0")).toBe(false);
    expect(registry().evictOldestEligibleForByteBudget()).toBe(true);

    expect(registry().peek(EPIC_ID)).toBeNull();
    expect(registry().peek("tab-built-0")).not.toBeNull();
  });
});

const REAL_TITLE = "Quarterly rollout";

/**
 * The task is open in a hidden, already-named tab (no pane, no session of its
 * own); a card presents it, then lets go. The entry stays, so its session sits
 * warm, suspended and demand-free.
 */
async function warmSessionUnderHiddenNamedTab(): Promise<void> {
  openTestEpicTab("tab-first", EPIC_ID, "My real title");
  expect(registry().peek(EPIC_ID)).toBeNull();
  const card = await presentCardOn(EPIC_ID, "row-1");
  deliverSnapshotTo(EPIC_ID);
  intersectIn(card.container, false);
  expect(registry().hasReaderDemand(EPIC_ID)).toBe(false);
  expect(registry().peek(EPIC_ID)).not.toBeNull();
  expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(true);
}

function tabNamed(tabId: string): string | undefined {
  return useEpicCanvasStore.getState().tabsById[tabId]?.name;
}

describe("a hidden tab joining a warm, demand-free session", () => {
  it("an unnamed one takes one mount unit, gets the real title written, and gives the unit back once", async () => {
    await warmSessionUnderHiddenNamedTab();
    const acquired = vi.spyOn(registry(), "acquireMounted");
    const released = vi.spyOn(registry(), "releaseMounted");

    openTestEpicTab("tab-unnamed", EPIC_ID, "");

    // No pane shows it, yet the controller holds the session for its title.
    expect(acquired).toHaveBeenCalledTimes(1);
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(false);
    deliverSnapshot();
    const handle = registry().peek(EPIC_ID);
    if (handle === null) throw new Error("the held session is gone");
    handle.store.setState((state) => ({
      epic: { ...state.epic, title: REAL_TITLE },
    }));

    expect(tabNamed("tab-unnamed")).toBe(REAL_TITLE);
    expect(released).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledWith(EPIC_ID);
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(true);
  });

  it("an already-named one takes no unit", async () => {
    await warmSessionUnderHiddenNamedTab();
    const acquired = vi.spyOn(registry(), "acquireMounted");
    const released = vi.spyOn(registry(), "releaseMounted");

    openTestEpicTab("tab-named", EPIC_ID, "My real title");

    expect(acquired).not.toHaveBeenCalled();
    expect(released).not.toHaveBeenCalled();
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(true);
  });
});

describe("a session a tab holds, then re-pointed to another host", () => {
  it("keeps the activity arm after the tab and the card both let go", async () => {
    planeReportingTurnsOn([EPIC_ID]);
    // A tab builds the session and a card joins it: the arms apply to it.
    openShownTaskTab();
    const card = await presentCardOn(EPIC_ID, "row-1");
    deliverSnapshotTo(EPIC_ID);
    const joined = registry().peek(EPIC_ID);
    expect(seen.constructions).toBe(1);

    // The window's host moves and the tab's session re-points: the candidate
    // on the new host loads and replaces the joined one.
    act(() => setTestEffectiveHost("host-b", true));
    await waitFor(() => expect(seen.constructions).toBe(2));
    deliverSnapshotTo(EPIC_ID);
    await waitFor(() =>
      expect(registry().peek(EPIC_ID)?.hostId).toBe("host-b"),
    );
    expect(registry().peek(EPIC_ID)).not.toBe(joined);

    detachTaskSurfaces();
    intersectIn(card.container, false);

    expect(registry().hasReaderDemand(EPIC_ID)).toBe(false);
    expect(registry().peek(EPIC_ID)).not.toBeNull();
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(false);
  });
});

describe("a reader-only entry", () => {
  it("is pinned to its card's host and never re-points when the window's host moves", async () => {
    planeReportingTurnsOn([EPIC_ID]);
    const card = await presentCardOn(EPIC_ID, "row-1");
    deliverSnapshotTo(EPIC_ID);
    const token = lastToken();
    await waitFor(() => expect(token.read().kind).toBe("ready"));
    const handle = registry().peek(EPIC_ID);
    const constructionsBefore = seen.constructions;

    act(() => setTestEffectiveHost("host-b", true));
    await act(async () => {
      await Promise.resolve();
    });

    // Nothing was built for the new host; the entry still serves the card's.
    expect(seen.constructions).toBe(constructionsBefore);
    expect(
      getEpicSessionController().readEntryStatusForTests(EPIC_ID)?.presentation,
    ).toMatchObject({ kind: "ready", targetHostId: HOST_ID });
    expect(token.read().kind).toBe("ready");
    expect(registry().peek(EPIC_ID)).toBe(handle);

    // Still the reader-built session the bound applies to: under a reported
    // turn the cap may take it the moment the card lets go.
    intersectIn(card.container, false);
    expect(registry().isEligibleForCapEviction(EPIC_ID)).toBe(true);
  });
});
