import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import {
  providerCliStateSchema,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";

const host = vi.hoisted(
  (): {
    client: HostClient<HostRpcRegistry> | null;
  } => ({ client: null }),
);

vi.mock("@/lib/host", () => ({
  useHostClient: () => host.client,
  useHostRuntimeClient: () => host.client,
}));

import {
  useModelProviderVisibility,
  type ModelProviderVisibility,
} from "../use-model-provider-visibility";

type ProvidersResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type HiddenResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.setModelProviderHidden"
>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

interface VisibilityFixture {
  readonly queryClient: QueryClient;
  readonly readCount: { value: number };
  readonly writes: Array<{
    readonly modelProviderId: string;
    readonly hidden: boolean;
    readonly deferred: Deferred<HiddenResponse>;
  }>;
  readonly queueListRead: (read: Promise<ProvidersResponse>) => void;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function providerState(
  hiddenModelProviders: readonly string[],
): ProviderCliState {
  return providerCliStateSchema.parse({
    providerId: "opencode",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    auth: {
      status: "unknown",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    hiddenModelProviders,
  });
}

function createFixture(): VisibilityFixture {
  const queryClient = createAppQueryClient();
  const readCount = { value: 0 };
  const writes: VisibilityFixture["writes"] = [];
  const listReads: Array<Promise<ProvidersResponse>> = [];
  let hidden: string[] = [];
  let requestSequence = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSequence += 1;
        return `provider-visibility-${String(requestSequence)}`;
      },
      handlers: {
        "providers.list": () => {
          readCount.value += 1;
          const queued = listReads.shift();
          return queued ?? { providers: [providerState(hidden)], native: null };
        },
        "providers.setModelProviderHidden": (request) => {
          const write = deferred<HiddenResponse>();
          writes.push({
            modelProviderId: request.modelProviderId,
            hidden: request.hidden,
            deferred: write,
          });
          return write.promise.then((response) => {
            hidden = [...response.hiddenModelProviders];
            return response;
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  host.client = spine.createRequester(mockLocalHostEntry);
  recordNegotiatedHostManifest(mockLocalHostEntry.hostId, manifest());
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    queryClient,
    readCount,
    writes,
    queueListRead: (read) => listReads.push(read),
    Wrapper,
  };
}

function manifest(): ConnectionManifest {
  return {
    "providers.list": { major: 10, minor: 10 },
    "providers.setModelProviderHidden": { major: 1, minor: 0 },
  };
}

function useStoredVisibility(): ModelProviderVisibility {
  const providers = useProvidersList({ enabled: true, subscribed: true });
  const stored = providers.data?.providers.find(
    (provider) => provider.providerId === "opencode",
  )?.hiddenModelProviders;
  return useModelProviderVisibility({
    hostId: mockLocalHostEntry.hostId,
    providerId: "opencode",
    stored,
  });
}

describe("useModelProviderVisibility", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
    host.client = null;
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    host.client = null;
  });

  it("holds the clicked state until the real providers.list read-back lands", async () => {
    const fixture = createFixture();
    const { result } = renderHook(useStoredVisibility, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => expect(result.current.supported).toBe(true));
    await waitFor(() => expect(fixture.readCount.value).toBe(1));
    const readBack = deferred<ProvidersResponse>();
    fixture.queueListRead(readBack.promise);

    act(() => result.current.setShown("provider-a", false));
    expect(result.current.isShown("provider-a")).toBe(false);
    expect(result.current.isSettling("provider-a")).toBe(true);
    await waitFor(() => expect(fixture.writes).toHaveLength(1));
    await act(async () => {
      fixture.writes[0]?.deferred.resolve({
        hiddenModelProviders: ["provider-a"],
      });
      await fixture.writes[0]?.deferred.promise;
    });
    await waitFor(() => expect(fixture.readCount.value).toBe(2));
    expect(result.current.isShown("provider-a")).toBe(false);
    expect(result.current.isSettling("provider-a")).toBe(true);

    await act(async () => {
      readBack.resolve({
        providers: [providerState(["provider-a"])],
        native: null,
      });
      await readBack.promise;
    });
    await waitFor(() =>
      expect(result.current.isSettling("provider-a")).toBe(false),
    );
    expect(result.current.isShown("provider-a")).toBe(false);
  });

  it("restores the stored state when the host refuses the write", async () => {
    const fixture = createFixture();
    const { result } = renderHook(useStoredVisibility, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => expect(fixture.readCount.value).toBe(1));
    act(() => result.current.setShown("provider-a", false));
    await waitFor(() => expect(fixture.writes).toHaveLength(1));

    await act(async () => {
      fixture.writes[0]?.deferred.reject(new Error("write refused"));
      await fixture.writes[0]?.deferred.promise.catch(() => undefined);
    });

    expect(result.current.isShown("provider-a")).toBe(true);
    expect(result.current.isSettling("provider-a")).toBe(false);
  });

  it("settles quick clicks on different rows from each row's own write", async () => {
    const fixture = createFixture();
    const { result } = renderHook(useStoredVisibility, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => expect(fixture.readCount.value).toBe(1));
    act(() => {
      result.current.setShown("provider-a", false);
      result.current.setShown("provider-b", false);
    });
    expect(result.current.isShown("provider-a")).toBe(false);
    expect(result.current.isShown("provider-b")).toBe(false);
    await waitFor(() => expect(fixture.writes).toHaveLength(1));

    await act(async () => {
      fixture.writes[0]?.deferred.resolve({
        hiddenModelProviders: ["provider-a"],
      });
      await fixture.writes[0]?.deferred.promise;
    });
    await waitFor(() => expect(fixture.writes).toHaveLength(2));
    await waitFor(() =>
      expect(result.current.isSettling("provider-a")).toBe(false),
    );
    expect(result.current.isSettling("provider-b")).toBe(true);

    await act(async () => {
      fixture.writes[1]?.deferred.resolve({
        hiddenModelProviders: ["provider-a", "provider-b"],
      });
      await fixture.writes[1]?.deferred.promise;
    });
    await waitFor(() =>
      expect(result.current.isSettling("provider-b")).toBe(false),
    );
    expect(result.current.isShown("provider-a")).toBe(false);
    expect(result.current.isShown("provider-b")).toBe(false);
  });
});
