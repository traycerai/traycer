import { afterEach, describe, expect, it } from "vitest";
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  useChatSendGateWorkspaceBindingsForClient,
  useWorktreeListBindingsForEpicForClient,
} from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";

const RETRY_SETTLE_TIMEOUT_MS = 5_000;

interface BindingsFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly callCount: () => number;
  readonly setFail: (next: boolean) => void;
}

function createFixture(): BindingsFixture {
  const queryClient = createAppQueryClient();
  let fail = true;
  let calls = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String(calls)}`,
      handlers: {
        "worktree.listBindingsForEpic": () => {
          calls += 1;
          if (fail) throw new Error("bindings unavailable");
          return { rows: [], folderlessCwd: null };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client,
    queryClient,
    Wrapper,
    callCount: () => calls,
    setFail: (next: boolean) => {
      fail = next;
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

function blurThenFocus(): void {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

function focusWindowWithoutVisibilityChange(): void {
  expect(document.visibilityState).toBe("visible");
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

function dropThenRestoreConnection(): void {
  act(() => {
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
}

function queryStatus(queryClient: QueryClient): string | undefined {
  return queryClient.getQueryCache().getAll()[0]?.state.status;
}

describe("useChatSendGateWorkspaceBindingsForClient", () => {
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  });

  it("refetches a failed listing on window focus and recovers", async () => {
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useChatSendGateWorkspaceBindingsForClient({
          client: fixture.client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: RETRY_SETTLE_TIMEOUT_MS,
    });
    const settledCalls = fixture.callCount();
    fixture.setFail(false);

    blurThenFocus();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fixture.callCount()).toBeGreaterThan(settledCalls);
    expect(result.current.data?.rows).toEqual([]);
  });

  it("keeps the app default once the listing has succeeded", async () => {
    const fixture = createFixture();
    fixture.setFail(false);
    const { result } = renderHook(
      () =>
        useChatSendGateWorkspaceBindingsForClient({
          client: fixture.client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const settledCalls = fixture.callCount();

    blurThenFocus();
    await flush();

    expect(fixture.callCount()).toBe(settledCalls);
    expect(result.current.isSuccess).toBe(true);
  });

  it("refetches a failed listing on reconnect and recovers", async () => {
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useChatSendGateWorkspaceBindingsForClient({
          client: fixture.client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: RETRY_SETTLE_TIMEOUT_MS,
    });
    const settledCalls = fixture.callCount();
    fixture.setFail(false);

    dropThenRestoreConnection();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fixture.callCount()).toBeGreaterThan(settledCalls);
  });
});

describe("useChatSendGateWorkspaceBindingsForClient on a plain window focus", () => {
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
  });

  function renderGate(fixture: BindingsFixture) {
    return renderHook(
      () =>
        useChatSendGateWorkspaceBindingsForClient({
          client: fixture.client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
  }

  it("refetches a failed listing and recovers", async () => {
    const fixture = createFixture();
    const { result } = renderGate(fixture);
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: RETRY_SETTLE_TIMEOUT_MS,
    });
    const settledCalls = fixture.callCount();
    fixture.setFail(false);

    focusWindowWithoutVisibilityChange();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fixture.callCount()).toBeGreaterThan(settledCalls);
    expect(result.current.data?.rows).toEqual([]);
  });

  it("does not refetch after a success", async () => {
    const fixture = createFixture();
    fixture.setFail(false);
    const { result } = renderGate(fixture);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const settledCalls = fixture.callCount();

    focusWindowWithoutVisibilityChange();
    await flush();

    expect(fixture.callCount()).toBe(settledCalls);
    expect(result.current.isSuccess).toBe(true);
  });

  it("sends one request for several observers of the same failed entry", async () => {
    const fixture = createFixture();
    const first = renderGate(fixture);
    const second = renderGate(fixture);
    await waitFor(
      () => {
        expect(first.result.current.isError).toBe(true);
        expect(second.result.current.isError).toBe(true);
      },
      { timeout: RETRY_SETTLE_TIMEOUT_MS },
    );
    await flush();
    const settledCalls = fixture.callCount();
    fixture.setFail(false);

    focusWindowWithoutVisibilityChange();

    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
      expect(second.result.current.isSuccess).toBe(true);
    });
    await flush();
    expect(fixture.callCount()).toBe(settledCalls + 1);
  });
});

describe("useWorktreeListBindingsForEpicForClient on a failed listing", () => {
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  });

  it("does not refetch on window focus", async () => {
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useWorktreeListBindingsForEpicForClient({
          client: fixture.client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: RETRY_SETTLE_TIMEOUT_MS,
    });
    const settledCalls = fixture.callCount();
    fixture.setFail(false);

    blurThenFocus();
    await flush();

    expect(fixture.callCount()).toBe(settledCalls);
    expect(queryStatus(fixture.queryClient)).toBe("error");
  });

  it("does not refetch on a plain window focus either", async () => {
    const fixture = createFixture();
    const { result } = renderHook(
      () =>
        useWorktreeListBindingsForEpicForClient({
          client: fixture.client,
          epicId: "epic-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: RETRY_SETTLE_TIMEOUT_MS,
    });
    const settledCalls = fixture.callCount();
    fixture.setFail(false);

    focusWindowWithoutVisibilityChange();
    await flush();

    expect(fixture.callCount()).toBe(settledCalls);
    expect(queryStatus(fixture.queryClient)).toBe("error");
  });
});
