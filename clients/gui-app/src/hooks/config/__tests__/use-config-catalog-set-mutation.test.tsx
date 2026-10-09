import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ConfigCatalogSetRequest } from "@traycer/protocol/host/config/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  useConfigCatalogSetMutation,
  useConfigCatalogSetOutstanding,
} from "@/hooks/config/use-config-catalog-set-mutation";
import { FloorEnforcingMessenger } from "./floor-enforcing-messenger";

const toasted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (...args: ReadonlyArray<unknown>) => {
    toasted(...args);
  },
}));

/**
 * The scoped write carries a dispatch-time floor of `config.catalog.set@1.1`.
 * Without it, a host rolled back to 1.0 after the rows rendered would take the
 * 1.1 body through the same-major downgrade, whose 1.0 schema strips `scope`
 * and `harnessId` and moves the SHARED value. The messenger here enforces the
 * floor with the transports' own predicate and error, so a hook that dropped
 * the option reaches the handler and these tests redden.
 */
const HOST_ID = mockLocalHostEntry.hostId;
const OTHER_HOST_ID = "host-b";
const V10: SchemaVersion = { major: 1, minor: 0 };
const V11: SchemaVersion = { major: 1, minor: 1 };

const HARNESS_WRITE: ConfigCatalogSetRequest = {
  scope: "harness",
  harnessId: "claude",
  probeTimeoutSeconds: 120,
};

function fixture(
  negotiated: SchemaVersion,
  hold: Promise<void> | null,
): {
  readonly messenger: FloorEnforcingMessenger<HostRpcRegistry>;
  readonly handled: ConfigCatalogSetRequest[];
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const handled: ConfigCatalogSetRequest[] = [];
  const messenger = new FloorEnforcingMessenger<HostRpcRegistry>(
    {
      registry: hostRpcRegistry,
      requestId: () => "req-catalog-set",
      handlers: {
        "config.catalog.set": async (params) => {
          handled.push(params);
          await (hold ?? Promise.resolve());
          return {
            probeTimeoutSeconds: 60,
            overrides: { claude: 120 },
            bounds: { minSeconds: 60, maxSeconds: 180 },
          };
        },
      },
    },
    new Map([["config.catalog.set", negotiated]]),
  );
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return {
    messenger,
    handled,
    client: spine.createRequester(mockLocalHostEntry),
    Wrapper,
  };
}

describe("useConfigCatalogSetMutation's dispatch-time version floor", () => {
  beforeEach(() => {
    toasted.mockClear();
  });

  it("attaches a floor of config.catalog.set@1.1 to the write", async () => {
    const f = fixture(V11, null);
    const rendered = renderHook(
      () => useConfigCatalogSetMutation(f.client, HOST_ID),
      {
        wrapper: f.Wrapper,
      },
    );

    await rendered.result.current.mutateAsync(HARNESS_WRITE);

    expect(f.messenger.calls).toHaveLength(1);
    expect(f.messenger.calls[0]?.method).toBe("config.catalog.set");
    expect(f.messenger.calls[0]?.requiredHostMethodVersion).toEqual({
      method: "config.catalog.set",
      version: { major: 1, minor: 1 },
    });
    expect(f.handled).toEqual([HARNESS_WRITE]);
  });

  it("refuses the write on a connection that negotiated 1.0: the handler never runs and no 1.0 body can reach it", async () => {
    const f = fixture(V10, null);
    const rendered = renderHook(
      () => useConfigCatalogSetMutation(f.client, HOST_ID),
      {
        wrapper: f.Wrapper,
      },
    );

    const failure = await rendered.result.current
      .mutateAsync(HARNESS_WRITE)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(f.handled).toEqual([]);
    expect(f.messenger.dispatched).toEqual([]);
    expect(f.messenger.calls).toEqual([]);
    expect(toasted).toHaveBeenCalledTimes(1);
    expect(toasted).toHaveBeenCalledWith(
      failure,
      "Couldn't update the model list timeout",
    );
  });

  it("refuses the shared write too, since the floor is the method's, not the scope's", async () => {
    const f = fixture(V10, null);
    const rendered = renderHook(
      () => useConfigCatalogSetMutation(f.client, HOST_ID),
      {
        wrapper: f.Wrapper,
      },
    );

    const failure = await rendered.result.current
      .mutateAsync({ scope: "all", probeTimeoutSeconds: 90 })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(f.handled).toEqual([]);
  });
});

describe("useConfigCatalogSetOutstanding", () => {
  it("is true on the asked host while its set is held, even after the component that sent it unmounted; false for another host; false once it answers", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(V11, hold);

    // One component sends the write; another, mounted for the whole test, only
    // reads who is outstanding - the rows that mount while a write is in flight.
    const watcher = renderHook(
      () => ({
        hostA: useConfigCatalogSetOutstanding(HOST_ID),
        hostB: useConfigCatalogSetOutstanding(OTHER_HOST_ID),
      }),
      { wrapper: f.Wrapper },
    );
    const sender = renderHook(
      () => useConfigCatalogSetMutation(f.client, HOST_ID),
      { wrapper: f.Wrapper },
    );
    expect(watcher.result.current).toEqual({ hostA: false, hostB: false });

    act(() => {
      sender.result.current.mutate(HARNESS_WRITE);
    });
    await waitFor(() => {
      expect(watcher.result.current.hostA).toBe(true);
    });
    expect(f.handled).toEqual([HARNESS_WRITE]);

    // The sender goes away with the write still on the wire.
    sender.unmount();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(watcher.result.current).toEqual({ hostA: true, hostB: false });

    release();
    await waitFor(() => {
      expect(watcher.result.current.hostA).toBe(false);
    });
    expect(watcher.result.current.hostB).toBe(false);
  });
});
