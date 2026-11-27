// In a build with a server pool the Rules read goes to the pool, not the
// picked computer, so a dropped pool connection says nothing about that
// computer: the page's own line shows and the away notice never names it.
import "../../../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { RulesTab } from "@/components/settings/panels/permissions/rules-tab";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const hostMock = vi.hoisted(
  (): { client: unknown; binding: { readonly auth: unknown } | null } => ({
    client: null,
    binding: null,
  }),
);

vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  return { useAddressableHostId: () => entry.hostId };
});
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostMock.client,
  useHostBinding: () => hostMock.binding,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/chats/use-visible-chats", () => ({
  useVisibleChats: () => new Map(),
}));
// The host lists the scope reads: one listed, reachable computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  const options = hostOptionsFixture({
    hosts: [
      hostScopeOptionFixture({ hostId: entry.hostId, name: "Studio Mac" }),
    ],
  });
  return { useHostOptions: () => options };
});
// The scope would dial a host it does not follow; this one is followed, so no
// client of its own is built.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

const OWN_LINE = "Couldn't read your rules. Reopen Settings to try again.";

// The tier plan is frozen per process from the build; this file's build has a pool.
beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

const lookedUp: string[] = [];

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
  hostMock.binding = null;
});

function renderRulesTab(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-rules",
    handlers: {
      "autoPolicy.get": () =>
        Promise.reject(
          new RetryableTransportError({
            replaySafetyFromKey: false,
            code: "RPC_ERROR",
            message: "The relay did not answer.",
            requestId: "req-away",
            method: "autoPolicy.get",
            fatalDetails: null,
          }),
        ),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => {
      lookedUp.push(hostId);
      const entries: ReadonlyArray<HostDirectoryEntry> = [
        mockLocalHostEntry,
        poolEntry,
      ];
      return entries.find((entry) => entry.hostId === hostId) ?? null;
    },
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostMock.client = spine.createRequester(mockLocalHostEntry);
  hostMock.binding = { auth: null };
  // A pool-only method's capability is the pool's, not the picked computer's.
  recordNegotiatedHostMethods(poolEntry.hostId, ["autoPolicy.get"]);
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <RulesTab
          active
          drafts={[]}
          onDraftsConsumed={() => undefined}
          snapshot={null}
          onSnapshot={() => undefined}
        />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<RulesTab /> a dropped connection with a pool", () => {
  it("shows the page's own line, not the away notice naming the picked computer", async () => {
    renderRulesTab();

    expect(await screen.findByText(OWN_LINE)).toBeTruthy();
    expect(lookedUp).toContain(poolEntry.hostId);
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
    expect(document.body.textContent).not.toContain("Studio Mac");
  });
});
