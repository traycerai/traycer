import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

/**
 * "Stop all" over a chat's host-supervised commands, driven against a real
 * `HostClient` and a mock host that refuses some of the stops.
 *
 * The point of the aggregate is what it does NOT do: one dead or unhappy host
 * used to produce one toast per row, because each stop was its own mutation
 * judging its own failure.
 */

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
const directoryState = vi.hoisted(() => ({ available: true }));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  useHostDirectory: () => ({
    findById: () => (directoryState.available ? mockLocalHostEntry : null),
  }),
}));

import {
  useManagedCommandStopAll,
  useManagedCommandStopAllIsPending,
} from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";

const EPIC_ID = "epic-1";

/** Command ids the mock host refuses to stop. */
const refusedCommandIds = new Set<string>();
/** When set, every stop waits on it - the observable in-flight window. */
let stopGate: Promise<void> | null = null;
let releaseStopGate: (() => void) | null = null;
const stoppedCommandIds: string[] = [];

let hostClient: HostClient<HostRpcRegistry>;
let queryClient: QueryClient;

function stoppedCommand(commandId: string): ManagedCommand {
  return {
    id: commandId,
    monitoring: true,
    description: "deploy watcher",
    status: { state: "stopped", stoppedAtMs: 5 },
    chatId: "chat-1",
    createdAtMs: 1,
    updatedAtMs: 5,
  };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  toastError.mockClear();
  directoryState.available = true;
  stopGate = null;
  releaseStopGate = null;
  refusedCommandIds.clear();
  stoppedCommandIds.length = 0;
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "stop-all-request",
    handlers: {
      "managedCommand.stop": async (request) => {
        if (stopGate !== null) await stopGate;
        if (refusedCommandIds.has(request.commandId)) {
          throw new Error(`no such process: ${request.commandId}`);
        }
        stoppedCommandIds.push(request.commandId);
        return { command: stoppedCommand(request.commandId) };
      },
    },
  });
  hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
  });
  hostClient.bind(mockLocalHostEntry);
  hostClient.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "stop-all-token",
    }),
  );
});

afterEach(() => {
  cleanup();
  hostClient.dispose();
});

describe("useManagedCommandStopAll", () => {
  it("fails once with the real reason when no host client can be built", async () => {
    directoryState.available = false;
    const { result } = renderHook(() => useManagedCommandStopAll("chat-1"), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandIds: ["cmd-1", "cmd-2"],
      });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Nothing was sent and nothing was manufactured: one typed failure routed
    // through the host-error policy (its rendered form is the fallback copy,
    // since a client-unavailable error carries no user-facing message).
    expect(stoppedCommandIds).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Couldn't stop them.");
  });

  it("says a partial failure once, naming how many of how many", async () => {
    refusedCommandIds.add("cmd-2");
    const { result } = renderHook(() => useManagedCommandStopAll("chat-1"), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandIds: ["cmd-1", "cmd-2", "cmd-3"],
      });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // A refusal does not abandon the rest: every stop is sent before the
    // outcome is judged.
    expect(stoppedCommandIds).toEqual(["cmd-1", "cmd-3"]);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Couldn't stop 1 of 3 shells.");
  });

  it("routes a wholesale failure through the host-error policy, once", async () => {
    refusedCommandIds.add("cmd-1");
    refusedCommandIds.add("cmd-2");
    const { result } = renderHook(() => useManagedCommandStopAll("chat-1"), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandIds: ["cmd-1", "cmd-2"],
      });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // The whole point: a host that fails everything is ONE piece of news, not
    // one per row.
    expect(toastError).toHaveBeenCalledTimes(1);
    // All rejections share one systemic cause, so the TYPED error is thrown
    // and the standard policy renders it - not the count, which is reserved
    // for partial failures with mixed causes.
    expect(toastError).toHaveBeenCalledWith("Couldn't stop them.");
  });

  it("reports a batch in flight to every observer, not just its own", async () => {
    // Two hooks over one QueryClient stand in for the same chat open in two
    // tiles: the second tile's button reads the shared pending, so it goes
    // dead the moment the first tile's batch starts.
    stopGate = new Promise<void>((resolve) => {
      releaseStopGate = resolve;
    });
    const first = renderHook(() => useManagedCommandStopAll("chat-1"), {
      wrapper,
    });
    const second = renderHook(
      () => useManagedCommandStopAllIsPending("chat-1"),
      {
        wrapper,
      },
    );
    expect(second.result.current).toBe(false);

    act(() => {
      first.result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandIds: ["cmd-1"],
      });
    });
    await waitFor(() => {
      expect(second.result.current).toBe(true);
    });
    act(() => {
      releaseStopGate?.();
    });
    await waitFor(() => {
      expect(second.result.current).toBe(false);
    });
  });

  it("stays quiet when every stop lands", async () => {
    const { result } = renderHook(() => useManagedCommandStopAll("chat-1"), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandIds: ["cmd-1", "cmd-2"],
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(stoppedCommandIds).toEqual(["cmd-1", "cmd-2"]);
    expect(toastError).not.toHaveBeenCalled();
  });
});
