import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import {
  defaultScheduler,
  focusManager,
  notifyManager,
} from "@tanstack/react-query";
import {
  afterEach,
  assert,
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
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  environmentStatusResponseSchemaV14,
  type EnvironmentPersonalHold,
  type EnvironmentStatusResponseV14,
} from "@traycer/protocol/host/environment-schemas";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import { PERSONAL_HOLD_TEXT } from "@/components/settings/panels/personal-hold-text";
import { NO_RECEIPT } from "@/components/settings/panels/__tests__/ownership-receipt-fixture";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  mountTeamPageOnPoolBuild,
  personalPoolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
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

const REFUSAL = "Couldn't read this computer's settings. Try again.";
const PREVIOUS_PICK: EnvironmentPick = {
  kind: "local",
  hostId: "another-host",
  hostName: "Other computer",
};
const PERSONAL_PROOF = {
  environmentId: "env-personal",
  bindingGeneration: 1,
  sharingGeneration: 2,
};

interface ReachablePair {
  readonly label: string;
  readonly hold: Exclude<EnvironmentPersonalHold, "none">;
  readonly ownership: NonNullable<EnvironmentStatusResponseV14["ownership"]>;
}

const PAIRS: readonly ReachablePair[] = [
  {
    label: "a pending Personal arrival before an unreadable ledger opens",
    hold: "unconfirmed",
    ownership: {
      kind: "unreadable",
      personalBinding: PERSONAL_PROOF,
      unbound: false,
    },
  },
  {
    label:
      "an old-run unbound reply while the newer run retains pending Personal",
    hold: "unconfirmed",
    ownership: { kind: "unreadable", personalBinding: null, unbound: true },
  },
  {
    label: "a current unbound reply over a retained Personal residual",
    hold: "refused",
    ownership: { kind: "unreadable", personalBinding: null, unbound: true },
  },
  {
    label:
      "an unavailable reply after Personal refusal clears the unbound flag",
    hold: "refused",
    ownership: { kind: "unreadable", personalBinding: null, unbound: false },
  },
];

beforeAll(() => settleProcessHostRpcTierPlan(poolEntry));
beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  notifyManager.setScheduler((notify) => notify());
  useAuthStore.setState({
    contextMetadata: { userId: "user-me", username: "me" },
  });
  useSettingsEnvironmentPickStore.setState({ pick: PREVIOUS_PICK });
  for (const host of [mockLocalHostEntry, mockRemoteHostEntry]) {
    recordNegotiatedHostManifest(host.hostId, {
      "environment.status": { major: 1, minor: 4 },
      "environment.setup.retry": { major: 1, minor: 0 },
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
  useSettingsEnvironmentPickStore.setState({ pick: PREVIOUS_PICK });
  notifyManager.setScheduler(defaultScheduler);
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("ownership before a current-owner Personal hold", () => {
  it.each(PAIRS)(
    "keeps the existing Gate row for $label, then reads the live hold without a user step",
    async ({ hold, ownership }) => {
      const initial = Promise.withResolvers<EnvironmentStatusResponseV14>();
      const readable = Promise.withResolvers<EnvironmentStatusResponseV14>();
      const readableHold = hold === "unconfirmed" ? "refused" : "unconfirmed";
      let answer = environmentStatusFixture({
        ownership,
        personalHold: hold,
        principal: null,
      });
      const harness = mountTeamPageOnPoolBuild(personalPoolSource(), {
        "environment.status": () => answer,
        "environment.binding.read": (request) => ({
          hostId: request.hostId,
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
        }),
      });
      const stopWatching = harness.queryClient
        .getQueryCache()
        .subscribe((event) => {
          if (
            event.type !== "updated" ||
            event.action.type !== "success" ||
            event.query.meta?.hostRpcMethod !== "environment.status"
          )
            return;
          const parsed = environmentStatusResponseSchemaV14.safeParse(
            event.query.state.data,
          );
          if (!parsed.success) return;
          if (
            parsed.data.ownership !== null &&
            parsed.data.personalHold === hold
          )
            initial.resolve(parsed.data);
          if (
            parsed.data.ownership === null &&
            parsed.data.personalHold === readableHold
          )
            readable.resolve(parsed.data);
        });
      try {
        render(
          <HostOverviewSettingsCardSlot
            client={requireViewingHostClient()}
            hostId={mockRemoteHostEntry.hostId}
            hostName={mockRemoteHostEntry.label}
            usable
            owner={{ kind: "user", id: "user-me" }}
            isLocalMachine={false}
            receipt={NO_RECEIPT}
            onReturn={() => undefined}
          />,
          { wrapper: harness.Wrapper },
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
          expect(await initial.promise).toEqual(answer);
        });

        expect(screen.queryByTestId("host-settings-personal-hold")).toBeNull();
        expect(screen.queryByText(PERSONAL_HOLD_TEXT[hold])).toBeNull();
        expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
        if (ownership.unbound) {
          expect(
            screen.getByText("Runs its own settings, not in Personal yet"),
          ).toBeTruthy();
          expect(screen.queryByText(REFUSAL)).toBeNull();
          expect(
            within(
              screen.getByRole("combobox", { name: "Environment" }),
            ).getByText(mockRemoteHostEntry.label),
          ).toBeTruthy();
          expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
        } else {
          expect(screen.getByText(REFUSAL)).toBeTruthy();
          expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
          expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
          if (ownership.personalBinding === null) {
            expect(
              screen.queryByRole("combobox", { name: "Environment" }),
            ).toBeNull();
          } else {
            const source = screen.getByRole("combobox", {
              name: "Environment",
            });
            expect(within(source).getByText("Personal")).toBeTruthy();
            expect(source.hasAttribute("disabled")).toBe(true);
          }
        }

        const pick = useSettingsEnvironmentPickStore.getState().pick;
        const changes: (EnvironmentPick | null)[] = [];
        const stopPick = useSettingsEnvironmentPickStore.subscribe(
          (state, previous) => {
            if (state.pick !== previous.pick) changes.push(state.pick);
          },
        );
        try {
          const nextRead =
            HOST_METHOD_POLL_TABLE["environment.status"].poll.classify(answer);
          assert(
            nextRead !== false,
            "Status must keep observing ownership recovery",
          );
          answer = environmentStatusFixture({
            ownership: null,
            personalHold: readableHold,
            principal: null,
          });
          // The existing mounted status poll observes the repaired publisher; no Retry or cache injection.
          await act(async () => {
            await vi.advanceTimersByTimeAsync(nextRead.initialDelayMs);
            expect(await readable.promise).toEqual(answer);
          });

          expect(screen.queryByText(REFUSAL)).toBeNull();
          expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
          expect(
            screen.getByTestId("host-settings-personal-hold").textContent,
          ).toBe(PERSONAL_HOLD_TEXT[readableHold]);
          expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
          expect(screen.queryByRole("status", { name: "Reading" })).toBeNull();
          const source = screen.getByRole("combobox", { name: "Environment" });
          if (readableHold === "unconfirmed") {
            expect(within(source).getByText("Personal")).toBeTruthy();
            expect(source.hasAttribute("disabled")).toBe(false);
          } else {
            expect(source.textContent).toBe(mockRemoteHostEntry.label);
            expect(source.hasAttribute("disabled")).toBe(true);
          }
          expect(changes).toEqual([]);
          expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(pick);
          expect(
            harness.messenger.calls.every(
              (call) =>
                call.method === "environment.status" ||
                call.method === "environment.binding.read",
            ),
          ).toBe(true);
          expect(
            harness.cloudRequests.every((request) => request.method === "GET"),
          ).toBe(true);
        } finally {
          stopPick();
        }
      } finally {
        stopWatching();
      }
    },
  );
});
