import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  defaultScheduler,
  notifyManager,
  type Query,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentPersonalHold } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHistoryResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { HostOverviewSettingsCard } from "@/components/settings/panels/host-overview-settings-card";
import { PERSONAL_HOLD_TEXT } from "@/components/settings/panels/personal-hold-text";
import { NO_RECEIPT } from "@/components/settings/panels/__tests__/ownership-receipt-fixture";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  personalPoolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: (hostId: string | null) =>
    requireTeamHostClient().createRequesterForHostId(hostId),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

beforeAll(() => settleProcessHostRpcTierPlan(poolEntry));
beforeEach(() => {
  notifyManager.setScheduler((notify) => notify());
  useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
  useAuthStore.setState({
    contextMetadata: { userId: "user-me", username: "me" },
  });
  for (const host of [mockLocalHostEntry, mockRemoteHostEntry]) {
    recordNegotiatedHostManifest(host.hostId, {
      "environment.status": { major: 1, minor: 4 },
      "environment.move.stopPreview": { major: 1, minor: 0 },
      "environment.move.stop": { major: 1, minor: 0 },
    });
  }
  recordNegotiatedHostManifest(POOL_HOST_ID, {
    "environment.binding.read": { major: 1, minor: 0 },
  });
});
afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useAuthStore.setState({ contextMetadata: null });
  useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
  notifyManager.setScheduler(defaultScheduler);
});

function querySettled(
  harness: TeamPageHarness,
  method: string,
  status: "success" | "error",
): Promise<void> {
  const cache = harness.queryClient.getQueryCache();
  const finished = (query: Query): boolean =>
    (query.meta?.hostRpcMethod === method ||
      (method === "settings-details" && query.queryKey[0] === method)) &&
    query.state.status === status &&
    query.state.fetchStatus === "idle";
  if (cache.getAll().some(finished)) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = cache.subscribe((event) => {
      // Looked up by hash for a typed query: the event's own query is `any`.
      const query = cache.get(event.query.queryHash);
      if (query === undefined || !finished(query)) return;
      unsubscribe();
      resolve();
    });
  });
}

describe("a named computer's held row through real Details", () => {
  it.each(["unconfirmed", "refused"] as const)(
    "uses the row's computer for the binding, late history and Stop controls while %s",
    async (cause) => {
      const response = Promise.withResolvers<EnvironmentHistoryResponse>();
      const requested = Promise.withResolvers<void>();
      const historyRequests: unknown[] = [];
      const binding: EnvironmentHostBinding = {
        hostId: mockRemoteHostEntry.hostId,
        environment: {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: "user-me",
          roomId: "room-personal",
          label: "Personal",
        },
        explicit: false,
        enrolledByUserId: null,
        canUnbind: false,
      };
      const harness = mountTeamPageOnPoolBuild(personalPoolSource(), {
        "environment.binding.read": (request) => ({
          ...binding,
          hostId: request.hostId,
        }),
        "environment.history": (request) => {
          historyRequests.push(request);
          requested.resolve();
          return response.promise;
        },
        "environment.move.stopPreview": () => {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "Connect this computer before stopping sharing.",
            requestId: "held-stop-preview",
            method: "environment.move.stopPreview",
            fatalDetails: null,
          });
        },
      });
      const row = (personalHold: EnvironmentPersonalHold): ReactNode => (
        <HostOverviewSettingsCard
          client={requireViewingHostClient()}
          hostId={mockRemoteHostEntry.hostId}
          hostName={mockRemoteHostEntry.label}
          status={environmentStatusFixture({ personalHold })}
          binding={binding}
          owner={{ kind: "user", id: "user-me" }}
          isLocalMachine={false}
          receipt={NO_RECEIPT}
        />
      );
      const bindingReady = querySettled(
        harness,
        "environment.binding.read",
        "success",
      );
      const view = render(row(cause), { wrapper: harness.Wrapper });
      await act(async () => {
        await bindingReady;
      });
      const delivered = querySettled(harness, "settings-details", "success");

      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      await act(async () => {
        await requested.promise;
      });
      const drawer = screen.getByRole("dialog", { name: "Settings" });
      expect(within(drawer).getByText(PERSONAL_HOLD_TEXT[cause])).toBeTruthy();

      await act(async () => {
        response.resolve({
          readerScope: "full",
          entries: [],
          hostStates: [
            {
              hostId: mockRemoteHostEntry.hostId,
              hostName: mockRemoteHostEntry.label,
              state: "applied",
              reason: null,
              at: null,
              lastReportedAt: null,
            },
          ],
        });
        await delivered;
      });

      expect(harness.paramsOf("environment.binding.read")).toEqual([
        { hostId: mockRemoteHostEntry.hostId },
      ]);
      expect(hostIdsOf(harness, "environment.binding.read")).toEqual([
        POOL_HOST_ID,
      ]);
      expect(historyRequests).toMatchObject([
        {
          environmentId: "env-personal",
          subject: { kind: "host_settings", key: mockRemoteHostEntry.hostId },
        },
      ]);
      expect(within(drawer).queryByText("Applied on 1 host")).toBeNull();
      expect(within(drawer).queryByText("Applied", { exact: true })).toBeNull();
      expect(within(drawer).getByText(PERSONAL_HOLD_TEXT[cause])).toBeTruthy();
      expect(within(drawer).getByRole("tab", { name: "History" })).toBeTruthy();
      expect(
        within(drawer).getByRole("tab", { name: "Export diagnostics" }),
      ).toBeTruthy();
      expect(
        within(drawer)
          .getByTestId("overview-stop-sharing")
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(harness.paramsOf("environment.move.stopPreview")).toEqual([]);
      expect(
        harness.cloudRequests.every((request) => request.method === "GET"),
      ).toBe(true);
      expect(harness.messenger.calls.map((call) => call.method)).toEqual([
        "environment.binding.read",
      ]);

      view.rerender(row("none"));
      expect(within(drawer).getByText("Applied on 1 host")).toBeTruthy();
      const hostRow = within(drawer)
        .getByText(mockRemoteHostEntry.label)
        .closest("li");
      if (hostRow === null)
        throw new Error("The named host has no Details row");
      expect(
        within(hostRow).getByText("Applied", { exact: true }),
      ).toBeTruthy();
      view.rerender(row(cause));
      expect(within(drawer).queryByText("Applied on 1 host")).toBeNull();
      expect(within(drawer).queryByText("Applied", { exact: true })).toBeNull();
      expect(within(drawer).getByText(PERSONAL_HOLD_TEXT[cause])).toBeTruthy();

      const preview = querySettled(
        harness,
        "environment.move.stopPreview",
        "error",
      );
      fireEvent.click(within(drawer).getByTestId("overview-stop-sharing"));
      await act(async () => {
        await preview;
      });
      expect(hostIdsOf(harness, "environment.move.stopPreview")).toEqual([
        mockRemoteHostEntry.hostId,
      ]);
    },
  );
});
