import { afterEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClientProvider, type Query, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EpicReadArtifactObjectRequest,
  EpicReadArtifactObjectResponse,
} from "@traycer/protocol/host/epic/files";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useArtifactObjectTextQuery } from "@/hooks/files/use-artifact-object-text-query";

const mocks = vi.hoisted(() => ({
  client: { current: null as HostRequester<HostRpcRegistry> | null },
}));

// The one boundary this suite stands in for: which `HostClient` a hostId
// resolves to. Everything downstream - `useHostQuery`, the condition-poll
// coordinator, the query cache - runs for real against a mock transport.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.client.current,
}));

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const SHA = "a".repeat(64);
const ADDRESS = { epicId: EPIC_ID, sha256: SHA };

const ENTRY: HostDirectoryEntry = {
  hostId: HOST_ID,
  label: "Test host",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const TEXT: EpicReadArtifactObjectResponse = {
  kind: "text",
  text: "<p>hi</p>",
  mediaType: "text/html",
  networkPolicy: "https-only",
};
const UNAVAILABLE: EpicReadArtifactObjectResponse = {
  kind: "unavailable",
  reason: "missing",
};

type Handler = (
  params: EpicReadArtifactObjectRequest,
) => Promise<EpicReadArtifactObjectResponse> | EpicReadArtifactObjectResponse;

interface ArtifactObjectFixture {
  readonly client: HostRequester<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createArtifactObjectFixture(handler: Handler): ArtifactObjectFixture {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-artifact-object",
    handlers: { "epic.readArtifactObject": handler },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? ENTRY : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(ENTRY);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, queryClient, messenger, Wrapper };
}

function mountQuery(fixture: ArtifactObjectFixture) {
  mocks.client.current = fixture.client;
  return renderHook(() => useArtifactObjectTextQuery(HOST_ID, ADDRESS), {
    wrapper: fixture.Wrapper,
  });
}

function queryForArtifactObject(queryClient: QueryClient): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes("epic.readArtifactObject"));
  if (query === undefined) {
    throw new Error("Expected a query for epic.readArtifactObject");
  }
  return query;
}

function isRefetchInterval(
  value: unknown,
): value is (query: Query) => number | false | undefined {
  return typeof value === "function";
}

function refetchIntervalFor(query: Query): unknown {
  const { options } = query;
  return "refetchInterval" in options ? options.refetchInterval : undefined;
}

function appliedDelay(query: Query): number | false | undefined {
  const interval = refetchIntervalFor(query);
  if (!isRefetchInterval(interval)) {
    return typeof interval === "number" || interval === false
      ? interval
      : undefined;
  }
  return interval(query);
}

describe("useArtifactObjectTextQuery", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
    mocks.client.current = null;
  });

  it("sends the sha-addressed text request and reads it back", async () => {
    const fixture = createArtifactObjectFixture(() => TEXT);
    const rendered = mountQuery(fixture);

    await waitFor(() => {
      expect(rendered.result.current.data?.kind).toBe("text");
    });
    expect(fixture.messenger.calls).toHaveLength(1);
    expect(fixture.messenger.calls[0]).toMatchObject({
      method: "epic.readArtifactObject",
      params: { epicId: EPIC_ID, sha256: SHA, want: { kind: "text" } },
    });
  });

  it("never re-asks for a served text answer, but re-asks on a fresh observer while the answer is unavailable", async () => {
    const textFixture = createArtifactObjectFixture(() => TEXT);
    const first = mountQuery(textFixture);
    await waitFor(() => {
      expect(first.result.current.data?.kind).toBe("text");
    });
    expect(textFixture.messenger.calls).toHaveLength(1);

    // A second observer on the same content-addressed sha reuses the cache.
    const second = renderHook(() => useArtifactObjectTextQuery(HOST_ID, ADDRESS), {
      wrapper: textFixture.Wrapper,
    });
    expect(second.result.current.data?.kind).toBe("text");
    expect(textFixture.messenger.calls).toHaveLength(1);

    const unavailableFixture = createArtifactObjectFixture(() => UNAVAILABLE);
    const firstUnavailable = mountQuery(unavailableFixture);
    await waitFor(() => {
      expect(firstUnavailable.result.current.data?.kind).toBe("unavailable");
    });
    expect(unavailableFixture.messenger.calls).toHaveLength(1);

    // staleTime 0 for a non-text answer: a fresh observer finds it stale and
    // asks again, since the host may have it by now.
    renderHook(() => useArtifactObjectTextQuery(HOST_ID, ADDRESS), {
      wrapper: unavailableFixture.Wrapper,
    });
    await waitFor(() => {
      expect(unavailableFixture.messenger.calls).toHaveLength(2);
    });
  });

  it("polls a downloading answer on the 500ms-to-2s lane and stops once text arrives", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    let call = 0;
    const fixture = createArtifactObjectFixture(() => {
      call += 1;
      return call < 4
        ? { kind: "downloading", receivedBytes: call * 10, totalBytes: 100 }
        : TEXT;
    });
    mountQuery(fixture);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fixture.messenger.calls).toHaveLength(1);
    expect(appliedDelay(queryForArtifactObject(fixture.queryClient))).toBe(
      500,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fixture.messenger.calls).toHaveLength(2);
    expect(appliedDelay(queryForArtifactObject(fixture.queryClient))).toBe(
      1_000,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fixture.messenger.calls).toHaveLength(3);
    // Capped at the lane's 2s ceiling.
    expect(appliedDelay(queryForArtifactObject(fixture.queryClient))).toBe(
      2_000,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fixture.messenger.calls).toHaveLength(4);
    // Text ends the episode: nothing left to poll for.
    expect(appliedDelay(queryForArtifactObject(fixture.queryClient))).toBe(
      false,
    );
  });

  it("never schedules a poll for an unavailable answer - it is terminal, not merely slow", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const fixture = createArtifactObjectFixture(() => UNAVAILABLE);
    mountQuery(fixture);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fixture.messenger.calls).toHaveLength(1);
    expect(appliedDelay(queryForArtifactObject(fixture.queryClient))).toBe(
      false,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(fixture.messenger.calls).toHaveLength(1);
  });
});
