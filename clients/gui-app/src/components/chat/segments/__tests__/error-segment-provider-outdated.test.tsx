/**
 * The error row of a turn the provider refused because its command-line tool
 * is out of date (Tracy Bots T71), through the real `ErrorSegment` inside a
 * transcript: it reads as an interruption in the host's words, and offers
 * Update only for the code the host gives where it can update the provider.
 * Update reaches the host that ran the turn over a host client whose
 * messenger plays that host: it records what it is asked and holds the
 * provider's install state, which the row watches until the install settles.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderCliState,
  ProviderManagedInstallState,
  ProviderPackVersionInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { ErrorSegment } from "../error-segment";

/** The host that ran the turn: the one the recording client addresses. */
const HOST_ID = mockRemoteHostEntry.hostId;

const OUTDATED = "Grok's command-line tool is out of date.";

const mocks = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.client,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

/** The version the host finds and sets out to install. */
const NEWEST = "1.0.20";
/** The version installed before the press. */
const INSTALLED = "1.0.13";

/** The host the turn ran on, as its RPCs answer. */
type FakeHost = {
  /** What it was asked, in order: each list read, check and update. */
  asked: ReadonlyArray<string>;
  /** Grok's single install slot, as `providers.list` reports it. */
  install: ProviderManagedInstallState;
  /** {@link NEWEST}'s own row in Grok's version manager; `null` for none. */
  newest: ProviderPackVersionInstallState | null;
  /** How `providers.ensurePack` answers. */
  ensure: "starts" | "finishes-at-once" | "nothing-newer" | Error;
  /** Runs while the host answers `providers.ensurePack`, after it took it. */
  whileAnswering: (() => Promise<void>) | null;
  /** The host stops answering `providers.list` (a slow host). */
  listStalls: boolean;
};

let host: FakeHost;

function grokRow(): ProviderCliState {
  return {
    providerId: "grok",
    packId: "grok",
    managedInstallState: host.install,
    managedVersions:
      host.newest === null
        ? null
        : {
            autoDownload: true,
            pinnedVersion: null,
            updateAvailable: null,
            sharedWithProviders: [],
            totalSizeBytes: null,
            available: [
              {
                version: NEWEST,
                sizeBytes: null,
                certification: "eligible",
                recommended: true,
                current: false,
                installState: host.newest,
              },
            ],
          },
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

function hostClientPlaying(
  queryClient: QueryClient,
): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-update",
    handlers: {
      "providers.list": () => {
        host.asked = [...host.asked, "list"];
        if (host.listStalls) return new Promise(() => undefined);
        return { providers: [grokRow()], native: null };
      },
      "providers.refreshPackDiscovery": (params) => {
        host.asked = [...host.asked, `check ${params.packId}`];
        return { result: { ok: true, outcome: "moved" } };
      },
      "providers.ensurePack": async (params) => {
        host.asked = [...host.asked, `update ${params.providerId}`];
        if (host.ensure instanceof Error) throw host.ensure;
        if (host.ensure === "nothing-newer") {
          return { managedInstallState: host.install };
        }
        const started: ProviderManagedInstallState = {
          status: "downloading",
          percent: 10,
          version: NEWEST,
        };
        host.install =
          host.ensure === "finishes-at-once"
            ? { status: "installed", version: NEWEST }
            : started;
        await host.whileAnswering?.();
        return { managedInstallState: started };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    // The app's policy, which grants the update check its long timeout.
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** Another view of the host's provider list, open beside the row. */
function ListViewer(): null {
  useProvidersListForClient(mocks.client, { enabled: true, subscribed: true });
  return null;
}

function renderRow(
  code: string,
  message: string,
  listOpenElsewhere: boolean,
): QueryClient {
  const queryClient = createAppQueryClient();
  mocks.client = hostClientPlaying(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      {listOpenElsewhere ? <ListViewer /> : null}
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
  return queryClient;
}

function hostOffers(methods: ReadonlyArray<string>): void {
  recordNegotiatedHostManifest(
    HOST_ID,
    Object.fromEntries(
      methods.map((method) => [method, { major: 1, minor: 0 }]),
    ),
  );
}

function updateButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Update" });
}

beforeEach(() => {
  host = {
    asked: [],
    install: { status: "installed", version: INSTALLED },
    newest: null,
    ensure: "starts",
    whileAnswering: null,
    listStalls: false,
  };
  hostOffers(["providers.ensurePack"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  resetNegotiatedManifests();
  mocks.client = null;
});

describe("<ErrorSegment /> a provider whose command-line tool is out of date", () => {
  it("reads as an interruption in the host's words, and Update updates the provider on the host that ran the turn", async () => {
    const user = userEvent.setup();
    renderRow("provider_outdated", OUTDATED, false);

    const row = screen
      .getByText(OUTDATED)
      .closest("[data-failure-presentation]");
    expect(row?.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(screen.getByText("Out of date")).toBeTruthy();
    // The code is the client's to key on, never the reader's to see.
    expect(screen.queryByText("provider_outdated")).toBeNull();

    await user.click(updateButton());

    await waitFor(() => expect(host.asked).toContain("update grok"));
    // No check where the host has none: the update runs on what it knows.
    expect(host.asked.filter((asked) => asked.startsWith("check"))).toEqual([]);
  });

  it("checks for the provider's newest version first, with the pack the cached provider list names", async () => {
    const user = userEvent.setup();
    hostOffers(["providers.ensurePack", "providers.refreshPackDiscovery"]);
    const queryClient = renderRow("provider_outdated", OUTDATED, false);
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        HOST_ID,
        "providers.list",
        { native: null },
      ),
      { providers: [grokRow()], native: null },
    );

    await user.click(updateButton());

    await waitFor(() => expect(host.asked).toContain("update grok"));
    expect(host.asked.slice(0, 2)).toEqual(["check grok", "update grok"]);
  });

  it("reads the provider list from the host to find the pack when none is cached, then checks before it updates", async () => {
    const user = userEvent.setup();
    hostOffers(["providers.ensurePack", "providers.refreshPackDiscovery"]);
    renderRow("provider_outdated", OUTDATED, false);

    await user.click(updateButton());

    await waitFor(() => expect(host.asked).toContain("update grok"));
    expect(host.asked.slice(0, 3)).toEqual([
      "list",
      "check grok",
      "update grok",
    ]);
  });

  it("stays pending while the host installs the update, and is ready again once the version it set out to install is installed", async () => {
    const user = userEvent.setup();
    const queryClient = renderRow("provider_outdated", OUTDATED, false);

    await user.click(updateButton());

    // The host took the request and is downloading: the press is not over.
    await waitFor(() =>
      expect(host.asked.filter((asked) => asked === "list")).toHaveLength(2),
    );
    expect(updateButton().disabled).toBe(true);

    host.install = { status: "installed", version: NEWEST };
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    });

    await waitFor(() => expect(updateButton().disabled).toBe(false));
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
  });

  it("says why when the host's install of the update fails", async () => {
    const user = userEvent.setup();
    const queryClient = renderRow("provider_outdated", OUTDATED, false);

    await user.click(updateButton());
    await waitFor(() => expect(updateButton().disabled).toBe(true));

    host.install = {
      status: "error",
      reason: "network",
      version: null,
      message: "fetch failed",
      retryAtMs: null,
    };
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    });

    expect(
      (await screen.findByTestId("provider-update-failure")).textContent,
    ).toBe(
      "The update failed: the download could not be reached. Retry when you're back online.",
    );
    expect(updateButton().disabled).toBe(false);
  });

  it("says why when the replacement fails while the old copy stays runnable, which the host's slot reports as installed", async () => {
    const user = userEvent.setup();
    const queryClient = renderRow("provider_outdated", OUTDATED, false);

    await user.click(updateButton());
    await waitFor(() => expect(updateButton().disabled).toBe(true));

    // The host's slot answers with the runnable old copy before its error;
    // the version it set out to install says what happened to it.
    host.install = { status: "installed", version: INSTALLED };
    host.newest = {
      status: "error",
      reason: "network",
      message: "fetch failed",
      retryAtMs: null,
    };
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    });

    expect(
      (await screen.findByTestId("provider-update-failure")).textContent,
    ).toBe(
      "The update failed: the download could not be reached. Retry when you're back online.",
    );
    expect(updateButton().disabled).toBe(false);
  });

  it("settles on a list read the host answered after it took the request, though that read finished before the request's own answer", async () => {
    const user = userEvent.setup();
    // The host installs at once and never reports downloading. Another view
    // of its list reads it while the host is still answering the request,
    // and every read after that one stalls.
    host.ensure = "finishes-at-once";
    // Every read of the clock a tick later than the last, so the times say
    // the order things happened in.
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => ++clock);
    const queryClient = renderRow("provider_outdated", OUTDATED, true);
    host.whileAnswering = async () => {
      await queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
      });
      host.listStalls = true;
    };

    await user.click(updateButton());

    await waitFor(() => expect(host.listStalls).toBe(true));
    await waitFor(() => expect(updateButton().disabled).toBe(false));
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
  });

  it("says so when the host has no newer version to install", async () => {
    const user = userEvent.setup();
    host.ensure = "nothing-newer";
    renderRow("provider_outdated", OUTDATED, false);

    await user.click(updateButton());

    expect(
      (await screen.findByTestId("provider-update-failure")).textContent,
    ).toBe("There's no newer version to install yet.");
  });

  it("says why when the host refuses the update", async () => {
    const user = userEvent.setup();
    host.ensure = new Error("Grok is disabled on this host.");
    renderRow("provider_outdated", OUTDATED, false);

    await user.click(updateButton());

    expect(
      (await screen.findByTestId("provider-update-failure")).textContent,
    ).toContain("Grok is disabled on this host.");
    expect(updateButton().disabled).toBe(false);
  });

  it("offers no Update where the host cannot update the provider, and keeps the host's words for who does", () => {
    const owner = `${OUTDATED} The host's owner can update it.`;
    renderRow("provider_outdated_host_owner", owner, false);

    expect(screen.getByText(owner)).toBeTruthy();
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("offers no Update on a host that has no provider update", () => {
    resetNegotiatedManifests();
    renderRow("provider_outdated", OUTDATED, false);

    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});
