/**
 * The error row of a turn the provider refused because its command-line tool
 * is out of date (Tracy Bots T71), through the real `ErrorSegment` inside a
 * transcript: it reads as an interruption in the host's words, and offers
 * Update only for the code the host gives where it can update the provider.
 * Update reaches the host that ran the turn as `providers.ensurePack`, over a
 * host client whose messenger records what it is asked.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostQueryKeys } from "@/lib/query-keys";
import { ErrorSegment } from "../error-segment";

/** The host that ran the turn: the one the recording client addresses. */
const HOST_ID = mockRemoteHostEntry.hostId;

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.client,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

/** What the host was asked, in order: each check's pack and each update's provider. */
let asked: ReadonlyArray<string>;

function hostClientRecordingUpdates(): HostRequester<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-update",
    handlers: {
      "providers.refreshPackDiscovery": (params) => {
        asked = [...asked, `check ${params.packId}`];
        return Promise.resolve({ result: { ok: true, outcome: "moved" } });
      },
      "providers.ensurePack": (params) => {
        asked = [...asked, `update ${params.providerId}`];
        return Promise.resolve({ managedInstallState: null });
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    // The app's policy, which grants the update check its long timeout.
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

function renderRow(
  code: string,
  message: string,
  queryClient: QueryClient,
): void {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId={HOST_ID}>
          <ChatTranscriptProvider value={{ chatId: "chat-1", hostId: HOST_ID }}>
            <ErrorSegment
              turnId="turn-1"
              message={message}
              code={code}
              recoverable
              findUnitId={null}
              harnessId="grok"
              failure={null}
              settledNotice={null}
              settledNoticeFindUnitId={null}
            />
          </ChatTranscriptProvider>
        </TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  asked = [];
  mocks.client = hostClientRecordingUpdates();
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.ensurePack": { major: 1, minor: 0 },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  mocks.client = null;
});

describe("<ErrorSegment /> a provider whose command-line tool is out of date", () => {
  it("reads as an interruption in the host's words, and Update updates the provider on the host that ran the turn", async () => {
    const user = userEvent.setup();
    renderRow(
      "provider_outdated",
      "Grok's command-line tool is out of date.",
      new QueryClient(),
    );

    const row = screen
      .getByText("Grok's command-line tool is out of date.")
      .closest("[data-failure-presentation]");
    expect(row?.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(screen.getByText("Out of date")).toBeTruthy();
    // The code is the client's to key on, never the reader's to see.
    expect(screen.queryByText("provider_outdated")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(asked).toEqual(["update grok"]));
  });

  it("checks for the provider's newest version first where the host's provider list names its pack", async () => {
    const user = userEvent.setup();
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.ensurePack": { major: 1, minor: 0 },
      "providers.refreshPackDiscovery": { major: 1, minor: 0 },
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        HOST_ID,
        "providers.list",
        { native: null },
      ),
      { providers: [{ providerId: "grok", packId: "grok" }] },
    );
    renderRow(
      "provider_outdated",
      "Grok's command-line tool is out of date.",
      queryClient,
    );

    await user.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(asked).toEqual(["check grok", "update grok"]));
  });

  it("offers no Update where the host cannot update the provider, and keeps the host's words for who does", () => {
    const owner =
      "Grok's command-line tool is out of date. The host's owner can update it.";
    renderRow("provider_outdated_host_owner", owner, new QueryClient());

    expect(screen.getByText(owner)).toBeTruthy();
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("offers no Update on a host that has no provider update", () => {
    resetNegotiatedManifests();
    renderRow(
      "provider_outdated",
      "Grok's command-line tool is out of date.",
      new QueryClient(),
    );

    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});
