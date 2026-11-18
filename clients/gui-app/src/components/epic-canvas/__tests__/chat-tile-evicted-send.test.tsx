import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { settleLegendList } from "@/components/chat/__tests__/legend-list-test-environment";
import { composerDraftIsEmpty } from "@/hooks/chats/use-initial-chat-handoff-driver";
import { SYSTEM_ACTOR_ID } from "@/lib/identity/person-identity";
import type { SentChatMessage } from "@/components/share-on-x/sent-messages";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  HOST_ID,
  SAVED_CREATOR_USER_ID,
  TEAM_ENVIRONMENT_OWNER_ID,
  environmentListTestState,
} from "./chat-tile-evicted-send-mock-state";
import {
  ADMITTED_SAVED_CREATOR_ACCESS,
  CHAT_ARTIFACT,
  EPIC_ID,
  FIRST_TEXT,
  HASH,
  POOL_VIEWER_ACCESS,
  SECOND_TEXT,
  TEAM_CREATOR_CHAT_SOURCE,
  TEAM_ENVIRONMENT_LIST_RESPONSE,
  acceptMessage,
  answerHydrate,
  clickSend,
  draftOf,
  expectRetainedDraftToast,
  hydrates,
  imageRootHeld,
  mountOnThePool,
  observeSentMessages,
  openStream,
  pendingRows,
  putInComposer,
  resetEvictedSendFixture,
  rowsWithText,
  runningShell,
  sendFramesOf,
  settleEvictedSendHostTier,
  stageRebind,
  streams,
  teardownEvictedSendFixture,
  textInContent,
} from "./chat-tile-evicted-send-support";

/**
 * A message to a chat its host dropped the records of, through the real tile:
 * the pool serves the transcript (a copy that cannot act), the message is
 * parked and drawn as a pending send, the host is asked for the chat
 * (`epic.hydrateChat`), and once the host answers the session moves there and
 * sends the message by the ordinary road. Faked: the chat streams, the
 * serving witness's stream and the `epic.hydrateChat` RPC. Everything between
 * the composer and the transcript is the real code.
 */

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

beforeAll(settleEvictedSendHostTier);

beforeEach(resetEvictedSendFixture);

afterEach(teardownEvictedSendFixture);

describe("a message sent to a chat the pool serves because its host dropped the records", () => {
  it.each([
    {
      cause: "no saved starter",
      source: {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: null,
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "a system starter",
      source: {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: SYSTEM_ACTOR_ID,
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "a different saved starter",
      source: {
        ownerUserId: TEAM_ENVIRONMENT_OWNER_ID,
        starterUserId: "creator-elsewhere",
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "an owner outside the answered team list",
      source: {
        ownerUserId: "env-team-not-listed",
        starterUserId: SAVED_CREATOR_USER_ID,
      },
      environmentList: TEAM_ENVIRONMENT_LIST_RESPONSE,
    },
    {
      cause: "an unanswered team list",
      source: TEAM_CREATOR_CHAT_SOURCE,
      environmentList: undefined,
    },
  ] as const)(
    "does not park a message for $cause",
    async ({ source, environmentList }) => {
      environmentListTestState.data = environmentList;
      await mountOnThePool(POOL_VIEWER_ACCESS, source);

      expect(screen.getByText("Read-only viewer.")).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Clone agent" }),
      ).not.toBeNull();
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      putInComposer(FIRST_TEXT);
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      expect(
        useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
      ).toEqual(draftOf(FIRST_TEXT));
      expect(streams.flatMap(sendFramesOf)).toEqual([]);
      expect(hydrates).toEqual([]);
    },
  );

  it("is drawn as pending, sent once by the host after it answers, and read back as sent", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);

    clickSend();

    // Cleared like any send, pending, nothing sent, nothing toasted.
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
    });
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(streams[0].sent).toEqual([]);
    expect(toast.getToasts()).toHaveLength(0);
    expect(reported).toEqual([]);
    await waitFor(() => {
      expect(hydrates).toHaveLength(1);
    });
    expect(hydrates[0]?.params).toEqual({
      epicId: EPIC_ID,
      chatId: CHAT_ARTIFACT.id,
    });

    // The host answers, the session moves there, and one send goes out.
    await answerHydrate(0);
    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      undefined,
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await waitFor(() => {
      expect(sendFramesOf(streams[1])).toHaveLength(1);
    });
    expect(sendFramesOf(streams[0])).toEqual([]);
    const frame = sendFramesOf(streams[1])[0];
    expect(textInContent(frame.content)).toBe(FIRST_TEXT);
    expect(JSON.stringify(frame.content)).toContain(HASH);

    // The parked row was swapped for the store's own.
    expect(pendingRows()).toHaveLength(1);
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);

    // The host accepted it: the row is the sent message.
    acceptMessage(streams[1], frame);
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(0);
    });
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    expect(toast.getToasts()).toHaveLength(0);
    expect(streams).toHaveLength(2);
    expect(sendFramesOf(streams[1])).toHaveLength(1);
    expect(reported).toEqual([
      { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
    ]);
  });

  it("holds a second message behind the first and sends both once, in order", async () => {
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => {
      expect(hydrates).toHaveLength(1);
    });
    putInComposer(SECOND_TEXT);

    clickSend();

    await waitFor(() => {
      expect(pendingRows()).toHaveLength(2);
    });
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    expect(streams[0].sent).toEqual([]);
    expect(hydrates).toHaveLength(1);

    await answerHydrate(0);
    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      undefined,
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await waitFor(() => {
      expect(sendFramesOf(streams[1])).toHaveLength(2);
    });
    await settleLegendList();
    const texts = sendFramesOf(streams[1]).map((frame) =>
      textInContent(frame.content),
    );
    expect(texts).toEqual([FIRST_TEXT, SECOND_TEXT]);
    expect(sendFramesOf(streams[0])).toEqual([]);
    expect(hydrates).toHaveLength(1);
    // The first send started the turn, so the second is the host's queued
    // message: each text is on screen once, the second in the queue.
    await waitFor(() => {
      expect(pendingRows()).toHaveLength(1);
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      expect(
        within(screen.getByTestId("queued-message-rows")).getByText(
          SECOND_TEXT,
        ),
      ).not.toBeNull();
    });
    expect(toast.getToasts()).toHaveLength(0);
  });

  it.each(["unmount", "pagehide", "confirm-close"] as const)(
    "settles consent correctly during %s",
    async (lifecycle) => {
      const reported: SentChatMessage[] = [];
      observeSentMessages(reported);
      stageRebind();
      await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
      putInComposer(FIRST_TEXT);
      clickSend();
      await waitFor(() => expect(pendingRows()).toHaveLength(1));
      putInComposer(SECOND_TEXT);
      clickSend();
      await waitFor(() => expect(pendingRows()).toHaveLength(2));
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      await settleLegendList();
      await answerHydrate(0);
      await settleLegendList();
      await waitFor(() => expect(streams).toHaveLength(2));
      await settleLegendList();
      openStream(
        streams[1],
        ADMITTED_SAVED_CREATOR_ACCESS,
        [runningShell()],
        TEAM_ENVIRONMENT_OWNER_ID,
      );
      await settleLegendList();
      expect(
        await screen.findByTestId("teardown-commit-dialog"),
      ).not.toBeNull();
      expect(pendingRows()).toHaveLength(2);
      expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
      expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
      expect(reported).toEqual([]);

      if (lifecycle === "confirm-close") {
        const confirm = screen.getByTestId("teardown-commit-immediate");
        act(() => {
          fireEvent.click(confirm);
          cleanup();
        });
        await waitFor(() => {
          expect(sendFramesOf(streams[1])).toHaveLength(1);
        });
        await waitFor(() => {
          expect(reported).toEqual([
            { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
          ]);
        });
        expect(sendFramesOf(streams[0])).toEqual([]);
        expect(textInContent(sendFramesOf(streams[1])[0].content)).toBe(
          FIRST_TEXT,
        );
        expect(
          useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
        ).toEqual(draftOf(SECOND_TEXT));
        expect(
          toast
            .getToasts()
            .filter(
              (entry) =>
                "duration" in entry &&
                entry.duration === Number.POSITIVE_INFINITY,
            ),
        ).toEqual([]);
        expect(pendingRows()).toHaveLength(0);
        expect(imageRootHeld()).toBe(false);
      } else if (lifecycle === "pagehide") {
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
      } else {
        cleanup();
      }

      if (lifecycle !== "confirm-close") {
        expect(
          useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
        ).toEqual(draftOf(FIRST_TEXT));
        expectRetainedDraftToast(SECOND_TEXT);
        expect(imageRootHeld()).toBe(false);
        expect(screen.queryByTestId("teardown-commit-dialog")).toBeNull();
        expect(pendingRows()).toHaveLength(0);
        expect(streams.flatMap(sendFramesOf)).toEqual([]);
        expect(hydrates).toHaveLength(1);
        expect(reported).toEqual([]);
      }
    },
  );

  it("serializes consent for two parked sends and dispatches them in order", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    stageRebind();
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    putInComposer(SECOND_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(2));
    await settleLegendList();
    await answerHydrate(0);
    await settleLegendList();
    await waitFor(() => expect(streams).toHaveLength(2));
    await settleLegendList();
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      [runningShell()],
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await settleLegendList();

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    expect(pendingRows()).toHaveLength(2);
    expect(rowsWithText(FIRST_TEXT)).toHaveLength(1);
    expect(rowsWithText(SECOND_TEXT)).toHaveLength(1);
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(reported).toEqual([]);

    fireEvent.click(screen.getByTestId("teardown-commit-immediate"));
    await waitFor(() => expect(sendFramesOf(streams[1])).toHaveLength(2));
    await waitFor(() => expect(reported).toHaveLength(2));
    expect(
      sendFramesOf(streams[1]).map((frame) => textInContent(frame.content)),
    ).toEqual([FIRST_TEXT, SECOND_TEXT]);
    expect(reported).toEqual([
      { text: FIRST_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
      { text: SECOND_TEXT, epicId: EPIC_ID, hostId: HOST_ID },
    ]);
    expect(composerDraftIsEmpty(CHAT_ARTIFACT.id)).toBe(true);
    const [first, second] = sendFramesOf(streams[1]);
    acceptMessage(streams[1], first);
    acceptMessage(streams[1], second);
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
  });

  it("restores both parked sends when each consent is cancelled", async () => {
    const reported: SentChatMessage[] = [];
    observeSentMessages(reported);
    stageRebind();
    await mountOnThePool(POOL_VIEWER_ACCESS, TEAM_CREATOR_CHAT_SOURCE);
    putInComposer(FIRST_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    putInComposer(SECOND_TEXT);
    clickSend();
    await waitFor(() => expect(pendingRows()).toHaveLength(2));
    await settleLegendList();
    await answerHydrate(0);
    await settleLegendList();
    await waitFor(() => expect(streams).toHaveLength(2));
    await settleLegendList();
    openStream(
      streams[1],
      ADMITTED_SAVED_CREATOR_ACCESS,
      [runningShell()],
      TEAM_ENVIRONMENT_OWNER_ID,
    );
    await settleLegendList();

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    expect(pendingRows()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
    await waitFor(() => expect(pendingRows()).toHaveLength(1));
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(reported).toEqual([]);

    expect(await screen.findByTestId("teardown-commit-dialog")).not.toBeNull();
    fireEvent.click(screen.getByTestId("teardown-commit-cancel"));
    await waitFor(() => expect(pendingRows()).toHaveLength(0));
    expect(sendFramesOf(streams[1])).toEqual([]);
    expect(streams[0].sent).toEqual([]);
    expect(reported).toEqual([]);
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ARTIFACT.id]?.content,
    ).toEqual(draftOf(FIRST_TEXT));
    expectRetainedDraftToast(SECOND_TEXT);
  });
});
