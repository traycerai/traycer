// With no server pool in the build, a Rules read that never reached the
// computer shows the away notice naming it, not the page's own line.
import "../../../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
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
      return hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null;
    },
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostMock.client = spine.createRequester(mockLocalHostEntry);
  hostMock.binding = { auth: null };
  recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["autoPolicy.get"]);
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

describe("<RulesTab /> a dropped connection without a pool", () => {
  it("shows the away notice, not the page's own line", async () => {
    renderRulesTab();

    const notice = await screen.findByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain("Can't reach Studio Mac from here");
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });
});
