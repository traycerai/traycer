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
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const state = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
}));

// Only requester selection is replaced: Query, status helper and RPC are real.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => state.client,
}));

import { useSandboxRowSessionReport } from "@/hooks/sandboxes/use-sandbox-session-report";

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

function wake(at: number): SandboxSummary {
  return sandboxSummaryFixture({ hostId: HOST_ID, lastTransitionAt: at });
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

afterEach(() => {
  cleanup();
  state.client = null;
});

describe("an awake row's report for its wake", () => {
  it("does not count an earlier wake's cached answer as this wake's", async () => {
    const answer = Promise.withResolvers<unknown>();
    const view = mount([() => STATUS, () => answer.promise], wake(100));
    await waitFor(() => expect(view.result.current.row.hasReported).toBe(true));
    expect(view.result.current.row.report.kind).toBe("live");

    view.rerender(wake(200));
    expect(view.result.current.row.hasReported).toBe(false);
    expect(view.result.current.row.report.kind).toBe("unknown");
    await waitFor(() => expect(view.reads()).toBe(2));

    await act(async () => {
      answer.resolve(STATUS);
      await answer.promise;
    });
    await waitFor(() => expect(view.result.current.row.hasReported).toBe(true));
  });

  it("counts an answer that carries no sessions as the host reporting", async () => {
    const view = mount([() => ({ ...STATUS, sessions: null })], wake(100));
    await waitFor(() => expect(view.result.current.row.hasReported).toBe(true));
    expect(view.result.current.row.report.kind).toBe("unknown");
  });
});
