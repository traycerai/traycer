// The launch flash, from the two layers that produce it: the hook that reads
// whether discovery has answered, and the narrator that decides what to say
// about ∅ while it has not.
//
// The failure being pinned: on a shell with no local host - the phone, in
// practice - the authority publishes an empty lease list before anything has
// asked the registry, the narrator reads that as ∅, and "No host is available"
// (with Retry and Report issue) is on screen for the beat between the kernel
// attaching and the first listing landing. On every launch.
//
// The pure derivation lives in `window-narration.test.ts`; what these cases add
// is that the real hook supplies the real flag, and that a surface actually
// renders - or does not - because of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { useHostDiscoverySettled } from "@/hooks/host/use-host-discovery-settled";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { setMobileApp } from "@/lib/mobile-app";

// Narration DETAIL, and mounting its query would put a host round-trip between
// these fixtures and the one thing they are about.
vi.mock("@/hooks/host/use-host-provisioning-progress", () => ({
  useHostProvisioningProgress: () => null,
}));

/**
 * The binding seam, in the shape the two hooks under this tree narrow it to:
 * `binding?.directory`, and nothing else.
 *
 * Replacing `useHostBinding` rather than providing a real `HostRuntimeContext`
 * value is what keeps the fixture honest without a cast: a genuine binding
 * carries a client, a messenger and a registry that nothing here touches, and
 * asserting one into existence would be a much larger surface to keep in step
 * than the two methods this actually needs. The hook under test still runs its
 * OWN logic - the subscribe, the re-read, the null-binding arm.
 */
const mocks = vi.hoisted(() => ({
  directory: null as {
    hasConcludedDiscovery(): boolean;
    getLocalHostId(): string | null;
    onChange(listener: () => void): { dispose: () => void };
  } | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () =>
      mocks.directory === null ? null : { directory: mocks.directory },
  };
});

const REMOTE_HOST_ID = "remote-host";

/**
 * The directory as this hook uses it: a concluded attempt, and the change
 * stream that announces one.
 *
 * Deliberately NOT the real `HostDirectoryService`. Standing one up needs a
 * fetcher, an auth era and a poll timer, none of which this hook can see - it
 * reads one predicate and one subscription - so a full service would test the
 * service's own commit rules a second time while telling us nothing new about
 * the hook. What the fake must keep honest is the ORDER: `hasConcludedDiscovery()`
 * is re-read on every emit, never cached from the first read. That a FAILED
 * fetch also counts as a conclusion is the service's own rule, pinned against
 * the real service in `host-directory-service.test.ts`.
 */
class FakeDirectory {
  private concluded = false;
  private readonly listeners = new Set<() => void>();

  hasConcludedDiscovery(): boolean {
    return this.concluded;
  }

  /**
   * `useReactiveLocalHostId` reads the same binding from the same tree, so this
   * fake has to answer it too. Null is the truthful answer for the shell these
   * cases describe: a phone has no local machine.
   */
  getLocalHostId(): string | null {
    return null;
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * An attempt FINISHED - a committed listing empty or not, or a failed fetch.
   * Both are conclusions, which is the flag's own definition.
   */
  settle(): void {
    this.concluded = true;
    this.emit();
  }

  /** A `signed-out` outcome, or the foreign-identity drop: the answer is withdrawn. */
  withdraw(): void {
    this.concluded = false;
    this.emit();
  }

  /**
   * An emit that changes NOTHING about settlement - the 60s poll landing on a
   * byte-identical fleet. The hook must survive it, and must not read it as an
   * answer.
   */
  emit(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

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
 * A LAUNCH: the gate is blocking on a narrator-owned kind, so it draws no card
 * of its own and the words are the narrator's. Modelling this as `ready` would
 * put these cases against the post-latch dialog instead of the launch card.
 */
const GATE_BLOCKING: SurfaceReadiness = { kind: "loading-host" };

const LAUNCH_CONTROLLER: HostReadinessController = {
  readinessFor: () => GATE_BLOCKING,
  defaultHostPresentation: EMPTY_PRESENTATION,
  hasBeenDefaultHostReady: false,
};

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

function renderNarrator(): void {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    // The phone: nothing local to be "starting", which is what sends ∅ down
    // the `no-usable-host` arm instead of the cold-start grace, and therefore
    // what made the unanswered launch narrate a failure.
    hasLocalHost: false,
    traycerCli: null,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider value={LAUNCH_CONTROLLER}>
          <WindowHostModalHost bypassed={false} />
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function narratorSurface(): HTMLElement | null {
  return (
    screen.queryByTestId("window-host-modal") ??
    screen.queryByTestId("window-host-startup-card")
  );
}

beforeEach(() => {
  mocks.directory = new FakeDirectory();
  setMobileApp(true);
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  mocks.directory = null;
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.setState({ status: "signed-out" });
  setMobileApp(false);
});

/** The fixture's own directory, as the hook under test will see it. */
function directoryUnderTest(): FakeDirectory {
  const directory = mocks.directory;
  if (!(directory instanceof FakeDirectory)) {
    throw new Error("the fixture's directory was not installed");
  }
  return directory;
}

describe("useHostDiscoverySettled", () => {
  it("is false with no binding - an absent directory is not an answer", () => {
    mocks.directory = null;
    const { result } = renderHook(() => useHostDiscoverySettled());
    expect(result.current).toBe(false);
  });

  it("re-reads the flag on every directory emit, not once at subscribe time", async () => {
    const directory = directoryUnderTest();
    const { result } = renderHook(() => useHostDiscoverySettled());
    expect(result.current).toBe(false);

    // An emit that changes nothing about settlement - the poll tick. Reading
    // the flag here is what a rows-keyed derivation would skip.
    act(() => {
      directory.emit();
    });
    expect(result.current).toBe(false);

    act(() => {
      directory.settle();
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    // WITHDRAWN, which is the half that makes this not a latch: a `signed-out`
    // outcome un-observes the listing, and the wait has to re-arm with it.
    act(() => {
      directory.withdraw();
    });
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });
});

describe("the narrator across the launch, on a shell with no local host", () => {
  it("says nothing about ∅ until discovery answers, then narrates it unchanged", async () => {
    const directory = directoryUnderTest();
    // The launch frame: the kernel has attached, and its lease list is empty
    // because nothing has asked the registry yet.
    applySnapshot({ attached: true, effectiveHostId: null, leases: [] });
    renderNarrator();

    // THE FIX: no failure card over an unanswered fleet.
    await waitFor(() => {
      expect(narratorSurface()).toBeNull();
    });

    // THE CONTROL, and the discriminating half of the pair: the same ∅, the
    // same empty lease list, differing only in that the registry has now
    // answered - and the verdict is today's, unchanged.
    act(() => {
      directory.settle();
    });
    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(screen.getByText("No host is available")).toBeTruthy();
  });

  it("does not wait once the authority has named a host, whatever the directory has said", async () => {
    // The fleet answered the AUTHORITY first (on the phone the two are separate
    // reads). A window that has been given a host is not waiting for anything,
    // so the cold-start story is the narrator's to tell.
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [
        {
          hostId: REMOTE_HOST_ID,
          status: "connecting",
          dead: null,
        },
      ],
    });
    renderNarrator();

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(screen.queryByText("No host is available")).toBeNull();
  });
});
