import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  heldPortForwardLeaseSchema,
  ownedPortForwardSchema,
  type HeldPortForwardLease,
  type OwnedPortForward,
  type PortForwardListForHostResponse,
} from "@traycer/protocol/host/port-forward";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostPortForwardsCard } from "@/components/settings/panels/host-port-forwards-card";
import { useHostPortForwards } from "@/components/settings/panels/host-port-forwards-state";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

const HOST_ID = "host-1";
const HOST_ENTRY: HostDirectoryEntry = {
  hostId: HOST_ID,
  label: "My machine",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
};

// The scope's hosts, as the panel hands them to the card. The card names the
// other end of a forward from these and from nothing else.
const scopeHosts: { current: readonly HostScopeOption[] } = { current: [] };

function ownedForward(over: Partial<OwnedPortForward>): OwnedPortForward {
  return ownedPortForwardSchema.parse({
    forwardId: "owned-1",
    epicId: "epic-1",
    ownerAgentId: "agent-1",
    description: "dev server",
    target: { hostId: "host-target", port: 3000 },
    listen: { hostId: HOST_ID, requestedPort: 8080, boundPort: null },
    state: "active",
    stateReason: null,
    createdAtMs: 1,
    counters: {
      openConnections: 1,
      totalConnections: 4,
      bytesIn: 100,
      bytesOut: 200,
    },
    recentEvents: [],
    ...over,
  });
}

function heldLease(over: Partial<HeldPortForwardLease>): HeldPortForwardLease {
  return heldPortForwardLeaseSchema.parse({
    leaseId: "lease-1",
    forwardId: "forward-1",
    epicId: "epic-1",
    ownerHostId: "host-owner",
    role: "listen",
    port: 9090,
    description: "reverse tunnel",
    createdAtMs: 1,
    openConnections: 0,
    ...over,
  });
}

function emptyList(): PortForwardListForHostResponse {
  return { owned: [], held: [] };
}

interface CardFixture {
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly setListResponse: (
    response:
      | PortForwardListForHostResponse
      | (() => Promise<PortForwardListForHostResponse>),
  ) => void;
}

function createCardFixture(): CardFixture {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  let listResponse:
    | PortForwardListForHostResponse
    | (() => Promise<PortForwardListForHostResponse>) = emptyList();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `req-${n}`;
      };
    })(),
    handlers: {
      "portForward.listForHost": () => {
        return typeof listResponse === "function"
          ? listResponse()
          : listResponse;
      },
      "portForward.stop": () => ({ stopped: true }),
      "portForward.cutLease": () => ({ cut: true }),
    },
  });
  const baseClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? HOST_ENTRY : null),
    messenger,
  });
  baseClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = baseClient.createRequester(HOST_ENTRY);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    Wrapper,
    client,
    messenger,
    setListResponse: (response) => {
      listResponse = response;
    },
  };
}

function listCallCount(messenger: MockHostMessenger<HostRpcRegistry>): number {
  return messenger.calls.filter(
    (call) => call.method === "portForward.listForHost",
  ).length;
}

const ALL_METHODS: readonly string[] = [
  "portForward.listForHost",
  "portForward.stop",
  "portForward.cutLease",
];

/**
 * The panel's own wiring: one real `useHostPortForwards` read handed to the
 * card, exactly as `HostSettingsPanel` does it.
 */
function CardHarness(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly usable: boolean;
  readonly connecting: boolean;
}): ReactNode {
  const ports = useHostPortForwards({
    client: props.client,
    hostId: props.hostId,
    usable: props.usable,
    connecting: props.connecting,
  });
  return (
    <HostPortForwardsCard
      ports={ports}
      client={props.client}
      hostId={props.hostId}
      hostName={props.hostName}
      hosts={scopeHosts.current}
    />
  );
}

function renderCard(
  fixture: CardFixture,
  overrides: {
    readonly hostId?: string | null;
    readonly hostName?: string;
    readonly usable?: boolean;
    readonly connecting?: boolean;
    readonly client?: HostClient<HostRpcRegistry> | null;
    /** The handshake's methods; `null` records no handshake at all. */
    readonly methods?: readonly string[] | null;
  },
) {
  const hostId = overrides.hostId === undefined ? HOST_ID : overrides.hostId;
  const methods =
    overrides.methods === undefined ? ALL_METHODS : overrides.methods;
  if (methods !== null && hostId !== null) {
    recordNegotiatedHostMethods(hostId, methods);
  }
  return render(
    <fixture.Wrapper>
      <CardHarness
        client={
          overrides.client === undefined ? fixture.client : overrides.client
        }
        hostId={hostId}
        hostName={overrides.hostName ?? "My machine"}
        usable={overrides.usable ?? true}
        connecting={overrides.connecting ?? false}
      />
    </fixture.Wrapper>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetNegotiatedManifests();
  scopeHosts.current = [];
});

describe("<HostPortForwardsCard />", () => {
  describe("states table", () => {
    it("connecting: the connecting shape, no list", () => {
      const fixture = createCardFixture();
      renderCard(fixture, { connecting: true, hostName: "Build box" });

      expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
        "Connecting to Build box",
      );
      expect(screen.queryByTestId("host-port-forwards-refresh")).toBeNull();
      expect(screen.queryByTestId("host-port-forwards-owned")).toBeNull();
    });

    it("unreachable: one sentence naming the host, no Refresh, and no read", () => {
      const fixture = createCardFixture();
      renderCard(fixture, { usable: false, hostName: "Build box" });

      expect(
        screen.getByTestId("host-port-forwards-unreachable").textContent,
      ).toBe(
        "Port forwards run on Build box, so they need a connection to it.",
      );
      expect(screen.queryByTestId("host-port-forwards-refresh")).toBeNull();
      expect(listCallCount(fixture.messenger)).toBe(0);
    });

    it("unsupported: the older-host sentence, no Refresh, and no read", () => {
      const fixture = createCardFixture();
      renderCard(fixture, { methods: [], hostName: "Build box" });

      const note = screen.getByTestId("host-port-forwards-unsupported");
      expect(note.textContent).toContain("Build box");
      expect(note.textContent).toContain("doesn't support this yet");
      expect(screen.queryByTestId("host-port-forwards-refresh")).toBeNull();
      expect(listCallCount(fixture.messenger)).toBe(0);
    });

    it("loading: the reading line while the first read is pending", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse(() => new Promise(() => undefined));
      renderCard(fixture, { hostName: "Build box" });

      expect(
        screen.getByTestId("host-port-forwards-loading").textContent,
      ).toContain("Reading Build box's port forwards…");
      await waitFor(() => {
        expect(listCallCount(fixture.messenger)).toBe(1);
      });
      expect(screen.queryByTestId("host-port-forwards-refresh")).toBeNull();
    });

    it("unreadable: the notice, then Refresh", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse(() => Promise.reject(new Error("boom")));
      renderCard(fixture, { hostName: "Build box" });

      const note = await screen.findByTestId("host-port-forwards-unreadable");
      expect(note.textContent).toBe("Couldn't read Build box's port forwards.");
      const refresh = screen.getByTestId("host-port-forwards-refresh");
      expect(
        note.compareDocumentPosition(refresh) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByTestId("host-port-forwards-loading")).toBeNull();
    });

    it("empty: the empty sentence, with no groups and no Refresh", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse(emptyList());
      renderCard(fixture, { hostName: "Build box" });

      const note = await screen.findByTestId("host-port-forwards-empty");
      expect(note.textContent).toContain(
        "Nothing is forwarded through Build box.",
      );
      expect(screen.queryByTestId("host-port-forwards-owned")).toBeNull();
      expect(screen.queryByTestId("host-port-forwards-held")).toBeNull();
      expect(screen.queryByTestId("host-port-forwards-refresh")).toBeNull();
    });

    it("listed: both groups with their titles, then Refresh", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [ownedForward({})],
        held: [heldLease({})],
      });
      renderCard(fixture, {});

      const owned = await screen.findByTestId("host-port-forwards-owned");
      const held = screen.getByTestId("host-port-forwards-held");
      expect(owned.textContent).toContain("Forwards on this host");
      expect(held.textContent).toContain("Ports other machines hold here");
      const refresh = screen.getByTestId("host-port-forwards-refresh");
      expect(
        held.compareDocumentPosition(refresh) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByTestId("host-port-forwards-empty")).toBeNull();
    });

    it("draws only the owned group when nothing is held", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({ owned: [ownedForward({})], held: [] });
      renderCard(fixture, {});

      await screen.findByTestId("host-port-forwards-owned");
      expect(screen.queryByTestId("host-port-forwards-held")).toBeNull();
    });

    it("draws only the held group when nothing is owned", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({ owned: [], held: [heldLease({})] });
      renderCard(fixture, {});

      await screen.findByTestId("host-port-forwards-held");
      expect(screen.queryByTestId("host-port-forwards-owned")).toBeNull();
    });
  });

  describe("read gates", () => {
    it("makes no read while the host is not usable", () => {
      const fixture = createCardFixture();
      renderCard(fixture, { usable: false });

      expect(screen.getByTestId("host-port-forwards-unreachable")).toBeTruthy();
      expect(listCallCount(fixture.messenger)).toBe(0);
    });

    it("makes no read while the host's handshake lacks the method", () => {
      const fixture = createCardFixture();
      renderCard(fixture, { methods: ["portForward.stop"] });

      expect(screen.getByTestId("host-port-forwards-unsupported")).toBeTruthy();
      expect(listCallCount(fixture.messenger)).toBe(0);
    });

    it("makes no read before any handshake is recorded", () => {
      const fixture = createCardFixture();
      renderCard(fixture, { methods: null });

      expect(screen.getByTestId("host-port-forwards-loading")).toBeTruthy();
      expect(listCallCount(fixture.messenger)).toBe(0);
    });

    it("reads once the handshake lands", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({ owned: [ownedForward({})], held: [] });
      renderCard(fixture, { methods: null });
      expect(listCallCount(fixture.messenger)).toBe(0);

      act(() => {
        recordNegotiatedHostMethods(HOST_ID, ALL_METHODS);
      });

      await screen.findByTestId("host-port-forwards-owned");
      expect(listCallCount(fixture.messenger)).toBe(1);
    });
  });

  // A negative assertion needs a positive anchor: the listing's RPC is recorded
  // before React commits its result, so the empty sentence is awaited only after
  // the rows were shown, and the refresh is what takes them away.
  it("switches to the empty sentence once a read returns both tables empty", async () => {
    const fixture = createCardFixture();
    fixture.setListResponse({ owned: [ownedForward({})], held: [] });
    renderCard(fixture, {});
    await screen.findByTestId("host-port-forwards-owned");

    fixture.setListResponse(emptyList());
    fireEvent.click(screen.getByTestId("host-port-forwards-refresh"));

    await screen.findByTestId("host-port-forwards-empty");
    expect(screen.queryByTestId("host-port-forwards-owned")).toBeNull();
    expect(listCallCount(fixture.messenger)).toBe(2);
  });

  it("shows the unreadable notice when the first read fails", async () => {
    const fixture = createCardFixture();
    fixture.setListResponse(() => Promise.reject(new Error("boom")));
    renderCard(fixture, { hostName: "Build box" });

    await waitFor(() => {
      expect(screen.getByTestId("host-port-forwards-unreadable")).toBeTruthy();
    });
    expect(
      screen.getByTestId("host-port-forwards-unreadable").textContent,
    ).toBe("Couldn't read Build box's port forwards.");
  });

  it("a failed re-read after rows were shown replaces them with the unreadable line", async () => {
    const fixture = createCardFixture();
    fixture.setListResponse({ owned: [ownedForward({})], held: [] });
    renderCard(fixture, {});
    await screen.findByTestId("host-port-forward-owned-owned-1");

    fixture.setListResponse(() => Promise.reject(new Error("boom")));
    fireEvent.click(screen.getByTestId("host-port-forwards-refresh"));

    await screen.findByTestId("host-port-forwards-unreadable");
    expect(listCallCount(fixture.messenger)).toBe(2);
    expect(screen.queryByTestId("host-port-forward-owned-owned-1")).toBeNull();
    expect(screen.queryByTestId("host-port-forwards-owned")).toBeNull();
  });

  it("keeps the unreadable line, not the loading one, while a retry from a failed first read is in flight", async () => {
    const fixture = createCardFixture();
    fixture.setListResponse(() => Promise.reject(new Error("boom")));
    renderCard(fixture, {});
    await screen.findByTestId("host-port-forwards-unreadable");
    expect(listCallCount(fixture.messenger)).toBe(1);

    fixture.setListResponse(() => new Promise(() => undefined));
    fireEvent.click(screen.getByTestId("host-port-forwards-refresh"));

    await waitFor(() => {
      expect(listCallCount(fixture.messenger)).toBe(2);
    });
    expect(screen.getByTestId("host-port-forwards-unreadable")).toBeTruthy();
    expect(screen.queryByTestId("host-port-forwards-loading")).toBeNull();
  });

  describe("owned forward rows", () => {
    it("renders the description, port badge, Forwarding state, and open-connections count", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            description: "api server",
            state: "active",
            counters: {
              openConnections: 1,
              totalConnections: 1,
              bytesIn: 0,
              bytesOut: 0,
            },
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1"),
        ).toBeTruthy();
      });
      const row = screen.getByTestId("host-port-forward-owned-owned-1");
      expect(row.textContent).toContain("api server");
      expect(row.textContent).toContain(":8080");
      expect(row.textContent).toContain("Forwarding");
      expect(row.textContent).toContain("1 open connection");
      expect(row.textContent).not.toContain("1 open connections");
    });

    it("pluralizes the open-connections count", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            counters: {
              openConnections: 3,
              totalConnections: 5,
              bytesIn: 0,
              bytesOut: 0,
            },
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1").textContent,
        ).toContain("3 open connections");
      });
    });

    it("shows Interrupted with its stateReason instead of connection counters", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            state: "interrupted",
            stateReason: "the target refused the connection",
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1"),
        ).toBeTruthy();
      });
      const row = screen.getByTestId("host-port-forward-owned-owned-1");
      expect(row.textContent).toContain("Interrupted");
      expect(row.textContent).toContain("the target refused the connection");
      expect(row.textContent).not.toContain("open connection");
    });

    it("labels the button Stop while active and Clear while interrupted", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({ forwardId: "active-1", state: "active" }),
          ownedForward({ forwardId: "interrupted-1", state: "interrupted" }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-stop-active-1"),
        ).toBeTruthy();
      });
      expect(
        screen.getByTestId("host-port-forward-stop-active-1").textContent,
      ).toBe("Stop");
      expect(
        screen.getByTestId("host-port-forward-stop-interrupted-1").textContent,
      ).toBe("Clear");
    });

    it("sends portForward.stop with the forwardId on click and refetches the listing after success", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [ownedForward({ forwardId: "owned-1" })],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-stop-owned-1"),
        ).toBeTruthy();
      });
      expect(listCallCount(fixture.messenger)).toBe(1);

      fireEvent.click(screen.getByTestId("host-port-forward-stop-owned-1"));

      await waitFor(() => {
        expect(
          fixture.messenger.calls.filter(
            (call) => call.method === "portForward.stop",
          ),
        ).toHaveLength(1);
      });
      expect(
        fixture.messenger.calls.find(
          (call) => call.method === "portForward.stop",
        )?.params,
      ).toEqual({ forwardId: "owned-1" });

      await waitFor(() => {
        expect(listCallCount(fixture.messenger)).toBe(2);
      });
    });

    it("shows Binding with a requested-port badge (no bound port yet, no counters, no bare port badge)", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            state: "binding",
            listen: { hostId: HOST_ID, requestedPort: 9090, boundPort: null },
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1"),
        ).toBeTruthy();
      });
      const row = screen.getByTestId("host-port-forward-owned-owned-1");
      expect(row.textContent).toContain("requested :9090");
      expect(row.textContent).toContain("Binding");
      expect(row.textContent).toContain("Nothing is listening yet");
      expect(row.textContent).not.toContain("open connection");
      expect(row.textContent).not.toContain(" in · ");
      // The only occurrence of `:9090` anywhere in the row's text must be the
      // one inside "requested :9090" - stripping that phrase out must leave no
      // bare `:9090` badge behind.
      expect(row.textContent.replace("requested :9090", "")).not.toContain(
        ":9090",
      );
      expect(
        screen.getByTestId("host-port-forward-stop-owned-1").textContent,
      ).toBe("Stop");
    });

    it("shows Stopped with its stateReason, no counters, and a Clear button", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            state: "stopped",
            stateReason: "the user stopped it",
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1"),
        ).toBeTruthy();
      });
      const row = screen.getByTestId("host-port-forward-owned-owned-1");
      expect(row.textContent).toContain("Stopped");
      expect(row.textContent).toContain("the user stopped it");
      expect(row.textContent).not.toContain("open connection");
      expect(
        screen.getByTestId("host-port-forward-stop-owned-1").textContent,
      ).toBe("Clear");
    });

    it("stamps each row's data-state with its own owned state", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({ forwardId: "binding-1", state: "binding" }),
          ownedForward({ forwardId: "active-1", state: "active" }),
          ownedForward({ forwardId: "interrupted-1", state: "interrupted" }),
          ownedForward({ forwardId: "stopped-1", state: "stopped" }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-binding-1"),
        ).toBeTruthy();
      });
      expect(
        screen
          .getByTestId("host-port-forward-owned-binding-1")
          .getAttribute("data-state"),
      ).toBe("binding");
      expect(
        screen
          .getByTestId("host-port-forward-owned-active-1")
          .getAttribute("data-state"),
      ).toBe("active");
      expect(
        screen
          .getByTestId("host-port-forward-owned-interrupted-1")
          .getAttribute("data-state"),
      ).toBe("interrupted");
      expect(
        screen
          .getByTestId("host-port-forward-owned-stopped-1")
          .getAttribute("data-state"),
      ).toBe("stopped");
    });
  });

  describe("held lease rows", () => {
    it("renders the description, port, and a Listening for role badge naming the owner machine", async () => {
      scopeHosts.current = [
        hostScopeOptionFixture({ hostId: "host-owner", name: "Owner box" }),
      ];
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [
          heldLease({
            leaseId: "lease-1",
            description: "reverse tunnel",
            port: 9090,
            role: "listen",
            ownerHostId: "host-owner",
          }),
        ],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-held-lease-1"),
        ).toBeTruthy();
      });
      const row = screen.getByTestId("host-port-forward-held-lease-1");
      expect(row.textContent).toContain("reverse tunnel");
      expect(row.textContent).toContain(":9090");
      expect(row.textContent).toContain("Listening for Owner box");
    });

    it("labels a target-role lease Reached by the owner machine", async () => {
      scopeHosts.current = [
        hostScopeOptionFixture({ hostId: "host-owner", name: "Owner box" }),
      ];
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [
          heldLease({
            leaseId: "lease-1",
            role: "target",
            ownerHostId: "host-owner",
          }),
        ],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-held-lease-1").textContent,
        ).toContain("Reached by Owner box");
      });
    });

    it("opens a confirm dialog naming the port and owner machine on Cut, and sends nothing on cancel", async () => {
      scopeHosts.current = [
        hostScopeOptionFixture({ hostId: "host-owner", name: "Owner box" }),
      ];
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [
          heldLease({
            leaseId: "lease-1",
            port: 9090,
            ownerHostId: "host-owner",
          }),
        ],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-cut-lease-1"),
        ).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("host-port-forward-cut-lease-1"));

      const dialog = screen.getByTestId("confirm-destructive-dialog");
      expect(dialog.textContent).toContain("9090");
      expect(dialog.textContent).toContain("Owner box");

      fireEvent.click(screen.getByTestId("confirm-cancel"));

      expect(
        fixture.messenger.calls.filter(
          (call) => call.method === "portForward.cutLease",
        ),
      ).toHaveLength(0);
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });

    it("sends portForward.cutLease with the leaseId on confirm and refetches the listing after success", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [heldLease({ leaseId: "lease-1" })],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-cut-lease-1"),
        ).toBeTruthy();
      });
      expect(listCallCount(fixture.messenger)).toBe(1);

      fireEvent.click(screen.getByTestId("host-port-forward-cut-lease-1"));
      fireEvent.click(screen.getByTestId("confirm-action"));

      await waitFor(() => {
        expect(
          fixture.messenger.calls.filter(
            (call) => call.method === "portForward.cutLease",
          ),
        ).toHaveLength(1);
      });
      expect(
        fixture.messenger.calls.find(
          (call) => call.method === "portForward.cutLease",
        )?.params,
      ).toEqual({ leaseId: "lease-1" });

      await waitFor(() => {
        expect(listCallCount(fixture.messenger)).toBe(2);
      });
    });
  });

  describe("an armed Cut confirmation", () => {
    function cutCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
      return messenger.calls.filter(
        (call) => call.method === "portForward.cutLease",
      );
    }

    it("closes when the same host becomes unreachable, without sending a cut", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [heldLease({ leaseId: "lease-1" })],
      });
      const view = renderCard(fixture, {});
      fireEvent.click(
        await screen.findByTestId("host-port-forward-cut-lease-1"),
      );
      expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();

      view.rerender(
        <fixture.Wrapper>
          <CardHarness
            client={null}
            hostId={HOST_ID}
            hostName="My machine"
            usable={false}
            connecting={false}
          />
        </fixture.Wrapper>,
      );

      await screen.findByTestId("host-port-forwards-unreachable");
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      expect(cutCalls(fixture.messenger)).toHaveLength(0);
    });

    it("closes when the next read returns both lists empty, without sending a cut", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [heldLease({ leaseId: "lease-1" })],
      });
      renderCard(fixture, {});
      fireEvent.click(
        await screen.findByTestId("host-port-forward-cut-lease-1"),
      );
      expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
      expect(listCallCount(fixture.messenger)).toBe(1);

      fixture.setListResponse(emptyList());
      fireEvent.click(screen.getByTestId("host-port-forwards-refresh"));

      await screen.findByTestId("host-port-forwards-empty");
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      expect(cutCalls(fixture.messenger)).toHaveLength(0);
      expect(listCallCount(fixture.messenger)).toBe(2);
    });

    it("stays open when only its own lease vanishes and other rows remain", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [],
        held: [
          heldLease({ leaseId: "lease-1" }),
          heldLease({ leaseId: "lease-2", forwardId: "forward-2" }),
        ],
      });
      renderCard(fixture, {});
      fireEvent.click(
        await screen.findByTestId("host-port-forward-cut-lease-1"),
      );
      expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();

      fixture.setListResponse({
        owned: [],
        held: [heldLease({ leaseId: "lease-2", forwardId: "forward-2" })],
      });
      fireEvent.click(screen.getByTestId("host-port-forwards-refresh"));

      await waitFor(() => {
        expect(listCallCount(fixture.messenger)).toBe(2);
      });
      await waitFor(() => {
        expect(
          screen.queryByTestId("host-port-forward-held-lease-1"),
        ).toBeNull();
      });
      expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();

      fireEvent.click(screen.getByTestId("confirm-action"));
      await waitFor(() => {
        expect(cutCalls(fixture.messenger)).toHaveLength(1);
      });
      expect(cutCalls(fixture.messenger)[0]?.params).toEqual({
        leaseId: "lease-1",
      });
    });
  });

  it("triggers another portForward.listForHost request from the Refresh button", async () => {
    const fixture = createCardFixture();
    fixture.setListResponse({
      owned: [ownedForward({ forwardId: "owned-1" })],
      held: [],
    });
    renderCard(fixture, {});

    await waitFor(() => {
      expect(
        screen.getByTestId("host-port-forward-owned-owned-1"),
      ).toBeTruthy();
    });
    expect(listCallCount(fixture.messenger)).toBe(1);

    fireEvent.click(screen.getByTestId("host-port-forwards-refresh"));

    await waitFor(() => {
      expect(listCallCount(fixture.messenger)).toBe(2);
    });
  });

  describe("machine naming", () => {
    it("names this card's own host with hostName", async () => {
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            listen: { hostId: HOST_ID, requestedPort: 8080, boundPort: null },
            target: { hostId: "host-target", port: 3000 },
          }),
        ],
        held: [],
      });
      renderCard(fixture, { hostName: "My machine" });

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1").textContent,
        ).toContain("My machine:8080");
      });
    });

    it("names a host the scope knows by its name", async () => {
      scopeHosts.current = [
        hostScopeOptionFixture({ hostId: "host-target", name: "Build box" }),
      ];
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            target: { hostId: "host-target", port: 3000 },
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1").textContent,
        ).toContain("Build box:3000");
      });
    });

    it("names an unknown host another machine", async () => {
      scopeHosts.current = [];
      const fixture = createCardFixture();
      fixture.setListResponse({
        owned: [
          ownedForward({
            forwardId: "owned-1",
            target: { hostId: "host-unknown", port: 3000 },
          }),
        ],
        held: [],
      });
      renderCard(fixture, {});

      await waitFor(() => {
        expect(
          screen.getByTestId("host-port-forward-owned-owned-1").textContent,
        ).toContain("another machine:3000");
      });
    });
  });
});
