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
import type { ManagedCommandDeliverHeldResponse } from "@traycer/protocol/host/managed-command/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

/**
 * `managedCommand.deliverHeld`, driven against a real `HostClient` and a mock
 * host.
 *
 * The behaviour this suite exists to pin: a response naming `unresolved`
 * holds is a RESOLVED success, never a rejection - that split is the whole
 * point of the response shape (see `unary-schemas.ts`), and a test asserting
 * the opposite would undo the design.
 */

const { toastError, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));
const directoryState = vi.hoisted(() => ({ available: true }));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    warning: toastWarning,
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  useHostDirectory: () => ({
    findById: () => (directoryState.available ? mockLocalHostEntry : null),
  }),
}));

import {
  useManagedCommandDeliverHeld,
  useManagedCommandDeliverHeldIsPending,
} from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";

/** The response the mock host answers `managedCommand.deliverHeld` with. */
let deliverResponse: ManagedCommandDeliverHeldResponse = {
  released: [],
  unresolved: [],
  held: [],
};
/** The last request the mock host actually received. */
let lastRequestCommandIds: readonly string[] | null | undefined;
/** When set, the mock host's answer waits on it - the observable in-flight window. */
let deliverGate: Promise<void> | null = null;
let releaseDeliverGate: (() => void) | null = null;

let hostClient: HostClient<HostRpcRegistry>;
let queryClient: QueryClient;

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  toastError.mockClear();
  toastWarning.mockClear();
  directoryState.available = true;
  deliverResponse = { released: [], unresolved: [], held: [] };
  lastRequestCommandIds = undefined;
  deliverGate = null;
  releaseDeliverGate = null;
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "deliver-held-request",
    handlers: {
      "managedCommand.deliverHeld": async (request) => {
        lastRequestCommandIds = request.commandIds;
        if (deliverGate !== null) await deliverGate;
        return deliverResponse;
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
      bearerToken: "deliver-held-token",
    }),
  );
});

afterEach(() => {
  cleanup();
  hostClient.dispose();
});

describe("useManagedCommandDeliverHeld", () => {
  it("sends commandIds: null and resolves", async () => {
    const { result } = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: null,
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(lastRequestCommandIds).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("resolves - does not reject - when the response names unresolved holds", async () => {
    deliverResponse = {
      released: ["cmd-1"],
      unresolved: [
        {
          commandId: "cmd-2",
          code: "delivery_row_not_materialized",
          retryable: true,
          message: "reconcile pass has not run yet",
        },
      ],
      held: [{ commandId: "cmd-2", description: "db migration", heldAtMs: 1 }],
    };
    const { result } = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: null,
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual(deliverResponse);
  });

  it("tells the user to try again when at least one unresolved hold is retryable", async () => {
    deliverResponse = {
      released: [],
      unresolved: [
        {
          commandId: "cmd-1",
          code: "delivery_row_not_materialized",
          retryable: true,
          message: "reconcile pass has not run yet",
        },
        {
          commandId: "cmd-2",
          code: "boot_record_load_failed",
          retryable: false,
          message: "this host cannot decode it",
        },
      ],
      held: [],
    };
    const { result } = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: null,
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(
      "2 shells are still held. Try again in a moment.",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("tells the user it cannot be retried against this host when every unresolved hold is permanent", async () => {
    deliverResponse = {
      released: [],
      unresolved: [
        {
          commandId: "cmd-1",
          code: "boot_record_load_failed",
          retryable: false,
          message: "this host cannot decode it",
        },
      ],
      held: [],
    };
    const { result } = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: null,
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "That shell's output can't be delivered by this host. Restarting or updating it may help.",
    );
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("rejects with the host-unavailable error rather than sending, when the host entry is missing", async () => {
    directoryState.available = false;
    const { result } = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: null,
      });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(lastRequestCommandIds).toBeUndefined();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Couldn't deliver it.");
  });

  it("reports a Deliver in flight to every observer, not just its own", async () => {
    deliverGate = new Promise<void>((resolve) => {
      releaseDeliverGate = resolve;
    });
    const first = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });
    const second = renderHook(
      () => useManagedCommandDeliverHeldIsPending(CHAT_ID),
      { wrapper },
    );
    expect(second.result.current).toBe(false);

    act(() => {
      first.result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: null,
      });
    });
    await waitFor(() => {
      expect(second.result.current).toBe(true);
    });
    act(() => {
      releaseDeliverGate?.();
    });
    await waitFor(() => {
      expect(second.result.current).toBe(false);
    });
  });
});
