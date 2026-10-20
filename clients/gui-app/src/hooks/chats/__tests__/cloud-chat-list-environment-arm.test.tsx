import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  beginCloudChatDeletion,
  useCloudChatDeletions,
} from "@/lib/chats/cloud-chat-deletions";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

const arm = vi.hoisted(() => ({ chats: [] as readonly CloudChatSummary[] }));

vi.mock("@/hooks/environment/use-environment-arms", () => ({
  useEnvironmentArmChats: () => arm.chats,
}));

const TASK_ID = "epic-1";
const VIEWER = "viewer-1";

function chat(
  chatId: string,
  ownerUserId: string,
  ownerHostId: string,
): CloudChatSummary {
  return {
    identity: { taskId: TASK_ID, chatId, ownerUserId },
    ownerHostId,
    createdAt: 1,
    visibility: "task",
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: ownerUserId === VIEWER,
  };
}

function renderList(viewerRows: readonly CloudChatSummary[]) {
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "list",
      handlers: {
        "epic.listCloudChats": () =>
          Promise.resolve({ chats: [...viewerRows] }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return renderHook(
    () => useCloudChatList({ client, taskId: TASK_ID, enabled: true }),
    { wrapper },
  );
}

const idsOf = (
  data: { readonly chats: readonly CloudChatSummary[] } | undefined,
) =>
  data?.chats.map(
    (row) => `${row.identity.ownerUserId}:${row.identity.chatId}`,
  );

describe("useCloudChatList with the environment arm", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: VIEWER },
    });
  });

  afterEach(() => {
    cleanup();
    arm.chats = [];
    useCloudChatDeletions.setState({
      pending: new Map(),
      confirmed: new Set(),
    });
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("shows a chat on both lists once and an arm-only chat once", async () => {
    const shared = chat("a", VIEWER, "host-1");
    arm.chats = [chat("a", VIEWER, "host-1"), chat("m", "member", "sandbox-1")];

    const rendered = renderList([shared]);

    await waitFor(() => {
      expect(rendered.result.current.isSuccess).toBe(true);
    });
    expect(idsOf(rendered.result.current.data)).toEqual([
      `${VIEWER}:a`,
      "member:m",
    ]);
    expect(rendered.result.current.data?.chats[0]).toBe(shared);
  });

  it("hides an arm row whose deletion is pending", async () => {
    arm.chats = [chat("m", "member", "sandbox-1")];
    beginCloudChatDeletion({
      taskId: TASK_ID,
      ownerUserId: "member",
      ownerHostId: "sandbox-1",
      chatId: "m",
    });

    const rendered = renderList([chat("a", VIEWER, "host-1")]);

    await waitFor(() => {
      expect(rendered.result.current.isSuccess).toBe(true);
    });
    expect(idsOf(rendered.result.current.data)).toEqual([`${VIEWER}:a`]);
  });
});
