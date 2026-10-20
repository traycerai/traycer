import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostListItem,
  HostOwnerPrincipal,
  HostProfile,
  HostSandboxState,
} from "@traycer/protocol/host/host-status";
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
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTeamWakeConfirmStore } from "@/stores/hosts/team-wake-confirm-store";

const HOST_ID = "host-sbx-1";
const VIEWER = "user-viewer";
const TEAM: HostOwnerPrincipal = { kind: "team", id: "team-a", name: "Alpha" };

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
  useSandboxList: () => ({
    data: mocks.list,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => ({ sandboxControlUnavailableReason: null }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));

import { SandboxTileStateFrame } from "@/components/hosts/sandbox-tile-state-frame";
import { TeamWakeConfirmDialogHost } from "@/components/hosts/team-wake-confirm-dialog";

/**
 * The tile overlay's Resume or Start on a TEAM sandbox asks before it bills
 * the opener; a team pod and a personal sandbox do not ask. A frozen team
 * sandbox's overlay names whose bundle is out.
 */

/** The registry row as the host list reports it, `owner` included. */
function setEntry(input: {
  readonly state: HostSandboxState;
  readonly frozen: boolean;
  readonly owner: HostOwnerPrincipal | undefined;
  readonly profile: HostProfile;
  readonly summary: Partial<SandboxSummary>;
}): void {
  const item: HostListItem = {
    hostId: HOST_ID,
    displayName: "build-box",
    platform: "linux",
    kind: "sandbox",
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
    sandboxState: input.state,
    sandboxFrozen: input.frozen,
    profile: input.profile,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  };
  mocks.entry = hostListItemToDirectoryEntry(item, "wss://relay.example.test");
  mocks.list = {
    sandboxes: [
      sandboxSummaryFixture({
        id: "sbx_1",
        hostId: HOST_ID,
        state: input.state,
        frozen: input.frozen,
        ...input.summary,
      }),
    ],
  };
}

function renderFrame(): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxTileStateFrame chat={null}>
        <textarea data-testid="tile-body" />
      </SandboxTileStateFrame>
      <TeamWakeConfirmDialogHost />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.entry = null;
  mocks.list = null;
  useTeamWakeConfirmStore.setState({ pending: null });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "viewer" },
  });
});
afterEach(() => {
  cleanup();
  useTeamWakeConfirmStore.setState({ pending: null });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("<SandboxTileStateFrame /> wake on a team sandbox", () => {
  it("opens the confirm on Resume and calls no verb until Resume is pressed", async () => {
    setEntry({
      state: "suspended",
      frozen: false,
      owner: TEAM,
      profile: "agent",
      summary: {},
    });
    renderFrame();

    fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));

    const dialog = await screen.findByTestId("team-wake-confirm");
    expect(dialog.textContent).toContain(
      "Opening this resumes it on your bundle.",
    );
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("team-wake-confirm-resume"));
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "resume",
        expect.any(Number),
      );
    });
  });

  it("calls nothing on Cancel", async () => {
    setEntry({
      state: "suspended",
      frozen: false,
      owner: TEAM,
      profile: "agent",
      summary: {},
    });
    renderFrame();

    fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));
    await screen.findByTestId("team-wake-confirm");
    fireEvent.click(screen.getByTestId("team-wake-confirm-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
    });
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("asks before Start of a stopped team sandbox too", async () => {
    setEntry({
      state: "stopped",
      frozen: false,
      owner: TEAM,
      profile: "agent",
      summary: {},
    });
    renderFrame();

    fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));
    await screen.findByTestId("team-wake-confirm");
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("does not ask for a team pod: Start calls the verb at once", async () => {
    setEntry({
      state: "released",
      frozen: false,
      owner: TEAM,
      profile: "automation",
      summary: { kind: "automation" },
    });
    renderFrame();

    fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "start",
        expect.any(Number),
      );
    });
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });

  it("does not ask for a sandbox the person owns", async () => {
    for (const owner of [undefined, { kind: "user", id: VIEWER } as const]) {
      setEntry({
        state: "suspended",
        frozen: false,
        owner,
        profile: "agent",
        summary: {},
      });
      renderFrame();

      fireEvent.click(screen.getByTestId("sandbox-tile-overlay-wake"));

      await waitFor(() => {
        expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
      cleanup();
      mocks.binding = createFakeSandboxBinding();
    }
  });
});

describe("<SandboxTileStateFrame /> frozen team sandbox", () => {
  const ADA = { userId: "user-ada", displayName: "Ada Lovelace" };

  it("names whose bundle is out instead of the personal credits line, and offers no wake", () => {
    setEntry({
      state: "suspended",
      frozen: true,
      owner: TEAM,
      profile: "agent",
      summary: { wakePayer: ADA },
    });
    renderFrame();

    const overlay = screen.getByTestId("sandbox-tile-overlay");
    expect(overlay.getAttribute("data-kind")).toBe("frozen");
    expect(overlay.textContent).toBe("Frozen: Ada Lovelace's bundle is out.");
    expect(screen.queryByTestId("sandbox-tile-overlay-wake")).toBeNull();
  });

  it("adds the destroy day when the server sends frozenAt", () => {
    setEntry({
      state: "suspended",
      frozen: true,
      owner: TEAM,
      profile: "agent",
      summary: { wakePayer: ADA, frozenAt: new Date(2026, 8, 1, 12).getTime() },
    });
    renderFrame();
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toMatch(
      /^Frozen: Ada Lovelace's bundle is out\. Destroyed on /,
    );
  });

  it("keeps the personal credits line on a personal frozen sandbox", () => {
    setEntry({
      state: "suspended",
      frozen: true,
      owner: undefined,
      profile: "agent",
      summary: { wakePayer: ADA },
    });
    renderFrame();
    expect(screen.getByTestId("sandbox-tile-overlay").textContent).toBe(
      "Frozen: out of credits. Top up to resume.",
    );
  });
});
