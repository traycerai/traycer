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
 *
 * Every `message` below is a fixture written HERE, deliberately never copied
 * from the host that authors them in production. The two live in different
 * repositories, so pinning the host's exact sentence would make each future
 * copy edit a two-repo change - and this suite is about what the client does
 * with a message, not about which words the host chose. The fixtures are kept
 * REPRESENTATIVE of real host copy (whole sentences naming a remedy, no raw
 * ids) so a reader can see the surface the assertions describe; what they pin
 * is that the string arrives verbatim as the toast's description, whatever it
 * says.
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

/**
 * The un-attributed headline, named so the "says nothing about shells" guard
 * below asserts against the same string the expectation pins.
 */
const UNATTRIBUTED_PERMANENT_TITLE =
  "Nothing was delivered — this host can't tell what it's holding for this chat.";

/** The response the mock host answers `managedCommand.deliverHeld` with. */
let deliverResponse: ManagedCommandDeliverHeldResponse = {
  released: [],
  unresolved: [],
  unattributed: [],
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
  deliverResponse = {
    released: [],
    unresolved: [],
    unattributed: [],
    held: [],
  };
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

  it("sends a selected subset as a copy, not the caller's own array", async () => {
    const { result } = renderHook(() => useManagedCommandDeliverHeld(CHAT_ID), {
      wrapper,
    });
    // The Background panel's per-row Deliver takes this branch; every other
    // case here sends `null`, so the subset arm shipped unguarded.
    const selected = ["cmd-1", "cmd-2"];

    act(() => {
      result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        commandIds: selected,
      });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(lastRequestCommandIds).toEqual(["cmd-1", "cmd-2"]);
    // The mutation spreads into a fresh array. The mock messenger hands the
    // handler the params object by reference - no parse, no clone - so this
    // identity check actually discriminates: drop the spread and it fails.
    expect(lastRequestCommandIds).not.toBe(selected);
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
          message: "The reconcile pass has not run for this shell yet.",
        },
      ],
      unattributed: [],
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

  /** One Deliver against the mock host, settled - the shape every copy test
   *  shares, so each of them is only its fixture and its expectation. */
  async function deliverAndSettle(): Promise<void> {
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
  }

  it("reports the split rather than counting permanent failures into 'try again'", async () => {
    deliverResponse = {
      released: [],
      unresolved: [
        {
          commandId: "cmd-1",
          code: "delivery_row_not_materialized",
          retryable: true,
          message: "The reconcile pass has not run for this shell yet.",
        },
        {
          commandId: "cmd-2",
          code: "delivery_row_undecodable",
          retryable: false,
          message:
            "This shell's output was saved by a newer version of Traycer than this host runs.",
        },
      ],
      unattributed: [],
      held: [],
    };

    await deliverAndSettle();

    // The old copy said "2 shells are still held. Try again in a moment.",
    // which told the user to retry the one shell where retrying can never
    // work. Each half is now reported under its own remedy.
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(
      "2 shells are still held: 1 can be delivered on a retry, 1 can't be delivered by this host.",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows the host's own message when one permanent failure is the whole story", async () => {
    deliverResponse = {
      released: [],
      unresolved: [
        {
          commandId: "cmd-1",
          code: "delivery_row_written_by_newer_build",
          retryable: false,
          message: "This shell's output was written by a newer Traycer host.",
        },
      ],
      unattributed: [],
      held: [],
    };

    await deliverAndSettle();

    // `retryable: false` covers two different remedies - upgrade this host, or
    // restart it - and `message` is the only field that says which. Copy
    // composed from the boolean could only hedge across both.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "That shell's output can't be delivered by this host.",
      {
        description: "This shell's output was written by a newer Traycer host.",
      },
    );
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("falls back to a count when several permanent failures each have their own message", async () => {
    deliverResponse = {
      released: [],
      unresolved: [
        {
          commandId: "cmd-1",
          code: "delivery_row_written_by_newer_build",
          retryable: false,
          message: "This shell's output was written by a newer Traycer host.",
        },
        {
          commandId: "cmd-2",
          code: "boot_record_load_failed",
          retryable: false,
          message: "This host couldn't load its delivery records; restart it.",
        },
      ],
      unattributed: [],
      held: [],
    };

    await deliverAndSettle();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "2 shells' output can't be delivered by this host.",
      undefined,
    );
  });

  it("shows the host's message on a lone retryable hold too", async () => {
    deliverResponse = {
      released: ["cmd-1"],
      unresolved: [
        {
          commandId: "cmd-2",
          code: "delivery_row_not_materialized",
          retryable: true,
          message: "The reconcile pass has not run for this shell yet.",
        },
      ],
      unattributed: [],
      held: [{ commandId: "cmd-2", description: "db migration", heldAtMs: 1 }],
    };

    await deliverAndSettle();

    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(
      "One shell is still held. Try again in a moment.",
      { description: "The reconcile pass has not run for this shell yet." },
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports an un-attributed failure as proving nothing, never as a shell count", async () => {
    deliverResponse = {
      released: [],
      unresolved: [],
      unattributed: [
        {
          code: "boot_record_load_failed",
          retryable: false,
          message: "This host couldn't load its delivery records; restart it.",
        },
      ],
      held: [],
    };

    await deliverAndSettle();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(UNATTRIBUTED_PERMANENT_TITLE, {
      description: "This host couldn't load its delivery records; restart it.",
    });
    // One of these is produced whether the chat holds one shell or four, so
    // any number in this copy would count nothing a person can see. Asserted
    // against the constant the expectation above pins, so a rewrite that
    // reintroduces a shell count has to trip it.
    expect(UNATTRIBUTED_PERMANENT_TITLE).not.toContain("shell");
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("offers a retry for an un-attributed failure the host says is transient", async () => {
    deliverResponse = {
      released: [],
      unresolved: [],
      unattributed: [
        {
          code: "router_disposed",
          retryable: true,
          message: "The host was shutting down this chat's router.",
        },
      ],
      held: [],
    };

    await deliverAndSettle();

    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(
      "Nothing was delivered. Try again in a moment.",
      { description: "The host was shutting down this chat's router." },
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reads un-attributed FIRST, so a released id beside it never reads as progress", async () => {
    // The host cannot produce this - `released` is empty whenever nothing was
    // determined - and that is exactly why the client must not depend on it.
    // The ordering is the contract; a client that read `released`/`held` first
    // would report a delivery the host never proved.
    deliverResponse = {
      released: ["cmd-1"],
      unresolved: [
        {
          commandId: "cmd-2",
          code: "delivery_row_not_materialized",
          retryable: true,
          message: "The reconcile pass has not run for this shell yet.",
        },
      ],
      unattributed: [
        {
          code: "delivery_state_unreadable",
          retryable: false,
          message: "This host couldn't read its delivery state.",
        },
      ],
      held: [],
    };

    await deliverAndSettle();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(UNATTRIBUTED_PERMANENT_TITLE, {
      description: "This host couldn't read its delivery state.",
    });
    // ...and the per-command split is NOT also reported: it describes rows the
    // call never got far enough to judge.
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
