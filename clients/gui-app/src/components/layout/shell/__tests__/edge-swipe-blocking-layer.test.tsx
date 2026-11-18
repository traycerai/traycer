// The blocking surfaces that raise NO document barrier, driven through the real
// component rather than by poking the claim counter. A surface can be blocking
// in two ways - by making the whole document inert, or by inerting a subtree
// itself - and only the first is visible to a document-level recognizer. This
// suite covers the second, which is the one a barrier-only guard waves straight
// through.
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { EpicMigrationModal } from "@/components/epic-canvas/dialogs/epic-migration-modal";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import {
  blockingLayerClaimed,
  useBlockingLayerClaim,
} from "@/components/layout/shell/blocking-layer-claim";
import { setMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import type { EpicMigrationSlice } from "@/stores/epics/open-epic/store";

const IDLE_MIGRATION: EpicMigrationSlice = {
  status: "idle",
  phase: null,
  chunksDone: 0,
  chunksTotal: 0,
};

// Only the per-epic store reads are faked - the modal itself, the swipe
// recognizer, the shared actions and the router are all real. Partial, so every
// other selector in that module stays intact for the rest of the graph.
const migrationState = vi.hoisted((): { current: EpicMigrationSlice } => ({
  current: {
    status: "idle",
    phase: null,
    chunksDone: 0,
    chunksTotal: 0,
  },
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    useEpicMigrationState: () => migrationState.current,
    useEpicRetryMigration: () => () => {},
  };
});

function makeRouter(history: RouterHistory): AppRouter {
  return createRouter({
    routeTree,
    history,
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
}

function SwipesUnderMigration() {
  useMobileHistorySwipes();
  return (
    <div data-testid="epic-pane" className="relative">
      <div data-testid="epic-shell" data-epic-shell-root="true" />
      <EpicMigrationModal tabId="tab-a" />
    </div>
  );
}

function dispatchPointer(
  type: "pointerdown" | "pointermove",
  options: { readonly clientX: number; readonly timeStamp: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    clientX: options.clientX,
    clientY: 300,
    pointerId: 1,
    isPrimary: true,
    target: document.body,
    timeStamp: options.timeStamp,
  })) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  document.dispatchEvent(event);
}

function swipeFromEdge(edge: "leading" | "trailing"): void {
  const from = edge === "leading" ? 8 : window.innerWidth - 8;
  const to = edge === "leading" ? 80 : window.innerWidth - 80;
  act(() => {
    dispatchPointer("pointerdown", { clientX: from, timeStamp: 0 });
    dispatchPointer("pointermove", { clientX: to, timeStamp: 100 });
  });
}

function renderUnderMigration(history: RouterHistory): {
  rerender: () => void;
} {
  const router = makeRouter(history);
  const view = render(
    <RouterContextProvider router={router}>
      <SwipesUnderMigration />
    </RouterContextProvider>,
  );
  return {
    rerender: () => {
      view.rerender(
        <RouterContextProvider router={router}>
          <SwipesUnderMigration />
        </RouterContextProvider>,
      );
    },
  };
}

beforeEach(() => {
  setMobileApp(true);
  migrationState.current = IDLE_MIGRATION;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setMobileApp(false);
  useMobileNavStore.setState({ open: false });
  migrationState.current = IDLE_MIGRATION;
});

/**
 * WHEN the claim is acquired, which no behavioural test in this file can see:
 * Testing Library flushes passive effects inside `act`, so a claim registered
 * in a passive effect looks identical to one registered before paint. The
 * window it hides is real on a device - the surface is painted and under a
 * finger while the claim is still queued - so it is pinned structurally
 * instead.
 *
 * The probe is two competing effects in ONE component, with the passive one
 * declared FIRST. Passive effects run in declaration order, so a passively
 * acquired claim would run second and this probe would see the app free; a
 * layout effect runs before any passive effect regardless of where it was
 * declared, so seeing the claim held is proof of the earlier slot rather than
 * of ordering luck.
 */
describe("blocking-layer claim acquisition", () => {
  const passiveObservations: boolean[] = [];

  function AcquisitionOrderProbe() {
    useEffect(() => {
      passiveObservations.push(blockingLayerClaimed());
    }, []);
    useBlockingLayerClaim(true);
    return null;
  }

  beforeEach(() => {
    passiveObservations.length = 0;
  });

  it("holds the claim before any passive effect runs", () => {
    render(<AcquisitionOrderProbe />);

    expect(passiveObservations).toEqual([true]);
  });
});

describe("edge swipes under the epic migration modal", () => {
  // The modal mounts the dialog primitive with `modal={false}` and inerts only
  // its own epic shell, so the barrier an ordinary dialog raises never appears.
  // Pinned first, because it is the premise every case below rests on - and the
  // day the modal starts raising it, this fails and says so.
  it("raises no document barrier, and claims the app instead", () => {
    migrationState.current = {
      status: "running",
      phase: "upload",
      chunksDone: 1,
      chunksTotal: 2,
    };
    renderUnderMigration(createMemoryHistory({ initialEntries: ["/"] }));

    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(blockingLayerClaimed()).toBe(true);
  });

  it("fires neither action while a migration is running", () => {
    migrationState.current = {
      status: "running",
      phase: "upload",
      chunksDone: 1,
      chunksTotal: 2,
    };
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    const forwardSpy = vi.spyOn(history, "forward");
    renderUnderMigration(history);

    swipeFromEdge("leading");
    swipeFromEdge("trailing");

    expect(backSpy).not.toHaveBeenCalled();
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  // A migration the user cannot act on at all is the one they are most likely
  // to try to swipe away from.
  it("fires neither action on the not-allowed surface", () => {
    migrationState.current = { ...IDLE_MIGRATION, status: "not-allowed" };
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    renderUnderMigration(history);

    swipeFromEdge("leading");

    expect(backSpy).not.toHaveBeenCalled();
  });

  // The novelty guard: a stand-down that never lifted would satisfy every case
  // above just as well as one that keys off the migration.
  it("navigates again once the migration goes idle", () => {
    migrationState.current = {
      status: "running",
      phase: "upload",
      chunksDone: 1,
      chunksTotal: 2,
    };
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    const view = renderUnderMigration(history);

    migrationState.current = IDLE_MIGRATION;
    act(() => {
      view.rerender();
    });
    expect(blockingLayerClaimed()).toBe(false);
    swipeFromEdge("leading");

    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  // Unmounting mid-migration is an ordinary end for this surface - the tab is
  // closed from inside the modal itself. A claim outliving its surface would
  // leave the app permanently unswipeable for the rest of the session.
  it("releases the claim when the surface unmounts mid-migration", () => {
    migrationState.current = {
      status: "running",
      phase: "upload",
      chunksDone: 1,
      chunksTotal: 2,
    };
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    renderUnderMigration(history);
    expect(blockingLayerClaimed()).toBe(true);

    cleanup();
    expect(blockingLayerClaimed()).toBe(false);

    // The recognizer went with the surface, so the behavioural proof that the
    // claim lifted is a fresh mount - with nothing migrating - navigating
    // normally. A leaked claim would refuse this for the rest of the session.
    migrationState.current = IDLE_MIGRATION;
    renderUnderMigration(history);
    swipeFromEdge("leading");

    expect(backSpy).toHaveBeenCalledTimes(1);
  });
});
