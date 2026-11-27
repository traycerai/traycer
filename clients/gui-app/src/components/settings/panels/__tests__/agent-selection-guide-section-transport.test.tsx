// A failed read of the host's agent instructions: the computer never answering
// shows the away notice and no Report issue, anything it answered keeps the
// page's own line and offers one. The scope the notice names is the REAL
// `usePersonalHostScope`; only the host lists it reads and the host client are
// stood in.
const hostMock = vi.hoisted((): { client: unknown } => ({ client: null }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostMock.client,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-a",
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
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { AgentSelectionGuideSection } from "@/components/settings/panels/agent-selection-guide-section";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const OWN_LINE = "Couldn't load agent instructions for this host.";
const AWAY_TITLE = "Can't reach Studio Mac from here";

type ReadAnswer = "transport" | "refusal";

function failure(answer: ReadAnswer): Error {
  const fields = {
    code: "RPC_ERROR" as const,
    requestId: "req-guide",
    method: "agent.selectionGuide.getGlobal",
    fatalDetails: null,
  };
  if (answer === "transport") {
    return new RetryableTransportError({
      ...fields,
      replaySafetyFromKey: false,
      message: "The relay did not answer.",
    });
  }
  return new HostRpcError({
    ...fields,
    message: "The host refused the read.",
  });
}

beforeEach(() => {
  useDesktopDialogStore.setState({ reportIssueAvailable: true });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.client = null;
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
});

function renderGuide(answer: ReadAnswer): void {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "agent.selectionGuide.getGlobal": () => Promise.reject(failure(answer)),
  };
  hostMock.client = buildEnvironmentClient({
    hostId: "host-a",
    handlers,
  }).client;
  recordNegotiatedHostMethods("host-a", ["agent.selectionGuide.getGlobal"]);
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
        <AgentSelectionGuideSection />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<AgentSelectionGuideSection /> a failed read of the guide", () => {
  it("shows the away notice and no Report issue when the computer never answered", async () => {
    renderGuide("transport");

    const notice = await screen.findByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain(AWAY_TITLE);
    expect(screen.queryByText(OWN_LINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("keeps the page's own line and its Report issue when the computer answered with a refusal", async () => {
    renderGuide("refusal");

    expect(await screen.findByText(OWN_LINE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
  });
});
