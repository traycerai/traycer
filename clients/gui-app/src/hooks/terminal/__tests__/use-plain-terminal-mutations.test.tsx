import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { HostBelowMinimumError } from "@/lib/host/host-below-minimum-error";
import {
  getPlainTerminal,
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { usePlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";

const toastFromHostError = vi.hoisted(() =>
  vi.fn<(error: HostRpcError, fallbackMessage: string) => void>(),
);
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError }));

const SCOPE = { kind: "epic", epicId: "epic-1" } as const;

function terminal(overrides: {
  readonly hostId?: string;
  readonly revision?: number;
  readonly manualTitle?: string | null;
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: overrides.hostId ?? "host-a",
      scope: SCOPE,
      launch: {
        cwd: "/work",
        shellCommand: "/bin/zsh",
        shellArgs: [],
      },
      manualTitle: overrides.manualTitle ?? null,
      revision: overrides.revision ?? 1,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    },
    runtime: { status: "dormant" },
  };
}

function collection(hostId: string): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, [terminal({ hostId })]),
    ),
    "open",
  );
}

function wrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("plain terminal mutation authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a delayed canonical response to the serving-host cache captured at mutate start", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "rename",
      handlers: {
        "terminal.plain.rename": (request) => ({
          terminal: terminal({
            hostId: "host-a",
            revision: 2,
            manualTitle: request.manualTitle,
          }),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger,
      findHostById: (hostId) => ({ ...mockLocalHostEntry, hostId }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    const client = spine.createRequesterForHostId("host-a");
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals("host-a", SCOPE),
      collection("host-a"),
    );
    const rendered = renderHook(
      ({ currentHostId }) =>
        usePlainTerminalMutations({
          authority: {
            hostId: currentHostId,
            scope: SCOPE,
            canMutate: true,
            collection: collection(currentHostId),
          },
          client,
          resolveOwnerClient: () => client,
        }),
      {
        initialProps: { currentHostId: "host-a" },
        wrapper: wrapper(queryClient),
      },
    );

    const pending = rendered.result.current.rename.mutateAsync({
      hostId: "host-a",
      terminalId: "terminal-1",
      manualTitle: "canonical",
    });
    rendered.rerender({ currentHostId: "host-b" });
    await pending;

    expect(
      getPlainTerminal(
        queryClient.getQueryData<PlainTerminalCollection>(
          hostQueryKeys.plainTerminals("host-a", SCOPE),
        ),
        "host-a",
        "terminal-1",
      )?.record.manualTitle,
    ).toBe("canonical");
    expect(
      queryClient.getQueryData(hostQueryKeys.plainTerminals("host-b", SCOPE)),
    ).toBeUndefined();
  });

  it("uses ensureRunning only for an existing fleet identity and never falls back to create", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const rendered = renderHook(
      () =>
        usePlainTerminalMutations({
          authority: {
            hostId: "host-a",
            scope: SCOPE,
            canMutate: true,
            collection: collection("host-a"),
          },
          client: null,
          resolveOwnerClient: () => null,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await expect(
      rendered.result.current.ensureRunning.mutateAsync({
        hostId: "host-a",
        terminalId: "missing-terminal",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow("Cannot bootstrap an unknown terminal");
  });

  it("blocks mutations while capable host data is stale", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const rendered = renderHook(
      () =>
        usePlainTerminalMutations({
          authority: {
            hostId: "host-a",
            scope: SCOPE,
            canMutate: false,
            collection: collection("host-a"),
          },
          client: null,
          resolveOwnerClient: () => null,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await expect(
      rendered.result.current.rename.mutateAsync({
        hostId: "host-a",
        terminalId: "terminal-1",
        manualTitle: "blocked",
      }),
    ).rejects.toThrow("Cached data is view-only");
  });

  it("keeps automatic plain-terminal floor failures silent while floor-blocked rename remains reportable", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "below-minimum",
      handlers: {},
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger,
      findHostById: (hostId) => ({ ...mockLocalHostEntry, hostId }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    const client = spine.createRequesterForHostId("host-a");
    const request = vi.spyOn(messenger, "request").mockRejectedValue(
      new HostBelowMinimumError({
        requestId: "below-minimum",
        method: "terminal.plain.create",
      }),
    );
    const rendered = renderHook(
      () =>
        usePlainTerminalMutations({
          authority: {
            hostId: "host-a",
            scope: SCOPE,
            canMutate: true,
            collection: collection("host-a"),
          },
          client,
          resolveOwnerClient: () => client,
        }),
      { wrapper: wrapper(queryClient) },
    );
    const mutations = rendered.result.current;

    await expect(
      mutations.create.mutateAsync({
        terminalId: "terminal-2",
        scope: SCOPE,
        cwd: "/work",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(HostBelowMinimumError);
    expect(vi.mocked(toastFromHostError)).not.toHaveBeenCalled();

    await expect(
      mutations.ensureRunning.mutateAsync({
        hostId: "host-a",
        terminalId: "terminal-1",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(HostBelowMinimumError);
    expect(vi.mocked(toastFromHostError)).not.toHaveBeenCalled();

    await expect(
      mutations.close.mutateAsync({
        hostId: "host-a",
        terminalId: "terminal-1",
      }),
    ).rejects.toBeInstanceOf(HostBelowMinimumError);
    expect(vi.mocked(toastFromHostError)).not.toHaveBeenCalled();

    await expect(
      mutations.importLegacy.mutateAsync({
        hostId: "host-a",
        terminalId: "terminal-1",
        scope: SCOPE,
        cwd: "/work",
        name: "Terminal",
        titleSource: "default",
        sourceStoreVersion: 1,
      }),
    ).rejects.toBeInstanceOf(HostBelowMinimumError);
    expect(vi.mocked(toastFromHostError)).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(4);

    const renameFloorError = new HostBelowMinimumError({
      requestId: "rename-floor",
      method: "terminal.plain.rename",
    });
    request.mockRejectedValue(renameFloorError);
    await expect(
      mutations.rename.mutateAsync({
        hostId: "host-a",
        terminalId: "terminal-1",
        manualTitle: "Renamed",
      }),
    ).rejects.toBe(renameFloorError);
    expect(toastFromHostError).toHaveBeenCalledExactlyOnceWith(
      renameFloorError,
      "Couldn't rename the terminal.",
    );

    const ordinaryError = new HostRpcError({
      code: "RPC_ERROR",
      message: "create refused",
      requestId: "create-refusal",
      method: "terminal.plain.create",
      fatalDetails: null,
    });
    request.mockRejectedValue(ordinaryError);
    await expect(
      mutations.create.mutateAsync({
        terminalId: "terminal-3",
        scope: SCOPE,
        cwd: "/work",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBe(ordinaryError);
    expect(toastFromHostError).toHaveBeenLastCalledWith(
      ordinaryError,
      "Couldn't create the terminal.",
    );
    expect(toastFromHostError).toHaveBeenCalledTimes(2);
  });
});
