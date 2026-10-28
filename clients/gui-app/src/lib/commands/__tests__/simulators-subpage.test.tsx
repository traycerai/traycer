import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  SimulatorHostInstance,
  SimulatorOpenResponse,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { resetSimulatorPendingOpensForTests } from "@/stores/epics/simulator-pending-opens-store";
import type { CommandContext } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

const HOST = mockLocalHostEntry.hostId;
const EPIC = "epic-1";

const world = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  placed: vi.fn(),
}));

vi.mock("@/lib/commands/actions", () => ({
  openTileIntoTargetGroup: world.placed,
}));
vi.mock("@/lib/commands/sources/open/use-active-epic-projection", () => ({
  useActiveEpicProjection: () => null,
}));
vi.mock(
  "@/components/epic-canvas/sidebar/use-simulator-panel-availability",
  () => ({
    useSimulatorPanelAvailability: () => ({
      localHostRunsSimulators: true,
      hasSimulatorRecords: false,
    }),
  }),
);
vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: [{ hostId: "mock-local", name: "Studio Mac" }],
  }),
}));
vi.mock("@/hooks/browser/use-browser-open-host", () => ({
  useServingLocalHostId: () => "mock-local",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => world.client,
}));
vi.mock("@/hooks/simulator/use-simulator-catalog-inventory", () => ({
  useSimulatorCatalogInventory: () => ({
    status: "ready",
    scope: "cloud",
    records: [],
    refetch: () => undefined,
  }),
}));
vi.mock("@/lib/host/read-negotiated-method-version", () => ({
  readNegotiatedMethodVersion: () => ({ major: 1, minor: 1 }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
  useHostMethodSupport: () => true,
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => world.client,
  useHostDirectory: () => ({
    findById: (hostId: string) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  }),
}));
vi.mock("@/lib/host/binding-host-client", () => ({
  resolveNamedHostClient: () => world.client,
}));
vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasReadyRemoteSession: () => false,
}));
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

import { useSimulatorsOpenerItems } from "../sources/open/simulators-subpage";

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

const CTX: CommandContext = {
  pathname: "/",
  router: noopRouter(),
  activeTabId: "tab-1",
  activeEpicId: EPIC,
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

const LIST: SimulatorState = {
  revision: 1,
  hostId: HOST,
  platforms: [{ platform: "ios", available: true, reason: null }],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [
    {
      simulatorId: "udid-1",
      platform: "ios",
      name: "iPhone 16",
      version: "18.0",
      booted: true,
      physical: false,
    },
    {
      simulatorId: "udid-cold",
      platform: "ios",
      name: "iPad Air",
      version: "18.0",
      booted: false,
      physical: false,
    },
  ],
  sessions: [],
  booting: [],
};

const AGENT_INSTANCE: SimulatorHostInstance = {
  instanceKey: "udid-1",
  name: "iPhone 16",
  booted: true,
  cloneOf: null,
  drivenByAgent: true,
  keepRunning: false,
  idleUntil: null,
  simulatorId: "udid-1",
  platform: "ios",
  version: "18.0",
  cloneOfName: null,
  bootedByTraycer: true,
  tasks: [],
  otherTaskCount: 0,
};

const host = {
  opens: [] as unknown[],
  answer: (): Promise<SimulatorOpenResponse> => new Promise(() => {}),
};

function wrapper(props: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("the Mobile simulators opener sub-page", () => {
  beforeEach(() => {
    resetSimulatorPendingOpensForTests();
    world.placed.mockReset();
    host.opens = [];
    host.answer = () => new Promise(() => {});
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request",
      handlers: {
        "simulator.list": () => LIST,
        "simulator.instances": () => ({ instances: [AGENT_INSTANCE] }),
        "simulator.open": (params) => {
          host.opens.push(params);
          return host.answer();
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      schedulingPolicy: hostRpcSchedulingPolicy,
      findHostById: (hostId) => (hostId === HOST ? mockLocalHostEntry : null),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer" }),
    );
    world.client = spine.createRequester(mockLocalHostEntry);
  });
  afterEach(cleanup);

  async function rows() {
    const hook = renderHook(() => useSimulatorsOpenerItems(CTX), { wrapper });
    await waitFor(() => {
      expect(hook.result.current.some((item) => !item.disabled)).toBe(true);
    });
    return hook.result.current;
  }

  it("lists the instance with the Agent badge and the machine, and the cold device as Boot", async () => {
    const items = await rows();

    const running = items.find((item) => item.label === "iPhone 16");
    const cold = items.find((item) => item.label === "iPad Air");
    expect(running?.statusBadge).toBe("iOS 18.0 · Agent · Studio Mac");
    expect(cold?.statusBadge).toBe("iOS 18.0 · Boot · Studio Mac");
  });

  it("sends the open with the instance and a requestId before the tile is placed, and places it once the host answers", async () => {
    let answer: (response: SimulatorOpenResponse) => void = () => undefined;
    host.answer = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const items = await rows();
    const running = items.find((item) => item.label === "iPhone 16");

    act(() => {
      void running?.run(CTX);
    });

    await waitFor(() => expect(host.opens).toHaveLength(1));
    expect(host.opens[0]).toMatchObject({
      epicId: EPIC,
      simulatorId: "udid-1",
      boot: true,
      instance: "udid-1",
    });
    expect(host.opens[0]).toHaveProperty("requestId");
    expect(world.placed).not.toHaveBeenCalled();

    act(() => {
      answer({
        session: {
          epicId: EPIC,
          ownerUserId: "teammate",
          hostId: HOST,
          simulatorId: "udid-1",
          platform: "ios",
          openedAt: "2026-10-29T00:00:00.000Z",
          sessionId: "session-teammate",
          agentId: null,
        },
        simulator: LIST.simulators[0],
      });
    });

    await waitFor(() => expect(world.placed).toHaveBeenCalledTimes(1));
    expect(world.placed.mock.calls[0][0]).toMatchObject({
      tabId: "tab-1",
      groupId: "group-1",
      dedupe: true,
      ref: { type: "simulator", hostId: HOST, simulatorId: "udid-1" },
    });
  });

  it("boots a cold device with instance auto", async () => {
    const items = await rows();

    act(() => {
      void items.find((item) => item.label === "iPad Air")?.run(CTX);
    });

    await waitFor(() => expect(host.opens).toHaveLength(1));
    expect(host.opens[0]).toMatchObject({
      simulatorId: "udid-cold",
      instance: "auto",
    });
  });
});
