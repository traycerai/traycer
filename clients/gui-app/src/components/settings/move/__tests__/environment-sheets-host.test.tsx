import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentItemStatus,
  EnvironmentReviewResponseV12,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import { EnvironmentSheetsHost } from "@/components/settings/move/environment-sheets-host";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { OpenSettingsModalOpts } from "@/stores/tabs/use-system-tab-modal";

// The host directory is the boundary: which computer this is, and the client
// that names a host id. The reads and the sheet stay real.
const directory = vi.hoisted(
  (): {
    computer: ThisComputer;
    client: HostClient<HostRpcRegistry> | null;
  } => ({
    computer: { hostId: null, hostName: "this computer", client: null },
    client: null,
  }),
);
vi.mock("@/components/settings/move/this-computer", () => ({
  useThisComputer: (): ThisComputer => directory.computer,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (): HostClient<HostRpcRegistry> | null =>
    directory.client,
}));

// The move sheet reads the host runtime this suite does not mount; the target
// the retrospective sheet hands it is what is asserted.
vi.mock("@/components/settings/move-sheet", () => ({
  MoveSheet: () => null,
}));

const SHARED = environmentStatusFixture({
  planes: { records: "shared_unrecorded", broker: "local", room: "local" },
});

function review(shownAt: number | null): EnvironmentReviewResponseV12 {
  return {
    entries: [],
    shownAt,
    acknowledgedAt: null,
    evidence: { version: "1.5.2", at: Date.UTC(2026, 9, 14, 12) },
  };
}

interface Reads {
  readonly status: number;
  readonly review: number;
  readonly recorded: string[];
}

function thisComputerAnswering(
  status: EnvironmentStatusResponseV11,
  shownAt: number | null,
): Reads {
  const reads: { status: number; review: number; recorded: string[] } = {
    status: 0,
    review: 0,
    recorded: [],
  };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => {
      reads.status += 1;
      return status;
    },
    "environment.review": () => {
      reads.review += 1;
      return review(shownAt);
    },
    "environment.review.record": (request) => {
      reads.recorded.push(request.event);
      return { outcome: "recorded" };
    },
  };
  const { client } = buildEnvironmentClient({ hostId: "old", handlers });
  recordNegotiatedHostManifest("old", {
    "environment.status": { major: 1, minor: 1 },
    "environment.review": { major: 1, minor: 2 },
    "environment.review.record": { major: 1, minor: 0 },
  });
  directory.computer = { hostId: "old", hostName: "Old laptop", client };
  directory.client = client;
  return reads;
}

function renderHost(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <EnvironmentSheetsHost />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useRetrospectiveSheetStore.setState({
    target: null,
    open: false,
    checkedHostIds: new Set(),
    heldToastDismissed: false,
  });
  useMoveSheetStore.setState({ target: null });
});

afterEach(() => {
  cleanup();
  setSystemTabModalApi(null);
  resetNegotiatedManifests();
  directory.computer = {
    hostId: null,
    hostName: "this computer",
    client: null,
  };
  directory.client = null;
});

describe("<EnvironmentSheetsHost /> show-once", () => {
  it("opens the retrospective by itself for a shared computer whose review was never shown, and records shown once", async () => {
    const reads = thisComputerAnswering(SHARED, null);
    renderHost();

    expect(await screen.findByTestId("retrospective-sheet")).toBeTruthy();
    await waitFor(() => expect(reads.recorded).toEqual(["shown"]));
    expect(useRetrospectiveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("opens nothing once the review says it was shown", async () => {
    const reads = thisComputerAnswering(SHARED, Date.UTC(2026, 9, 15, 12));
    renderHost();

    await waitFor(() =>
      expect(
        useRetrospectiveSheetStore.getState().checkedHostIds.has("old"),
      ).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("retrospective-sheet")).toBeNull();
    expect(reads.recorded).toEqual([]);
  });

  it("opens nothing for a computer with no plane shared by an earlier version", async () => {
    const reads = thisComputerAnswering(
      environmentStatusFixture({
        planes: { records: "local", broker: "local", room: "local" },
      }),
      null,
    );
    renderHost();

    await waitFor(() =>
      expect(
        useRetrospectiveSheetStore.getState().checkedHostIds.has("old"),
      ).toBe(true),
    );
    expect(screen.queryByTestId("retrospective-sheet")).toBeNull();
    expect(reads.recorded).toEqual([]);
  });
});

describe("<EnvironmentSheetsHost /> inventory links", () => {
  it("closes the sheet and asks Settings for the linked page", async () => {
    const smtpPassword: EnvironmentItemStatus = {
      kind: "secret",
      key: "NOTIFICATION_SMTP_PASSWORD",
      os: "macos",
      desiredRevision: 1,
      status: "applied",
      code: "ok",
      args: { exitStatus: null, stage: null, durationMs: null, kind: null },
      brokerEnforced: null,
      minimumHostVersion: null,
      appliedAs: null,
    };
    thisComputerAnswering(
      environmentStatusFixture({
        planes: {
          records: "shared_unrecorded",
          broker: "local",
          room: "local",
        },
        items: [smtpPassword],
      }),
      Date.UTC(2026, 9, 15, 12),
    );
    const opened: OpenSettingsModalOpts[] = [];
    setSystemTabModalApi({
      active: null,
      openSettings: (opts) => {
        opened.push(opts);
      },
      openHistory: () => undefined,
      close: () => undefined,
      setSection: () => undefined,
      promoteToTab: () => undefined,
      isOverlayActive: () => false,
    });
    renderHost();
    act(() => {
      useRetrospectiveSheetStore
        .getState()
        .openSheet({ hostId: "old", hostName: "Old laptop" });
    });

    fireEvent.click(
      await screen.findByTestId("retrospective-link-secrets:secret"),
    );

    expect(opened.map((opts) => opts.section)).toEqual(["secrets"]);
    await waitFor(() => {
      expect(useRetrospectiveSheetStore.getState().open).toBe(false);
    });
  });
});

describe("<EnvironmentSheetsHost /> hand-offs from the retrospective sheet", () => {
  function openRetrospective(): void {
    thisComputerAnswering(SHARED, Date.UTC(2026, 9, 15, 12));
    renderHost();
    act(() => {
      useRetrospectiveSheetStore
        .getState()
        .openSheet({ hostId: "old", hostName: "Old laptop" });
    });
  }

  it("Move to Personal closes the retrospective sheet and opens the move sheet", async () => {
    openRetrospective();

    fireEvent.click(
      await screen.findByTestId("retrospective-move-to-personal"),
    );

    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
    await waitFor(() => {
      expect(useRetrospectiveSheetStore.getState().open).toBe(false);
    });
  });

  it("Stop using Personal closes the retrospective sheet and shows the stop sheet", async () => {
    openRetrospective();

    fireEvent.click(await screen.findByTestId("retrospective-stop-sharing"));

    expect(await screen.findByTestId("stop-sharing-sheet")).toBeTruthy();
    await waitFor(() => {
      expect(useRetrospectiveSheetStore.getState().open).toBe(false);
    });
  });
});
