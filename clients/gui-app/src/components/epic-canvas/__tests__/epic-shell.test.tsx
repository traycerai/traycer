import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
  EpicSessionPresentationContext,
  type EpicSessionPresentation,
} from "@/lib/registries/epic-session-registry";

const hostClient = {
  getActiveHostId: () => "host-test",
  getActiveHost: () => null,
  getRequestContextUserId: () => null,
  onChange: () => () => undefined,
  request: vi.fn(() => Promise.resolve({ tasks: [], hasMore: false })),
};

const authService = {
  revalidateCurrentContext: vi.fn(() => Promise.resolve({ kind: "valid" })),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => hostClient,
  useHostBinding: () => ({ hostClient }),
  useAuthService: () => authService,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-test",
}));

// `EpicSessionProvider` opens its own durable transport via this factory, but
// the test installs an `__setEpicStreamClientFactoryForTests` override that
// short-circuits before `openTransport` runs - so a stable stub opener that is
// never invoked lets the provider mount without the full host runtime.
const openTransportStub = vi.hoisted(() => () => {
  throw new Error("openTransport must not be called in this test");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    data: undefined,
    variables: undefined,
  }),
}));

vi.mock("@/components/epic-canvas/panels/epic-connection-pill", () => ({
  EpicConnectionPill: () => <div data-testid="epic-connection-pill" />,
}));

vi.mock("@/components/epic-canvas/panels/epic-connection-toasts", () => ({
  EpicConnectionToasts: () => null,
}));

vi.mock("@/components/epic-canvas/canvas/tile-canvas", () => ({
  TileCanvas: () => <div data-testid="tile-canvas-stub" />,
}));

interface ControlledStream {
  readonly callbacks: EpicStreamCallbacks;
  closeCount: number;
}

const EPIC_ID = "epic-shell";
const TAB_ID = "epic-shell-tab";

function buildMeta(
  title: string,
  permissionRole: PermissionRole | null,
): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight:
      permissionRole === null
        ? null
        : {
            id: EPIC_ID,
            title,
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "open",
            createdAt: 0,
            updatedAt: 0,
            createdBy: "u",
            version: "1",
          },
    permissionRole,
    repos: [
      {
        task: null,
        repoIdentifier: { owner: "traycer", repo: "cached-repo" },
        createdAt: 0,
        createdBy: "u",
      },
    ],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function buildSnapshot(title: string): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap("epic");
  epic.set("title", title);
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(donor);
}

function installControlledFactory(): {
  readonly streams: () => ReadonlyArray<ControlledStream>;
} {
  const streams: ControlledStream[] = [];
  __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
    const stream: ControlledStream = {
      callbacks,
      closeCount: 0,
    };
    streams.push(stream);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        stream.closeCount += 1;
      },
    };
  });
  return {
    streams: () => streams,
  };
}

function renderShell(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
          <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
        </EpicSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * `EpicSessionProvider` provides its OWN `EpicSessionPresentationContext`
 * value internally, wrapped around its children (between the real
 * `EpicSessionContext.Provider` and whatever is passed in) - so overriding
 * the presentation for a test means re-providing the context BETWEEN the
 * provider and `EpicShell`, not around the provider itself: the nearer
 * provider to the consumer wins. This keeps `EpicSessionContext` (and
 * therefore `useMaybeOpenEpicHandle()`) driven by the real provider/registry
 * machinery - a genuine session handle - while letting the test dictate the
 * `failed` / `ready` shape `EpicShell` reads via `use(...)`.
 */
function renderShellWithPresentation(
  queryClient: QueryClient,
  presentation: EpicSessionPresentation,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
          <EpicSessionPresentationContext.Provider value={presentation}>
            <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
          </EpicSessionPresentationContext.Provider>
        </EpicSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function buildPresentation(state: {
  readonly kind: EpicSessionPresentation["kind"];
  readonly targetHostId: string | null;
  readonly originalHostId: string | null;
}): EpicSessionPresentation {
  return {
    ...state,
    retry: vi.fn(),
    openOnOriginalHost: vi.fn(),
  };
}

/**
 * `data-session-ready` on the shell root is computed from
 * `useMaybeOpenEpicHandle() !== null` directly in `EpicShell`, ABOVE and
 * OUTSIDE `EpicSessionGate` - so it flips to `"true"` in the exact same
 * commit that the gate resolves to its children arm, regardless of which
 * component that arm goes on to render. That independence is deliberate:
 * `epic-connection-pill` (the readiness signal the pre-existing tests in this
 * file use) only renders from INSIDE `EpicShellSessionBody`, which is exactly
 * the component the `failed`-presentation defect swapped out - so gating on
 * the pill there would time out on the very regression this suite exists to
 * catch, never reaching the canvas-survival assertion at all.
 */
async function waitForSessionReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("epic-shell").dataset.sessionReady).toBe("true");
  });
}

describe("<EpicShell />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
  });

  it("renders the stable shell frame while the session is not ready", () => {
    render(<EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />);

    const shell = screen.getByTestId("epic-shell");
    const canvas = screen.getByTestId("tile-canvas-loading");
    expect(shell.dataset.sessionReady).toBe("false");
    expect(shell.className).not.toContain("rounded-r-lg");
    expect(canvas.className).not.toContain("rounded-t-lg");
    expect(screen.queryByTestId("epic-session-loading")).toBeNull();
  });

  it("is canvas-only: the sidebar is hoisted out of the keep-alive pane", () => {
    render(<EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />);

    expect(screen.queryByTestId("epic-sidebar")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-rail")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-column")).toBeNull();
  });

  it("omits the duplicated epic title from the shell header once the snapshot arrives", async () => {
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Live Epic", "editor"),
        buildSnapshot("Live Epic"),
      );

    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-shell-title")).toBeNull();
    expect(screen.queryByText("Live Epic")).toBeNull();

    queryClient.clear();
  });

  it("keeps the connection pill visible without a snapshot while withholding title content", async () => {
    installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    // The session handle publishes on a MICROTASK - `EpicSessionProvider` must
    // not hand it to consumers inside the commit that acquired it - so the pill
    // arrives one tick after render rather than synchronously. The title
    // content, gated on a snapshot that never comes, must never arrive at all;
    // asserting its absence AFTER the pill settles is the stronger order.
    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-shell-title-skeleton")).toBeNull();
    expect(screen.queryByText(EPIC_ID)).toBeNull();

    queryClient.clear();
  });

  it("keeps the open-in-editor control out of the shell header", async () => {
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Epic With Folder", "editor"),
        buildSnapshot("Epic With Folder"),
      );

    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-open-button")).toBeNull();

    queryClient.clear();
  });

  it("no longer renders an in-place access-lost banner on revoke (eject is coordinator-owned)", async () => {
    const controlled = installControlledFactory();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: 60_000,
        },
      },
    });

    renderShell(queryClient);

    controlled.streams()[0].callbacks.onConnectionStatus("open", null);
    controlled
      .streams()[0]
      .callbacks.onSnapshot(
        buildMeta("Hidden Epic", "editor"),
        buildSnapshot("Hidden Epic"),
      );
    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });

    controlled.streams()[0].callbacks.onPermissionChanged(null);

    // The shell does not swap in a banner/pill on revoke anymore -
    // EpicAccessCoordinator (mounted app-level, not in this isolated test)
    // force-closes the tab instead. The body keeps rendering until then.
    await waitFor(() => {
      expect(screen.getByTestId("epic-connection-pill")).not.toBeNull();
    });
    expect(screen.queryByTestId("epic-access-lost")).toBeNull();
    expect(screen.queryByTestId("epic-access-lost-pill")).toBeNull();

    queryClient.clear();
  });

  describe("EpicSessionGate resolved arm: `failed` presentation over a live session", () => {
    // The two arms below cover the two shapes `kind: "failed"` arrives in -
    // a null `targetHostId` (the ∅-host arm) and a named one (the
    // establishing-deadline arm). Which condition in `epic-session-provider.tsx`
    // produces which is NOT this suite's concern - established there, by
    // reading `presentGap` and the `deadline` callback in the acquire effect.
    // This suite only asserts on what `EpicShell` RENDERS for each shape, and
    // both shapes must render identically: neither trigger disposes the
    // current session (see the doc comment at `EpicShell`'s `EpicSessionGate`
    // call site), so the gate stays resolved through both and the body below
    // still has a session to render.

    it("positive control: a `ready` presentation renders the canvas with no failure card - proves the harness reaches the gate's resolved arm and can render a canvas at all", async () => {
      installControlledFactory();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 60_000,
          },
        },
      });

      renderShellWithPresentation(
        queryClient,
        buildPresentation({
          kind: "ready",
          targetHostId: "host-a",
          originalHostId: null,
        }),
      );

      // Proves the harness actually reaches the gate's resolved arm and can
      // render a canvas at all - without this, the survival assertions in
      // the two arms below could be passing against a tree that never had a
      // canvas to begin with.
      await waitForSessionReady();

      expect(screen.queryByTestId("tile-canvas-stub")).not.toBeNull();
      expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();

      queryClient.clear();
    });

    it("the ∅-host failure trigger keeps the canvas mounted, read-only, under the failure card", async () => {
      installControlledFactory();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 60_000,
          },
        },
      });

      renderShellWithPresentation(
        queryClient,
        buildPresentation({
          kind: "failed",
          targetHostId: null,
          originalHostId: "host-a",
        }),
      );

      await waitForSessionReady();

      // THE FINDING: the canvas survived the failure. Asserting only that the
      // failure card is shown (below) is precisely the trap this arm exists
      // to avoid - that assertion alone passes on the unfixed tree, which
      // rendered `EpicRepointFailure` INSTEAD OF the session body and
      // unmounted `TileCanvas` (and every tile with it) in the process.
      const canvasSurvivedTheFailure = screen.queryByTestId("tile-canvas-stub");
      expect(canvasSurvivedTheFailure).not.toBeNull();

      expect(screen.queryByTestId("epic-repoint-failure")).not.toBeNull();

      const canvasWrapper = screen
        .getByTestId("tile-canvas-stub")
        .closest("[data-epic-repoint-read-only]");
      expect(canvasWrapper?.getAttribute("data-epic-repoint-read-only")).toBe(
        "true",
      );

      queryClient.clear();
    });

    it("the establishing-deadline failure trigger (a named, merely-slow target) also keeps the canvas mounted, read-only", async () => {
      installControlledFactory();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 60_000,
          },
        },
      });

      renderShellWithPresentation(
        queryClient,
        buildPresentation({
          kind: "failed",
          targetHostId: "host-b",
          originalHostId: "host-a",
        }),
      );

      await waitForSessionReady();

      // THE FINDING, same as the ∅-host arm above: the canvas survived the
      // failure even though this trigger names a target host (a re-point that
      // was merely slow - nothing is necessarily wrong with the session).
      const canvasSurvivedTheFailure = screen.queryByTestId("tile-canvas-stub");
      expect(canvasSurvivedTheFailure).not.toBeNull();

      expect(screen.queryByTestId("epic-repoint-failure")).not.toBeNull();

      const canvasWrapper = screen
        .getByTestId("tile-canvas-stub")
        .closest("[data-epic-repoint-read-only]");
      expect(canvasWrapper?.getAttribute("data-epic-repoint-read-only")).toBe(
        "true",
      );

      queryClient.clear();
    });
  });
});
