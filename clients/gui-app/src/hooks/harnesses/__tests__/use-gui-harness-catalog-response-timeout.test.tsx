import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ListGuiHarnessesResponse } from "@traycer/protocol/host/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { CATALOG_LIST_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/catalog-list-response-timeout";
import { createAppQueryClient } from "@/lib/query-client";
import {
  useGuiHarnessCatalogForClient,
  useGuiHarnessCommandsQuery,
  useGuiHarnessModelsQueryForClient,
  useGuiHarnessModelsWarmup,
} from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * Every catalog caller dispatches with the catalog response allowance. The
 * messenger mock discards the budget, so it is read at the `HostClient` seam
 * (`requestForWithOptions`), which both the single-query and the batched path
 * reach. The client carries the real scheduling policy: HostClient refuses a
 * budget the policy does not declare, so a green request is also proof the
 * method declares it.
 */
const ACTIVE = { enabled: true, subscribed: true };

function harnesses(): ListGuiHarnessesResponse["harnesses"] {
  return [
    {
      id: "claude",
      label: "claude",
      enabled: true,
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
      supportedPermissionModes: ["supervised"],
      nativeAutoJudge: false,
      availabilityPending: false,
    },
  ];
}

interface BudgetCall {
  readonly method: string;
  readonly responseTimeoutMs: number | null;
}

function createFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly budgetCalls: () => ReadonlyArray<BudgetCall>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "agent.gui.listHarnesses": () => ({ harnesses: harnesses() }),
        "agent.gui.listModels": () => ({ harnessId: "claude", models: [] }),
        "agent.gui.listCommands": () => ({
          harnessId: "claude",
          commands: [],
        }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const requestForWithOptions = vi.spyOn(spine, "requestForWithOptions");
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    budgetCalls: () =>
      requestForWithOptions.mock.calls.map((call): BudgetCall => ({
        method: call[1],
        responseTimeoutMs: call[3].responseTimeoutMs,
      })),
    Wrapper,
  };
}

function callsFor(
  calls: ReadonlyArray<BudgetCall>,
  method: string,
): ReadonlyArray<BudgetCall> {
  return calls.filter((call) => call.method === method);
}

describe("catalog hooks carry the catalog response allowance", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("useGuiHarnessModelsQueryForClient", async () => {
    const fixture = createFixture();
    renderHook(
      () =>
        useGuiHarnessModelsQueryForClient(
          fixture.client,
          "claude",
          null,
          ACTIVE,
        ),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(callsFor(fixture.budgetCalls(), "agent.gui.listModels")).toEqual([
        {
          method: "agent.gui.listModels",
          responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
        },
      ]);
    });
  });

  it("useGuiHarnessCommandsQuery", async () => {
    const fixture = createFixture();
    renderHook(
      () => useGuiHarnessCommandsQuery(fixture.client, "claude", [], ACTIVE),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(callsFor(fixture.budgetCalls(), "agent.gui.listCommands")).toEqual(
        [
          {
            method: "agent.gui.listCommands",
            responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
          },
        ],
      );
    });
  });

  it("useGuiHarnessModelsWarmup", async () => {
    const fixture = createFixture();
    renderHook(
      () => useGuiHarnessModelsWarmup(fixture.client, "claude", ACTIVE),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(callsFor(fixture.budgetCalls(), "agent.gui.listModels")).toEqual([
        {
          method: "agent.gui.listModels",
          responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
        },
      ]);
    });
  });

  it("useGuiHarnessCatalogForClient's all-harnesses fan-out", async () => {
    const fixture = createFixture();
    renderHook(
      () =>
        useGuiHarnessCatalogForClient(fixture.client, null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(callsFor(fixture.budgetCalls(), "agent.gui.listModels")).toEqual([
        {
          method: "agent.gui.listModels",
          responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
        },
      ]);
    });
    // The harness list itself is an ordinary read, with no allowance.
    expect(
      callsFor(fixture.budgetCalls(), "agent.gui.listHarnesses").map(
        (call) => call.responseTimeoutMs,
      ),
    ).not.toContain(CATALOG_LIST_RESPONSE_TIMEOUT_MS);
  });
});
