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
import { hostStatusV110 } from "@traycer/protocol/host/status/contracts";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { sandboxClockLine } from "@/lib/sandboxes/sandbox-row-lines";
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
const STATUS = hostStatusV110.responseSchema.parse({
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
  updatesExternallyManaged: null,
});

function resumed(at: number, phase: "resuming" | "awake"): SandboxSummary {
  return sandboxSummaryFixture({
    hostId: HOST_ID,
    state: phase,
    operation: sandboxOperationFixture({
      at,
      fromState: "suspended",
      state: phase,
      cause: "wake",
      outcomeCause: "wake",
    }),
  });
}

function mount(
  answers: readonly (() => unknown)[],
  initialSummary: SandboxSummary,
) {
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
        return hostStatusV110.responseSchema.parse(await answer());
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
      initialProps: initialSummary,
    },
  );
  onTestFinished(() => {
    view.unmount();
    queryClient.clear();
  });
  return { ...view, queryClient, reads: () => reads };
}

/** Submit a real Resume mutation while retaining control of its reply. */
async function submitResume(queryClient: QueryClient, sandboxId: string) {
  const answer = Promise.withResolvers<void>();
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: sandboxMutationKeys.verb(sandboxId),
    mutationFn: () => answer.promise,
    onMutate: () => ({ userId: null }),
  });
  let completion = Promise.resolve();
  act(() => {
    completion = mutation.execute("resume");
  });
  await waitFor(() => expect(mutation.state.context).toEqual({ userId: null }));
  onTestFinished(async () => {
    answer.resolve();
    await completion;
  });
  return { finish: answer.resolve, completion };
}

afterEach(() => {
  cleanup();
  state.client = null;
});

describe("a resumed row's first host report", () => {
  const AWAKE = sandboxSummaryFixture({ hostId: HOST_ID });

  it("shows the unreachable line when a fresh client first sees an old Resume already awake", async () => {
    const neverAnswers = Promise.withResolvers<unknown>();
    const summary = resumed(100, "awake");
    const view = mount([() => neverAnswers.promise], summary);
    await waitFor(() => expect(view.reads()).toBe(1));

    expect(
      sandboxClockLine({
        summary,
        configuration: { kind: "personal" },
        cost: null,
        wakeString: null,
        viewerUserId: null,
        reachability: { unreachable: true, lastContactAt: null },
        now: 0,
        resumePending: view.result.current.row.resumePending,
      }),
    ).toBe("Running, but Traycer can't connect");
  });

  it("rejects pre-Resume cached status and the prior wake's placeholder through the real query", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const view = mount(
      [() => STATUS, () => first.promise, () => second.promise],
      AWAKE,
    );
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );

    view.rerender(resumed(100, "resuming"));
    expect(view.result.current.row.resumePending).toBe(true);
    expect(view.result.current.row.report.kind).toBe("unknown");
    // Opting in did not change the original query or its cached answer.
    expect(view.result.current.unscoped.report.kind).toBe("live");
    await waitFor(() => expect(view.reads()).toBe(2));

    view.rerender(resumed(100, "awake"));
    expect(view.result.current.row.resumePending).toBe(true);
    await act(async () => {
      first.resolve(STATUS);
      await first.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );

    // A different wake of this same host cannot retain the last one's data.
    view.rerender(resumed(200, "resuming"));
    expect(view.result.current.row.resumePending).toBe(true);
    expect(view.result.current.row.report.kind).toBe("unknown");
    await waitFor(() => expect(view.reads()).toBe(3));
    view.rerender(resumed(200, "awake"));
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
    const view = mount(
      [() => STATUS, () => answer.promise, () => outage.promise],
      AWAKE,
    );
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );
    view.rerender(resumed(100, "resuming"));
    await waitFor(() => expect(view.reads()).toBe(2));
    view.rerender(resumed(100, "awake"));
    await act(async () => {
      answer.resolve({ ...STATUS, sessions: null });
      await answer.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );
    expect(view.result.current.row.report.kind).toBe("unknown");

    const wakeKey = [
      ...hostQueryKeys.methodScope(HOST_ID, "host.status"),
      {},
      "sandbox-wake",
      "list",
      100,
    ];
    act(() =>
      view.queryClient.removeQueries({ queryKey: wakeKey, exact: true }),
    );
    view.rerender(resumed(100, "awake"));
    expect(view.result.current.row.resumePending).toBe(false);

    // Refetch only this wake's active query, leaving the unscoped caller alone.
    await act(async () => {
      const refresh = view.queryClient.invalidateQueries({
        queryKey: wakeKey,
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
    const view = mount([() => STATUS, () => answer.promise], AWAKE);
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );
    view.rerender(resumed(100, "resuming"));
    expect(view.result.current.row.resumePending).toBe(true);
    await waitFor(() => expect(view.reads()).toBe(2));
    view.rerender({ ...resumed(100, "resuming"), state: "stopped" });
    expect(view.result.current.row.resumePending).toBe(false);
    await act(async () => {
      answer.resolve(STATUS);
      await answer.promise;
    });
  });

  it("keeps a Resume this client sent pending when the list skips straight to awake", async () => {
    const answer = Promise.withResolvers<unknown>();
    const resting = sandboxSummaryFixture({
      hostId: HOST_ID,
      state: "suspended",
    });
    const view = mount([() => STATUS, () => answer.promise], resting);
    await waitFor(() =>
      expect(view.result.current.unscoped.report.kind).toBe("live"),
    );
    const sending = await submitResume(view.queryClient, resting.id);
    // Observe the pending mutation before its successful control-plane reply.
    view.rerender(resting);
    await act(async () => {
      sending.finish();
      await sending.completion;
    });
    view.rerender(resumed(100, "awake"));
    expect(view.result.current.row.resumePending).toBe(true);
    await waitFor(() => expect(view.reads()).toBe(2));
    await act(async () => {
      answer.resolve(STATUS);
      await answer.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );
  });

  it("lets a resting lifecycle consume a still-pending Resume without rearming it", async () => {
    const answer = Promise.withResolvers<unknown>();
    const nextAnswer = Promise.withResolvers<unknown>();
    const resting = sandboxSummaryFixture({
      hostId: HOST_ID,
      state: "suspended",
    });
    const view = mount(
      [() => STATUS, () => answer.promise, () => nextAnswer.promise],
      resting,
    );
    await waitFor(() =>
      expect(view.result.current.unscoped.report.kind).toBe("live"),
    );
    const sending = await submitResume(view.queryClient, resting.id);
    view.rerender(resumed(100, "awake"));
    await waitFor(() => expect(view.reads()).toBe(2));
    await act(async () => {
      answer.resolve(STATUS);
      await answer.promise;
    });
    await waitFor(() =>
      expect(view.result.current.row.report.kind).toBe("live"),
    );
    expect(view.queryClient.getMutationCache().getAll()[0]?.state.status).toBe(
      "pending",
    );

    const suspended = sandboxSummaryFixture({
      hostId: HOST_ID,
      state: "suspended",
      operation: sandboxOperationFixture({
        at: 200,
        fromState: "awake",
        state: "suspended",
        cause: "idle",
        outcomeCause: "idle",
      }),
    });
    view.rerender(suspended);
    expect(
      sandboxClockLine({
        summary: suspended,
        configuration: { kind: "personal" },
        cost: null,
        wakeString: null,
        viewerUserId: null,
        reachability: { unreachable: false, lastContactAt: null },
        now: 0,
        resumePending: view.result.current.row.resumePending,
      }),
    ).toMatch(/^Suspended since /);

    await act(async () => {
      sending.finish();
      await sending.completion;
    });
    const next = await submitResume(view.queryClient, resting.id);
    view.rerender(resumed(300, "awake"));
    expect(view.result.current.row.resumePending).toBe(true);
    await waitFor(() => expect(view.reads()).toBe(3));
    await act(async () => {
      nextAnswer.resolve(STATUS);
      await nextAnswer.promise;
      next.finish();
      await next.completion;
    });
    await waitFor(() =>
      expect(view.result.current.row.resumePending).toBe(false),
    );
  });
});
