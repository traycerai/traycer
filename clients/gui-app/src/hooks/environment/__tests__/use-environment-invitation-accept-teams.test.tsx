import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import {
  AUTHENTICATED_USER_FIXTURE_ID,
  createAuthenticatedUserFixture,
} from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  createFakeEnvironmentCloudServices,
  createFakeEnvironmentCloudTransport,
} from "../../../../__tests__/create-fake-runner-host";
import type { AuthService } from "@/lib/auth/auth-service";
import { TeamRows } from "@/components/settings/environment/team-rows";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hostQueryKeys } from "@/lib/query-keys";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEnvironmentInvitationAcceptMutation } from "../use-environment-invitations";

/**
 * The account is read again after an accepted invitation, and only then is
 * the environment list read, so the team just joined is among the teams the
 * list joins each row to. Every part here is the app's own: the hook, the
 * list query, `TeamRows` and a real `AuthService` signed in through its
 * session projection. Only the authn answers are faked.
 */

const mocks = vi.hoisted(() => ({
  binding: null as {
    readonly auth: AuthService;
    readonly directory: { readonly refresh: () => Promise<readonly never[]> };
  } | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    hostManagement: null,
    refreshHostFleet: () => Promise.resolve(),
  }),
}));

const EPOCH = new Date(0);
const BEARER = "t1";

const PERSONAL_ROW: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: AUTHENTICATED_USER_FIXTURE_ID,
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 0,
  providerHandle: null,
};

const TEAM_ROW: EnvironmentDescriptorV11 = {
  environmentId: "env-new",
  ownerKind: "organization",
  ownerId: "team-new",
  roomId: "room-new",
  label: "Acme New",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: "acme-new",
};

/** The account's answer once the team is on it. */
function userWithTheTeam(): AuthenticatedUser {
  const user = createAuthenticatedUserFixture(undefined);
  const subscription = {
    id: "sub-team",
    userID: AUTHENTICATED_USER_FIXTURE_ID,
    orgID: null,
    teamID: "team-new",
    customerId: "cus-team",
    createdAt: EPOCH,
    updatedAt: EPOCH,
    subscriptionExpiry: null,
    trialEndsAt: null,
    subscriptionStatus: "ULTRA_1X_V3",
    hasPaymentMethod: true,
    rechargeRateSeconds: 60,
    isInTrial: false,
    totalPlanCredits: 500,
    hasActiveBundle: false,
    bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
    team: {
      id: "team-new",
      slug: "acme-new",
      avatarUrl: null,
      privacyMode: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
  } satisfies AuthenticatedUser["teamSubscriptions"][number];
  return { ...user, teamSubscriptions: [subscription] };
}

function directoryRows(
  rows: readonly EnvironmentDescriptorV11[],
): EnvironmentDirectoryResult {
  return {
    kind: "ok",
    list: {
      environments: rows.map((row) => ({
        environmentId: row.environmentId,
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
        roomId: row.roomId,
        label: row.label,
      })),
    },
  };
}

function AcceptButton(): ReactNode {
  const accept = useEnvironmentInvitationAcceptMutation();
  return (
    <button
      type="button"
      onClick={() => accept.mutate({ environmentId: TEAM_ROW.environmentId })}
    >
      Accept
    </button>
  );
}

describe("accepting an invitation reads the account before the environment list", () => {
  let queryClient: QueryClient;
  let auth: AuthService | null = null;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    queryClient.clear();
    auth?.dispose();
    auth = null;
    mocks.binding = null;
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      shareableTeams: [],
    });
  });

  it("draws the team just joined with its role, not as Read-only settings", async () => {
    const events: string[] = [];
    const joined = { current: false };
    const rows = (): EnvironmentDescriptorV11[] =>
      joined.current ? [PERSONAL_ROW, TEAM_ROW] : [PERSONAL_ROW];
    const services = createFakeEnvironmentCloudServices({
      listEnvironments: () => {
        events.push("list-request");
        return Promise.resolve(directoryRows(rows()));
      },
      transport: createFakeEnvironmentCloudTransport({ environments: rows }),
      runnerHostOverrides: {
        validateAuthTokenIdentity:
          (): Promise<AuthIdentityValidationResult> => {
            events.push("reread");
            return Promise.resolve({
              kind: "valid",
              user: joined.current
                ? userWithTheTeam()
                : createAuthenticatedUserFixture(undefined),
            });
          },
      },
    });
    const service = services.auth;
    auth = service;
    service.applyExternalSession({
      status: "signed-in",
      token: BEARER,
      profile: {
        userId: AUTHENTICATED_USER_FIXTURE_ID,
        userName: "Test User",
        email: "test@example.com",
        avatarUrl: null,
      },
      user: createAuthenticatedUserFixture(undefined),
    });
    vi.spyOn(service, "listEnvironmentInvitations").mockResolvedValue({
      invitations: [],
    });
    vi.spyOn(service, "acceptEnvironmentInvitation").mockResolvedValue({
      outcome: "accepted",
    });
    mocks.binding = {
      auth: service,
      directory: { refresh: () => Promise.resolve([]) },
    };
    render(
      <QueryClientProvider client={queryClient}>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AcceptButton />
            <DropdownMenuRadioGroup value="personal">
              <TeamRows
                pick={PERSONAL_PICK}
                onPick={() => undefined}
                onReview={() => undefined}
                onConnectComputer={() => undefined}
              />
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(events).toEqual(["list-request"]);
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByTestId("environment-team-env-new")).toBeNull();

    // The team is on the account once the invitation is accepted. What the
    // store holds, and when the list is asked, are watched from outside.
    events.length = 0;
    joined.current = true;
    const unsubscribe = useAuthStore.subscribe((state, previous) => {
      if (state.shareableTeams.length > previous.shareableTeams.length)
        events.push("teams-in-store");
    });
    try {
      await userEvent.click(screen.getByRole("button", { name: "Accept" }));
      const row = await screen.findByTestId("environment-team-env-new");

      expect(events).toEqual(["reread", "teams-in-store", "list-request"]);
      expect(row.textContent).toContain("Acme New");
      expect(row.textContent).toContain("You edit");
      expect(row.textContent).not.toContain("Read-only settings");
      const lists = queryClient.getQueriesData<EnvironmentListResponseV11>({
        predicate: (query) =>
          hostQueryKeys.matchesMethodOnAnyHost(
            query.queryKey,
            "environment.list",
          ),
      });
      expect(
        lists
          .flatMap(([, data]) => data?.environments ?? [])
          .find((environment) => environment.environmentId === "env-new"),
      ).toMatchObject({ effectiveRole: "editor", providerHandle: "acme-new" });
    } finally {
      unsubscribe();
    }
    await act(async () => {
      await queryClient.cancelQueries();
    });
  });
});
