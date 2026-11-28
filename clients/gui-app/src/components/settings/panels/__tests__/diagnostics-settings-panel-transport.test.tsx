// A failed read of the host's log list: the computer never answering puts the
// away line in the log section's place, anything it answered keeps the
// section's own line. The scope that names the computer is the REAL
// `useHostScope`; only the host lists it reads and the host client are stood
// in.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const client = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  return { useAddressableHostId: () => entry.hostId };
});
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => client.current,
  useHostBinding: () => ({ hostClient: client.current }),
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

import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";

const OWN_LINE = "Couldn't load log details.";
const AWAY_LINE = "Can't reach Studio Mac from here";

type ReadAnswer = "transport" | "refusal" | "answered";

function transportFailure(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "diagnostics.logs.list",
    fatalDetails: null,
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "The host refused the read.",
    requestId: "req-refused",
    method: "diagnostics.logs.list",
    fatalDetails: null,
  });
}

interface Page {
  readonly queryClient: QueryClient;
  readonly answer: { current: ReadAnswer };
}

function renderPage(first: ReadAnswer): Page {
  const answer = { current: first };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-diagnostics",
    handlers: {
      "config.logLevels.get": () => ({
        cliLogLevel: "info",
        hostLogLevel: "info",
      }),
      "diagnostics.logs.list": () => {
        if (answer.current === "transport") {
          return Promise.reject(transportFailure());
        }
        if (answer.current === "refusal") return Promise.reject(refusal());
        return Promise.resolve({
          logs: [
            {
              target: "host",
              label: "Host log",
              path: "/var/log/traycer/host.log",
            },
          ],
        });
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  client.current = spine.createRequester(mockLocalHostEntry);
  recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
    "config.logLevels.get",
    "config.logLevels.set",
    "diagnostics.logs.list",
    "diagnostics.logs.tail",
  ]);
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
        <DiagnosticsSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, answer };
}

beforeEach(() => {
  // A Local pick lists the one computer as the scope's host without a cloud
  // membership read.
  useSettingsEnvironmentPickStore.setState({
    pick: {
      kind: "local",
      hostId: mockLocalHostEntry.hostId,
      hostName: "Studio Mac",
    },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  client.current = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("<DiagnosticsSettingsPanel /> a failed read of the host's logs", () => {
  it("shows the away line in the log section when the computer never answered", async () => {
    renderPage("transport");

    expect(await screen.findByText(AWAY_LINE)).toBeTruthy();
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });

  it("keeps the section's own line when the computer answered with a refusal", async () => {
    renderPage("refusal");

    expect(await screen.findByText(OWN_LINE)).toBeTruthy();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("lists the log files and drops the away line once the computer answers again", async () => {
    const page = renderPage("transport");
    await screen.findByText(AWAY_LINE);

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "diagnostics.logs.list"
        >(mockLocalHostEntry.hostId, "diagnostics.logs.list", {}),
      });
    });

    expect(await screen.findByText("Host log")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(AWAY_LINE)).toBeNull();
    });
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });
});
