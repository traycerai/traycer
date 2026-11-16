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
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { PoolArmClient } from "@/hooks/environment/__tests__/arm-pool-test-support";
import { publishEnvironmentArmScope } from "@/hooks/environment/use-environment-arms";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  HOST_ID,
  SAVED_CREATOR_USER_ID,
  TEAM_ENVIRONMENT_OWNER_ID,
  cloudChatListTestState,
} from "./chat-tile-evicted-send-mock-state";
import {
  ADMITTED_SAVED_CREATOR_ACCESS,
  CHAT_ARTIFACT,
  EPIC_ID,
  FIRST_TEXT,
  POOL_VIEWER_ACCESS,
  TEAM_CREATOR_CHAT_SOURCE,
  answerHydrate,
  clickSend,
  draftOf,
  hydrates,
  mountOnThePool,
  openStream,
  pendingRows,
  putInComposer,
  resetEvictedSendFixture,
  sendFramesOf,
  settleEvictedSendHostTier,
  streams,
  teardownEvictedSendFixture,
  textInContent,
  type ChatAccessFixture,
  type ChatSourceFixture,
  type Mounted,
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

// The real hydrate mutation, sent on the test's own host client: the one
// boundary the tile does not own.
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

function cloudChatSummary(input: {
  readonly taskId: string;
  readonly chatId: string;
  readonly ownerUserId: string;
  readonly ownerHostId: string;
  readonly creatorUserId: string | null | undefined;
}): CloudChatSummary {
  const summary = {
    identity: {
      taskId: input.taskId,
      chatId: input.chatId,
      ownerUserId: input.ownerUserId,
    },
    ownerHostId: input.ownerHostId,
    createdAt: 1,
    visibility:
      input.ownerUserId === SAVED_CREATOR_USER_ID
        ? ("private" as const)
        : ("task" as const),
    title: CHAT_ARTIFACT.name,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: input.ownerUserId === SAVED_CREATOR_USER_ID,
  } satisfies Omit<CloudChatSummary, "creatorUserId">;
  return input.creatorUserId === undefined
    ? summary
    : { ...summary, creatorUserId: input.creatorUserId };
}

const ADMITTED_PERSONAL_OWNER_ACCESS = {
  role: "owner",
  ownerUserId: SAVED_CREATOR_USER_ID,
  canAct: true,
} as const satisfies ChatAccessFixture;

function publishTeamChatArm(): PoolArmClient {
  const client = new PoolArmClient();
  publishEnvironmentArmScope({
    poolHostId: poolEntry.hostId,
    client,
    viewerId: SAVED_CREATOR_USER_ID,
    environmentIds: [TEAM_ENVIRONMENT_OWNER_ID],
    environmentIdByTeamId: new Map([["team-1", TEAM_ENVIRONMENT_OWNER_ID]]),
    supported: new Set(["environment.chats.subscribe"]),
  });
  return client;
}

async function waitForCloudChatList(mounted: Mounted): Promise<void> {
  const expected = cloudChatListTestState.data;
  if (expected === undefined) {
    throw new Error("expected a cloud chat list response");
  }
  await waitFor(() => {
    expect(
      mounted.queryClient.getQueryData(
        cloudChatListQueryKey({
          hostId: HOST_ID,
          viewerUserId: SAVED_CREATOR_USER_ID,
          taskId: EPIC_ID,
        }),
      ),
    ).toEqual(expected);
  });
}

function expectReadOnlyWithoutParking(): void {
  expect(screen.getByText("Read-only viewer.")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Clone agent" })).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  putInComposer(FIRST_TEXT);
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(
    useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
  ).toEqual(draftOf(FIRST_TEXT));
  expect(pendingRows()).toEqual([]);
  expect(streams.flatMap(sendFramesOf)).toEqual([]);
  expect(hydrates).toEqual([]);
}

async function parkAndSendThroughOwnerHost(
  access: ChatAccessFixture,
  ownerUserId: string,
): Promise<void> {
  putInComposer(FIRST_TEXT);
  clickSend();
  await waitFor(() => {
    expect(pendingRows()).toHaveLength(1);
    expect(hydrates).toHaveLength(1);
  });
  expect(sendFramesOf(streams[0])).toEqual([]);

  await answerHydrate(0);
  await waitFor(() => expect(streams).toHaveLength(2));
  openStream(streams[1], access, undefined, ownerUserId);
  await waitFor(() => expect(sendFramesOf(streams[1])).toHaveLength(1));
  expect(textInContent(sendFramesOf(streams[1])[0].content)).toBe(FIRST_TEXT);
}

beforeAll(settleEvictedSendHostTier);

beforeEach(resetEvictedSendFixture);

afterEach(teardownEvictedSendFixture);

describe("a message sent to a chat the pool serves because its host dropped the records", () => {
  it("parks a fresh Team chat when its exact cloud row names the viewer as creator", async () => {
    cloudChatListTestState.data = {
      chats: [
        cloudChatSummary({
          taskId: EPIC_ID,
          chatId: CHAT_ARTIFACT.id,
          ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
          ownerHostId: HOST_ID,
          creatorUserId: SAVED_CREATOR_USER_ID,
        }),
      ],
    };
    const source: ChatSourceFixture = {
      ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
      starterUserId: null,
    };
    const mounted = await mountOnThePool(POOL_VIEWER_ACCESS, source);
    await waitForCloudChatList(mounted);
    await parkAndSendThroughOwnerHost(
      ADMITTED_SAVED_CREATOR_ACCESS,
      TEAM_ENVIRONMENT_OWNER_ID,
    );
  });

  it("parks from the Team environment arm while the viewer cloud-list request is pending", async () => {
    const poolArm = publishTeamChatArm();
    const source: ChatSourceFixture = {
      ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
      starterUserId: null,
    };
    const mounted = await mountOnThePool(POOL_VIEWER_ACCESS, source);
    const listKey = cloudChatListQueryKey({
      hostId: HOST_ID,
      viewerUserId: SAVED_CREATOR_USER_ID,
      taskId: EPIC_ID,
    });

    await waitFor(() => {
      expect(cloudChatListTestState.requestCount).toBeGreaterThan(0);
      expect(poolArm.armSessions).toHaveLength(1);
    });
    expect(mounted.queryClient.getQueryState(listKey)?.status).toBe("pending");
    act(() => {
      poolArm.armSessions[0].emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          generation: 1,
          chats: [
            cloudChatSummary({
              taskId: EPIC_ID,
              chatId: CHAT_ARTIFACT.id,
              ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
              ownerHostId: HOST_ID,
              creatorUserId: SAVED_CREATOR_USER_ID,
            }),
          ],
        },
        null,
      );
    });

    await parkAndSendThroughOwnerHost(
      ADMITTED_SAVED_CREATOR_ACCESS,
      TEAM_ENVIRONMENT_OWNER_ID,
    );
  });

  it.each([
    { cause: "an explicit null creator", creatorUserId: null },
    { cause: "an omitted creator field", creatorUserId: undefined },
  ] as const)(
    "does not use a held Team starter when the matching cloud row has $cause",
    async ({ creatorUserId }) => {
      cloudChatListTestState.data = {
        chats: [
          cloudChatSummary({
            taskId: EPIC_ID,
            chatId: CHAT_ARTIFACT.id,
            ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
            ownerHostId: HOST_ID,
            creatorUserId,
          }),
        ],
      };
      const mounted = await mountOnThePool(
        POOL_VIEWER_ACCESS,
        TEAM_CREATOR_CHAT_SOURCE,
      );
      await waitForCloudChatList(mounted);

      expectReadOnlyWithoutParking();
    },
  );

  it.each([
    {
      cause: "task",
      taskId: "another-task",
      chatId: CHAT_ARTIFACT.id,
      ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
      ownerHostId: HOST_ID,
    },
    {
      cause: "chat",
      taskId: EPIC_ID,
      chatId: "another-chat",
      ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
      ownerHostId: HOST_ID,
    },
    {
      cause: "namespace owner",
      taskId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
      ownerUserId: "another-environment",
      ownerHostId: HOST_ID,
    },
    {
      cause: "owner host",
      taskId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
      ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
      ownerHostId: "another-host",
    },
  ] as const)(
    "does not use a cloud creator row with a mismatched $cause",
    async ({ taskId, chatId, ownerUserId, ownerHostId }) => {
      cloudChatListTestState.data = {
        chats: [
          cloudChatSummary({
            taskId,
            chatId,
            ownerUserId,
            ownerHostId,
            creatorUserId: SAVED_CREATOR_USER_ID,
          }),
        ],
      };
      const source: ChatSourceFixture = {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: null,
      };
      const mounted = await mountOnThePool(POOL_VIEWER_ACCESS, source);
      await waitForCloudChatList(mounted);

      expectReadOnlyWithoutParking();
    },
  );

  it("parks a personal-owner chat with its matching private cloud row", async () => {
    cloudChatListTestState.data = {
      chats: [
        cloudChatSummary({
          taskId: EPIC_ID,
          chatId: CHAT_ARTIFACT.id,
          ownerUserId: SAVED_CREATOR_USER_ID,
          ownerHostId: HOST_ID,
          creatorUserId: null,
        }),
      ],
    };
    const source: ChatSourceFixture = {
      ownerUserId: SAVED_CREATOR_USER_ID,
      starterUserId: null,
    };
    const mounted = await mountOnThePool(POOL_VIEWER_ACCESS, source);
    await waitForCloudChatList(mounted);
    await parkAndSendThroughOwnerHost(
      ADMITTED_PERSONAL_OWNER_ACCESS,
      SAVED_CREATOR_USER_ID,
    );
  });
});
