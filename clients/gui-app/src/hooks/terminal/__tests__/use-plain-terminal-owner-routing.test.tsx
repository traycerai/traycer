import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  getPlainTerminal,
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { usePlainTerminalMutations } from "@/hooks/terminal/use-plain-terminal-mutations";

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

const SERVING_HOST = "host-serving";
const OWNER_HOST = "host-owner";
const SCOPE = { kind: "epic", epicId: "epic-1" } as const;

function projection(hostId: string): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId,
      scope: SCOPE,
      launch: { cwd: "/work", shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle: null,
      revision: 1,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    },
    runtime: { status: "dormant" },
  };
}

function collection(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, terminals),
    ),
    "open",
  );
}

function setup(args: {
  readonly terminals: readonly PlainTerminalProjection[];
  readonly ownerClients: Readonly<
    Partial<Record<string, HostClient<HostRpcRegistry>>>
  >;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-routing",
    handlers: {
      "terminal.plain.rename": (request) => ({
        terminal: {
          ...projection(OWNER_HOST),
          record: {
            ...projection(OWNER_HOST).record,
            terminalId: request.terminalId,
            manualTitle: request.manualTitle,
            revision: 2,
          },
        },
      }),
      "terminal.plain.ensureRunning": (request) => ({
        terminal: {
          ...projection(OWNER_HOST),
          record: {
            ...projection(OWNER_HOST).record,
            terminalId: request.terminalId,
            revision: 2,
          },
          runtime: {
            status: "running",
            sessionId: request.terminalId,
            currentCwd: "/work",
            activeProcessName: null,
            cols: 80,
            rows: 24,
          },
        },
      }),
      "terminal.plain.close": (request) => ({
        terminalId: request.terminalId,
        revision: 3,
      }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === OWNER_HOST || hostId === SERVING_HOST
        ? { ...mockLocalHostEntry, hostId }
        : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  const servingClient = spine.createRequesterForHostId(SERVING_HOST);
  const ownerClient = spine.createRequesterForHostId(OWNER_HOST);
  queryClient.setQueryData(
    hostQueryKeys.plainTerminals(SERVING_HOST, SCOPE),
    collection(args.terminals),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  const rendered = renderHook(
    () =>
      usePlainTerminalMutations({
        authority: {
          hostId: SERVING_HOST,
          scope: SCOPE,
          canMutate: true,
          collection: collection(args.terminals),
        },
        client: servingClient,
        resolveOwnerClient: (hostId) => args.ownerClients[hostId] ?? null,
      }),
    { wrapper: Wrapper },
  );
  return { queryClient, messenger, servingClient, ownerClient, rendered };
}

describe("plain terminal owner-host routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes rename, ensureRunning, and close to the owner host, not the serving host", async () => {
    const ownerMessenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "owner",
      handlers: {
        "terminal.plain.rename": (request) => ({
          terminal: {
            ...projection(OWNER_HOST),
            record: {
              ...projection(OWNER_HOST).record,
              manualTitle: request.manualTitle,
              revision: 2,
            },
          },
        }),
        "terminal.plain.ensureRunning": () => ({
          terminal: {
            ...projection(OWNER_HOST),
            runtime: {
              status: "running",
              sessionId: "terminal-1",
              currentCwd: "/work",
              activeProcessName: null,
              cols: 80,
              rows: 24,
            },
          },
        }),
        "terminal.plain.close": () => ({
          terminalId: "terminal-1",
          revision: 3,
        }),
      },
    });
    const servingMessenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "serving",
      handlers: {},
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const ownerSpine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger: ownerMessenger,
      findHostById: (hostId) =>
        hostId === OWNER_HOST ? { ...mockLocalHostEntry, hostId } : null,
    });
    ownerSpine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    const servingSpine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger: servingMessenger,
      findHostById: (hostId) =>
        hostId === SERVING_HOST ? { ...mockLocalHostEntry, hostId } : null,
    });
    servingSpine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    const ownerClient = ownerSpine.createRequesterForHostId(OWNER_HOST);
    const servingClient = servingSpine.createRequesterForHostId(SERVING_HOST);
    const fleet = collection([projection(OWNER_HOST)]);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(SERVING_HOST, SCOPE),
      fleet,
    );
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    const rendered = renderHook(
      () =>
        usePlainTerminalMutations({
          authority: {
            hostId: SERVING_HOST,
            scope: SCOPE,
            canMutate: true,
            collection: fleet,
          },
          client: servingClient,
          resolveOwnerClient: (hostId) =>
            hostId === OWNER_HOST ? ownerClient : null,
        }),
      { wrapper: Wrapper },
    );

    await rendered.result.current.rename.mutateAsync({
      hostId: OWNER_HOST,
      terminalId: "terminal-1",
      manualTitle: "Owner title",
    });
    await rendered.result.current.ensureRunning.mutateAsync({
      hostId: OWNER_HOST,
      terminalId: "terminal-1",
      cols: 80,
      rows: 24,
    });
    await rendered.result.current.close.mutateAsync({
      hostId: OWNER_HOST,
      terminalId: "terminal-1",
    });

    expect(ownerMessenger.calls.map((call) => call.method)).toEqual([
      "terminal.plain.rename",
      "terminal.plain.ensureRunning",
      "terminal.plain.close",
    ]);
    expect(servingMessenger.calls).toEqual([]);
    expect(
      getPlainTerminal(
        queryClient.getQueryData<PlainTerminalCollection>(
          hostQueryKeys.plainTerminals(SERVING_HOST, SCOPE),
        ),
        OWNER_HOST,
        "terminal-1",
      ),
    ).toBeUndefined();
  });

  it("does not send a fallback request when the owner host is unavailable", async () => {
    const test = setup({
      terminals: [projection(OWNER_HOST)],
      ownerClients: {},
    });
    await expect(
      test.rendered.result.current.rename.mutateAsync({
        hostId: OWNER_HOST,
        terminalId: "terminal-1",
        manualTitle: "Nope",
      }),
    ).rejects.toThrow("owner host is unreachable");
    expect(test.messenger.calls).toEqual([]);
  });

  it("refuses mutations for remote rows removed by a partial replacement", async () => {
    const test = setup({
      terminals: [projection(SERVING_HOST)],
      ownerClients: {},
    });
    await expect(
      test.rendered.result.current.rename.mutateAsync({
        hostId: OWNER_HOST,
        terminalId: "terminal-1",
        manualTitle: "cached remote",
      }),
    ).rejects.toThrow("not in the current fleet authority");
    expect(test.messenger.calls).toEqual([]);
  });
});
