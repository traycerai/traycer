// A failed read of the host's agent definitions: the computer never answering
// shows the away notice, anything it answered keeps the page's own line. The
// scope the notice names is the REAL `usePersonalHostScope`; only the host
// lists it reads and the host client are stood in.
const hostMock = vi.hoisted(
  (): { client: unknown; binding: { readonly auth: unknown } | null } => ({
    client: null,
    binding: null,
  }),
);
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostMock.client,
    useHostBinding: () => hostMock.binding,
  };
});
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
// The host lists the scope reads: one listed, reachable computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({
    hosts: [hostScopeOptionFixture({ hostId: "host-a", name: "Studio Mac" })],
  });
  return { useHostOptions: () => options };
});
// The scope would dial a host it does not follow; this one is followed, so no
// client of its own is built.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ConfigurationSourceContext } from "@/components/settings/environment/configuration-source";
import { AgentDefinitionsTab } from "@/components/settings/panels/agent-definitions-tab";
import {
  mountTeamPage,
  requireTeamEnvironmentAuthnBinding,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { queryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const OWN_LINE = "Couldn't read these agent definitions.";
const AWAY_TITLE = "Can't reach Studio Mac from here";
const METHODS = [
  "environment.status",
  "environment.agentDefinitions.list",
  "environment.agentDefinitions.put",
  "environment.agentDefinitions.delete",
  "environment.list",
  "environment.configuration.items",
];

type ReadAnswer = "transport" | "refusal" | "terminal" | "answered";

function transportFailure(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "environment.agentDefinitions.list",
    fatalDetails: null,
  });
}

/** A terminal verdict: the host answered, then closed the session for good. */
function terminalVerdict(): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "Remote session closed terminally: SANDBOX_FROZEN",
    requestId: "req-terminal",
    method: "environment.agentDefinitions.list",
    fatalDetails: {
      code: "SANDBOX_FROZEN",
      reason: "The sandbox is frozen.",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "The host refused the read.",
    requestId: "req-refused",
    method: "environment.agentDefinitions.list",
    fatalDetails: null,
  });
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
  hostMock.binding = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useAuthStore.setState({ status: "signed-out" });
  resetTeamPageHarness();
});

interface Page {
  readonly queryClient: QueryClient;
  readonly answer: { current: ReadAnswer };
}

function renderPage(first: ReadAnswer): Page {
  useAuthStore.setState({ status: "signed-in" });
  const answer = { current: first };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => environmentStatusFixture({}),
    "environment.list": () => ({ environments: [] }),
    "environment.configuration.items": () => ({ items: [] }),
    "environment.agentDefinitions.list": () => {
      if (answer.current === "transport") {
        return Promise.reject(transportFailure());
      }
      if (answer.current === "refusal") return Promise.reject(refusal());
      if (answer.current === "terminal") {
        return Promise.reject(terminalVerdict());
      }
      return Promise.resolve({
        definitions: [
          { name: "reviewer.md", text: "Review the change.", revision: 3 },
        ],
      });
    },
  };
  const { client } = buildEnvironmentClient({ hostId: "host-a", handlers });
  const harness = mountTeamPage({ kind: "host" }, handlers);
  hostMock.binding = requireTeamEnvironmentAuthnBinding();
  recordNegotiatedHostMethods("host-a", METHODS);
  hostMock.client = client;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={harness.runnerHost}>
        <ConfigurationSourceContext.Provider value={{ kind: "host" }}>
          <AgentDefinitionsTab />
        </ConfigurationSourceContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, answer };
}

describe("<AgentDefinitionsTab /> a failed read of the host", () => {
  it("shows the away notice, not the page's own line, when the computer never answered", async () => {
    renderPage("transport");

    const notice = await screen.findByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain(AWAY_TITLE);
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });

  it.each(["refusal", "terminal"] as const)(
    "keeps the page's own line when the computer answered with a %s",
    async (answer) => {
      renderPage(answer);

      expect(await screen.findByText(OWN_LINE)).toBeTruthy();
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
      expect(screen.queryByText(/Can't reach/)).toBeNull();
    },
  );

  it("lists the definitions and drops the notice once the computer answers again", async () => {
    const page = renderPage("transport");
    await screen.findByTestId("host-scope-unreachable");

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "environment.agentDefinitions.list"
        >("host-a", "environment.agentDefinitions.list", {}),
      });
    });

    expect((await screen.findAllByTestId("agent-definition")).length).toBe(1);
    await waitFor(() => {
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    });
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });
});
