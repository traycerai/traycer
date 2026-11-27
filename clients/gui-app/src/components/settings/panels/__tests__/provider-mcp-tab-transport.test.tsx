// A cold MCP list that failed to read: the computer never answering shows the
// away notice with the tab's own Retry inside it; a press reads again. The
// scope the notice names is the REAL `usePersonalHostScope`; only the host
// lists it reads, the host client and the tab's workspace reads are stood in.
const hostMock = vi.hoisted((): { client: unknown } => ({ client: null }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostMock.client,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
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
// The scope picker needs the app's workspace stores; the list is global here.
vi.mock("@/components/settings/panels/use-provider-native-scope", async () => {
  const { GLOBAL_ONLY_NATIVE_SCOPE } =
    await import("@/components/settings/panels/__tests__/provider-native-scope-test-mocks");
  return { useProviderNativeScope: () => GLOBAL_ONLY_NATIVE_SCOPE };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
} from "@traycer/protocol/host/provider-native-schemas";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const OWN_TITLE = "Couldn't load MCP servers";
const AWAY_TITLE = "Can't reach Studio Mac from here";

const CAPS: ProviderMcpCapabilities = {
  transports: ["stdio", "http"],
  authTypes: ["none"],
  authActions: [],
  actionScopes: {
    list: ["global"],
    add: ["global"],
    update: ["global"],
    remove: ["global"],
    toggleServer: ["global"],
    toggleTool: ["global"],
    discover: ["global"],
    auth: [],
  },
  addServer: "cli",
  removeServer: "cli",
  updateServer: "patch",
  perToolBacking: "native",
  statusSource: "probe",
  toolsSource: "probe",
  schemasSource: "probe",
  instructionsSource: "probe",
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: false,
};

const DOCS_SERVER: ProviderMcpServer = {
  name: "docs-server",
  enabled: true,
  transport: { type: "http", url: "https://docs.example.test/mcp", auth: null },
  status: "connected",
  statusSource: "probe",
  statusDetail: null,
  tools: [],
  discoveryPending: false,
  instructions: null,
  configOnly: false,
  stdioDegraded: false,
};

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
});

interface Page {
  readonly answer: { current: "transport" | "answered" };
  readonly reads: { current: number };
}

function renderPage(): Page {
  const answer: Page["answer"] = { current: "transport" };
  const reads = { current: 0 };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "providers.list": () => {
      reads.current += 1;
      if (answer.current === "transport") {
        return Promise.reject(
          new RetryableTransportError({
            replaySafetyFromKey: false,
            code: "RPC_ERROR",
            message: "The relay did not answer.",
            requestId: "req-away",
            method: "providers.list",
            fatalDetails: null,
          }),
        );
      }
      return Promise.resolve({
        providers: [],
        native: {
          ok: true as const,
          kind: "mcp" as const,
          servers: [DOCS_SERVER],
        },
      });
    },
  };
  hostMock.client = buildEnvironmentClient({
    hostId: "host-a",
    handlers,
  }).client;
  recordNegotiatedHostMethods("host-a", ["providers.list"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
        <ProviderMcpTab
          providerId="codex"
          capabilities={CAPS}
          providerLabel="Codex"
          cliBinaryResolved
        />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { answer, reads };
}

describe("<ProviderMcpTab /> a cold list the computer never answered", () => {
  it("draws the tab's own Retry inside the away notice, and a press reads again and brings the servers back", async () => {
    const page = renderPage();

    const notice = await screen.findByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain(AWAY_TITLE);
    const retry = within(notice).getByRole("button", { name: "Retry" });
    expect(screen.queryByText(OWN_TITLE)).toBeNull();
    const readsBefore = page.reads.current;

    page.answer.current = "answered";
    await userEvent.click(retry);

    expect(await screen.findByText("docs-server")).toBeTruthy();
    expect(page.reads.current).toBeGreaterThan(readsBefore);
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.queryByText(OWN_TITLE)).toBeNull();
  });
});
