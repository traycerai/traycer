// Same boundaries as the tabbed-shell suite: the scope and the ambient binding
// are mocked, everything from the panel down is real.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly getLocalEntry: () => { readonly hostId: string } | null;
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  heldPortForwardLeaseSchema,
  ownedPortForwardSchema,
  type HeldPortForwardLease,
  type OwnedPortForward,
  type PortForwardListForHostResponse,
} from "@traycer/protocol/host/port-forward";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  selectHostOverviewTab,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { resetSettingsOpenIntentForTests } from "@/stores/tabs/settings-open-intent-store";

const LIST_METHOD = "portForward.listForHost";
const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;
const WITH_PORTS = [...OVERVIEW_METHODS, LIST_METHOD, "portForward.stop"];
const POLL_MS = 15_000;

function ownedForward(forwardId: string): OwnedPortForward {
  return ownedPortForwardSchema.parse({
    forwardId,
    epicId: "epic-1",
    ownerAgentId: "agent-1",
    description: `forward ${forwardId}`,
    target: { hostId: "host-target", port: 3000 },
    listen: { hostId: "host-a", requestedPort: 8080, boundPort: null },
    state: "active",
    stateReason: null,
    createdAtMs: 1,
    counters: {
      openConnections: 0,
      totalConnections: 0,
      bytesIn: 0,
      bytesOut: 0,
    },
    recentEvents: [],
  });
}

function heldLease(leaseId: string): HeldPortForwardLease {
  return heldPortForwardLeaseSchema.parse({
    leaseId,
    forwardId: `forward-${leaseId}`,
    epicId: "epic-1",
    ownerHostId: "host-owner",
    role: "listen",
    port: 9090,
    description: "reverse tunnel",
    createdAtMs: 1,
    openConnections: 0,
  });
}

/** The rows the fake host answers with; a test swaps it between reads. */
interface PortsSource {
  current: () => Promise<PortForwardListForHostResponse>;
}

function answering(
  owned: number,
  held: number,
): () => Promise<PortForwardListForHostResponse> {
  return () =>
    Promise.resolve({
      owned: Array.from({ length: owned }, (_, i) => ownedForward(`o${i}`)),
      held: Array.from({ length: held }, (_, i) => heldLease(`h${i}`)),
    });
}

interface Mounted {
  readonly fixture: OverviewHostFixture;
  readonly source: PortsSource;
  /** How many `portForward.listForHost` requests the fixture has answered. */
  readonly listCalls: () => number;
}

interface MountOptions {
  readonly methods: readonly string[];
  readonly health: "online" | "restarting";
  readonly answer: () => Promise<PortForwardListForHostResponse>;
}

/** A ready local host with a real client whose port lists come from `source`. */
function mountPanel(options: MountOptions): Mounted {
  const source: PortsSource = { current: options.answer };
  let listCalls = 0;
  const fixture = buildOverviewHostFixture({
    hostId: "host-a",
    isLocalMachine: true,
    overrideHandlers: {
      [LIST_METHOD]: () => {
        listCalls += 1;
        return source.current();
      },
    },
  });
  recordNegotiatedHostMethods("host-a", options.methods);
  hostBindingMock.current = {
    hostClient: fixture.client,
    directory: {
      getLocalEntry: () => null,
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
  const restarting = options.health === "restarting";
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: "host-a",
      isLocalMachine: true,
      connectable: true,
      isActive: true,
      health: restarting
        ? {
            state: "restarting",
            label: "Restarting",
            detail: null,
            tone: "idle",
            live: false,
          }
        : {
            state: "online",
            label: "Online",
            detail: null,
            tone: "live",
            live: true,
          },
    }),
    hostId: "host-a",
    status: "ready",
    client: fixture.client,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture, source, listCalls: () => listCalls };
}

const defaults: MountOptions = {
  methods: WITH_PORTS,
  health: "online",
  answer: answering(0, 0),
};

function portsTrigger(): HTMLElement {
  return screen.getByTestId("host-overview-tab-ports");
}

/** The count on the Ports trigger, or `null` when none is drawn. */
function triggerCount(): string | null {
  const badge = within(portsTrigger()).queryByTestId(
    "host-overview-ports-count",
  );
  return badge === null ? null : badge.getAttribute("data-count");
}

/** Lets pending mock RPCs settle, and moves the clock by `ms` (fake timers). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets already-resolved mock RPCs commit under real timers. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const initialInnerWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  resetNegotiatedManifests();
  resetSettingsOpenIntentForTests();
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  window.innerWidth = initialInnerWidth;
});

describe("Host Overview ▸ Ports tab and count", () => {
  it("polls portForward.listForHost on a 15 second fixed cadence", () => {
    expect(HOST_METHOD_POLL_TABLE[LIST_METHOD].poll).toEqual({
      kind: "fixed",
      intervalMs: 15_000,
    });
  });

  describe("the count on the trigger", () => {
    it("is owned plus held", async () => {
      const mounted = mountPanel({ ...defaults, answer: answering(2, 1) });

      await waitFor(() => {
        expect(triggerCount()).toBe("3");
      });
      expect(mounted.listCalls()).toBe(1);
      const badge = within(portsTrigger()).getByTestId(
        "host-overview-ports-count",
      );
      expect(badge.textContent).toContain("3");
      expect(badge.textContent).toContain(", 3 forwarded or held");
    });

    it("is read from the page's open, before the tab is ever visited", async () => {
      const mounted = mountPanel({ ...defaults, answer: answering(1, 0) });

      await waitFor(() => {
        expect(triggerCount()).toBe("1");
      });
      // Still on Status: the Ports pane has not been selected.
      expect(mounted.listCalls()).toBe(1);
      expect(
        screen
          .getByTestId("host-overview-tab-panel-ports")
          .getAttribute("data-state"),
      ).not.toBe("active");
    });

    it("is absent at zero", async () => {
      const mounted = mountPanel({ ...defaults, answer: answering(0, 0) });
      await selectHostOverviewTab("ports");

      await screen.findByTestId("host-port-forwards-empty");
      expect(mounted.listCalls()).toBe(1);
      expect(triggerCount()).toBeNull();
    });

    it("is absent on an unsupported host, which is never asked", async () => {
      const mounted = mountPanel({
        ...defaults,
        methods: OVERVIEW_METHODS,
        answer: answering(2, 1),
      });
      await selectHostOverviewTab("ports");

      await screen.findByTestId("host-port-forwards-unsupported");
      expect(mounted.listCalls()).toBe(0);
      expect(triggerCount()).toBeNull();
    });

    it("is absent on a failed read", async () => {
      const mounted = mountPanel({
        ...defaults,
        answer: () => Promise.reject(new Error("boom")),
      });
      await selectHostOverviewTab("ports");

      await screen.findByTestId("host-port-forwards-unreadable");
      expect(mounted.listCalls()).toBe(1);
      expect(triggerCount()).toBeNull();
    });

    it("is absent while the host is restarting, and the tab shows the connecting shape", async () => {
      const mounted = mountPanel({
        ...defaults,
        health: "restarting",
        answer: answering(2, 1),
      });
      await selectHostOverviewTab("ports");

      const pane = screen.getByTestId("host-overview-tab-panel-ports");
      expect(within(pane).getByTestId("host-scope-connecting")).toBeTruthy();
      expect(within(pane).queryByTestId("host-port-forwards-owned")).toBeNull();
      expect(triggerCount()).toBeNull();
      // The read itself is not gated by the restart, so let it land and prove
      // the count still stays off (a real answer is in hand by then).
      await waitFor(() => {
        expect(mounted.listCalls()).toBe(1);
      });
      await settle();
      expect(triggerCount()).toBeNull();
    });
  });

  describe("the 15 second read", () => {
    it("re-reads every 15 seconds and a forward that stopped drops out of the count", async () => {
      vi.useFakeTimers();
      let reads = 0;
      const mounted = mountPanel({
        ...defaults,
        answer: () => {
          reads += 1;
          return answering(reads === 1 ? 2 : 1, 0)();
        },
      });
      await advance(0);
      expect(mounted.listCalls()).toBe(1);
      expect(triggerCount()).toBe("2");

      await advance(POLL_MS - 1);
      expect(mounted.listCalls()).toBe(1);
      expect(triggerCount()).toBe("2");

      await advance(1);
      expect(mounted.listCalls()).toBe(2);
      expect(triggerCount()).toBe("1");

      await advance(POLL_MS);
      expect(mounted.listCalls()).toBe(3);
    });

    it("makes no re-read while the window is not visible", async () => {
      vi.useFakeTimers();
      const mounted = mountPanel({ ...defaults, answer: answering(1, 0) });
      await advance(0);
      expect(mounted.listCalls()).toBe(1);

      act(() => {
        focusManager.setFocused(false);
      });
      await advance(POLL_MS * 3);

      expect(mounted.listCalls()).toBe(1);
    });
  });

  it("Refresh on the Ports tab updates the count at once, without a timer", async () => {
    const mounted = mountPanel({ ...defaults, answer: answering(1, 0) });
    await selectHostOverviewTab("ports");
    await waitFor(() => {
      expect(triggerCount()).toBe("1");
    });
    expect(mounted.listCalls()).toBe(1);

    mounted.source.current = answering(1, 2);
    fireEvent.click(await screen.findByTestId("host-port-forwards-refresh"));

    await waitFor(() => {
      expect(triggerCount()).toBe("3");
    });
    expect(mounted.listCalls()).toBe(2);
  });

  describe("on a phone", () => {
    it("shows the count on the Ports item of the section dropdown", async () => {
      window.innerWidth = 500;
      const mounted = mountPanel({ ...defaults, answer: answering(2, 1) });
      await waitFor(() => {
        expect(mounted.listCalls()).toBe(1);
      });
      await settle();

      const select = await screen.findByTestId("host-overview-tab-select");
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      fireEvent.pointerDown(select, { button: 0, ctrlKey: false });
      fireEvent.keyDown(select, { key: "ArrowDown" });

      const option = await screen.findByRole("option", { name: /Ports/ });
      const badge = within(option).getByTestId("host-overview-ports-count");
      expect(badge.getAttribute("data-count")).toBe("3");
    });
  });
});
