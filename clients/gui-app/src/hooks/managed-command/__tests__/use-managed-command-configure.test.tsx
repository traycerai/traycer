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
 * `managedCommand.configure`, driven against a real `HostClient` and a mock
 * host. What this suite pins is ORDERING: two presses on one command's switch
 * reach the host in the order they were pressed, even though the request
 * coordinator keys its queues by the full params (which include the value) and
 * would otherwise run an "on" and an "off" as two independent jobs.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  useHostDirectory: () => ({
    findById: () => mockLocalHostEntry,
  }),
}));

import {
  useManagedCommandConfigure,
  useManagedCommandConfigureIsPending,
  useManagedCommandRelaunchOnHostRestart,
} from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";

const EPIC_ID = "epic-1";
const COMMAND_ID = "cmd-1";

const COMMAND: ManagedCommand = {
  id: COMMAND_ID,
  monitoring: false,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: null,
  cadence: null,
  status: { state: "exited", exitCode: 0, signal: null, exitedAtMs: 2 },
  chatId: "chat-1",
  relaunchOnHostRestart: false,
  createdAtMs: 1,
  updatedAtMs: 2,
};

/** Every value the mock host was asked to set, in arrival order. */
let received: boolean[] = [];
/** Each request's answer waits on its own gate, so the test owns the timing. */
let gates: { promise: Promise<void>; release: () => void }[] = [];

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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
  received = [];
  gates = [];
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  let requestSeq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `configure-request-${requestSeq++}`,
    handlers: {
      "managedCommand.configure": async (request) => {
        received.push(request.relaunchOnHostRestart);
        const gate = makeGate();
        gates.push(gate);
        await gate.promise;
        // The host bumps `updatedAtMs` on every live change, and that is
        // what lets a surface tell an answered write from a stale stream.
        return {
          command: {
            ...COMMAND,
            relaunchOnHostRestart: request.relaunchOnHostRestart,
            updatedAtMs: COMMAND.updatedAtMs + 1,
          },
        };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  hostClient = spine.createRequester(mockLocalHostEntry);
  hostClient.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "configure-token",
    }),
  );
});

afterEach(() => {
  cleanup();
  hostClient.dispose();
});

describe("useManagedCommandConfigure", () => {
  it("serializes on-then-off for one command: the host sees true before false, and not both at once", async () => {
    // Two hook instances for the same command - the list row and the output
    // window header both render the switch - so the ordering must hold
    // ACROSS instances, not merely within one observer.
    const target = { hostId: mockLocalHostEntry.hostId, commandId: COMMAND_ID };
    const row = renderHook(() => useManagedCommandConfigure(target), {
      wrapper,
    });
    const header = renderHook(() => useManagedCommandConfigure(target), {
      wrapper,
    });
    const variables = {
      hostId: mockLocalHostEntry.hostId,
      epicId: EPIC_ID,
      commandId: COMMAND_ID,
    };

    act(() => {
      row.result.current.mutate({ ...variables, relaunchOnHostRestart: true });
      header.result.current.mutate({
        ...variables,
        relaunchOnHostRestart: false,
      });
    });
    await waitFor(() => {
      expect(received).toEqual([true]);
    });
    // The off press is queued behind the on press, not racing it: with the
    // first request still unanswered, the host has not been asked again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(received).toEqual([true]);

    act(() => {
      gates[0].release();
    });
    await waitFor(() => {
      expect(received).toEqual([true, false]);
    });
    act(() => {
      gates[1].release();
    });
    await waitFor(() => {
      expect(row.result.current.isSuccess).toBe(true);
      expect(header.result.current.isSuccess).toBe(true);
    });
    expect(header.result.current.data?.command.relaunchOnHostRestart).toBe(
      false,
    );

    // Both answers carry the SAME `updatedAtMs` (the mock host stamps every
    // write identically, as two presses in one millisecond would). The
    // effective value must be the later-submitted write's - off - not the
    // first's; a strict timestamp comparison alone kept "on" here.
    const effective = renderHook(
      () => useManagedCommandRelaunchOnHostRestart(target, COMMAND),
      { wrapper },
    );
    expect(effective.result.current).toBe(false);
  });

  it("reports pending to every surface of the command, and to no other command", async () => {
    // The shared read is what stops a second surface from doubling a write
    // while the first is unanswered; it must be per command, or one shell's
    // slow write would freeze every other shell's switch.
    const target = { hostId: mockLocalHostEntry.hostId, commandId: COMMAND_ID };
    const row = renderHook(() => useManagedCommandConfigure(target), {
      wrapper,
    });
    const header = renderHook(
      () => useManagedCommandConfigureIsPending(target),
      { wrapper },
    );
    const other = renderHook(
      () =>
        useManagedCommandConfigureIsPending({
          hostId: mockLocalHostEntry.hostId,
          commandId: "cmd-other",
        }),
      { wrapper },
    );
    expect(header.result.current).toBe(false);

    act(() => {
      row.result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandId: COMMAND_ID,
        relaunchOnHostRestart: true,
      });
    });
    await waitFor(() => {
      expect(header.result.current).toBe(true);
    });
    expect(other.result.current).toBe(false);

    act(() => {
      gates[0].release();
    });
    await waitFor(() => {
      expect(row.result.current.isSuccess).toBe(true);
      expect(header.result.current).toBe(false);
    });
  });

  it("reads an answered write's value over a stale streamed record until the stream catches up", async () => {
    // After the write answers and before `managedCommandsChanged` lands, the
    // streamed record still says `false`. Every surface must read `true`
    // from the settled write, or the next press re-sends `true`.
    const target = { hostId: mockLocalHostEntry.hostId, commandId: COMMAND_ID };
    const row = renderHook(() => useManagedCommandConfigure(target), {
      wrapper,
    });
    const header = renderHook(
      () => useManagedCommandRelaunchOnHostRestart(target, COMMAND),
      { wrapper },
    );
    expect(header.result.current).toBe(false);

    act(() => {
      row.result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandId: COMMAND_ID,
        relaunchOnHostRestart: true,
      });
    });
    await waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    // Unanswered: still the streamed value.
    expect(header.result.current).toBe(false);
    act(() => {
      gates[0].release();
    });
    await waitFor(() => {
      expect(header.result.current).toBe(true);
    });

    // The stream catches up with a NEWER record: it wins again, whatever it
    // says - here a later change turned the flag back off.
    const caughtUp = renderHook(
      () =>
        useManagedCommandRelaunchOnHostRestart(target, {
          ...COMMAND,
          relaunchOnHostRestart: false,
          updatedAtMs: COMMAND.updatedAtMs + 2,
        }),
      { wrapper },
    );
    expect(caughtUp.result.current).toBe(false);
    // An EQUAL stamp is the stream's too: another client's write in the same
    // millisecond as ours is causally newer and lives in no local cache, so
    // no local order could rank it. (For our own answer it changes nothing -
    // the values agree.) Settled precedence here would show the obsolete
    // value indefinitely.
    const sameStamp = renderHook(
      () =>
        useManagedCommandRelaunchOnHostRestart(target, {
          ...COMMAND,
          relaunchOnHostRestart: false,
          updatedAtMs: COMMAND.updatedAtMs + 1,
        }),
      { wrapper },
    );
    expect(sameStamp.result.current).toBe(false);
    // And an unrelated command never reads this command's write.
    const other = renderHook(
      () =>
        useManagedCommandRelaunchOnHostRestart(
          { hostId: mockLocalHostEntry.hostId, commandId: "cmd-other" },
          COMMAND,
        ),
      { wrapper },
    );
    expect(other.result.current).toBe(false);
  });

  it("does not serialize writes to DIFFERENT commands behind each other", async () => {
    // The scope is per command: a slow write to one shell must not hold up a
    // press on another. Asserted positively (both requests arrive while the
    // first is still unanswered) so a scope that accidentally covered the
    // whole method would fail here rather than pass by being extra-safe.
    const a = renderHook(
      () =>
        useManagedCommandConfigure({
          hostId: mockLocalHostEntry.hostId,
          commandId: "cmd-a",
        }),
      { wrapper },
    );
    const b = renderHook(
      () =>
        useManagedCommandConfigure({
          hostId: mockLocalHostEntry.hostId,
          commandId: "cmd-b",
        }),
      { wrapper },
    );
    act(() => {
      a.result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandId: "cmd-a",
        relaunchOnHostRestart: true,
      });
      b.result.current.mutate({
        hostId: mockLocalHostEntry.hostId,
        epicId: EPIC_ID,
        commandId: "cmd-b",
        relaunchOnHostRestart: false,
      });
    });
    await waitFor(() => {
      expect(received).toEqual([true, false]);
    });
    expect(gates).toHaveLength(2);
    for (const gate of gates) gate.release();
    await waitFor(() => {
      expect(a.result.current.isSuccess).toBe(true);
      expect(b.result.current.isSuccess).toBe(true);
    });
  });
});
