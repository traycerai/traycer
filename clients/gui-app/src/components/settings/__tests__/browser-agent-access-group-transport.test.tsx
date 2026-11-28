// A failed read of the host's browser setting: the computer never answering
// puts the away line in the status's place, anything it answered keeps the
// page's own line. The scope that names the computer is the REAL
// `usePersonalHostScope`; only the host lists it reads and the host client are
// stood in.
import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { BrowserAgentAccessGroup } from "@/components/settings/panels/browser-agent-access-group";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { queryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const client = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  return { useAddressableHostId: () => entry.hostId };
});
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: () => undefined,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => client.current,
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

const OWN_LINE = /Couldn't read this host's browser setting/;
const AWAY_LINE = "Can't reach Studio Mac from here";
const NORMAL_DESCRIPTION = /Running agents pick this up on their next turn\.$/;

type ReadAnswer = "transport" | "refusal" | "answered";

function transportFailure(): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "config.browser.get",
    fatalDetails: null,
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "config.json is garbage",
    requestId: "req-refused",
    method: "config.browser.get",
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
    requestId: () => "req-agent-browser-access",
    handlers: {
      "config.browser.get": () => {
        if (answer.current === "transport") {
          return Promise.reject(transportFailure());
        }
        if (answer.current === "refusal") return Promise.reject(refusal());
        return Promise.resolve({ agentAccess: true });
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
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <BrowserAgentAccessGroup />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  render(tree);
  return { queryClient, answer };
}

afterEach(() => {
  cleanup();
  client.current = null;
});

describe("<BrowserAgentAccessGroup /> a failed read of the host", () => {
  it("shows the away line in the status's place when the computer never answered", async () => {
    renderPage("transport");

    expect(await screen.findByText(AWAY_LINE)).toBeTruthy();
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });

  it("keeps the page's own line when the computer answered with a refusal", async () => {
    renderPage("refusal");

    expect(await screen.findByText(OWN_LINE)).toBeTruthy();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("shows the switch with its normal description once the computer answers again", async () => {
    const page = renderPage("transport");
    await screen.findByText(AWAY_LINE);

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, "config.browser.get">(
          mockLocalHostEntry.hostId,
          "config.browser.get",
          {},
        ),
      });
    });

    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Let agents use the in-app browser" })
          .getAttribute("data-state"),
      ).toBe("checked");
    });
    expect(screen.getByText(NORMAL_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByText(AWAY_LINE)).toBeNull();
    expect(screen.queryByText(OWN_LINE)).toBeNull();
  });
});
