import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { LocalRowNote } from "@/components/settings/environment/local-row-note";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const HOST_ID = "old";

const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => clientMock.current,
}));

// Details opens the configuration drawer, which has its own suite.
vi.mock("@/components/settings/details/overview-card-details-line", () => ({
  OverviewCardDetailsLine: () => <button type="button">Details</button>,
}));

function renderNote(status: EnvironmentStatusResponseV11): void {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: { "environment.status": () => status },
  });
  clientMock.current = client;
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LocalRowNote />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useMoveSheetStore.setState({ target: null });
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: HOST_ID, hostName: "Old laptop" },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("<LocalRowNote />", () => {
  it("offers Move to Personal while the computer has not moved", async () => {
    renderNote(
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
    );

    const move = await screen.findByTestId("local-row-note-move");
    fireEvent.click(move);
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: HOST_ID,
      hostName: "Old laptop",
    });
  });

  it("shows the move's progress, and not Move to Personal, while the computer is moving", async () => {
    renderNote(
      environmentStatusFixture({
        // No consent while a move runs: the status serves the migration
        // MARKER's consent and the host writes that marker only once the upload
        // has finished (`traycer-host/.../migration/migrator.ts`, step 5). A
        // fixture that sets it here invites a reader to key on it.
        setup: { stage: "moving_settings", state: "running" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
        ],
      }),
    );

    const progress = await screen.findByTestId("host-settings-card-progress");
    expect(progress.textContent.replace(/\s+/g, " ")).toBe(
      "Moving this computer's settings to Personal · 1 of 2 items applied",
    );
    expect(screen.queryByTestId("local-row-note-move")).toBeNull();
    expect(screen.getByTestId("local-row-note").textContent).not.toContain(
      "not in Personal yet",
    );
  });

  it("shows no count while the move has registered no item", async () => {
    renderNote(
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "running" },
      }),
    );

    const progress = await screen.findByTestId("host-settings-card-progress");
    expect(progress.textContent.replace(/\s+/g, " ")).toBe(
      "Moving this computer's settings to Personal",
    );
  });

  it("says the move stopped, and not Move to Personal, once it stalled", async () => {
    renderNote(
      environmentStatusFixture({
        setup: { stage: "moving_settings", state: "stalled" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
        ],
      }),
    );

    const stopped = await screen.findByTestId(
      "host-settings-card-move-stopped",
    );
    expect(stopped.textContent).toBe(
      "Moving stopped: it timed out. 1 item left.",
    );
    expect(screen.queryByTestId("local-row-note-move")).toBeNull();
  });
});
