import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ListTaskHostsResponse } from "@traycer/protocol/host/task-host-summary";
import { useSandboxEndRead } from "@/hooks/sandboxes/use-sandbox-end-read";
import { useTaskHosts } from "@/hooks/epic/use-task-hosts-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { EpicSessionHostClientContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The read a sandbox chat holds on while its state is unknown, over the real
 * hook and the real `useTaskHosts`: only the host's answer to
 * `epic.listTaskHosts` is faked, per task.
 */

const THIS_TASK = "epic-this";
const OTHER_TASK = "epic-other";
const EMPTY: ListTaskHostsResponse = { hosts: [] };

function transientFailure(): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "Lost the connection to this computer.",
    requestId: "req-transient",
    method: "epic.listTaskHosts",
    fatalDetails: null,
  });
}

interface Deferred {
  readonly promise: Promise<ListTaskHostsResponse>;
  readonly resolve: (value: ListTaskHostsResponse) => void;
}

function deferred(): Deferred {
  let resolve: (value: ListTaskHostsResponse) => void = () => {
    throw new Error("the read has not started");
  };
  const promise = new Promise<ListTaskHostsResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What each task's `epic.listTaskHosts` does, per call, and how often it ran. */
const reads = {
  thisTask: [] as Array<() => Promise<ListTaskHostsResponse>>,
  thisCalls: 0,
  otherCalls: 0,
};

let queryClient: QueryClient;
let client: HostClient<HostRpcRegistry>;

function buildClient(): HostClient<HostRpcRegistry> {
  const built = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-end-read",
      handlers: {
        "epic.listTaskHosts": ({ taskId }) => {
          if (taskId === OTHER_TASK) {
            reads.otherCalls += 1;
            return Promise.reject(transientFailure());
          }
          const call = reads.thisCalls;
          reads.thisCalls += 1;
          const behaviour = reads.thisTask.at(call);
          return behaviour === undefined ? Promise.resolve(EMPTY) : behaviour();
        },
      },
    }),
  });
  built.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return built.createRequester(mockLocalHostEntry);
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionHostClientContext value={client}>
        {props.children}
      </EpicSessionHostClientContext>
    </QueryClientProvider>
  );
}

/** The hook under test, and an optional second task's read kept active beside it. */
function mount(otherTaskActive: boolean) {
  return renderHook(
    (props: { readonly unknown: boolean }) => {
      useTaskHosts(client, otherTaskActive ? OTHER_TASK : "");
      return useSandboxEndRead(THIS_TASK, props.unknown);
    },
    { wrapper, initialProps: { unknown: false } },
  );
}

describe("useSandboxEndRead", () => {
  beforeEach(() => {
    // A transient failure's retry waits far longer than any test runs, so a
    // retry is "out" without ever being dispatched or settled.
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 0, retryDelay: 60_000 } },
    });
    client = buildClient();
    reads.thisTask = [];
    reads.thisCalls = 0;
    reads.otherCalls = 0;
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("holds until this task's own read answers, and leaves another task's failing read alone", async () => {
    const answer = deferred();
    reads.thisTask = [() => Promise.resolve(EMPTY), () => answer.promise];
    const view = mount(true);
    await waitFor(() => {
      expect(reads.thisCalls).toBe(1);
      expect(reads.otherCalls).toBe(1);
    });

    view.rerender({ unknown: true });
    await waitFor(() => expect(reads.thisCalls).toBe(2));
    expect(view.result.current).toBe(true);

    await act(async () => {
      answer.resolve(EMPTY);
      await answer.promise;
    });
    await waitFor(() => expect(view.result.current).toBe(false));
    // The other task's read, active and failing, was neither asked again nor
    // waited on.
    expect(reads.otherCalls).toBe(1);
  });

  it("stops holding at this task's first failed attempt, with its retry still out", async () => {
    reads.thisTask = [
      () => Promise.resolve(EMPTY),
      () => Promise.reject(transientFailure()),
    ];
    const view = mount(false);
    await waitFor(() => expect(reads.thisCalls).toBe(1));

    view.rerender({ unknown: true });
    await waitFor(() => expect(reads.thisCalls).toBe(2));

    await waitFor(() => expect(view.result.current).toBe(false));
    // The retry has been scheduled and nothing has settled it: the hold did
    // not wait for it.
    expect(reads.thisCalls).toBe(2);
    expect(queryClient.isFetching()).toBeGreaterThan(0);
  });
});
