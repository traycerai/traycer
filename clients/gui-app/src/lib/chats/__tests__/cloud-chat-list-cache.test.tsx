import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import {
  cloudChatListQueryKey,
  cloudChatViewerIdSnapshot,
  readCloudKnownChatIds,
} from "@/lib/chats/cloud-chat-list-cache";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The anti-drift test for the imperative reader.
 *
 * `cloud-chat-list-cache.ts` rebuilds the slot `useCloudChatList` writes, and
 * two sides agreeing about a key format in prose is the exact bug shape that
 * fails SILENTLY - the lookup compiles, runs, and answers "nothing" forever.
 * So the hook is mounted for real here and the reader is pointed at whatever it
 * actually wrote, rather than at a key this test also hand-builds.
 */

const VIEWER = "viewer-a";
const TASK_ID = "task-1";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function row(chatId: string, isOwnedByViewer: boolean): CloudChatSummary {
  return {
    identity: {
      taskId: TASK_ID,
      chatId,
      ownerUserId: isOwnedByViewer ? VIEWER : "someone-else",
    },
    ownerHostId: mockLocalHostEntry.hostId,
    createdAt: 0,
    visibility: "task",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 0,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer,
  };
}

interface Harness {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
}

function createHarness(
  answer: () => readonly CloudChatSummary[] | Promise<never>,
): Harness {
  const queryClient = createAppQueryClient();
  queryClient.setDefaultOptions({
    // The hook under test sets its own `retry` predicate, and per-query
    // options beat these defaults - so `retry: false` never reaches it and
    // only disables retries for any OTHER query a test happens to mount.
    // What actually matters for the hook is `retryDelay: 0`: its predicate
    // still allows retries, and two backed-off ones would otherwise outlast
    // `waitFor`'s window and read as a hang rather than a settled failure.
    queries: {
      ...queryClient.getDefaultOptions().queries,
      retry: false,
      retryDelay: 0,
    },
    mutations: { retry: false },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {
        "epic.listCloudChats": () => {
          const chats = answer();
          return chats instanceof Promise ? chats : { chats: [...chats] };
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  useAuthStore.setState({
    contextMetadata: { userId: VIEWER, username: VIEWER },
  });
  return { queryClient, client };
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
}

async function mountList(harness: Harness): Promise<void> {
  const { result } = renderHook(
    () =>
      useCloudChatList({
        client: harness.client,
        taskId: TASK_ID,
        enabled: true,
      }),
    { wrapper: wrapperFor(harness.queryClient) },
  );
  await waitFor(() => {
    expect(result.current.isSuccess || result.current.isError).toBe(true);
  });
}

function readIds(harness: Harness): ReadonlySet<string> | null {
  return readCloudKnownChatIds(harness.queryClient, {
    hostId: mockLocalHostEntry.hostId,
    viewerUserId: cloudChatViewerIdSnapshot(),
    taskId: TASK_ID,
  });
}

afterEach(() => {
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("readCloudKnownChatIds", () => {
  it("reads the slot the real hook wrote, viewer-owned rows only", async () => {
    const harness = createHarness(() => [
      row("mine", true),
      row("theirs", false),
    ]);

    await mountList(harness);

    expect(readIds(harness)).toEqual(new Set(["mine"]));
  });

  it("finds that slot at the key the hook's own builder produced", async () => {
    const harness = createHarness(() => [row("mine", true)]);

    await mountList(harness);

    // Not "a key of this shape exists" - THE entry, by reference.
    expect(
      harness.queryClient.getQueryData(
        cloudChatListQueryKey({
          hostId: mockLocalHostEntry.hostId,
          viewerUserId: VIEWER,
          taskId: TASK_ID,
        }),
      ),
    ).toEqual({ chats: [row("mine", true)] });
  });

  it("refuses to answer before anything has asked", () => {
    const harness = createHarness(() => []);

    // Nothing mounted: the slot is empty, which is not the same fact as an
    // empty list and must not be reported as one.
    expect(readIds(harness)).toBeNull();
  });

  it("refuses to answer for a list that failed transiently", async () => {
    const harness = createHarness(() =>
      Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          requestId: "request-1",
          method: "epic.listCloudChats",
          message: "WebSocket dial timed out",
          fatalDetails: null,
        }),
      ),
    );

    await mountList(harness);

    expect(readIds(harness)).toBeNull();
  });

  it("answers empty for a host that cannot serve the list at all", async () => {
    const harness = createHarness(() =>
      Promise.reject(
        new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          requestId: "request-1",
          method: "epic.listCloudChats",
          message: "older host",
          fatalDetails: null,
        }),
      ),
    );

    await mountList(harness);

    // An older host will keep answering this forever: policing on local
    // records alone is its correct behavior, so this DOES authorize.
    expect(readIds(harness)).toEqual(new Set());
  });

  it("refuses to answer for a request that could never be made", () => {
    const harness = createHarness(() => []);

    // "Nothing could ask" is not "the cloud lists nothing": an unresolved host
    // binding or a sign-in still settling is a boot-order state, and reporting
    // it as an empty SET let a transient race authorize the caller's permanent
    // payload discard. These arms must be `null` - no answer to act on.
    expect(
      readCloudKnownChatIds(harness.queryClient, {
        hostId: null,
        viewerUserId: VIEWER,
        taskId: TASK_ID,
      }),
    ).toBeNull();
    expect(
      readCloudKnownChatIds(harness.queryClient, {
        hostId: mockLocalHostEntry.hostId,
        viewerUserId: "",
        taskId: TASK_ID,
      }),
    ).toBeNull();
    expect(
      readCloudKnownChatIds(harness.queryClient, {
        hostId: mockLocalHostEntry.hostId,
        viewerUserId: VIEWER,
        taskId: "",
      }),
    ).toBeNull();
  });
});
