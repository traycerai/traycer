import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  GuiHarnessId,
  ListGuiAgentModelsResponse,
  ListGuiHarnessesResponse,
} from "@traycer/protocol/host/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { HarnessCatalogPrefetcher } from "@/providers/harness-catalog-prefetcher";
import { useGuiHarnessModelsQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => hostBindingMock.current,
  useHostClient: () => hostBindingMock.current?.hostClient ?? null,
  useHostRuntimeClient: () => hostBindingMock.current?.hostClient ?? null,
}));
vi.mock("@/lib/host/compatibility-state", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/host/compatibility-state")
  >("@/lib/host/compatibility-state");
  return {
    ...actual,
    useHostCompatibility: () => ({ status: "compatible" as const }),
  };
});

function harnesses(
  ids: ReadonlyArray<GuiHarnessId>,
): ListGuiHarnessesResponse["harnesses"] {
  return ids.map((id) => ({
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised"],
    nativeAutoJudge: false,
    availabilityPending: false,
  }));
}

function modelsResponse(harnessId: GuiHarnessId): ListGuiAgentModelsResponse {
  return {
    harnessId,
    models: [
      {
        harnessId,
        slug: `${harnessId}-model`,
        label: harnessId,
        description: null,
        contextWindow: null,
        maxOutputTokens: null,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
        defaultServiceTier: null,
        supportedServiceTiers: [],
        deprecationNotice: null,
        metadata: {},
      },
    ],
  };
}

describe("HarnessCatalogPrefetcher", () => {
  afterEach(() => {
    hostBindingMock.current = null;
    useSelectionAuthorityStore.getState().reset();
    cleanup();
  });

  it("issues one listHarnesses and zero listModels at boot", async () => {
    const queryClient = createAppQueryClient();
    const calls = { listHarnesses: 0, listModels: [] as GuiHarnessId[] };
    let requestCounter = 0;
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestCounter += 1;
          return `req-${String(requestCounter)}`;
        },
        handlers: {
          "agent.gui.listHarnesses": () => {
            calls.listHarnesses += 1;
            return { harnesses: harnesses(["opencode", "claude", "codex"]) };
          },
          "agent.gui.listModels": (params) => {
            calls.listModels.push(params.harnessId);
            return modelsResponse(params.harnessId);
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    hostBindingMock.current = { hostClient: client };
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: mockLocalHostEntry.hostId,
      targetHostId: mockLocalHostEntry.hostId,
      effectiveHostId: mockLocalHostEntry.hostId,
      leases: [],
      selectionRevision: 1,
    });
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    render(<HarnessCatalogPrefetcher />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(calls.listHarnesses).toBe(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.listModels).toEqual([]);
  });

  it("a composer toolbar query on the same client issues listModels for the selected harness only", async () => {
    const queryClient = createAppQueryClient();
    const calls = { listModels: [] as GuiHarnessId[] };
    let requestCounter = 0;
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestCounter += 1;
          return `req-${String(requestCounter)}`;
        },
        handlers: {
          "agent.gui.listHarnesses": () => ({
            harnesses: harnesses(["opencode", "claude", "codex"]),
          }),
          "agent.gui.listModels": (params) => {
            calls.listModels.push(params.harnessId);
            return modelsResponse(params.harnessId);
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    hostBindingMock.current = { hostClient: client };
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: mockLocalHostEntry.hostId,
      targetHostId: mockLocalHostEntry.hostId,
      effectiveHostId: mockLocalHostEntry.hostId,
      leases: [],
      selectionRevision: 1,
    });
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    function BootSurface(): ReactNode {
      useGuiHarnessModelsQueryForClient(client, "claude", null, {
        enabled: true,
        subscribed: true,
      });
      return <HarnessCatalogPrefetcher />;
    }

    render(<BootSurface />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(calls.listModels).toEqual(["claude"]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.listModels).toEqual(["claude"]);
  });
});
