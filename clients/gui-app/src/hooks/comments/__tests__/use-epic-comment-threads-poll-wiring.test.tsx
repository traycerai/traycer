import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  type Query,
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
import { useEpicCommentThreadsForClient } from "@/hooks/comments/use-epic-comment-threads";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "artifact-1";
const METHOD = "epic.listCommentThreads";

/**
 * The comment poll's WIRE, through the public hook.
 *
 * `use-lane-comment-threads.test.ts` pins the two halves separately - that
 * `commentThreadsShouldPoll` answers correctly, and that the table carries a
 * cadence for it to opt into. Neither observes the hook actually JOINING them:
 * delete the `poll:` line from `useEpicCommentThreadsForClient` and every one
 * of those assertions still passes, because the pure function and the table
 * entry are both still exactly right. That is the same shape as the bug this
 * fixes - a mechanism that reads as wired and schedules nothing - so it is
 * pinned here from the outside, on the query TanStack actually built.
 */
describe("useEpicCommentThreadsForClient poll wiring", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
  });

  it("builds no refetch interval while the lane is UP", async () => {
    const fixture = createCommentThreadsFixture();
    renderHook(
      () =>
        useEpicCommentThreadsForClient({
          client: fixture.client,
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: ARTIFACT_ID,
          options: { enabled: true, laneDroppedAt: null },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });
    expect(refetchIntervalFor(queryForMethod(fixture.queryClient))).toBe(false);
  });

  it("builds the table's 15s cadence once the lane has DROPPED", async () => {
    const fixture = createCommentThreadsFixture();
    renderHook(
      () =>
        useEpicCommentThreadsForClient({
          client: fixture.client,
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: ARTIFACT_ID,
          options: { enabled: true, laneDroppedAt: 1_000 },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });
    const query = queryForMethod(fixture.queryClient);
    // The interval is the TABLE's, never a number this module chose -
    // `refetchInterval` is `Omit`ted from `useHostQuery`'s surface precisely so
    // cadence stays in `HOST_METHOD_POLL_TABLE`.
    expect(refetchIntervalFor(query)).toBe(15_000);
    // Asserted here rather than taken on trust: a blurred window must stop
    // polling, with `refetchOnWindowFocus` covering the moment it returns.
    expect(refetchIntervalInBackgroundFor(query)).toBe(false);
  });

  it("issues no further request while the lane is up, and does once it drops", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const fixture = createCommentThreadsFixture();
    // Annotated, not inferred: a bare `{ laneDroppedAt: null }` narrows the
    // prop to `null` and the `rerender` below stops type-checking.
    const initialProps: { readonly laneDroppedAt: number | null } = {
      laneDroppedAt: null,
    };
    const rendered = renderHook(
      (props: { readonly laneDroppedAt: number | null }) =>
        useEpicCommentThreadsForClient({
          client: fixture.client,
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: ARTIFACT_ID,
          options: { enabled: true, laneDroppedAt: props.laneDroppedAt },
        }),
      { wrapper: fixture.Wrapper, initialProps },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fixture.requestCount.value).toBe(1);

    // Four cadences' worth of time on a LIVE lane. The count must not move -
    // this is the arm that would regress into polling every open sidebar.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fixture.requestCount.value).toBe(1);

    // The drop is the ONLY thing that changes between the two halves, which is
    // what makes this a test of the wire rather than of the table.
    rendered.rerender({ laneDroppedAt: 1_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fixture.requestCount.value).toBe(2);
  });

  it("stays silent on a DISABLED query even while the lane is down", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const fixture = createCommentThreadsFixture();
    renderHook(
      () =>
        useEpicCommentThreadsForClient({
          client: fixture.client,
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: ARTIFACT_ID,
          // The hover popover's shape: it reads cache and must never put
          // traffic on the wire. TanStack runs no interval on a disabled
          // query, and this pins that the poll opt-in did not change it.
          options: { enabled: false, laneDroppedAt: 1_000 },
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fixture.requestCount.value).toBe(0);
  });
});

function queryForMethod(queryClient: QueryClient): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes(METHOD));
  if (query === undefined) {
    throw new Error(`No query cached for ${METHOD}`);
  }
  return query;
}

function refetchIntervalFor(query: Query): unknown {
  const { options } = query;
  return "refetchInterval" in options ? options.refetchInterval : undefined;
}

function refetchIntervalInBackgroundFor(query: Query): unknown {
  return Reflect.get(query.options, "refetchIntervalInBackground");
}

function createCommentThreadsFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const requestCount = { value: 0 };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-comment-threads-1",
      handlers: {
        "epic.listCommentThreads": () => {
          requestCount.value += 1;
          return { threads: [] };
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
  return { client, queryClient, requestCount, Wrapper };
}
