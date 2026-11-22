import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  type Query,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";

const POLL_MS = 5_000;
const CONFIG_METHOD = "environment.configuration.revision" as const;

type ConfigurationFixture = {
  readonly requester: HostRequester<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
};

describe("configuration polling window attention", () => {
  let originalVisibility: PropertyDescriptor | undefined;
  let focused: boolean;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
    visibility = "visible";
    originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    setVisibility(visibility);
  });

  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    vi.restoreAllMocks();
    if (originalVisibility === undefined) {
      Reflect.deleteProperty(document, "visibilityState");
    } else {
      Object.defineProperty(document, "visibilityState", originalVisibility);
    }
    vi.useRealTimers();
  });

  it("pauses while blurred and resumes once immediately, then on the five-second cadence", async () => {
    const fixture = createConfigurationFixture();
    const rendered = renderConfigurationQuery(fixture, "blur-cadence");
    await flushRequests(fixture, 1);

    act(() => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
      focusManager.setFocused(true);
    });
    await advance(POLL_MS * 2);
    expect(fixture.requestCount.value).toBe(1);

    const resumedAt = Date.now();
    act(() => {
      focused = true;
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushRequests(fixture, 2);
    await advance(POLL_MS - (Date.now() - resumedAt) - 1);
    expect(fixture.requestCount.value).toBe(2);
    await advance(1);
    await flushRequests(fixture, 3);
    rendered.unmount();
  });

  it("pauses while hidden even when the document still reports focus", async () => {
    const fixture = createConfigurationFixture();
    const rendered = renderConfigurationQuery(fixture, "hidden-cadence");
    await flushRequests(fixture, 1);

    act(() => {
      visibility = "hidden";
      setVisibility(visibility);
      focusManager.setFocused(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(POLL_MS * 2);
    expect(fixture.requestCount.value).toBe(1);

    act(() => {
      visibility = "visible";
      setVisibility(visibility);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushRequests(fixture, 2);
    rendered.unmount();
  });

  it("coalesces duplicate attention events and fetches a shared key once for multiple observers", async () => {
    const fixture = createConfigurationFixture();
    const first = renderConfigurationQuery(fixture, "shared-environment");
    const second = renderConfigurationQuery(fixture, "shared-environment");
    await flushRequests(fixture, 1);

    act(() => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
      focusManager.setFocused(true);
    });
    await advance(POLL_MS * 2);
    expect(fixture.requestCount.value).toBe(1);

    act(() => {
      focused = true;
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushRequests(fixture, 2);
    expect(fixture.requestCount.value).toBe(2);

    first.unmount();
    second.unmount();
  });

  it("resumes batched useHostQueries entries on return to an attended window", async () => {
    const fixture = createConfigurationFixture();
    renderHook(
      () =>
        useHostQueries({
          client: fixture.requester,
          cacheKeyIdentity: undefined,
          requests: [
            {
              method: CONFIG_METHOD,
              params: { environmentId: "batched-a" },
            },
            {
              method: CONFIG_METHOD,
              params: { environmentId: "batched-b" },
            },
          ],
          options: { poll: true },
        }),
      { wrapper: fixture.Wrapper },
    );
    await flushRequests(fixture, 2);

    act(() => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
      focusManager.setFocused(true);
    });
    await advance(POLL_MS * 2);
    expect(fixture.requestCount.value).toBe(2);

    act(() => {
      focused = true;
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushRequests(fixture, 4);
  });

  it("does not resume disabled, opted-out, or unmounted observers", async () => {
    const fixture = createConfigurationFixture();
    const disabled = renderHook(
      () =>
        useHostQuery({
          client: fixture.requester,
          cacheKeyIdentity: undefined,
          method: CONFIG_METHOD,
          params: { environmentId: "disabled" },
          options: { poll: true, enabled: false },
        }),
      { wrapper: fixture.Wrapper },
    );
    const optedOut = renderHook(
      () =>
        useHostQuery({
          client: fixture.requester,
          cacheKeyIdentity: undefined,
          method: CONFIG_METHOD,
          params: { environmentId: "opted-out" },
          options: { poll: false },
        }),
      { wrapper: fixture.Wrapper },
    );
    const unmounted = renderConfigurationQuery(fixture, "unmounted");
    const active = renderConfigurationQuery(fixture, "active");
    await flushRequests(fixture, 3);
    unmounted.unmount();

    act(() => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      focused = true;
      window.dispatchEvent(new Event("focus"));
    });
    await flushRequests(fixture, 4);
    const configurationRequests = fixture.messenger.calls
      .filter((call) => call.method === CONFIG_METHOD)
      .map((call) => call.params);
    expect(configurationRequests).toEqual([
      { environmentId: "opted-out" },
      { environmentId: "unmounted" },
      { environmentId: "active" },
      { environmentId: "active" },
    ]);

    disabled.unmount();
    optedOut.unmount();
    active.unmount();
  });

  it("keeps its own cadence when TanStack's focus manager remains unfocused", async () => {
    const fixture = createConfigurationFixture();
    const rendered = renderConfigurationQuery(fixture, "focus-manager-false");
    await flushRequests(fixture, 1);

    act(() => focusManager.setFocused(false));
    await advance(POLL_MS);
    await flushRequests(fixture, 2);
    rendered.unmount();
  });

  it("keeps ordinary fixed and condition polls on their own cadence while blurred", async () => {
    const fixture = createConfigurationFixture();
    renderHook(
      () =>
        useHostQuery({
          client: fixture.requester,
          cacheKeyIdentity: undefined,
          method: "environment.secrets.rotation",
          params: { environmentId: null, secretId: "fixed-poll" },
          options: { poll: true, refetchOnWindowFocus: false },
        }),
      { wrapper: fixture.Wrapper },
    );
    renderHook(
      () =>
        useHostQuery({
          client: fixture.requester,
          cacheKeyIdentity: undefined,
          method: "agent.gui.listHarnesses",
          params: {},
          options: { poll: true, refetchOnWindowFocus: false },
        }),
      { wrapper: fixture.Wrapper },
    );
    await flushRequests(fixture, 2);

    act(() => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
      focusManager.setFocused(true);
    });
    await advance(800);
    await flushRequests(fixture, 3);
    expect(methodCallCount(fixture, "agent.gui.listHarnesses")).toBe(2);
    expect(methodCallCount(fixture, "environment.secrets.rotation")).toBe(1);

    await advance(2_200);
    await flushRequests(fixture, 5);
    expect(methodCallCount(fixture, "agent.gui.listHarnesses")).toBe(3);
    expect(methodCallCount(fixture, "environment.secrets.rotation")).toBe(2);
  });
});

function renderConfigurationQuery(
  fixture: ConfigurationFixture,
  environmentId: string,
) {
  return renderHook(
    () =>
      useHostQuery({
        client: fixture.requester,
        cacheKeyIdentity: undefined,
        method: CONFIG_METHOD,
        params: { environmentId },
        options: { poll: true },
      }),
    { wrapper: fixture.Wrapper },
  );
}

function createConfigurationFixture(): ConfigurationFixture {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
    },
  });
  const requestCount = { value: 0 };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "configuration-poll-test",
    handlers: {
      [CONFIG_METHOD]: () => {
        requestCount.value += 1;
        return { revision: String(requestCount.value) };
      },
      "environment.secrets.rotation": () => ({
        rotation: null,
        lastVerify: null,
      }),
      "agent.gui.listHarnesses": () => ({
        harnesses: [
          {
            id: "claude",
            label: "Claude Code",
            enabled: true,
            available: false,
            error: "probe pending",
            modes: ["gui", "tui"],
            requiresApiKey: false,
            supportedPermissionModes: [
              "supervised",
              "auto_accept_edits",
              "full_access",
            ],
            nativeAutoJudge: false,
            availabilityPending: true,
          },
        ],
      }),
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    requester: client.createRequester(mockLocalHostEntry),
    queryClient,
    messenger,
    requestCount,
    Wrapper,
  };
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function flushRequests(
  fixture: ConfigurationFixture,
  expected: number,
): Promise<void> {
  await act(async () => {
    await vi.waitFor(
      () => {
        expect(fixture.messenger.calls).toHaveLength(expected);
        const queries: ReadonlyArray<Query> = fixture.queryClient
          .getQueryCache()
          .getAll();
        expect(
          queries.every((query) => query.state.fetchStatus === "idle"),
        ).toBe(true);
      },
      { interval: 10, timeout: 1_000 },
    );
  });
}

function methodCallCount(
  fixture: ConfigurationFixture,
  method: string,
): number {
  return fixture.messenger.calls.filter((call) => call.method === method)
    .length;
}
