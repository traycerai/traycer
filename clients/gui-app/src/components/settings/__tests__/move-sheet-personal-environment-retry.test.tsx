import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentHostRecordV12,
} from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentMovePlanResponseV12 } from "@traycer/protocol/host/environment/move-contracts";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { MoveSheet } from "@/components/settings/move-sheet";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const HOST_ID = "old";
const ENVIRONMENT_ID = "env-personal";

const reads = vi.hoisted(
  (): {
    scope: HostScope | null;
    readonly statuses: Map<string, unknown>;
  } => ({
    scope: null,
    statuses: new Map(),
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => reads.scope,
  useHostScopeFor: () => reads.scope,
  WINDOW_HOST_SELECTION: {
    scopedHostId: null,
    setScopedHostId: () => undefined,
  },
}));
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

const personal: EnvironmentDescriptorV11 = {
  environmentId: ENVIRONMENT_ID,
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

const movePlan: EnvironmentMovePlanResponseV12 = {
  personalHoldsSecrets: false,
  itemChoices: false,
  planHash: "plan-a",
  planRevision: 1,
  hostVersion: "1.5.0",
  disclosureVersion: 1,
  rows: {
    looksLikeAKey: [],
    sameNameInPersonal: [],
    moves: [
      {
        kind: "variable",
        key: "EDITOR",
        os: null,
        label: "EDITOR",
        detail: "variable",
      },
    ],
    staysOnThisComputer: [],
    alreadyInPersonal: [],
    differsMasked: [],
  },
  guideDiffers: false,
};

const runningHost: EnvironmentHostRecordV12 = {
  hostId: "dev",
  hostLabel: "dev-box",
  hostPlatform: "darwin",
  enrolledByUserId: "user-me",
  kind: "personal",
  boundAt: 1,
  reachable: false,
  lastReportedAt: 1,
  applied: [],
  hasLocalRow: false,
};

function renderMoveSheet(): {
  readonly environmentListCalls: number[];
  readonly hostListEnvironmentIds: string[];
} {
  const environmentListCalls: number[] = [];
  const hostListEnvironmentIds: string[] = [];
  // Personal's id and its running computers are the app's own reads on the
  // sign-in; the move itself stays on the computer.
  const harness = mountTeamPage(
    { kind: "host" },
    {
      "environment.list": () => {
        environmentListCalls.push(environmentListCalls.length + 1);
        if (environmentListCalls.length === 1) {
          throw HostRpcError.fromWireEnvelope(
            { code: "INTERNAL", message: "temporary read failure" },
            "req-environments",
            "environment.list",
          );
        }
        return { environments: [personal] };
      },
      "environment.host.list": ({ environmentId }) => {
        hostListEnvironmentIds.push(environmentId);
        return { hosts: [runningHost] };
      },
      "environment.move.plan": () => movePlan,
      "environment.move.accept": () => ({
        outcome: "accepted",
        attemptId: "attempt-a",
        consentId: "consent-a",
      }),
    },
  );
  reads.scope = hostScopeFixture({ host: null, hosts: [] });
  recordNegotiatedHostMethods(HOST_ID, [
    "environment.move.plan",
    "environment.move.accept",
  ]);

  render(<MoveSheet />, { wrapper: harness.Wrapper });
  act(() => {
    useMoveSheetStore.getState().openSheet({
      hostId: HOST_ID,
      hostName: "Old laptop",
    });
  });

  return { environmentListCalls, hostListEnvironmentIds };
}

beforeEach(() => {
  reads.scope = null;
  reads.statuses.clear();
  useMoveSheetStore.setState({ target: null });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  resetTeamPageHarness();
  reads.scope = null;
});

describe("MoveSheet retry while Personal is unresolved", () => {
  it("retries the Personal lookup before requesting hosts and then enables the move", async () => {
    const { environmentListCalls, hostListEnvironmentIds } = renderMoveSheet();

    await screen.findByText("Couldn't read which computers run Personal.");
    expect(environmentListCalls).toHaveLength(1);
    expect(hostListEnvironmentIds).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(environmentListCalls).toHaveLength(2);
      expect(hostListEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Move to Personal" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.getByTestId("move-sheet-moves")).toBeTruthy();
  });
});
