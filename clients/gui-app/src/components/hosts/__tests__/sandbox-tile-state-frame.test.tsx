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
  // `undefined` is a list that has not answered; `null` the suite's older
  // "no list" stand-in, which the frame reads the same way as no row.
  list: null as { sandboxes: readonly SandboxSummary[] } | null | undefined,
  listError: false,
  listFetching: false,
  listRefetch: vi.fn(),
  entryReads: vi.fn(),
  /** `IRunnerHost.sandboxControlUnavailableReason`; `null` reaches the control plane. */
  unavailableReason: null as string | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-sbx-1",
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => {
    mocks.entryReads();
    return mocks.entry;
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: mocks.list,
    isError: mocks.listError,
    isFetching: mocks.listFetching,
    refetch: mocks.listRefetch,
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => ({
    sandboxControlUnavailableReason: mocks.unavailableReason,
  }),
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

function setSandboxEntry(
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
      sandboxSummaryFixture({
        id: "sbx_1",
        hostId: HOST_ID,
        frozen,
        // A state the registry has not reported leaves the fixture's own.
        ...(state === null ? {} : { state }),
      }),
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
  mocks.listError = false;
  mocks.listFetching = false;
  mocks.listRefetch.mockClear();
  mocks.entryReads.mockClear();
  mocks.unavailableReason = null;
});
afterEach(cleanup);

describe("<SandboxTileStateFrame />", () => {
  it("returns the tile untouched, reading no directory, when there is no host runtime above it", () => {
    setSandboxEntry("suspended", false);
    mocks.binding = null;
    const { container } = renderFrame(false);

    expect(screen.getByTestId("tile-body")).toBeDefined();
    expect(container.querySelector("[data-sandbox-tile-state]")).toBeNull();
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    expect(mocks.entryReads).not.toHaveBeenCalled();
  });

  it("frames a personal host's tile live, with no overlay and a body that is not inert", () => {
    mocks.entry = hostListItemToDirectoryEntry(
      registryItem("personal"),
      "wss://relay.example.test",
    );
    const { container } = renderFrame(false);
    expect(
      container
        .querySelector("[data-sandbox-tile-state]")
        ?.getAttribute("data-sandbox-tile-state"),
    ).toBe("live");
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("tile-body")).toBeDefined();
  });

  it("frames the tile live, with no overlay, while the directory has not answered for its host", () => {
    mocks.entry = null;
    const { container } = renderFrame(false);
    expect(
      container
        .querySelector("[data-sandbox-tile-state]")
        ?.getAttribute("data-sandbox-tile-state"),
    ).toBe("live");
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("tile-body")).toBeDefined();
  });

  describe("the body survives the directory's first answer", () => {
    function answerWith(kind: "personal" | "awake" | "suspended"): void {
      if (kind === "personal") {
        mocks.entry = hostListItemToDirectoryEntry(
          registryItem("personal"),
          "wss://relay.example.test",
        );
        return;
      }
      setSandboxEntry(kind, false);
    }

    it("keeps the same body node when the entry goes from unanswered to a personal host", () => {
      mocks.entry = null;
      const { rerenderFrame } = renderFrame(false);
      const body = screen.getByTestId("tile-body");

      answerWith("personal");
      rerenderFrame();

      expect(screen.getByTestId("tile-body")).toBe(body);
      expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    });

    it("keeps the same body node when the entry goes from unanswered to an awake sandbox", () => {
      mocks.entry = null;
      const { rerenderFrame } = renderFrame(false);
      const body = screen.getByTestId("tile-body");

      answerWith("awake");
      rerenderFrame();

      expect(screen.getByTestId("tile-body")).toBe(body);
      expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
      expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    });

    it("keeps the same body node, now inert under the overlay, when the entry goes from unanswered to a suspended sandbox", () => {
      mocks.entry = null;
      const { rerenderFrame } = renderFrame(false);
      const body = screen.getByTestId("tile-body");
      expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();

      answerWith("suspended");
      rerenderFrame();

      expect(screen.getByTestId("tile-body")).toBe(body);
      expect(screen.getByTestId("sandbox-tile-overlay")).toBeDefined();
      expect(body.closest("[inert]")).not.toBeNull();
    });
  });

  it("wraps an awake sandbox's tile live: no overlay and the body is not inert", () => {
    setSandboxEntry("awake", false);
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
      setSandboxEntry(state, false);
      renderFrame(false);
      expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
      expect(bodyWrapper().hasAttribute("inert")).toBe(false);
      cleanup();
    }
  });

  it("overlays a suspended sandbox with its copy and Resume, and makes the body inert", () => {
    setSandboxEntry("suspended", false);
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
    setSandboxEntry("stopped", false);
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
      setSandboxEntry(state, false);
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
    setSandboxEntry("suspended", true);
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
    setSandboxEntry("stopped", true);
    renderFrame(false);
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toBe(
      "Frozen: out of credits. Top up to resume.",
    );
  });

  it("puts the body out of the tab order and Resume in it: Tab can reach Resume, not the terminal", () => {
    setSandboxEntry("suspended", false);
    renderFrame(false);

    const body = screen.getByTestId("tile-body");
    expect(body.closest("[inert]")).not.toBeNull();

    const resume = screen.getByTestId("sandbox-tile-overlay-wake");
    expect(resume.closest("[inert]")).toBeNull();
    resume.focus();
    expect(document.activeElement).toBe(resume);
  });

  it("wakes the sandbox through the control plane when Resume is pressed", async () => {
    setSandboxEntry("suspended", false);
    renderFrame(false);
    fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "resume",
        expect.any(Number),
      );
    });
  });

  it("offers no button while the control plane's row for this host has not answered", () => {
    setSandboxEntry("suspended", false);
    mocks.list = null;
    renderFrame(false);
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
      "Suspended",
    );
    expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
  });

  it("swaps Resume for Resuming (and Start for Starting) while the tab-open wake is in flight", async () => {
    setSandboxEntry("suspended", false);
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

    setSandboxEntry("stopped", false);
    renderFrame(true);
    fireEvent.click(screen.getByTestId("start-wake"));
    await waitFor(() => {
      expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
        "Starting",
      );
    });
  });

  it("does not swap a frozen overlay for a wake in flight", async () => {
    setSandboxEntry("suspended", true);
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
    setSandboxEntry("suspended", false);
    const { rerenderFrame } = renderFrame(false);
    const body = screen.getByTestId("tile-body");
    expect(bodyWrapper().hasAttribute("inert")).toBe(true);

    setSandboxEntry("awake", false);
    rerenderFrame();

    expect(screen.getByTestId("tile-body")).toBe(body);
    expect(bodyWrapper().hasAttribute("inert")).toBe(false);
    expect(screen.queryByTestId("sandbox-tile-overlay")).toBeNull();
  });

  describe("when the sandbox list's first read failed", () => {
    it("says it could not load the sandbox and offers a retry in place of Resume, which reads the list again", () => {
      setSandboxEntry("suspended", false);
      mocks.list = undefined;
      mocks.listError = true;
      renderFrame(false);

      expect(screen.getByTestId("sandbox-tile-overlay").textContent).toContain(
        "Couldn't load this sandbox.",
      );
      expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
      const retry = screen.getByTestId("sandbox-tile-overlay-retry-list");
      expect(retry.hasAttribute("disabled")).toBe(false);

      fireEvent.click(retry);

      expect(mocks.listRefetch).toHaveBeenCalled();
    });

    it("holds the retry while the list is being read again", () => {
      setSandboxEntry("suspended", false);
      mocks.list = undefined;
      mocks.listError = true;
      mocks.listFetching = true;
      renderFrame(false);

      expect(
        screen
          .getByTestId("sandbox-tile-overlay-retry-list")
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    it("says why in place of the retry when the build cannot reach the control plane, with no wake offered", () => {
      mocks.unavailableReason =
        "Sandboxes aren't available in the staging build.";
      setSandboxEntry("suspended", false);
      mocks.list = undefined;
      mocks.listError = true;
      renderFrame(false);

      expect(
        screen.getByTestId("sandbox-tile-overlay-unavailable").textContent,
      ).toBe("Sandboxes aren't available in the staging build.");
      expect(
        screen.queryByTestId("sandbox-tile-overlay-retry-list"),
      ).toBeNull();
      expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
      expect(
        screen.getByTestId("sandbox-tile-overlay").textContent,
      ).not.toContain("Couldn't load this sandbox.");
    });

    it("shows no unavailable line when the control plane is reachable", () => {
      setSandboxEntry("suspended", false);
      mocks.list = undefined;
      mocks.listError = true;
      renderFrame(false);

      expect(
        screen.queryByTestId("sandbox-tile-overlay-unavailable"),
      ).toBeNull();
      expect(
        screen.getByTestId("sandbox-tile-overlay-retry-list"),
      ).toBeDefined();
    });

    it("offers Resume and no retry when the list lists the row", () => {
      setSandboxEntry("suspended", false);
      renderFrame(false);

      expect(screen.getByTestId("sandbox-tile-overlay-wake")).toBeDefined();
      expect(
        screen.queryByTestId("sandbox-tile-overlay-retry-list"),
      ).toBeNull();
      expect(
        screen.getByTestId("sandbox-tile-overlay").textContent,
      ).not.toContain("Couldn't load this sandbox.");
    });

    it("offers no retry while the first read is still pending, or when a later refetch failed over a good list", () => {
      setSandboxEntry("suspended", false);
      mocks.list = undefined;
      renderFrame(false);
      expect(
        screen.queryByTestId("sandbox-tile-overlay-retry-list"),
      ).toBeNull();
      cleanup();

      // A later failure keeps the last good rows: Resume stays available.
      setSandboxEntry("suspended", false);
      mocks.listError = true;
      renderFrame(false);
      expect(
        screen.queryByTestId("sandbox-tile-overlay-retry-list"),
      ).toBeNull();
      expect(screen.getByTestId("sandbox-tile-overlay-wake")).toBeDefined();
    });
  });
});
