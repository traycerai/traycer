import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { sandboxMutationKeys } from "@/lib/query-keys";

const HOST_ID = "host-sbx-1";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  entry: null as RemoteHostDirectoryEntry | null,
  list: null as { sandboxes: readonly SandboxSummary[] } | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-sbx-1",
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: mocks.list }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));

import { SandboxTileStateFrame } from "@/components/hosts/sandbox-tile-state-frame";

function registryItem(kind: "personal" | "sandbox"): HostListItem {
  return {
    hostId: HOST_ID,
    displayName: "build-box",
    platform: "linux",
    kind,
    publicKey: "pk-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
  };
}

function useSandboxEntry(
  state: HostSandboxState | null,
  frozen: boolean,
): void {
  mocks.entry = hostListItemToDirectoryEntry(
    {
      ...registryItem("sandbox"),
      sandboxState: state,
      sandboxFrozen: frozen,
      profile: "agent",
    },
    "wss://relay.example.test",
  );
  mocks.list = {
    sandboxes: [
      sandboxSummaryFixture({ id: "sbx_1", hostId: HOST_ID, state, frozen }),
    ],
  };
}

/** A tab-open wake in flight for the host, as `useSandboxWakeForOpenedTile` runs it. */
function WakeInFlight(): ReactNode {
  const wake = useMutation({
    mutationKey: sandboxMutationKeys.wake(HOST_ID),
    mutationFn: () => new Promise<void>(() => undefined),
  });
  return (
    <button
      type="button"
      data-testid="start-wake"
      data-pending={wake.isPending ? "true" : "false"}
      onClick={() => wake.mutate()}
    >
      wake
    </button>
  );
}

function renderFrame(withWake: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  // A fresh element per call: the directory and list hooks are mocked, so an
  // identical element would let React skip the render that reads them again.
  const tree = (): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {withWake ? <WakeInFlight /> : null}
      <SandboxTileStateFrame>
        <textarea data-testid="tile-body" />
      </SandboxTileStateFrame>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerenderFrame: () => view.rerender(tree()) };
}

function bodyWrapper(): HTMLElement {
  const wrapper = screen.getByTestId("tile-body").parentElement;
  if (wrapper === null) throw new Error("the tile body has no wrapper");
  return wrapper;
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.entry = null;
  mocks.list = null;
});
afterEach(cleanup);

describe("<SandboxTileStateFrame />", () => {
  it("returns an unwrapped personal host's tile exactly as it was", () => {
    mocks.entry = hostListItemToDirectoryEntry(
      registryItem("personal"),
      "wss://relay.example.test",
    );
    const { container } = renderFrame(false);
    expect(container.querySelector("[data-sandbox-tile-state]")).toBeNull();
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("tile-body")).toBeDefined();
  });

  it("returns the tile unwrapped while the directory has not answered for its host", () => {
    mocks.entry = null;
    const { container } = renderFrame(false);
    expect(container.querySelector("[data-sandbox-tile-state]")).toBeNull();
    expect(screen.getByTestId("tile-body")).toBeDefined();
  });

  it("wraps an awake sandbox's tile live: no overlay and the body is not inert", () => {
    useSandboxEntry("awake", false);
    const { container } = renderFrame(false);
    expect(
      container
        .querySelector("[data-sandbox-tile-state]")
        ?.getAttribute("data-sandbox-tile-state"),
    ).toBe("live");
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
  });

  it("shows no overlay for the states the tile already renders itself", () => {
    for (const state of [
      "creating",
      "failed",
      "destroying",
      "destroyed",
      "released",
    ] as const) {
      useSandboxEntry(state, false);
      renderFrame(false);
      expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
      expect(bodyWrapper().hasAttribute("inert")).toBe(false);
      cleanup();
    }
  });

  it("overlays a suspended sandbox with its copy and Resume, and makes the body inert", () => {
    useSandboxEntry("suspended", false);
    renderFrame(false);

    const overlay = screen.getByTestId("sandbox-tile-overlay");
    expect(overlay.getAttribute("data-kind")).toBe("asleep");
    expect(overlay.textContent).toContain(
      "Suspended, resumes on your next action",
    );
    expect(screen.getByTestId("sandbox-tile-overlay-wake").textContent).toBe(
      "Resume",
    );
    expect(bodyWrapper().hasAttribute("inert")).toBe(true);
  });

  it("overlays a stopped sandbox with Stopped and Start", () => {
    useSandboxEntry("stopped", false);
    renderFrame(false);
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
      "Stopped",
    );
    expect(screen.getByTestId("sandbox-tile-overlay-wake").textContent).toBe(
      "Start",
    );
    expect(bodyWrapper().hasAttribute("inert")).toBe(true);
  });

  it("says Resuming or Starting with a spinner and no button while it comes back", () => {
    for (const [state, word] of [
      ["resuming", "Resuming"],
      ["starting", "Starting"],
    ] as const) {
      useSandboxEntry(state, false);
      renderFrame(false);
      const overlay = screen.getByTestId("sandbox-tile-overlay");
      expect(overlay.getAttribute("data-kind")).toBe("moving");
      expect(overlay.textContent).toContain(word);
      expect(screen.getByTestId("sandbox-tile-overlay-spinner")).toBeDefined();
      expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
      expect(bodyWrapper().hasAttribute("inert")).toBe(true);
      cleanup();
    }
  });

  it("overlays a frozen sandbox with the frozen line and its destroy date, and offers no wake", () => {
    useSandboxEntry("suspended", true);
    mocks.list = {
      sandboxes: [
        sandboxSummaryFixture({
          id: "sbx_1",
          hostId: HOST_ID,
          state: "suspended",
          frozen: true,
          frozenAt: new Date(2026, 9, 9, 12).getTime(),
        }),
      ],
    };
    renderFrame(false);
    const overlay = screen.getByTestId("sandbox-tile-overlay");
    expect(overlay.getAttribute("data-kind")).toBe("frozen");
    expect(overlay.textContent).toMatch(
      /^Frozen: out of credits\. Top up to resume\. Destroyed on /,
    );
    expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
    expect(bodyWrapper().hasAttribute("inert")).toBe(true);
  });

  it("frames a frozen row without a destroy date when the server sent no frozenAt", () => {
    useSandboxEntry("stopped", true);
    renderFrame(false);
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toBe(
      "Frozen: out of credits. Top up to resume.",
    );
  });

  it("puts the body out of the tab order and Resume in it: Tab can reach Resume, not the terminal", () => {
    useSandboxEntry("suspended", false);
    renderFrame(false);

    const body = screen.getByTestId("tile-body");
    expect(body.closest("[inert]")).not.toBeNull();

    const resume = screen.getByTestId("sandbox-tile-overlay-wake");
    expect(resume.closest("[inert]")).toBeNull();
    resume.focus();
    expect(document.activeElement).toBe(resume);
  });

  it("wakes the sandbox through the control plane when Resume is pressed", async () => {
    useSandboxEntry("suspended", false);
    renderFrame(false);
    fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "resume",
      );
    });
  });

  it("offers no button while the control plane's row for this host has not answered", () => {
    useSandboxEntry("suspended", false);
    mocks.list = null;
    renderFrame(false);
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
      "Suspended",
    );
    expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
  });

  it("swaps Resume for Resuming (and Start for Starting) while the tab-open wake is in flight", async () => {
    useSandboxEntry("suspended", false);
    renderFrame(true);
    expect(screen.getByTestId("sandbox-tile-overlay-wake")).toBeDefined();

    fireEvent.click(screen.getByTestId("start-wake"));

    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-tile-overlay").getAttribute("data-kind"),
      ).toBe("moving");
    });
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
      "Resuming",
    );
    expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
    cleanup();

    useSandboxEntry("stopped", false);
    renderFrame(true);
    fireEvent.click(screen.getByTestId("start-wake"));
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
        "Starting",
      );
    });
  });

  it("does not swap a frozen overlay for a wake in flight", async () => {
    useSandboxEntry("suspended", true);
    renderFrame(true);
    fireEvent.click(screen.getByTestId("start-wake"));
    await waitFor(() => {
      expect(
        screen.getByTestId("start-wake").getAttribute("data-pending"),
      ).toBe("true");
    });
    expect(
      screen.getByTestId("sandbox-tile-overlay").getAttribute("data-kind"),
    ).toBe("frozen");
  });

  it("toggles inert without remounting the body when the sandbox wakes", () => {
    useSandboxEntry("suspended", false);
    const { rerenderFrame } = renderFrame(false);
    const body = screen.getByTestId("tile-body");
    expect(bodyWrapper().hasAttribute("inert")).toBe(true);

    useSandboxEntry("awake", false);
    rerenderFrame();

    expect(screen.getByTestId("tile-body")).toBe(body);
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
  });
});
