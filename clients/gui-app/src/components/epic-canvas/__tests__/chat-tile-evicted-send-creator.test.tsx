import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  SAVED_CREATOR_USER_ID,
  TEAM_ENVIRONMENT_OWNER_ID,
  emitOriginSignInChange,
  environmentListTestState,
  hostDirectoryTestState,
  originSignInTestState,
} from "./chat-tile-evicted-send-mock-state";
import {
  CHAT_ARTIFACT,
  FIRST_TEXT,
  HOST_VIEWER_ACCESS,
  PERSONAL_AND_TEAM_VIEWER_ENVIRONMENT_LIST_RESPONSE,
  POOL_VIEWER_ACCESS,
  TEAM_CREATOR_CHAT_SOURCE,
  answerHydrate,
  clickSend,
  draftOf,
  hydrates,
  imageRootHeld,
  mountOnThePool,
  openStream,
  pendingRows,
  putInComposer,
  resetEvictedSendFixture,
  rowsWithText,
  sendFramesOf,
  settleEvictedSendHostTier,
  streams,
  teardownEvictedSendFixture,
  textOnlyDraftOf,
} from "./chat-tile-evicted-send-support";

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => <div data-testid="host-workspace-selector" />,
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/lib/host", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return {
    useHostBinding: () => support.MOCK_HOST_BINDING,
    useOptionalHostClient: () => support.MOCK_HOST_CLIENT,
    useHostDirectory: () => support.MOCK_HOST_DIRECTORY,
    useAuthService: () =>
      support.hostDirectoryTestState.teamSandboxForCurrentChat
        ? support.MOCK_HOST_BINDING.auth
        : {
            revalidateCurrentContext: () =>
              Promise.resolve({ kind: "valid" as const }),
          },
    useHostClient: () => support.MOCK_HOST_CLIENT,
    useHostRuntimeClient: () => support.MOCK_HOST_CLIENT,
  };
});
vi.mock("@/hooks/host/use-tab-host-client", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return { useTabHostClient: () => support.MOCK_HOST_CLIENT };
});
vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importActual) => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return {
    ...(await importActual<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >()),
    useHostClientForHostId: () => null,
    useHostDirectoryEntryForHostId: (hostId: string | null) =>
      hostId === null ? null : support.MOCK_HOST_DIRECTORY.findById(hostId),
  };
});
vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));
vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return { useAddressableHostId: () => support.HOST_ID };
});
vi.mock("@/hooks/host/use-effective-host-id", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return { useEffectiveHostId: () => support.HOST_ID };
});
vi.mock("@/hooks/bots/use-environment-list-query", async () => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  return {
    useEnvironmentListQuery: () => ({
      data: support.environmentListTestState.data,
      error: null,
      isError: false,
      refetch: () => Promise.resolve(),
    }),
  };
});

vi.mock("@/hooks/chats/use-chat-hydrate-mutation", async (importActual) => {
  const support = await import("./chat-tile-evicted-send-mock-state");
  const actual =
    await importActual<
      typeof import("@/hooks/chats/use-chat-hydrate-mutation")
    >();
  return {
    ...actual,
    useChatHydrateMutation: (input: {
      readonly client: HostClient<HostRpcRegistry> | null;
      readonly hostId: string;
      readonly chatId: string;
    }) =>
      actual.useChatHydrateMutation({
        ...input,
        client: support.hydrateBoundary.client,
      }),
  };
});

beforeAll(settleEvictedSendHostTier);

beforeEach(resetEvictedSendFixture);

afterEach(teardownEvictedSendFixture);

describe("a message sent to a chat the pool serves because its host dropped the records", () => {
  it("keeps a noncreator pool viewer read-only without staging a send", async () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "viewer-2",
        userName: "Viewer",
        email: "viewer@example.com",
      },
      contextMetadata: { userId: "viewer-2", username: "Viewer" },
    });

    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);

    expect(screen.getByText("Read-only viewer.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    putInComposer(FIRST_TEXT);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toEqual([]);
  });

  it("does not use a person-owned V15 fallback row to park on a team host", async () => {
    environmentListTestState.data =
      PERSONAL_AND_TEAM_VIEWER_ENVIRONMENT_LIST_RESPONSE;
    hostDirectoryTestState.teamSandboxForCurrentChat = true;
    await mountOnThePool(POOL_VIEWER_ACCESS, {
      ownerUserId: SAVED_CREATOR_USER_ID,
      starterUserId: SAVED_CREATOR_USER_ID,
    });

    expect(await screen.findByText("Read-only viewer.")).not.toBeNull();
    expect(screen.getByText(/Team sandbox is suspended/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    putInComposer(FIRST_TEXT);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toEqual([]);
  });

  it("restores a parked draft when the host's fresh snapshot is viewer-only", async () => {
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
      expect(hydrates).toHaveLength(1);
    });

    await answerHydrate(0);
    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    openStream(
      streams[1],
      HOST_VIEWER_ACCESS,
      undefined,
      TEAM_ENVIRONMENT_OWNER_ID,
    );

    await waitFor(() => {
      expect(pendingRows()).toHaveLength(0);
    });
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toHaveLength(1);
  });

  it("does not take, send, or restore a parked message after its sign-in ends", async () => {
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    const listenersBeforePending = originSignInTestState.listeners.size;
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
      expect(hydrates).toHaveLength(1);
    });
    await waitFor(() => {
      expect(originSignInTestState.listeners.size).toBe(
        listenersBeforePending + 1,
      );
    });

    originSignInTestState.generation += 1;
    originSignInTestState.userId = "viewer-2";
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "viewer-2",
        userName: "Viewer",
        email: "viewer@example.com",
      },
      contextMetadata: { userId: "viewer-2", username: "Viewer" },
    });
    emitOriginSignInChange();
    act(() => {
      useComposerDraftStore
        .getState()
        .replaceDraft(
          CHAT_ARTIFACT.id,
          textOnlyDraftOf("another account's draft"),
          null,
        );
    });

    await answerHydrate(0);
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(0);
      expect(originSignInTestState.listeners.size).toBe(listenersBeforePending);
    });

    expect(rowsWithText(FIRST_TEXT)).toHaveLength(0);
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(textOnlyDraftOf("another account's draft"));
    expect(imageRootHeld()).toBe(false);
    expect(streams.flatMap(sendFramesOf)).toEqual([]);
    expect(hydrates).toHaveLength(1);
    expect(toast.getToasts()).toHaveLength(0);
  });
});
