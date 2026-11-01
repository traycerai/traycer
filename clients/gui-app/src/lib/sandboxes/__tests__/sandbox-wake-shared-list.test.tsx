/**
 * A wake reads the sandbox list through the shared query, so every surface on
 * that sandbox follows the wake from those reads, also while the lifecycle
 * verb holds its request (which can be minutes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxLifecycleVerbFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const HOST_ID = "host-sbx-1";
const POLL_MS = 2_000;

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/host/runtime", () => ({
  getHostBindingSnapshot: () => mocks.binding,
}));
vi.mock("@/lib/host", () => ({ useHostBinding: () => mocks.binding }));
// The app-wide client a pick wakes through, free of the app's persistence.
vi.mock("@/lib/query-client", async () => {
  const { QueryClient: Client } = await import("@tanstack/react-query");
  return {
    queryClient: new Client({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    }),
  };
});

import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { queryClient } from "@/lib/query-client";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useAuthStore } from "@/stores/auth/auth-store";

const client = queryClient;
let rowState: HostSandboxState;
let settleVerb: (() => void) | null;

function wrapper({ children }: { readonly children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function listCalls(): number {
  return mocks.binding?.auth.listSandboxes.mock.calls.length ?? 0;
}

/** The first read, then the verb sent and held. */
async function startHeldWake(): Promise<void> {
  const binding = mocks.binding;
  if (binding === null) throw new Error("no binding");
  binding.auth.runSandboxVerb.mockImplementation(
    () =>
      new Promise<SandboxLifecycleVerbFetchResult>((resolve) => {
        settleVerb = () => {
          resolve({ kind: "ok", settled: true, state: null });
        };
      }),
  );
  wakeSandboxOnPick(
    hostScopeOptionFixture({
      hostId: HOST_ID,
      kind: "sandbox",
      connectable: false,
      sandbox: {
        state: "suspended",
        frozen: false,
        summary: sandboxSummaryFixture({
          id: "sbx_1",
          hostId: HOST_ID,
          state: "suspended",
        }),
        teamOwned: false,
      },
    }),
    null,
  );
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  rowState = "suspended";
  settleVerb = null;
  mocks.binding = createFakeSandboxBinding();
  mocks.binding.auth.listSandboxes.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            id: "sbx_1",
            hostId: HOST_ID,
            state: rowState,
          }),
        ],
      },
    }),
  );
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
});

afterEach(async () => {
  // A wake still in flight is the module's, and would join the next test's.
  rowState = "awake";
  settleVerb?.();
  await vi.advanceTimersByTimeAsync(POLL_MS * 10);
  client.clear();
  vi.useRealTimers();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a wake's reads of the sandbox list", () => {
  it("reach a surface reading the list while the verb still holds its request", async () => {
    const list = renderHook(() => useSandboxList(), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    expect(list.result.current.data?.sandboxes[0]?.state).toBe("suspended");

    await startHeldWake();
    expect(settleVerb).not.toBeNull();
    rowState = "resuming";
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(500));

    // The verb has not answered, and the surface already sees the move.
    expect(list.result.current.data?.sandboxes[0]?.state).toBe("resuming");

    rowState = "awake";
    settleVerb?.();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(list.result.current.data?.sandboxes[0]?.state).toBe("awake");
  });

  it("stop following once the verb settles", async () => {
    await startHeldWake();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    const whileHeld = listCalls();
    expect(whileHeld).toBeGreaterThan(2);

    rowState = "awake";
    settleVerb?.();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    const atSettled = listCalls();
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);

    expect(listCalls()).toBe(atSettled);
  });
});
