import "../../../../../__tests__/test-browser-apis";
import { useContext, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentPlan } from "@traycer/protocol/host/environment/configuration-contracts";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { TeamProviderLiveFacts } from "@/components/settings/environment/team-provider-live-facts";
import { TeamSkills } from "@/components/settings/environment/team-skills";
import { GLOBAL_ONLY_NATIVE_SCOPE } from "@/components/settings/panels/__tests__/provider-native-scope-test-mocks";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  providerState,
  reachableHost,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

// A team page reads through the team's viewing host, which is not the host
// this window runs on. A transport failure from that read says nothing about
// the window's host, so the page keeps its own line. The window's host and
// the team's host are two listed computers; the team's inventory, the host
// clients and the reads are stood in, and the binding, the Settings scope and
// the helper are real.
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/host/runtime")>();
  const useHostBinding = () => {
    const provided = useContext(original.HostRuntimeContext);
    return (
      provided ?? {
        hostId: "host-local",
        hostClient: requireTeamHostClient(),
      }
    );
  };
  return {
    ...original,
    useHostBinding,
    useHostClient: () => useHostBinding().hostClient,
  };
});
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: (await import("@/lib/host/runtime")).useHostClient,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    return hostId === mockRemoteHostEntry.hostId
      ? requireViewingHostClient()
      : requireTeamHostClient();
  },
}));
// The host lists the Settings scope reads: the window's own computer, active
// and reachable, beside the team's viewing host.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({
    hosts: [
      hostScopeOptionFixture({ hostId: "host-local", name: "Window box" }),
      hostScopeOptionFixture({
        hostId: "host-remote",
        name: "Team box",
        isActive: false,
        isLocalMachine: false,
      }),
    ],
    activeHostId: "host-local",
  });
  return { useHostOptions: () => options };
});
// The scope would dial a host it does not follow; the window's is followed.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
// The scope picker needs the app's workspace stores; skills are global here.
vi.mock("@/components/settings/panels/use-provider-native-scope", () => ({
  useProviderNativeScope: () => GLOBAL_ONLY_NATIVE_SCOPE,
}));
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: { content: "", truncated: false, error: null },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const RELAY_MESSAGE = "The relay did not answer.";

function transportFailure(method: string): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: RELAY_MESSAGE,
    requestId: "req-away",
    method,
    fatalDetails: null,
  });
}

/** The team's inventory: one reachable host that is not the window's own. */
const teamHost = {
  ...reachableHost,
  hostId: mockRemoteHostEntry.hostId,
  hostLabel: "Team box",
};

function teamHandlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.host.list": () => ({ hosts: [teamHost] }),
    "environment.list": () => teamEnvironments,
    "environment.plans.list": () => ({ plans: [] }),
  };
}

/** The harness's page frame, under the runner host the Settings scope reads. */
function wrapperOf(
  harness: TeamPageHarness,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <harness.Wrapper>
        <RunnerHostProvider runnerHost={harness.runnerHost}>
          {props.children}
        </RunnerHostProvider>
      </harness.Wrapper>
    );
  };
}

function expectNoAwayNotice(): void {
  expect(screen.queryByText(/Can't reach/)).toBeNull();
  expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
}

describe("a team page whose viewing host's read failed in transport", () => {
  it("keeps Team Skills' own list error and names no computer", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      ...teamHandlers(),
      "providers.list": (request) => {
        if (request.native !== null) {
          return Promise.reject(transportFailure("providers.list"));
        }
        return {
          providers: [
            providerState("claude-code", { mcp: false, skills: true }),
          ],
          native: null,
        };
      },
    });

    render(<TeamSkills providerId={null} />, { wrapper: wrapperOf(harness) });

    expect(await screen.findByText(RELAY_MESSAGE)).toBeTruthy();
    expectNoAwayNotice();
  });

  it("keeps the team usage card's own line and names no computer", async () => {
    const plan: EnvironmentPlan = {
      profileId: "team-plan",
      harness: "openrouter",
      status: "linked",
      linkedBy: { name: "Ada", you: false },
    };
    const profile: ProviderProfile = {
      profileId: "team-plan",
      enabled: true,
      kind: "managed",
      authType: "oauth",
      label: "Team plan",
      auth: {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      identity: null,
      usageUpdatedAt: null,
      rateLimitStatus: "unknown",
      rateLimitLimitedScopes: null,
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
      accentColor: null,
    };
    const state: ProviderCliState = {
      ...providerState("openrouter", { mcp: false, skills: false }),
      profiles: [profile],
    };
    const harness = mountTeamPage(poolSource("editor"), {
      ...teamHandlers(),
      "environment.plans.list": () => ({ plans: [plan] }),
      "providers.list": () => ({ providers: [state], native: null }),
      "host.getRateLimitUsage": () =>
        Promise.reject(transportFailure("host.getRateLimitUsage")),
    });

    render(<TeamProviderLiveFacts providerId="openrouter" />, {
      wrapper: wrapperOf(harness),
    });

    expect(
      await screen.findByText(/Couldn't load usage limits\. Try refreshing\./),
    ).toBeTruthy();
    expectNoAwayNotice();
  });
});
