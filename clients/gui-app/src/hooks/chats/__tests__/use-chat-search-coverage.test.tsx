import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { useChatSearchCoverage } from "@/hooks/chats/use-chat-search-coverage";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { useAuthStore } from "@/stores/auth/auth-store";

const VIEWER = "viewer-1";
const SEARCH_HOST = "host-1";
const TASK = "task-1";

function chat(chatId: string, ownerHostId: string): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId, ownerUserId: VIEWER },
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
    isOwnedByViewer: true,
  };
}

describe("useChatSearchCoverage", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("reflects a chat list that arrives after the first render when the results re-render", () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: VIEWER },
    });
    const queryClient = new QueryClient();
    const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    const rendered = renderHook(
      () => useChatSearchCoverage(SEARCH_HOST, TASK),
      { wrapper },
    );
    expect(rendered.result.current).toEqual({ kind: "unknown" });

    act(() => {
      queryClient.setQueryData(
        cloudChatListQueryKey({
          hostId: SEARCH_HOST,
          viewerUserId: VIEWER,
          taskId: TASK,
        }),
        { chats: [chat("here", SEARCH_HOST), chat("away", "sandbox-1")] },
      );
    });
    rendered.rerender();

    expect(rendered.result.current).toEqual({ kind: "elsewhere", count: 1 });
  });
});
