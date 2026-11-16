import { QueryClient } from "@tanstack/react-query";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { TaskEnvironmentAttachmentRequest } from "@traycer-clients/shared/host-client/task-environment-attachment";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

export type LandingAttachmentCall =
  | { readonly kind: "list"; readonly bearer: string }
  | {
      readonly kind: "attach";
      readonly bearer: string;
      readonly request: TaskEnvironmentAttachmentRequest;
    };

export interface LandingAttachmentFixture {
  readonly auth: AuthService;
  readonly runnerHost: MockRunnerHost;
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  readonly authnCalls: LandingAttachmentCall[];
  readonly dispose: () => void;
  readonly signInAs: (userId: string, token: string) => Promise<void>;
}

export function landingTeamEnvironment(
  teamId: string,
): EnvironmentDescriptorV11 {
  return {
    environmentId: `env-${teamId}`,
    ownerKind: "organization",
    ownerId: teamId,
    roomId: `room-${teamId}`,
    label: "Team",
    effectiveRole: "editor",
    kind: "team",
    hostCount: 1,
    providerHandle: teamId,
  };
}

function signedInResponse(userId: string): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: userId,
        name: userId,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${userId}`,
        userID: userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${userId}`,
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
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
}

export async function createLandingAttachmentFixture(options: {
  readonly userId: string;
  readonly token: string;
  readonly hostId: string;
  readonly teamEnvironments: ReadonlyArray<EnvironmentDescriptorV11>;
}): Promise<LandingAttachmentFixture> {
  const userByToken = new Map([[options.token, options.userId]]);
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  vi.stubGlobal(
    "fetch",
    (_input: RequestInfo | URL, init: RequestInit | undefined) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      const token = authorization?.replace(/^Bearer /u, "") ?? "";
      return Promise.resolve(
        signedInResponse(userByToken.get(token) ?? options.userId),
      );
    },
  );
  const auth = new AuthService({ runnerHost });
  await runnerHost.tokenStore.signIn(
    { token: options.token, refreshToken: `${options.token}-refresh` },
    {
      id: options.userId,
      email: `${options.userId}@example.com`,
      name: options.userId,
    },
  );
  await auth.start();

  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
    onRegistryPollTick: null,
    authContextId: () => auth.currentAuthEra().identity,
    credentialGeneration: () => auth.getCredentialGeneration(),
    localHostIdSeeder: () => Promise.resolve(options.hostId),
  });
  const queryClient = new QueryClient();
  let requestId = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    onHostTokenRenewal: () => undefined,
    registry: hostRpcRegistry,
    singleAttemptMessenger: null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `landing-attachment-${++requestId}`,
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    connectionRegistry: null,
    selectedHostId: () => options.hostId,
  });
  const authnCalls: LandingAttachmentCall[] = [];
  vi.spyOn(runnerHost, "listEnvironments").mockImplementation((bearer) => {
    authnCalls.push({ kind: "list", bearer });
    return Promise.resolve({
      kind: "ok",
      list: { environments: [...options.teamEnvironments] },
    });
  });
  vi.spyOn(runnerHost, "attachTaskEnvironment").mockImplementation(
    (bearer, request) => {
      authnCalls.push({ kind: "attach", bearer, request });
      return Promise.resolve({ kind: "ok" });
    },
  );

  return {
    auth,
    runnerHost,
    authnCalls,
    binding: {
      runtime,
      hostClient: runtime.hostClient,
      directory,
      auth,
      hostId: options.hostId,
    },
    signInAs: async (userId, token) => {
      userByToken.set(token, userId);
      await auth.signOut();
      await auth.signIn();
      runnerHost.deviceFlow.emitResult({
        kind: "authorized",
        token,
        refreshToken: `${token}-refresh`,
      });
      await waitFor(() => {
        expect(auth.getCurrentSessionSnapshot().token).toBe(token);
      });
    },
    dispose: () => {
      runtime.dispose();
      directory.dispose();
      auth.dispose();
      queryClient.clear();
    },
  };
}
