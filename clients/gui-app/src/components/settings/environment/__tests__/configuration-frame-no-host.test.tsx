import "../../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { AuthService } from "@/lib/auth/auth-service";
import {
  hostRpcRegistry,
  HostRuntimeContext,
  HostRuntimeProvider,
  useHostBinding,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const AUTHN = "http://localhost:5005";
const DIRECTORY = "https://server.test.invalid/api/environments";
const TEAM_ENVIRONMENT = `${AUTHN}/api/v3/environments/env-a`;

const services: AuthService[] = [];
let originalFetch: unknown = undefined;

afterEach(() => {
  cleanup();
  for (const service of services.splice(0)) service.dispose();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: originalFetch,
  });
});

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    }),
  );
}

/** The person's account, as authn validates the device sign-in's token. */
const PROFILE = {
  user: {
    id: "user-1",
    name: "Test User",
    providerId: "gh-1",
    providerHandle: "test-user",
    providerType: "GITHUB",
    email: "test@example.com",
    avatarUrl: null,
    activatedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    lastSeenAt: null,
    privacyMode: false,
    isLearningEnabled: true,
  },
  userSubscription: {
    id: "sub-1",
    userID: "user-1",
    orgID: null,
    teamID: null,
    customerId: "cus-1",
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

/**
 * traycer-server's directory names one team environment, authn answers its
 * reads, and every other request is the sign-in's validation.
 */
function installCloud(): string[] {
  const sent: string[] = [];
  originalFetch = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = String(input);
      sent.push(url);
      if (url === DIRECTORY) {
        return json({
          environments: [
            {
              environmentId: "env-a",
              ownerKind: "organization",
              ownerId: "team-1",
              roomId: "room-a",
              label: "Acme",
            },
          ],
        });
      }
      if (url === `${TEAM_ENVIRONMENT}/hosts`) return json({ hosts: [] });
      if (url === `${TEAM_ENVIRONMENT}/members`) {
        return json({ viewer: { effectiveRole: "editor" } });
      }
      if (url.startsWith(`${AUTHN}/api/v3/environments/`)) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return json(PROFILE);
    },
  });
  return sent;
}

function mockRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: AUTHN,
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

async function signedInService(): Promise<AuthService> {
  const host = mockRunnerHost();
  const service = new AuthService({ runnerHost: host });
  services.push(service);
  await service.signIn();
  host.deviceFlow.emitResult({
    kind: "authorized",
    token: "user-1-token",
    refreshToken: "user-1-token-refresh",
  });
  await vi.waitFor(() => {
    expect(service.getCurrentSessionSnapshot().token).toBe("user-1-token");
  });
  return service;
}

/** The window's binding, with the signed-in session in place of its own. */
function SignedInBinding(props: {
  readonly auth: AuthService;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  if (binding === null) throw new Error("expected the host runtime binding");
  return (
    <HostRuntimeContext.Provider value={{ ...binding, auth: props.auth }}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}

describe("a team page's frame with no computer connected", () => {
  it("opens from the app's own reads", async () => {
    const sent = installCloud();
    const auth = await signedInService();
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: "user-1",
          userName: "Test User",
          email: "test@example.com",
        },
        contextMetadata: { userId: "user-1", username: "test-user" },
        shareableTeams: [{ teamId: "team-1", slug: "acme", avatarUrl: null }],
      });
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: "env-a" },
      });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <RunnerHostProvider runnerHost={mockRunnerHost()}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={(args) =>
              new MockHostMessenger<HostRpcRegistry>({
                registry: args.registry,
                requestId: () => "req-no-host",
                handlers: {},
              })
            }
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={null}
          >
            <SignedInBinding auth={auth}>
              <PersonalPageFrame section="mcp-servers">
                <p>The team's page</p>
              </PersonalPageFrame>
            </SignedInBinding>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    expect(await screen.findByText("The team's page")).toBeTruthy();
    await waitFor(() => {
      expect(sent).toContain(`${TEAM_ENVIRONMENT}/members`);
    });
    expect(sent).toContain(DIRECTORY);
  });
});
