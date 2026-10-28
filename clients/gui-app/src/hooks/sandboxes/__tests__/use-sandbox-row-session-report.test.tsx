import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostStatusV19 } from "@traycer/protocol/host/status/contracts";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  sandboxOperationFixture,
  sandboxSummaryFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const state = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
}));

// Only requester selection is replaced: Query, status helper and RPC are real.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => state.client,
}));

import {
  useSandboxRowSessionReport,
  useSandboxSessionReport,
} from "@/hooks/sandboxes/use-sandbox-session-report";

const HOST_ID = mockLocalHostEntry.hostId;
const STATUS = hostStatusV19.responseSchema.parse({
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  busyBreakdown: null,
  updateProgress: null,
  updateOperation: null,
  updateTransaction: null,
  storeFormats: null,
  install: null,
  processMemory: null,
  crossHostMessaging: null,
  sessions: { agents: [], terminals: [] },
});

function resumed(at: number): SandboxSummary {
  return sandboxSummaryFixture({
    hostId: HOST_ID,
    state: "resuming",
    operation: sandboxOperationFixture({
      at,
      fromState: "suspended",
      state: "resuming",
      cause: "wake",
      outcomeCause: "wake",
    }),
  });
}

function mount(answers: readonly (() => unknown)[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let reads = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `status-${String(reads)}`,
    handlers: {
      "host.status": async () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return hostStatusV19.responseSchema.parse(await answer());
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  client.setRequestContext(createRequestContextFixture({ origin: "renderer" }));
  state.client = client.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const view = renderHook(
    (summary: SandboxSummary) => ({
      row: useSandboxRowSessionReport(summary),
      // The dialog's unscoped caller still shares the original host query.
      unscoped: useSandboxSessionReport(HOST_ID, true),
    }),
    {
      wrapper: Wrapper,
      initialProps: sandboxSummaryFixture({ hostId: HOST_ID }),
    },
  );
  onTestFinished(() => {
    view.unmount();
    queryClient.clear();
  });
  return { ...view, queryClient, reads: () => reads };
}

afterEach(() => {
  cleanup();
  state.client = null;
});

describe("a resumed row's first host report", () => {
  it("rejects pre-Resume cached status and the prior wake's placeholder through the real query", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const view = mount([
      () => STATUS,
      () => first.promise,
      () => second.promise,
    ]);
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );

    view.rerender(resumed(100));
    expect(view.result.current.row.resumePending).toBe(true);
    expect(view.result.current.row.report.kind).toBe("unknown");
    // Opting in did not change the original query or its cached answer.
    expect(view.result.current.unscoped.report.kind).toBe("live");
    await waitFor(() => expect(view.reads()).toBe(2));

    view.rerender({ ...resumed(100), state: "awake" });
    expect(view.result.current.row.resumePending).toBe(true);
    await act(async () => {
      first.resolve(STATUS);
      await first.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );

    // A different wake of this same host cannot retain the last one's data.
    view.rerender({ ...resumed(200), state: "awake" });
    expect(view.result.current.row.resumePending).toBe(true);
    expect(view.result.current.row.report.kind).toBe("unknown");
    await waitFor(() => expect(view.reads()).toBe(3));
    await act(async () => {
      second.resolve(STATUS);
      await second.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );
  });

  it("accepts an answer without sessions and never calls a later outage a new Resume", async () => {
    const answer = Promise.withResolvers<unknown>();
    const outage = Promise.withResolvers<unknown>();
    const view = mount([
      () => STATUS,
      () => answer.promise,
      () => outage.promise,
    ]);
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );
    view.rerender({ ...resumed(100), state: "awake" });
    await waitFor(() => expect(view.reads()).toBe(2));
    await act(async () => {
      answer.resolve({ ...STATUS, sessions: null });
      await answer.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );
    expect(view.result.current.row.report.kind).toBe("unknown");

    // Refetch only this wake's active query, leaving the unscoped caller alone.
    await act(async () => {
      const refresh = view.queryClient.invalidateQueries({
        queryKey: [
          ...hostQueryKeys.methodScope(HOST_ID, "host.status"),
          {},
          "sandbox-wake",
          100,
          "wake",
        ],
        exact: true,
      });
      await waitFor(() => expect(view.reads()).toBe(3));
      outage.reject(new Error("Host disconnected"));
      await refresh;
    });
    await waitFor(() => expect(view.result.current.row.failed).toBe(true));
    expect(view.result.current.row.resumePending).toBe(false);
  });

  it("lets a new lifecycle state replace Resume before the host answers", async () => {
    const answer = Promise.withResolvers<unknown>();
    const view = mount([() => STATUS, () => answer.promise]);
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );
    view.rerender(resumed(100));
    expect(view.result.current.row.resumePending).toBe(true);
    await waitFor(() => expect(view.reads()).toBe(2));
    view.rerender({ ...resumed(100), state: "stopped" });
    expect(view.result.current.row.resumePending).toBe(false);
    await act(async () => {
      answer.resolve(STATUS);
      await answer.promise;
    });
  });
});
