import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { useBrowserSessionsPlane } from "@/hooks/home-focus/use-browser-sessions-plane";

/**
 * Home's read of the browser plane, and the one property the whole design rests
 * on: it SUBSCRIBES to the coordinator registry and never acquires from it.
 *
 * The registry is mocked at the module seam rather than driven through a real
 * stream, because what is under test is which seams this hook touches - a
 * `acquireBrowserSessionsCoordinator` call here would open a
 * `browser.sessions` stream per task on every host in the fleet the moment Home
 * was opened, and the assertion below is what stops that from being added
 * quietly.
 */

const { registryMock } = vi.hoisted(() => ({
  registryMock: {
    entries: [] as Array<{
      readonly key: string;
      readonly epicId: string;
      readonly state: BrowserSessionsState;
    }>,
    listeners: new Set<() => void>(),
    acquire: vi.fn(),
  },
}));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  browserSessionsCoordinatorEntries: () => registryMock.entries,
  subscribeToBrowserSessionsCoordinators: (listener: () => void) => {
    registryMock.listeners.add(listener);
    return () => registryMock.listeners.delete(listener);
  },
  acquireBrowserSessionsCoordinator: registryMock.acquire,
}));

/**
 * A COMPLETE `BrowserSessionsState`, not a three-field object asserted into
 * one.
 *
 * The hook reads three of these fields and the rest is stream machinery, but a
 * cast would mean a field added to the contract never reaches this fixture -
 * and the whole reason the hook can be trusted not to acquire is that it sees
 * the real shape and still touches only the read side. The action members
 * reject rather than resolve: nothing here may call them, and a test that
 * quietly did should fail rather than pass on an `undefined`.
 */
function unusedAction(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} is not callable from Home`));
}

function coordinatorState(args: {
  readonly hostId: string;
  readonly inventoryReady: boolean;
  readonly items: BrowserSessionsState["items"];
}): BrowserSessionsState {
  return {
    hostId: args.hostId,
    lifecycle: "live",
    inventoryReady: args.inventoryReady,
    canMaterializeElectron: false,
    connectionGeneration: 1,
    items: args.items,
    // Viewport control is a tile concern; Home never draws a browser surface,
    // so the plane it reads is inert here.
    viewports: {},
    setViewport: unusedAction("setViewport"),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: () => undefined,
    openTab: unusedAction("openTab"),
    closeTab: unusedAction("closeTab"),
    attachTab: unusedAction("attachTab"),
    moveTab: unusedAction("moveTab"),
  };
}

function coordinator(args: {
  readonly epicId: string;
  readonly hostId: string;
  readonly inventoryReady: boolean;
  readonly items: BrowserSessionsState["items"];
}): {
  readonly key: string;
  readonly epicId: string;
  readonly state: BrowserSessionsState;
} {
  return {
    key: `${args.hostId}:${args.epicId}`,
    epicId: args.epicId,
    state: coordinatorState({
      hostId: args.hostId,
      inventoryReady: args.inventoryReady,
      items: args.items,
    }),
  };
}

function notifyRegistry(): void {
  act(() => {
    for (const listener of registryMock.listeners) listener();
  });
}

beforeEach(() => {
  registryMock.entries = [];
  registryMock.acquire.mockClear();
});

afterEach(() => {
  // Explicit, because `vitest.config.ts` sets `globals: false` and the setup
  // file registers no `cleanup()` - so Testing Library never finds the global
  // `afterEach` its auto-cleanup hooks into. Clearing the mock's listener set
  // is not a substitute: it drops the registry's side of the wiring while the
  // `renderHook` roots stay mounted and their unsubscribes are never called.
  cleanup();
  registryMock.listeners.clear();
});

describe("useBrowserSessionsPlane", () => {
  it("never acquires a coordinator", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({})] })],
      }),
    ];
    const { result } = renderHook(() => useBrowserSessionsPlane());

    expect(result.current).toHaveLength(1);
    // The whole point: Home lists browsers without opening a single
    // `browser.sessions` stream of its own.
    expect(registryMock.acquire).not.toHaveBeenCalled();
  });

  it("unions the coordinators of one epic across hosts", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ sessionId: "s-a", hostId: "host-a" })],
      }),
      coordinator({
        epicId: "epic-1",
        hostId: "host-b",
        inventoryReady: true,
        items: [sessionInfo({ sessionId: "s-b", hostId: "host-b" })],
      }),
    ];
    const { result } = renderHook(() => useBrowserSessionsPlane());

    expect(result.current).toHaveLength(1);
    expect(
      result.current[0]?.sessions.map((session) => [
        session.sessionId,
        session.hostId,
      ]),
    ).toEqual([
      ["s-a", "host-a"],
      ["s-b", "host-b"],
    ]);
  });

  it("skips a coordinator that has not delivered its first snapshot", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: false,
        items: [sessionInfo({ tabs: [tabInfo({})] })],
      }),
    ];
    const { result } = renderHook(() => useBrowserSessionsPlane());

    // Its `items` are the PREVIOUS incarnation's, so listing them would show
    // pages that may already be gone.
    expect(result.current).toEqual([]);
  });

  it("returns the same snapshot when a frame changes nothing a row reads", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({ title: "Checkout" })] })],
      }),
    ];
    const { result } = renderHook(() => useBrowserSessionsPlane());
    const first = result.current;

    // A fresh state object with a bumped activity stamp, which is what the
    // host sends on essentially every frame.
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [
          sessionInfo({
            lastActivityAt: 999,
            runtime: { kind: "headless", revision: 7 },
            tabs: [tabInfo({ title: "Checkout" })],
          }),
        ],
      }),
    ];
    notifyRegistry();

    expect(result.current).toBe(first);
  });

  it("re-renders exactly once for a title change, and not at all without one", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({ title: "Checkout" })] })],
      }),
    ];
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useBrowserSessionsPlane();
    });
    const afterMount = renders;

    // Two frames that change nothing a row reads. `useSyncExternalStore` only
    // re-renders when the snapshot reference moves, so a content-keyed read is
    // what keeps a page with a busy agent off the render loop.
    for (const lastActivityAt of [111, 222]) {
      registryMock.entries = [
        coordinator({
          epicId: "epic-1",
          hostId: "host-a",
          inventoryReady: true,
          items: [
            sessionInfo({
              lastActivityAt,
              tabs: [tabInfo({ title: "Checkout" })],
            }),
          ],
        }),
      ];
      notifyRegistry();
    }
    expect(renders).toBe(afterMount);

    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({ title: "Order placed" })] })],
      }),
    ];
    notifyRegistry();

    expect(renders).toBe(afterMount + 1);
  });

  it("publishes a new snapshot when a tab navigates", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({ title: "Checkout" })] })],
      }),
    ];
    const { result } = renderHook(() => useBrowserSessionsPlane());
    const first = result.current;

    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({ title: "Order placed" })] })],
      }),
    ];
    notifyRegistry();

    expect(result.current).not.toBe(first);
    expect(result.current[0]?.sessions[0]?.tabs[0]?.title).toBe("Order placed");
  });

  it("drops an epic whose last coordinator went away", () => {
    registryMock.entries = [
      coordinator({
        epicId: "epic-1",
        hostId: "host-a",
        inventoryReady: true,
        items: [sessionInfo({ tabs: [tabInfo({})] })],
      }),
    ];
    const { result } = renderHook(() => useBrowserSessionsPlane());
    expect(result.current).toHaveLength(1);

    // Closing the canvas that owned the stream takes the rows with it, which
    // is the honest reading of a window-local inventory.
    registryMock.entries = [];
    notifyRegistry();

    expect(result.current).toEqual([]);
  });
});
