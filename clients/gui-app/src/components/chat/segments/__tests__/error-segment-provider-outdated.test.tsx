/**
 * The error row of a turn the provider refused because its command-line tool
 * is out of date (Tracy Bots T71), through the real `ErrorSegment` inside a
 * transcript: it reads as an interruption in the host's words, and offers
 * Update only for the code the host gives where it can update the provider.
 * Update reaches the host that ran the turn over a host client whose
 * messenger plays that host: it records what it is asked and holds the
 * provider's install slot, which the row reports as the host's list presents
 * it.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClientProvider,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
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
} from "@traycer/protocol/host/provider-schemas";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetProfileEnabledForClient } from "@/hooks/providers/use-providers-set-profile-enabled-mutation";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
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

const LIST_KEY = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
  HOST_ID,
  "providers.list",
  { native: null },
);

/** The host the turn ran on, as its RPCs answer. */
type FakeHost = {
  /** What it was asked, in order: each list read, check and update. */
  asked: ReadonlyArray<string>;
  /** Grok's single install slot, as `providers.list` reports it. */
  install: ProviderManagedInstallState;
  /**
   * How `providers.ensurePack` answers: the install starts, finishes before
   * the answer is assembled, or is refused.
   */
  ensure: "starts" | "finishes-at-once" | Error;
  /**
   * While set, `providers.list` answers only once it settles, with the slot
   * as it stood when the read arrived (a slow host).
   */
  listHeld: Promise<void> | null;
  /** How many of the next `providers.list` reads fail. */
  listRefusals: number;
};

let host: FakeHost;
/** The host client the row's requesters are cut from. */
let playingSpine: HostClient<HostRpcRegistry> | null = null;
/** Renders the rows again, as fresh elements. */
let rerenderRows: () => void = () => undefined;

function grokRow(): ProviderCliState {
  return {
    providerId: "grok",
    packId: "grok",
    managedInstallState: host.install,
    managedVersions: null,
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
  const hosts = [mockRemoteHostEntry, mockLocalHostEntry];
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-update",
    handlers: {
      "providers.list": async () => {
        host.asked = [...host.asked, "list"];
        if (host.listRefusals > 0) {
          host.listRefusals -= 1;
          throw new Error("The host did not answer the list.");
        }
        const answer = { providers: [grokRow()], native: null };
        await host.listHeld;
        return answer;
      },
      "providers.refreshPackDiscovery": (params) => {
        host.asked = [...host.asked, `check ${params.packId}`];
        return { result: { ok: true, outcome: "moved" } };
      },
      "providers.setProfileEnabled": (params) => {
        host.asked = [...host.asked, `toggle ${params.profileId}`];
        return { profileId: params.profileId, enabled: params.enabled };
      },
      "providers.ensurePack": (params) => {
        host.asked = [...host.asked, `update ${params.providerId}`];
        if (host.ensure instanceof Error) return Promise.reject(host.ensure);
        host.install =
          host.ensure === "finishes-at-once"
            ? { status: "installed", version: NEWEST }
            : { status: "downloading", percent: 10, version: NEWEST };
        return { managedInstallState: host.install };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    // The app's policy, which grants the update check its long timeout.
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hosts.find((entry) => entry.hostId === hostId) ?? null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine;
}

/** Holds every `providers.list` answer until the returned release runs. */
function holdList(): () => void {
  let release = (): void => undefined;
  host.listHeld = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    host.listHeld = null;
    release();
  };
}

function listReads(): number {
  return host.asked.filter((asked) => asked === "list").length;
}

function renderRow(code: string, message: string): QueryClient {
  return renderRows(code, message, ["turn-1"]);
}

/** One error row per turn, each with its own Update, in one transcript. */
function renderRows(
  code: string,
  message: string,
  turnIds: ReadonlyArray<string>,
): QueryClient {
  const queryClient = createAppQueryClient();
  const spine = hostClientPlaying(queryClient);
  playingSpine = spine;
  mocks.client = spine.createRequester(mockRemoteHostEntry);
  const tree = (): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId={HOST_ID}>
          <ChatTranscriptProvider value={{ chatId: "chat-1", hostId: HOST_ID }}>
            {turnIds.map((turnId) => (
              <ErrorSegment
                key={turnId}
                turnId={turnId}
                message={message}
                code={code}
                recoverable
                findUnitId={null}
                harnessId="grok"
                failure={null}
                settledNotice={null}
                settledNoticeFindUnitId={null}
              />
            ))}
          </ChatTranscriptProvider>
        </TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  rerenderRows = () => view.rerender(tree());
  return queryClient;
}

/**
 * Settings' providers panel, open beside the row: it watches the host's
 * provider list and has a switch for one of Grok's profiles.
 */
function ProvidersPanel(): React.JSX.Element {
  useProvidersListForClient(mocks.client, { enabled: true, subscribed: true });
  const toggle = useProvidersSetProfileEnabledForClient(mocks.client, "grok");
  return (
    <button
      type="button"
      onClick={() =>
        toggle.mutate({ providerId: "grok", profileId: "work", enabled: false })
      }
    >
      Turn off profile
    </button>
  );
}

function updateButtons(): ReadonlyArray<HTMLButtonElement> {
  return screen.getAllByRole<HTMLButtonElement>("button", { name: "Update" });
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
    ensure: "starts",
    listHeld: null,
    listRefusals: 0,
  };
  hostOffers(["providers.ensurePack"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  resetNegotiatedManifests();
  mocks.client = null;
  playingSpine = null;
  rerenderRows = () => undefined;
});

describe("<ErrorSegment /> a provider whose command-line tool is out of date", () => {
  it("reads as an interruption in the host's words, and Update updates the provider on the host that ran the turn", async () => {
    const user = userEvent.setup();
    renderRow("provider_outdated", OUTDATED);

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
    const queryClient = renderRow("provider_outdated", OUTDATED);
    queryClient.setQueryData(LIST_KEY, {
      providers: [grokRow()],
      native: null,
    });

    await user.click(updateButton());

    await waitFor(() => expect(host.asked).toContain("update grok"));
    expect(host.asked.slice(0, 2)).toEqual(["check grok", "update grok"]);
  });

  it("reads the provider list from the host to find the pack when none is cached, then checks before it updates", async () => {
    const user = userEvent.setup();
    hostOffers(["providers.ensurePack", "providers.refreshPackDiscovery"]);
    renderRow("provider_outdated", OUTDATED);

    await user.click(updateButton());

    await waitFor(() => expect(host.asked).toContain("update grok"));
    expect(host.asked.slice(0, 3)).toEqual([
      "list",
      "check grok",
      "update grok",
    ]);
  });

  it("stays pending until a list read the host answered after it took the request, and an install that finished before the answer settles", async () => {
    const user = userEvent.setup();
    host.ensure = "finishes-at-once";
    const release = holdList();
    renderRow("provider_outdated", OUTDATED);

    await user.click(updateButton());

    await waitFor(() => expect(listReads()).toBe(1));
    expect(host.asked).toEqual(["update grok", "list"]);
    expect(updateButton().disabled).toBe(true);

    release();

    await waitFor(() => expect(updateButton().disabled).toBe(false));
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
  });

  it("does not settle on a list read that left before the host took the request", async () => {
    const user = userEvent.setup();
    const release = holdList();
    const queryClient = renderRow("provider_outdated", OUTDATED);
    // Another surface's read, in flight from before the press: it answers
    // with the copy installed then, which reads as settled.
    void queryClient
      .fetchQuery(
        queryOptions({
          queryKey: LIST_KEY,
          queryFn: () =>
            mocks.client?.request("providers.list", { native: null }) ??
            Promise.reject(new Error("no client")),
        }),
      )
      .catch(() => undefined);
    await waitFor(() => expect(listReads()).toBe(1));

    await user.click(updateButton());
    await waitFor(() => expect(host.asked).toContain("update grok"));
    // The host client sends one list read at a time: the press's own read
    // goes out once the earlier one is answered.
    release();

    await waitFor(() => expect(listReads()).toBe(2));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{
          readonly providers: ReadonlyArray<ProviderCliState>;
        }>(LIST_KEY)?.providers[0]?.managedInstallState?.status,
      ).toBe("downloading"),
    );
    expect(updateButton().disabled).toBe(true);
  });

  it("settles every one of three Update rows on the host pressed one after another, each on a list answer after its own request", async () => {
    const user = userEvent.setup();
    host.ensure = "finishes-at-once";
    const release = holdList();
    const queryClient = renderRows("provider_outdated", OUTDATED, [
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
    // The cached list says the old copy is installed, which reads as settled.
    queryClient.setQueryData(LIST_KEY, {
      providers: [grokRow()],
      native: null,
    });
    const updates = (): number =>
      host.asked.filter((asked) => asked === "update grok").length;

    for (const [index, button] of updateButtons().entries()) {
      await user.click(button);
      await waitFor(() => expect(updates()).toBe(index + 1));
    }
    // Every update was answered; each press now waits on its list read.
    await waitFor(() =>
      expect(
        queryClient.isMutating({
          mutationKey: providersMutationKeys.ensurePack(),
        }),
      ).toBe(0),
    );
    expect(updateButtons().map((button) => button.disabled)).toEqual([
      true,
      true,
      true,
    ]);

    release();

    await waitFor(() =>
      expect(updateButtons().map((button) => button.disabled)).toEqual([
        false,
        false,
        false,
      ]),
    );
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
  });

  it("stays pending while a profile switch rewrites the cached list before the host answers the press's list read", async () => {
    const user = userEvent.setup();
    hostOffers(["providers.ensurePack", "providers.setProfileEnabled"]);
    host.ensure = "finishes-at-once";
    const release = holdList();
    const queryClient = renderRow("provider_outdated", OUTDATED);
    queryClient.setQueryData(LIST_KEY, {
      providers: [grokRow()],
      native: null,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ProvidersPanel />
      </QueryClientProvider>,
    );

    await user.click(updateButton());
    await waitFor(() => expect(host.asked).toContain("list"));
    // Each flip of the switch cancels the list's reads and writes its own
    // copy of the list, with no answer from the host.
    const flip = screen.getByRole("button", { name: "Turn off profile" });
    await user.click(flip);
    await user.click(flip);
    await waitFor(() =>
      expect(
        host.asked.filter((asked) => asked === "toggle work"),
      ).toHaveLength(2),
    );
    expect(updateButton().disabled).toBe(true);

    release();

    await waitFor(() => expect(updateButton().disabled).toBe(false));
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
  });

  it("stays pending across list reads while the host downloads, and is ready again once its slot reads installed", async () => {
    const user = userEvent.setup();
    const queryClient = renderRow("provider_outdated", OUTDATED);

    await user.click(updateButton());

    await waitFor(() => expect(listReads()).toBeGreaterThanOrEqual(1));
    const readsWhileStarting = listReads();
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    });
    await waitFor(() =>
      expect(listReads()).toBeGreaterThan(readsWhileStarting),
    );
    expect(updateButton().disabled).toBe(true);

    host.install = { status: "installed", version: NEWEST };
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    });

    await waitFor(() => expect(updateButton().disabled).toBe(false));
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
  });

  // The only failure the row can show at the click is the slot's error, which
  // the host's list reports only while no copy of the provider is runnable: a
  // replacement that fails beside a runnable old copy reads as installed and
  // settles, and the next refused turn offers Update again.
  it("says why when the host's slot reports the install in error, as it does where no copy is runnable", async () => {
    const user = userEvent.setup();
    host.install = { status: "absent" };
    const queryClient = renderRow("provider_outdated", OUTDATED);

    await user.click(updateButton());
    await waitFor(() => expect(updateButton().disabled).toBe(true));

    host.install = {
      status: "error",
      reason: "network",
      version: NEWEST,
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

  it("stays pending with no failure when the list read after the update fails, until the list's own next read answers, and asks for the update once", async () => {
    const user = userEvent.setup();
    host.listRefusals = 1;
    const release = holdList();
    const queryClient = renderRow("provider_outdated", OUTDATED);

    await user.click(updateButton());

    // The press's own read failed; the list's next read is out.
    await waitFor(() => expect(listReads()).toBe(2));
    expect(updateButton().disabled).toBe(true);
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();

    release();
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{
          readonly providers: ReadonlyArray<ProviderCliState>;
        }>(LIST_KEY)?.providers[0]?.managedInstallState?.status,
      ).toBe("downloading"),
    );
    expect(updateButton().disabled).toBe(true);

    host.install = { status: "installed", version: NEWEST };
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "providers.list"),
    });

    await waitFor(() => expect(updateButton().disabled).toBe(false));
    expect(screen.queryByTestId("provider-update-failure")).toBeNull();
    expect(host.asked.filter((asked) => asked === "update grok")).toEqual([
      "update grok",
    ]);
  });

  it("drops what a press says once the row's client answers for another host", async () => {
    const user = userEvent.setup();
    host.ensure = new Error("Grok is disabled on this host.");
    renderRow("provider_outdated", OUTDATED);
    await user.click(updateButton());
    await screen.findByTestId("provider-update-failure");

    mocks.client = playingSpine?.createRequester(mockLocalHostEntry) ?? null;
    rerenderRows();

    await waitFor(() =>
      expect(screen.queryByTestId("provider-update-failure")).toBeNull(),
    );
    expect(updateButton().disabled).toBe(false);
  });

  it("says why when the host refuses the update", async () => {
    const user = userEvent.setup();
    host.ensure = new Error("Grok is disabled on this host.");
    renderRow("provider_outdated", OUTDATED);

    await user.click(updateButton());

    expect(
      (await screen.findByTestId("provider-update-failure")).textContent,
    ).toContain("Grok is disabled on this host.");
    expect(updateButton().disabled).toBe(false);
  });

  it("offers no Update where the host cannot update the provider, and keeps the host's words for who does", () => {
    const owner = `${OUTDATED} The host's owner can update it.`;
    renderRow("provider_outdated_host_owner", owner);

    expect(screen.getByText(owner)).toBeTruthy();
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("offers no Update on a host that has no provider update", () => {
    resetNegotiatedManifests();
    renderRow("provider_outdated", OUTDATED);

    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});
