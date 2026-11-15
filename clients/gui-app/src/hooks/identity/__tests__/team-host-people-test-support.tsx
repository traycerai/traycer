import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type {
  RemoteHostDirectoryEntry,
  RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry } from "@/lib/host";
import { HostRuntimeProvider } from "@/lib/host/runtime";
import { HostTeamPeopleProvider } from "@/hooks/identity/use-host-team-people";
import { PersonMembersContext } from "@/hooks/identity/use-person-identity";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  createPersonAvatarHarness,
  type PersonAvatarHarness,
} from "@/components/comments/__tests__/person-avatar-test-support";

export const TEAM_HOST_ID = "identity-team-host";
export const TEAM_ID = "team-1";
export const TEAM_ENVIRONMENT_ID = "env-9";
export const VIEWER_USER_ID = "user-1";
export const MEMBER_USER_ID = "member-a";
export const FORMER_USER_ID = "former-a";
export const TEAM_ONLY_USER_ID = "team-only-a";

export const TEAM_MEMBER = {
  userId: MEMBER_USER_ID,
  displayName: "Team Member",
  avatarUrl: "https://images.example.test/team-member.png",
  effectiveRole: "editor" as const,
  linkedPlan: false,
  inviteState: null,
  invitedAddress: null,
  email: null,
};

export interface TeamPeopleHarnessOptions {
  readonly owner?: RemoteHostDirectoryEntry["owner"];
  readonly environmentList?: () =>
    | EnvironmentListResponseV11
    | Promise<EnvironmentListResponseV11>;
  readonly members?: (
    environmentId: string,
    cursor: string | null,
  ) => EnvironmentMembersResponseV12 | Promise<EnvironmentMembersResponseV12>;
  readonly methods?: ReadonlyArray<string>;
}

export interface TeamPeopleHarness {
  readonly memberRequests: Array<{
    environmentId: string;
    cursor: string | null;
  }>;
  readonly environmentListRequests: number;
  readonly personReads: string[];
  readonly people: PersonAvatarHarness;
  readonly queryClient: QueryClient;
  readonly setPersonAnswer: (answer: unknown, status: number) => void;
  readonly wrap: (children: ReactNode, outer: BotMemberResolver) => ReactNode;
  readonly dispose: () => void;
}

export async function createTeamPeopleHarness(
  options: TeamPeopleHarnessOptions,
): Promise<TeamPeopleHarness> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.example.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  let personAnswer: unknown = {
    userId: FORMER_USER_ID,
    name: "Former Member",
    handle: "former-handle",
    avatarUrl: "https://images.example.test/former.png",
  };
  let personStatus = 200;
  const personReads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/api/v3/user/negotiated")) {
      return new Response(JSON.stringify(authenticatedUser()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-traycer-user-record-version": "2.0",
        },
      });
    }
    if (url.includes("/api/v3/environments/") && url.includes("/people/")) {
      personReads.push(url);
      return new Response(
        personStatus === 404 ? null : JSON.stringify(personAnswer),
        {
          status: personStatus,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(null, { status: 404 });
  });
  await runnerHost.tokenStore.signIn(
    { token: "test-cloud-bearer", refreshToken: "test-refresh-token" },
    { id: VIEWER_USER_ID, email: "viewer@example.test", name: "Viewer" },
  );

  const people = createPersonAvatarHarness();
  const queryClient = people.queryClient;
  const memberRequests: Array<{
    environmentId: string;
    cursor: string | null;
  }> = [];
  let environmentListRequests = 0;
  const owner = options.owner ?? { kind: "team", id: TEAM_ID, name: "Team" };
  const remoteHost: RemoteHostDirectoryEntry = {
    ...remoteEntry(TEAM_HOST_ID, null),
    owner,
  };
  let requestSeq = 0;
  runnerHost.selectionPreferredStore.save(VIEWER_USER_ID, TEAM_HOST_ID);
  runnerHost.selectionIdentity.set(VIEWER_USER_ID);
  runnerHost.setHosts([remoteHost]);
  recordNegotiatedHostMethods(
    TEAM_HOST_ID,
    options.methods ?? ["environment.list", "environment.members"],
  );
  useAuthStore.getState().setSignedIn(
    {
      userId: VIEWER_USER_ID,
      userName: "Viewer",
      email: "viewer@example.test",
    },
    { userId: VIEWER_USER_ID, username: "Viewer" },
    [],
  );
  return {
    memberRequests,
    get environmentListRequests() {
      return environmentListRequests;
    },
    personReads,
    people,
    queryClient,
    setPersonAnswer: (answer, status) => {
      personAnswer = answer;
      personStatus = status;
    },
    wrap: (children, outer) => (
      <RunnerHostProvider runnerHost={runnerHost}>
        {people.wrap(
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={({ registry }) =>
              new MockHostMessenger<HostRpcRegistry>({
                registry,
                requestId: () => `identity-test-${++requestSeq}`,
                handlers: {
                  "environment.list": () => {
                    environmentListRequests += 1;
                    return (
                      options.environmentList?.() ?? environmentListWithTeam()
                    );
                  },
                  "environment.members": (request) => {
                    memberRequests.push(request);
                    return (
                      options.members?.(
                        request.environmentId,
                        request.cursor,
                      ) ?? {
                        members: [TEAM_MEMBER],
                        nextCursor: null,
                        legacyRoleNoticeSeenAt: null,
                        legacyMembers: [],
                      }
                    );
                  },
                },
              })
            }
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve<RemoteHostFetchOutcome>({
                kind: "hosts",
                entries: [remoteHost],
              })
            }
            fallback={<div data-testid="team-runtime-fallback" />}
          >
            <PersonMembersContext.Provider value={outer}>
              <HostTeamPeopleProvider hostId={TEAM_HOST_ID}>
                {children}
              </HostTeamPeopleProvider>
            </PersonMembersContext.Provider>
          </HostRuntimeProvider>,
        )}
      </RunnerHostProvider>
    ),
    dispose: () => {
      people.dispose();
      resetNegotiatedManifests();
      useSelectionAuthorityStore.getState().reset();
    },
  };
}

export function environmentListWithTeam(): EnvironmentListResponseV11 {
  return {
    environments: [
      {
        environmentId: TEAM_ENVIRONMENT_ID,
        ownerKind: "organization",
        ownerId: TEAM_ID,
        roomId: "room-team-1",
        label: "Team",
        effectiveRole: "admin",
        kind: "team",
        hostCount: 1,
        providerHandle: "team",
      },
    ],
  };
}

function authenticatedUser() {
  return {
    user: {
      id: VIEWER_USER_ID,
      name: "Viewer",
      providerId: "provider-1",
      providerHandle: "viewer",
      providerType: "GITHUB",
      email: "viewer@example.test",
      avatarUrl: null,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      id: "subscription-1",
      userID: VIEWER_USER_ID,
      orgID: null,
      teamID: null,
      customerId: "customer-1",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "FREE",
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: { allowPayAsYouGo: false },
  };
}
