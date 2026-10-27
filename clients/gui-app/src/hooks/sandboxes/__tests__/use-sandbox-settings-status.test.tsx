import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

/**
 * The readiness `useSandboxSettingsStatus` gives a pending send, through the
 * real host query: a receipt from before this wake never counts, a failed read
 * or a stale in-flight answer never unlocks, and a host known to lack
 * `environment.status` falls back to the older evidence.
 */

const state = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  support: true as boolean | null,
  entry: null as { websocketUrl: string; transportDialability: string } | null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => state.client,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => state.entry,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => state.support,
}));

import { useSandboxSettingsStatus } from "@/hooks/sandboxes/use-sandbox-settings-status";

const HOST_ID = mockLocalHostEntry.hostId;

function status(items: readonly { kind: string; status: string }[]) {
  return {
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 1,
    desiredRevision: 5,
    receivedRevision: 5,
    appliedRevision: 5,
    receiptAgeMs: 0,
    items: items.map((item, index) => ({
      kind: item.kind,
      key: `key-${String(index)}`,
      os: "any",
      desiredRevision: 3,
      status: item.status,
      code: "ok",
      args: { exitStatus: null, stage: null, durationMs: null, kind: null },
      brokerEnforced: null,
      minimumHostVersion: null,
      appliedAs: null,
    })),
  };
}

const HOST_STATUS = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  updateOperation: null,
  updateTransaction: null,
  storeFormats: null,
  install: null,
  processMemory: null,
  crossHostMessaging: null,
  sessions: null,
};

const APPLIED = status([{ kind: "variable", status: "applied" }]);

interface Gate {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function gate(): Gate {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Answers `environment.status` from a script: each read takes the next answer, the last repeats. */
function mount(
  answers: readonly (() => Promise<unknown> | unknown)[],
  hostStatusAnswers: readonly (() => Promise<unknown> | unknown)[],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  let reads = 0;
  let probes = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${String(reads)}`,
    handlers: {
      "host.status": () => {
        const answer =
          hostStatusAnswers[Math.min(probes, hostStatusAnswers.length - 1)];
        probes += 1;
        return answer();
      },
      "environment.status": () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return answer();
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === HOST_ID ? mockLocalHostEntry : null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  state.client = client.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const view = renderHook(
    (props: { readonly transitionAt: number }) =>
      useSandboxSettingsStatus(
        sandboxSummaryFixture({
          hostId: HOST_ID,
          state: "awake",
          lastTransitionAt: props.transitionAt,
        }),
      ),
    { wrapper: Wrapper, initialProps: { transitionAt: 1 } },
  );
  return Object.assign(view, { probes: () => probes, reads: () => reads });
}

function mockEntry() {
  return {
    websocketUrl: "wss://sandbox-1.example/a",
    transportDialability: "dialable",
  };
}

beforeEach(() => {
  state.support = true;
  state.entry = mockEntry();
});

afterEach(() => {
  cleanup();
  state.client = null;
});

describe("useSandboxSettingsStatus readiness", () => {
  it("is ready once a fresh status reports every item applied", async () => {
    const view = mount([() => APPLIED], [() => HOST_STATUS]);
    expect(view.result.current.ready).toBe(false);

    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });
  });

  it("parks the previous wake's receipt: a new awake generation is held until its own fresh applied status", async () => {
    const second = gate();
    const view = mount([() => APPLIED, () => second.promise], [() => HOST_STATUS]);
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });

    view.rerender({ transitionAt: 2 });

    await waitFor(() => {
      expect(view.result.current.ready).toBe(false);
    });
    // The old receipt is still in the cache; it must not unlock the new wake.
    expect(view.result.current.ready).toBe(false);
    await act(async () => {
      second.resolve(APPLIED);
      await second.promise;
    });
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });
  });

  it.each([
    ["a new endpoint", { websocketUrl: "wss://sandbox-1.example/b" }],
    ["a changed dialability", { transportDialability: "undialable" }],
  ])(
    "holds the prior receipt on %s of the same host and wake, until a new read answers",
    async (_name, change) => {
      const second = gate();
      const view = mount([() => APPLIED, () => second.promise], [() => HOST_STATUS]);
      await waitFor(() => {
        expect(view.result.current.ready).toBe(true);
      });

      state.entry = { ...(state.entry ?? mockEntry()), ...change };
      view.rerender({ transitionAt: 1 });

      await waitFor(() => {
        expect(view.result.current.ready).toBe(false);
      });
      await act(async () => {
        second.resolve(APPLIED);
        await second.promise;
      });
      await waitFor(() => {
        expect(view.result.current.ready).toBe(true);
      });
    },
  );

  it("keeps a verified ready through an ordinary refetch, pending or completed", async () => {
    const refetch = gate();
    const view = mount([() => APPLIED, () => refetch.promise], [() => HOST_STATUS]);
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = view.result.current.refetch();
    });
    await waitFor(() => {
      expect(view.result.current.isFetching).toBe(true);
    });
    expect(view.result.current.ready).toBe(true);

    await act(async () => {
      refetch.resolve(APPLIED);
      await pending;
    });
    expect(view.result.current.ready).toBe(true);
  });

  it("stays held when the status read fails", async () => {
    const view = mount([
      () => {
        throw new Error("host unreachable");
      },
    ], [() => HOST_STATUS]);

    await waitFor(() => {
      expect(view.result.current.fetchStatus).toBe("idle");
    });
    expect(view.result.current.ready).toBe(false);
  });

  it("is not unlocked by a stale answer to a request begun before the wake", async () => {
    const before = gate();
    const after = gate();
    const view = mount([() => before.promise, () => after.promise], [() => HOST_STATUS]);
    await waitFor(() => {
      expect(view.result.current.isFetching).toBe(true);
    });

    view.rerender({ transitionAt: 2 });
    await act(async () => {
      before.resolve(APPLIED);
      await before.promise;
    });

    expect(view.result.current.ready).toBe(false);
    await act(async () => {
      after.resolve(APPLIED);
      await after.promise;
    });
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });
  });

  it.each([
    ["an explicit settings operation still pending (null operation id)", { ...APPLIED, sandboxSettingsOperationId: null }],
    ["a status with no principal, though a received revision is cached", { ...APPLIED, principal: null }],
  ])("stays held on %s", async (_name, answer) => {
    const view = mount([() => answer], [() => HOST_STATUS]);

    await waitFor(() => {
      expect(view.result.current.isSuccess).toBe(true);
    });
    expect(view.result.current.ready).toBe(false);
  });

  it("is ready on a named operation id with every item applied, and on an older host that sends none", async () => {
    const named = mount(
      [() => ({ ...APPLIED, sandboxSettingsOperationId: "op-1" })],
      [() => HOST_STATUS],
    );
    await waitFor(() => {
      expect(named.result.current.ready).toBe(true);
    });
    cleanup();

    const older = mount([() => APPLIED], [() => HOST_STATUS]);
    await waitFor(() => {
      expect(older.result.current.ready).toBe(true);
    });
  });

  it("stays held on an item status this app does not know", async () => {
    const view = mount([
      () => status([{ kind: "variable", status: "some_future_status" }]),
    ], [() => HOST_STATUS]);

    await waitFor(() => {
      expect(view.result.current.isSuccess).toBe(true);
    });
    expect(view.result.current.ready).toBe(false);
  });

  it("starts a host.status probe while the manifest is unknown, then reads environment.status once support is known", async () => {
    state.support = null;
    const view = mount([() => APPLIED], [() => HOST_STATUS]);
    await waitFor(() => {
      expect(view.probes()).toBe(1);
    });
    expect(view.reads()).toBe(0);
    expect(view.result.current.ready).toBe(false);

    state.support = true;
    view.rerender({ transitionAt: 1 });

    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });
    expect(view.reads()).toBeGreaterThan(0);
  });

  it("holds a known-absent method until this episode's own probe answers, then falls back to the older evidence", async () => {
    state.support = false;
    const probe = gate();
    const view = mount([() => APPLIED], [() => probe.promise]);

    await waitFor(() => {
      expect(view.probes()).toBe(1);
    });
    expect(view.result.current.ready).toBe(false);
    expect(view.reads()).toBe(0);

    await act(async () => {
      probe.resolve(HOST_STATUS);
      await probe.promise;
    });
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });
    expect(view.reads()).toBe(0);
  });

  it("holds the older-evidence fallback again across a wake until a fresh probe answers", async () => {
    state.support = false;
    const second = gate();
    const view = mount([() => APPLIED], [() => HOST_STATUS, () => second.promise]);
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });

    view.rerender({ transitionAt: 2 });

    await waitFor(() => {
      expect(view.result.current.ready).toBe(false);
    });
    await act(async () => {
      second.resolve(HOST_STATUS);
      await second.promise;
    });
    await waitFor(() => {
      expect(view.result.current.ready).toBe(true);
    });
  });
});
