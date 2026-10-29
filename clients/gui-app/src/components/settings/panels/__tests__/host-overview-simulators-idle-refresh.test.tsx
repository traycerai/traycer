import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ConfigSimulatorResponse } from "@traycer/protocol/host/simulator/schemas";
import { buildOverviewManagement } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createLocalMaintenanceFallbackClient } from "@/lib/host/local-maintenance-fallback-client";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * Overview ▸ Mobile simulators, through the REAL simulator hooks: a write
 * leaves the card showing what the host stored, not what it stored before.
 *
 * `host-overview-simulators-tab.test.tsx` fakes
 * `@/hooks/simulator/use-simulator-mutations` wholesale, so it pins what the
 * card DRAWS for one published config and can say nothing about the cache
 * between a write and the next read. That gap is the whole subject here, so
 * everything on the path is real: `useSimulatorConfigQuery` and
 * `useSimulatorConfigSetMutation` over a `HostClient`, its request
 * coordinator and the app's own scheduling policy, and `createAppQueryClient`
 * rather than a bare `QueryClient` - the serving-tier cache key the read is
 * filed under and the invalidation the write sends have to agree inside the
 * same client the app ships.
 *
 * The client is the shape Settings hands down for THIS machine's host: an
 * id-pinned requester (`createRequesterForHostId`, what `useHostClient()`
 * resolves while the page follows the active host) under the
 * local-maintenance fallback decorator, which `use-host-scope.ts` wraps every
 * local-host scope client in. Both are Proxies that re-point some members, so
 * the host id the invalidation is keyed by travels through two of them.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => ({
  openOrFocusEpicIntent: (intent: { readonly epicId: string }) => intent,
  navigateToTabIntent: () => undefined,
}));
vi.mock("@/components/settings/panels/use-simulator-task-titles", () => ({
  useSimulatorTaskTitles: () => new Map<string, string>(),
}));
// The handshake facts, which no mock messenger negotiates: this host
// advertises the simulator verbs and speaks `@1.1`, so the idle row is drawn
// and writable.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 1 }),
}));

import { HostOverviewSimulatorsTab } from "@/components/settings/panels/host-overview-simulators-tab";

const STORED_BEFORE = 15;
const WRITTEN = 2;

/** A host that merges a partial write into its stored block, as `@1.1` does. */
function buildScopeClient(): HostClient<HostRpcRegistry> {
  let stored: ConfigSimulatorResponse = {
    enabled: true,
    idleMinutes: STORED_BEFORE,
  };
  let sent = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `simulator-idle-req-${String((sent += 1))}`,
    handlers: {
      "config.simulator.get": () => stored,
      "config.simulator.set": (params) => {
        stored = {
          enabled: params.enabled ?? stored.enabled,
          idleMinutes: params.idleMinutes ?? stored.idleMinutes,
        };
        return stored;
      },
      "simulator.status": () => ({
        platforms: [{ platform: "ios", available: true, reason: null }],
        packState: { kind: "ready", reason: null, progress: null },
        packVersion: "0.15.3-0.21.25.22.23.3",
        installed: {
          version: "0.15.3-0.21.25.22.23.3",
          sizeBytes: 216 * 1024 ** 2,
        },
      }),
      "simulator.instances": () => ({ instances: [] }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-simulator-idle",
    }),
  );
  return createLocalMaintenanceFallbackClient({
    client: spine.createRequesterForHostId(mockLocalHostEntry.hostId),
    localHostId: mockLocalHostEntry.hostId,
    management: buildOverviewManagement({}),
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Overview ▸ Mobile simulators ▸ Power off when idle", () => {
  it("shows the host's stored window again after the write", async () => {
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <HostOverviewSimulatorsTab
          client={buildScopeClient()}
          hostId={mockLocalHostEntry.hostId}
          hostName="Studio Mac"
        />
      </QueryClientProvider>,
    );
    const input = await screen.findByTestId("settings-simulators-idle-minutes");
    await waitFor(() => {
      expect(input).toHaveProperty("value", String(STORED_BEFORE));
    });

    fireEvent.change(input, { target: { value: String(WRITTEN) } });
    fireEvent.blur(input);

    // The row keeps no copy of what it sent - it clears its draft at commit
    // and reads the config query again - so the field is the cache, and the
    // cache is only right if the write's invalidation reached the key the
    // read is filed under.
    await waitFor(() => {
      expect(input).toHaveProperty("value", String(WRITTEN));
    });
  });
});
