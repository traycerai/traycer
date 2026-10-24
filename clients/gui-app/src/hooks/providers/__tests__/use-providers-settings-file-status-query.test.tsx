import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";

const clientHolder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

// `useHostClient` reads the host runtime context, which this suite does not
// stand up; the query, the request and the cache behavior under it are real.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientHolder.client };
});

import { useProvidersSettingsFileStatus } from "@/hooks/providers/use-providers-settings-file-status-query";

interface Fixture {
  readonly queryClient: QueryClient;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly setUnreadable: (unreadable: boolean) => void;
}

function createFixture(): Fixture {
  // The production factory, so the app-wide `refetchOnWindowFocus: false` is
  // what this hook has to opt out of.
  const queryClient = createAppQueryClient();
  const requestCount = { value: 0 };
  let unreadable = false;
  let requestSeq = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      handlers: {
        "providers.settingsFile.status": () => {
          requestCount.value += 1;
          return { unreadable, unreadableProviderIds: [] };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  clientHolder.client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    queryClient,
    requestCount,
    Wrapper,
    setUnreadable: (next) => {
      unreadable = next;
    },
  };
}

function blurAndRefocus(): void {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

describe("useProvidersSettingsFileStatus", () => {
  beforeEach(() => {
    // Only the clock is faked, so the test can step past the app-wide
    // `staleTime` (a fresh query is not refetched on focus) while the query
    // and `waitFor` keep running on real timers.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    focusManager.setFocused(true);
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    cleanup();
    clientHolder.client = null;
  });

  it("reads the settings-file status again when the window regains focus, although the app's queries do not refetch on focus", async () => {
    const fixture = createFixture();
    // The premise: nothing else in the app refetches on focus, so only this
    // hook's own option can make the second read happen.
    expect(
      fixture.queryClient.getDefaultOptions().queries?.refetchOnWindowFocus,
    ).toBe(false);

    const { result } = renderHook(() => useProvidersSettingsFileStatus(true), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(result.current.data).toEqual({
        unreadable: false,
        unreadableProviderIds: [],
      });
    });
    expect(fixture.requestCount.value).toBe(1);

    // The file goes bad outside the app while the panel stays mounted, and
    // the first read is by now older than the app-wide `staleTime`.
    fixture.setUnreadable(true);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    blurAndRefocus();

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(2);
    });
    await waitFor(() => {
      expect(result.current.data?.unreadable).toBe(true);
    });
  });

  it("re-reads the settings-file status on focus even within the app's staleTime", async () => {
    const fixture = createFixture();

    const { result } = renderHook(() => useProvidersSettingsFileStatus(true), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(result.current.data).toEqual({
        unreadable: false,
        unreadableProviderIds: [],
      });
    });
    expect(fixture.requestCount.value).toBe(1);

    // No clock step: the first read is still fresh by the app-wide
    // `staleTime`, yet the file can have gone bad a moment after it, and the
    // panel must not wait out that window to offer the reset.
    fixture.setUnreadable(true);
    blurAndRefocus();

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(2);
    });
    await waitFor(() => {
      expect(result.current.data?.unreadable).toBe(true);
    });
  });
});
