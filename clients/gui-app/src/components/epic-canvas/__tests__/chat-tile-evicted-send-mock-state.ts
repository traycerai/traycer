import type {
  AuthEra,
  RequestContextListener,
} from "@traycer-clients/shared/auth/request-context-provider";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  poolEntry,
  teamSandboxEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ListCloudChatsResponse } from "@traycer/protocol/host/epic/cloud-chat";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { teamSubscription } from "@/lib/sandboxes/__tests__/auth-user-fixture";

export const HOST_ID = "host-test";
export const SAVED_CREATOR_USER_ID = "owner-1";
export const TEAM_ENVIRONMENT_OWNER_ID = "env-team-1";

export const environmentListTestState: {
  data: EnvironmentListResponseV11 | undefined;
} = {
  data: undefined,
};

export const originSignInTestState = {
  userId: "owner-1",
  generation: 0,
  listeners: new Set<RequestContextListener>(),
};

export const cloudChatListTestState: {
  data: ListCloudChatsResponse | undefined;
  requestCount: number;
} = { data: undefined, requestCount: 0 };

export const hostDirectoryTestState = {
  teamSandboxForCurrentChat: false,
};

function requestContextFor(userId: string | null) {
  return userId === null
    ? null
    : createRequestContextFixture({
        identity: { userId, username: userId, providerHandle: null },
        origin: "renderer",
        bearerToken: `test-bearer-${userId}`,
      });
}

export function emitOriginSignInChange(): void {
  const context = requestContextFor(originSignInTestState.userId);
  const era: AuthEra = {
    identity: originSignInTestState.userId,
    credentialGeneration: originSignInTestState.generation,
  };
  for (const listener of [...originSignInTestState.listeners]) {
    listener(context, era);
  }
}

export const hydrateBoundary: { client: HostClient<HostRpcRegistry> | null } = {
  client: null,
};

export const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  requestWithSignal: (method: string) => {
    if (method === "epic.listCloudChats") {
      cloudChatListTestState.requestCount += 1;
      const data = cloudChatListTestState.data;
      return data === undefined ? new Promise(() => {}) : Promise.resolve(data);
    }
    return new Promise(() => {});
  },
  // A pool build reads the pool tier's client through the surface's.
  createRequesterForHostId: () => MOCK_HOST_CLIENT,
  getActiveHostId: () => HOST_ID,
  getRequestContextUserId: () =>
    useAuthStore.getState().profile?.userId ?? SAVED_CREATOR_USER_ID,
  onChange: () => () => undefined,
};
const MOCK_HOST_ENTRY = {
  hostId: HOST_ID,
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_TEAM_SANDBOX_ENTRY = {
  ...teamSandboxEntry,
  hostId: HOST_ID,
};
export const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  getLocalEntry: () =>
    hostDirectoryTestState.teamSandboxForCurrentChat ? null : MOCK_HOST_ENTRY,
  getLocalHostId: () =>
    hostDirectoryTestState.teamSandboxForCurrentChat
      ? null
      : MOCK_HOST_ENTRY.hostId,
  findById: (hostId: string) => {
    if (hostId === MOCK_HOST_ENTRY.hostId) {
      return hostDirectoryTestState.teamSandboxForCurrentChat
        ? MOCK_TEAM_SANDBOX_ENTRY
        : MOCK_HOST_ENTRY;
    }
    return hostId === poolEntry.hostId ? poolEntry : null;
  },
};

// ENUMERATES deliberately, as `chat-tile-queue-edit-steer.test.tsx` does: the
// barrel's un-overridden residue is provider-coupled and throws.
// The one binding carries the directory `useHostDirectory` answers, as in the
// app: `useHostDirectoryEntry` reads it off the binding.
export const MOCK_HOST_BINDING = {
  directory: MOCK_HOST_DIRECTORY,
  hostClient: {
    ...MOCK_HOST_CLIENT,
    resolveHostById: (hostId: string) => MOCK_HOST_DIRECTORY.findById(hostId),
  },
  auth: {
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
    getRequestContextProvider: () => ({
      current: () => requestContextFor(originSignInTestState.userId),
      onChange: (listener: RequestContextListener) => {
        originSignInTestState.listeners.add(listener);
        return () => {
          originSignInTestState.listeners.delete(listener);
        };
      },
    }),
    environmentCloud: () => {
      const generation = originSignInTestState.generation;
      return {
        onOriginSignIn: () => generation === originSignInTestState.generation,
      };
    },
    fetchAuthenticatedUser: () => {
      if (!hostDirectoryTestState.teamSandboxForCurrentChat) {
        return Promise.reject(new Error("No TeamSandbox fixture is active"));
      }
      const user = createAuthenticatedUserFixture(undefined);
      return Promise.resolve({
        ...user,
        user: { ...user.user, id: SAVED_CREATOR_USER_ID },
        teamSubscriptions: [
          {
            ...teamSubscription(0),
            userID: SAVED_CREATOR_USER_ID,
          },
        ],
      });
    },
    getTeamEnvironment: () =>
      Promise.resolve(
        hostDirectoryTestState.teamSandboxForCurrentChat
          ? { kind: "ok" as const, environmentId: TEAM_ENVIRONMENT_OWNER_ID }
          : { kind: "not-a-member" as const },
      ),
    listSandboxes: () =>
      Promise.resolve({
        ...(hostDirectoryTestState.teamSandboxForCurrentChat
          ? {
              kind: "ok" as const,
              response: {
                sandboxes: [
                  sandboxSummaryFixture({
                    hostId: HOST_ID,
                    displayName: "Team sandbox",
                    environmentId: TEAM_ENVIRONMENT_OWNER_ID,
                    state: "suspended",
                  }),
                ],
              },
            }
          : {
              kind: "unavailable" as const,
              reason: "No TeamSandbox fixture is active",
            }),
      }),
  },
};
