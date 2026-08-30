// The window narrator over a MOUNTED mobile shell, from the gesture's side.
//
// The two are wired together by the document and nothing else: a modal layer
// raises `body { pointer-events: none }`, `modalLayerCoversApp` reads it, and
// the edge recognizer stands its touch reservation down. That coupling is
// invisible from either file on its own - the narrator's own suite can only see
// which surface rendered, and the recognizer's can only see a barrier someone
// poked in - so it is pinned here, with the real narrator deciding and the real
// recognizer answering.
//
// The failure being pinned: a post-latch ∅ - one frame of it is enough, and the
// authority produces one on every resume that re-attaches before naming an
// effective host - taking the barrier and killing back AND forward app-wide,
// with taps still working and no modal left on screen to explain it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { modalLayerCoversApp } from "@/components/layout/shell/shell-gestures";
import { setMobileApp } from "@/lib/mobile-app";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

// The provisioning lane is narration DETAIL, and mounting its query would put a
// host round-trip between this fixture and the one thing it is about. Every
// other decision the narrator makes here - which surface, which cause - is a
// function of the authority snapshot below.
vi.mock("@/hooks/host/use-host-provisioning-progress", () => ({
  useHostProvisioningProgress: () => null,
}));

const REMOTE_HOST_ID = "remote-host";

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "remote",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

/**
 * The gate is OPEN and LATCHED: an app is mounted behind the narrator, which is
 * the only state in which this pairing exists at all. While the gate blocks
 * there is no `AppShell`, so no recognizer either.
 */
const LATCHED_CONTROLLER: HostReadinessController = {
  readinessFor: () => ({ kind: "ready" }),
  defaultHostPresentation: EMPTY_PRESENTATION,
  hasBeenDefaultHostReady: true,
};

function deadLease(hostId: string): HostLeaseSnapshot {
  return {
    hostId,
    status: "dead",
    dead: { reason: "offline" },
  };
}

function applySnapshot(overrides: Partial<SelectionKernelSnapshot>): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
    selectionRevision: 1,
    ...overrides,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

/** The ∅ verdict over a mounted app: nothing can serve this window right now. */
function applyEmptyFleet(): void {
  applySnapshot({
    attached: true,
    effectiveHostId: null,
    targetHostId: REMOTE_HOST_ID,
    leases: [deadLease(REMOTE_HOST_ID)],
  });
}

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

/** The shell's two halves: the narrator that decides, the recognizer that reads. */
function NarratedShell() {
  useMobileHistorySwipes();
  return <WindowHostModalHost bypassed={false} />;
}

function renderShell(history: RouterHistory): void {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    // The phone: no local host to expect, which is what sends the authority's
    // ∅ down the `no-usable-host` arm instead of the cold-start grace.
    hasLocalHost: false,
    traycerCli: null,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider value={LATCHED_CONTROLLER}>
          <RouterContextProvider router={makeRouter(history)}>
            <NarratedShell />
          </RouterContextProvider>
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/**
 * jsdom ships no working `Touch` constructor, so a touch is a plain `Event`
 * wearing the one shape the reservation reads off it - a `touches` list with
 * `.item()`, and a `target`. Same trick as `shell-gestures.test.tsx`.
 */
function dispatchTouch(
  type: "touchstart" | "touchmove" | "touchend",
  points: ReadonlyArray<{ readonly clientX: number; readonly clientY: number }>,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: Object.assign([...points], {
      item: (index: number) => points[index] ?? null,
    }),
    configurable: true,
  });
  Object.defineProperty(event, "target", {
    value: document.body,
    configurable: true,
  });
  document.dispatchEvent(event);
  return event;
}

/**
 * A leading-edge touch dragged inward, answering the question the device asks:
 * did the reservation attach and cancel the move.
 *
 * A cancelled move is the ONLY proof that matters here. The reservation exists
 * because a pointer stream the web view has already given to a scroller cannot
 * be taken back, so a recognizer that never cancels is one whose gesture dies
 * on a phone while every synthetic pointer test still passes.
 */
function reservesLeadingEdgeDrag(): boolean {
  dispatchTouch("touchstart", [{ clientX: 8, clientY: 300 }]);
  const move = dispatchTouch("touchmove", [{ clientX: 40, clientY: 300 }]);
  dispatchTouch("touchend", []);
  return move.defaultPrevented;
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

function swipeFromLeadingEdge(): void {
  act(() => {
    dispatchPointer("pointerdown", { clientX: 8, timeStamp: 0 });
    dispatchPointer("pointermove", { clientX: 80, timeStamp: 100 });
  });
}

beforeEach(() => {
  setMobileApp(true);
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.setState({ status: "signed-out" });
  useMobileNavStore.setState({ open: false });
  setMobileApp(false);
  document.body.style.pointerEvents = "";
});

describe("edge swipes under the window narrator", () => {
  it("keeps back navigation alive while a post-latch ∅ is narrating", async () => {
    applyEmptyFleet();
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    renderShell(history);

    // The narrator IS speaking - without this the case would pass on a window
    // that simply had nothing to say, which is the vacuity this pairing is
    // most likely to decay into.
    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(screen.queryByTestId("window-host-modal")).toBeNull();

    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(modalLayerCoversApp()).toBe(false);
    expect(reservesLeadingEdgeDrag()).toBe(true);

    swipeFromLeadingEdge();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  // The positive control for the mechanism: the same tree, the same gesture,
  // with the barrier a modal layer raises. The reservation is refused at
  // touchstart, so on a device the web view keeps the drag and the recognizer
  // never sees the travel - which is what the case above would look like if a
  // modal layer came back to this arm.
  it("stands down while the document declares itself covered", async () => {
    applyEmptyFleet();
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    renderShell(history);
    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });

    document.body.style.pointerEvents = "none";

    expect(reservesLeadingEdgeDrag()).toBe(false);
    swipeFromLeadingEdge();
    expect(backSpy).not.toHaveBeenCalled();
  });
});
