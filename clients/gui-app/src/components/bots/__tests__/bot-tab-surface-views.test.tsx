/**
 * The Tracy surface (Tracy Bots): the surface asks `bot.open` through its own
 * host and follows the answer - serving, or paused with a reason - and never
 * names the machine a bot runs on or moves to it.
 * Also: the stream's states, the re-subscribe and re-open when the pane comes
 * back into view, the surface forgetting a channel's state and selecting the
 * default when the bot is gone from `bot.list`, and a team's main bot still
 * to be set up (T67): a channel on its id shows the channel where the team is
 * set up, with nothing opened, subscribed or forgotten (the real hook, over a
 * scripted `bot.onboarding.read`). Its Enable cloud
 * runs the real sandbox reads and create over a scripted control plane.
 * The three views and the bot's session view are replaced by stubs
 * that expose their props, so what the surface PASSES them is what is
 * asserted. The tab strip's Activity count reads the real
 * `useBotActiveTasks` over the real agent-activity store and the real
 * notification-indicator hooks (the host answers `indicatorState`).
 */
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostClientMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { useBotMentionCompletion } from "@/components/bots/bot-mention-completion";
import { ComposerPromptEditor } from "@/components/chat/composer/composer-prompt-editor";
import { EMPTY_BOT_BOX } from "@/lib/bots/bot-box-content";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

import { KEYBOARD_FOCUS_OWNER_PROPS } from "@/hooks/ui/use-keyboard-focus-layout";

import { StrictMode, useContext, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotChannelLanding } from "@/components/bots/bot-channel-view";

import type { BotOpenSession } from "@/components/bots/bot-session-view";
import type {
  BotOpenMemory,
  BotOpenThread,
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import { __setAgentActivityStateForTests } from "@/stores/agent-activity-store";
import {
  BOT,
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  snapshot,
  TAB_HOST,
  trackingTask,
} from "./bot-tab-surface-harness";

vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
// The tasks a bot's channel can name come from two host reads, scripted here:
// the titles of the stream's tasks, and Home's task list.
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
// The Activity count reads the notification indicators through the notification
// host; the query transport below answers them.
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);

vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
// The card's memory row is driven in `bot-memory-pane.test.tsx`.
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
vi.mock("@/hooks/bots/use-bot-mutations", () => botMutationsMock);
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: (props: {
    activeBotId: string | null;
    hostId: string;
    threadsView: {
      shown: boolean;
      onShow: () => void;
      onLeave: () => void;
    } | null;
    onChannelOpened: () => void;
  }) => (
    <div
      data-testid="stub-sidebar"
      data-active-bot-id={props.activeBotId ?? "none"}
      data-host-id={props.hostId}
      data-threads-shown={String(props.threadsView?.shown ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-sidebar-pick"
        onClick={props.onChannelOpened}
      />
      <button
        type="button"
        data-testid="stub-sidebar-threads"
        onClick={props.threadsView?.onShow}
      />
      <button
        type="button"
        data-testid="stub-sidebar-own-channel"
        onClick={props.threadsView?.onLeave}
      />
    </div>
  ),
}));
/**
 * A message box on the real `@` completion, over what the tab hands its
 * content: the tab's directory decides when a search that matched nothing
 * closes the menu.
 */
function MentionBox(): ReactNode {
  const [content, setContent] = useState<JsonContent>(EMPTY_BOT_BOX);
  const mentions = useBotMentionCompletion({ replyRow: null });
  return (
    <>
      {mentions.menu}
      <div role="group" aria-label="Stub message box">
        <ComposerPromptEditor
          pickerStore={mentions.pickerStore}
          initialContent={content}
          initialSelection={null}
          placeholder="Message"
          editorClassName={undefined}
          stabilizeImageAttachmentCaret={false}
          isActive
          disabled={false}
          slashProviderId={null}
          hasPastedImageBytes={() => false}
          ingestPastedComposerImages={() => []}
          onDocumentChange={setContent}
          onSelectionChange={() => {}}
          onSubmit={() => {}}
          onPaste={() => {}}
          onDragOver={() => {}}
          onDrop={() => {}}
          onKeyDown={undefined}
          interceptKeyDown={null}
          onFocus={() => {}}
          onBlur={() => {}}
          onEditorReady={() => {}}
        />
      </div>
    </>
  );
}

let exerciseMentionEditor = false;

/** What the tab hands its content to mention (`BotMentionsContext`), as the stub channel sees it. */
function MentionsProbe(): ReactNode {
  const mentionable = useContext(BotMentionsContext);
  if (mentionable === null) return null;
  return (
    <>
      {exerciseMentionEditor ? <MentionBox /> : null}
      <output
        data-testid="stub-mentionable"
        data-bots={
          mentionable.bots === null
            ? "unread"
            : mentionable.bots.map((target) => target.name).join("|")
        }
        data-tasks={mentionable.tasks.map((target) => target.name).join("|")}
      />
    </>
  );
}

vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: (props: {
    botId: string;
    hostId: string;
    boundHostId: string | null;
    botTitle: string;
    appConversationChatId: string | null;
    openThread: BotOpenThread | null;
    landOn: BotChannelLanding | null;
    trunkChatId: string;
    openMemory: BotOpenMemory | null;
    onOpenMemory: (open: BotOpenMemory | null) => void;
    onOpenTurn: BotTurnOpen;
    onOpenSession: BotSessionOpen;
    resolveMember: (
      userId: string,
    ) => { displayName: string | null; avatarUrl: string | null } | null;
    setupHistory: ReactNode;
    tiles: number | null;
  }) => (
    <div
      data-testid="stub-channel"
      data-tiles={String(props.tiles)}
      data-host-id={props.hostId}
      data-bound-host-id={props.boundHostId ?? "none"}
      data-bot-title={props.botTitle}
      data-app-conversation-chat-id={props.appConversationChatId ?? "none"}
      data-open-thread={props.openThread?.anchorMessageId ?? "none"}
      data-land-on={props.landOn?.messageId ?? "none"}
      data-land-on-thread={props.landOn?.threadId ?? "none"}
      data-open-memory={String(props.openMemory !== null)}
      data-trunk-chat-id={props.trunkChatId}
      data-teammate-name={
        props.resolveMember("user-teammate")?.displayName ?? "unresolved"
      }
    >
      <button
        type="button"
        data-testid="stub-channel-open-memory"
        onClick={() => props.onOpenMemory({ back: null })}
      />
      <button
        type="button"
        data-testid="stub-channel-open-turn"
        onClick={() => props.onOpenTurn(REPLY_TURN, null)}
      />
      <button
        type="button"
        data-testid="stub-channel-open-thread-session"
        onClick={() =>
          props.onOpenSession({
            chatId: "session-thread-1",
            threadId: "thread-1",
            messageId: null,
            sendPostId: null,
          })
        }
      />
      {props.setupHistory}
      <MentionsProbe />
      {/* The two boxes' places in the real view: the channel's own, and one
          inside the thread panel, which the header tells apart by its marker. */}
      <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
        <textarea aria-label="Channel box" />
      </div>
      <section data-bot-thread-panel="">
        <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
          <textarea aria-label="Thread box" />
        </div>
      </section>
    </div>
  ),
}));
// The session view is driven in `bot-session-view.test.tsx`; here, what the
// tab hands it and what its links do to the tab.
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: (props: {
    session: BotOpenSession;
    onClose: () => void;
    onOpenChannel: (messageId: string | null) => void;
    onOpenThread: (threadId: string, messageId: string | null) => void;
  }) => (
    <div
      data-testid="stub-session"
      data-chat-id={props.session.chatId}
      data-thread-id={props.session.threadId ?? "none"}
      data-land-on={props.session.landOn?.messageId ?? "none"}
      data-visit={String(props.session.landOn?.visit ?? "none")}
    >
      <button
        type="button"
        data-testid="stub-session-back"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-session-channel"
        onClick={() => props.onOpenChannel(null)}
      />
      <button
        type="button"
        data-testid="stub-session-post"
        onClick={() => props.onOpenChannel("post-1")}
      />
      <button
        type="button"
        data-testid="stub-session-thread"
        onClick={() => props.onOpenThread("thread-1", null)}
      />
      <button
        type="button"
        data-testid="stub-session-thread-post"
        onClick={() => props.onOpenThread("thread-1", "thread-reply-9")}
      />
    </div>
  ),
}));
// The Activity page takes whether this host runs the bot, and the list the
// tab's count is read from: its rows are what the page would draw.
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: (props: {
    boundHere: boolean;
    active: { rows: ReadonlyArray<{ task: { taskId: string } }> };
    trunkChatId: string;
    onOpenSession: BotSessionOpen;
  }) => (
    <div
      data-testid="stub-activity"
      data-is-this-host={String(props.boundHere)}
      data-row-ids={props.active.rows.map((row) => row.task.taskId).join(",")}
    >
      <button
        type="button"
        data-testid="stub-activity-open-trunk"
        onClick={() =>
          props.onOpenSession({
            chatId: props.trunkChatId,
            threadId: null,
            messageId: null,
            sendPostId: null,
          })
        }
      />
    </div>
  ),
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: (props: {
    hostId: string;
    channelTitle: string;
    onBack: () => void;
  }) => (
    <div
      data-testid="stub-threads"
      data-host-id={props.hostId}
      data-channel-title={props.channelTitle}
    >
      <button
        type="button"
        data-testid="stub-threads-back"
        onClick={props.onBack}
      />
    </div>
  ),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
// The panel takes the bot, whether its environment is a person's own, its
// channel, its environment's bots and how to close, and nothing else: no prop
// says which host serves the tab, so no control can be gated on it. The stub lists the props it was given.
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: (props: {
    personal: boolean;
    channelId: string | null;
    onClose: () => void;
    onDeleted: () => void;
  }) => (
    <div
      data-testid="stub-settings"
      data-personal={String(props.personal)}
      data-channel-id={props.channelId ?? "none"}
    >
      <button
        type="button"
        data-testid="stub-settings-close"
        onClick={props.onClose}
      />
      <button
        type="button"
        data-testid="stub-settings-deleted"
        onClick={props.onDeleted}
      />
    </div>
  ),
}));

import { BotTabSurface } from "@/components/bots/bot-tab-surface";

import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";

import { useAuthStore } from "@/stores/auth/auth-store";
import {
  boxInput,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";

/** The trunk's turn behind a reply in the channel. */
const REPLY_TURN: BotTurnRef = {
  chatId: "trunk-1",
  turnIds: ["turn-reply"],
  userMessageId: "prompt-reply",
  threadId: null,
  startedAt: 1_000,
  endedAt: 2_000,
  summary: null,
  messageIds: ["reply-1"],
  requestIds: [],
};

let queryClient = new QueryClient();

function surfaceFor(botId: string | null): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTabSurface botId={botId} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>
  );
}

function surface(): ReactNode {
  return surfaceFor(BOT_ID);
}

beforeEach(() => {
  exerciseMentionEditor = false;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
});

describe("<BotTabSurface /> views", () => {
  function activityTab(): HTMLElement {
    return screen.getByTestId("bot-tab-view-activity");
  }

  describe("what the channel can mention", () => {
    const TASK_STREAM = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const TASK_HOME = "0b9d7c1e-2a3f-4b5c-8d6e-7f8091a2b3c4";
    const TASK_ELSEWHERE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

    function taskRow(
      id: string,
      title: string,
      ownerEnvironmentId: string,
    ): ListTaskLight {
      return {
        epic: {
          light: {
            id,
            title,
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "draft",
            createdAt: 0,
            updatedAt: 0,
            createdBy: "user-1",
            version: "1.0.0",
          },
          permission: null,
          repos: [],
          workspaces: [],
          roomInfo: null,
        },
        pinned: false,
        ownerEnvironmentId,
      };
    }

    it("hands the channel the bots of the bot's environment, and the tasks its stream lists, then Home's tasks that environment owns", () => {
      useStandaloneBotsStore.setState({
        directory: {
          model: buildHomeBotsModel({
            environments: [
              {
                environmentId: "env-team",
                label: "Acme",
                ownerKind: "organization",
                ownerId: "org-1",
                roomId: "room-team",
              },
              {
                environmentId: "env-other",
                label: "Newco",
                ownerKind: "organization",
                ownerId: "org-2",
                roomId: "room-other",
              },
            ],
            bots: [
              BOT,
              {
                ...BOT,
                botId: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1",
                title: "Triage",
              },
              {
                ...BOT,
                botId: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M2",
                environmentId: "env-other",
                title: "Elsewhere",
              },
            ],
            mainBotIds: {},
          }),
          setups: [],
        },
        settled: true,
        botsListed: true,
      });
      mocks.state.snapshot = {
        ...snapshot(),
        tasks: [trackingTask(TASK_STREAM)],
      };
      mocks.taskContexts.set(
        TASK_STREAM,
        taskRow(TASK_STREAM, "Release notes", "env-team"),
      );
      mocks.homeTasks = [
        taskRow(TASK_ELSEWHERE, "Their plan", "env-other"),
        taskRow(TASK_HOME, "Roadmap", "env-team"),
      ];

      render(surface());

      const mentionable = screen.getByTestId("stub-mentionable");
      expect(mentionable.getAttribute("data-bots")).toBe("Release Bot|Triage");
      expect(mentionable.getAttribute("data-tasks")).toBe(
        "Release notes|Roadmap",
      );
    });

    describe("Home tasks the viewer owns directly", () => {
      const VIEWER = "user-viewer";

      /** A Home row naming no owner environment, on which the viewer holds the owner permission directly. */
      function ownedDirectly(id: string, title: string): ListTaskLight {
        const { ownerEnvironmentId: _unowned, ...base } = taskRow(
          id,
          title,
          "unused",
        );
        const epic = base.epic;
        if (epic === null || epic === undefined) {
          throw new Error("the fixture row is an epic");
        }
        return {
          ...base,
          epic: {
            ...epic,
            permission: {
              role: "owner",
              accessType: "direct",
              userId: VIEWER,
              grantedBy: VIEWER,
              grantedAt: 0,
            },
          },
        };
      }

      beforeEach(() => {
        useAuthStore.setState({
          profile: {
            userId: VIEWER,
            userName: "Olive Owner",
            email: "olive@example.com",
            avatarUrl: null,
          },
        });
        mocks.homeTasks = [ownedDirectly(TASK_HOME, "Roadmap")];
      });

      it("are the tasks a personal bot's channel can mention, in the viewer's own environment", () => {
        mocks.state.environments = [
          {
            environmentId: "env-team",
            label: "Olive Owner",
            ownerKind: "user",
          },
        ];

        render(surface());

        expect(
          screen.getByTestId("stub-mentionable").getAttribute("data-tasks"),
        ).toBe("Roadmap");
      });

      it("are not the tasks of a team bot's channel", () => {
        mocks.state.environments = [
          {
            environmentId: "env-team",
            label: "Acme",
            ownerKind: "organization",
          },
        ];

        render(surface());

        expect(
          screen.getByTestId("stub-mentionable").getAttribute("data-tasks"),
        ).toBe("");
      });
    });

    describe("a search for a name nothing has", () => {
      const VIEWER = "user-viewer";
      const mentionMenu = (): Element | null =>
        document.querySelector('[data-slot="composer-menu"]');

      beforeEach(() => {
        useAuthStore.setState({
          status: "signed-in",
          profile: {
            userId: VIEWER,
            userName: "Olive Owner",
            email: "olive@example.com",
            avatarUrl: null,
          },
        });
        // A personal bot: the viewer is its one member, so there are no
        // members to wait for.
        mocks.state.environments = [
          {
            environmentId: "env-team",
            label: "Olive Owner",
            ownerKind: "user",
          },
        ];
        useStandaloneBotsStore.setState({
          directory: {
            model: buildHomeBotsModel({
              environments: [
                {
                  environmentId: "env-team",
                  label: "Olive Owner",
                  ownerKind: "user",
                  ownerId: VIEWER,
                  roomId: "room-team",
                },
              ],
              bots: [
                BOT,
                {
                  ...BOT,
                  botId: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1",
                  title: "Triage",
                },
              ],
              mainBotIds: {},
            }),
            setups: [],
          },
          settled: true,
          botsListed: true,
        });
        mocks.state.snapshot = {
          ...snapshot(),
          tasks: [trackingTask(TASK_STREAM)],
        };
        mocks.taskContexts.set(
          TASK_STREAM,
          taskRow(TASK_STREAM, "Release notes", "env-team"),
        );
      });

      function typeNoMatch(): void {
        exerciseMentionEditor = true;
        render(surface());
        typeInto(boxInput("Stub message box"), "@zzzz");
      }

      it("closes the menu once Home's initial read is refused, though its first page is pending", () => {
        mocks.taskReads.homeRefused = true;
        mocks.taskReads.homePending = true;

        typeNoMatch();

        expect(mentionMenu()).toBeNull();
      });

      it("keeps the menu open while Home's first page is pending and its read may still run", () => {
        mocks.taskReads.homePending = true;

        typeNoMatch();

        expect(mentionMenu()).not.toBeNull();
      });

      it("closes the menu for a viewer who is not signed in, though the stream's task contexts never answer", () => {
        useAuthStore.setState({ status: "unverified" });
        mocks.taskReads.contextsPending = true;

        typeNoMatch();

        expect(mentionMenu()).toBeNull();
      });

      it("keeps the menu open for a signed-in viewer while the stream's task contexts are pending", () => {
        mocks.taskReads.contextsPending = true;

        typeNoMatch();

        expect(mentionMenu()).not.toBeNull();
      });
    });

    it("hands the channel no bots while the bot list has not answered, though the environment's group is in the directory", () => {
      useStandaloneBotsStore.setState({
        directory: {
          model: buildHomeBotsModel({
            environments: [
              {
                environmentId: "env-team",
                label: "Acme",
                ownerKind: "organization",
                ownerId: "org-1",
                roomId: "room-team",
              },
            ],
            bots: [],
            mainBotIds: {},
          }),
          setups: [],
        },
        settled: true,
        botsListed: false,
      });

      render(surface());

      expect(
        screen.getByTestId("stub-mentionable").getAttribute("data-bots"),
      ).toBe("unread");
    });

    it("hands the channel no bots while the bots directory has not answered", () => {
      render(surface());

      expect(
        screen.getByTestId("stub-mentionable").getAttribute("data-bots"),
      ).toBe("unread");
    });
  });

  it("shows Messages first, with Activity beside it and no Threads tab, and no counts for a quiet bot", () => {
    render(surface());

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Messages",
      "Activity",
    ]);
    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-activity-count")).toBeNull();
  });

  /** The tab's words as a sighted person reads them: no screen-reader text. */
  function visibleTabText(): string {
    const copy = activityTab().cloneNode(true);
    if (!(copy instanceof HTMLElement))
      throw new Error("tab is not an element");
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return copy.textContent;
  }

  it("rule 6: counts the rows the Activity list shows, one number and no words, whatever puts a task there", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "user-ada",
        userName: "Ada",
        email: "ada@example.com",
      },
      contextMetadata: { userId: "user-ada", username: "ada" },
    });
    mocks.unreadTaskIds.add("task-unseen");
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [
        { ...trackingTask("task-working"), cadence: { kind: "on-completion" } },
        {
          ...trackingTask("task-asking"),
          cadence: { kind: "on-completion" },
          inputNeeded: [
            {
              hostId: "host-agents",
              hostName: "Studio Mac",
              agentChatId: "agent-asking",
              surfaceId: "surface-1",
              surface: {
                kind: "approval",
                approvalId: "approval-1",
                tool: "gh pr merge",
                summary: "Merge the release PR",
                tier: null,
                requiresPerson: true,
                askedAt: 1_000,
              },
              reportedAt: 1_000,
              acceptsActions: true,
            },
          ],
        },
        { ...trackingTask("task-unseen"), cadence: { kind: "on-completion" } },
        trackingTask("task-periodic"),
        { ...trackingTask("task-quiet"), cadence: { kind: "on-completion" } },
      ],
    };
    __setAgentActivityStateForTests(
      { "task-working": { working: ["agent-1"], turn: ["agent-1"] } },
      "local",
      null,
    );
    render(surface());
    await user.click(activityTab());

    const shown = screen
      .getByTestId("stub-activity")
      .dataset.rowIds?.split(",");
    expect(shown).toHaveLength(4);
    expect(shown).not.toContain("task-quiet");
    const badge = within(activityTab()).getByTestId("bot-tab-activity-count");
    expect(badge.textContent).toContain(String(shown?.length));
    expect(visibleTabText()).toBe(`Activity${String(shown?.length)}`);
    // jsdom joins the name's parts without the spaces a browser puts in.
    expect(
      screen.getByRole("tab", {
        name: new RegExp(`^Activity\\s*${String(shown?.length)}\\s*active$`),
      }),
    ).toBe(activityTab());
    expect(screen.queryByRole("tab", { name: /unread/ })).toBeNull();
  });

  it("rule 6: shows no count when no task is active", () => {
    mocks.state.snapshot = {
      ...snapshot(),
      tasks: [
        { ...trackingTask("task-quiet"), cadence: { kind: "on-completion" } },
      ],
    };
    render(surface());

    expect(screen.queryByTestId("bot-tab-activity-count")).toBeNull();
    expect(visibleTabText()).toBe("Activity");
  });

  it("T179: the Activity tab's trunk door swaps the whole Tabs view for the trunk's own session, not a thread", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());
    expect(screen.getByTestId("stub-activity")).toBeTruthy();

    await user.click(screen.getByTestId("stub-activity-open-trunk"));

    const session = screen.getByTestId("stub-session");
    expect(session.getAttribute("data-chat-id")).toBe(
      snapshot().bot.trunkChatId,
    );
    expect(session.getAttribute("data-thread-id")).toBe("none");
    expect(screen.queryByTestId("stub-activity")).toBeNull();
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("shows Threads from the column in place of the channel and its views, through the tab's host, and its own channel row lands back where it was", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());

    await user.click(screen.getByTestId("stub-sidebar-threads"));

    expect(
      screen.getByTestId("stub-threads").getAttribute("data-host-id"),
    ).toBe(TAB_HOST);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("stub-activity")).toBeNull();
    const sidebar = screen.getByTestId("stub-sidebar");
    expect(sidebar.getAttribute("data-threads-shown")).toBe("true");
    expect(sidebar.getAttribute("data-active-bot-id")).toBe(BOT_ID);

    await user.click(screen.getByTestId("stub-sidebar-own-channel"));

    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expect(activityTab().getAttribute("aria-selected")).toBe("true");
    expect(sidebar.getAttribute("data-threads-shown")).toBe("false");
  });

  it.each([
    ["the view's back control", "stub-threads-back"],
    ["the column's row for this channel", "stub-sidebar-own-channel"],
  ])(
    "leaves Threads for the channel, not for a session open before it, through %s",
    async (_way, testId) => {
      const user = userEvent.setup();
      render(surface());
      await user.click(screen.getByTestId("stub-channel-open-thread-session"));
      expect(screen.getByTestId("stub-session")).toBeTruthy();
      await user.click(screen.getByTestId("stub-sidebar-threads"));

      await user.click(screen.getByTestId(testId));

      expect(screen.queryByTestId("stub-threads")).toBeNull();
      expect(screen.queryByTestId("stub-session")).toBeNull();
      expect(screen.getByTestId("stub-channel")).toBeTruthy();
      expect(
        screen
          .getByTestId("bot-tab-view-messages")
          .getAttribute("aria-selected"),
      ).toBe("true");
    },
  );

  it("goes back from Threads to the channel where it was through the view's own back control, which names the tab's channel", async () => {
    const user = userEvent.setup();
    render(surface());
    await user.click(activityTab());
    await user.click(screen.getByTestId("stub-sidebar-threads"));
    expect(
      screen.getByTestId("stub-threads").getAttribute("data-channel-title"),
    ).toBe(snapshot().bot.title);

    await user.click(screen.getByTestId("stub-threads-back"));

    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expect(activityTab().getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByTestId("stub-sidebar").getAttribute("data-threads-shown"),
    ).toBe("false");
  });

  it("opens a thread chosen in Threads beside the channel, through the tab's landing, and leaves Threads", async () => {
    const user = userEvent.setup();
    mocks.state.threads = [
      {
        threadId: "thread-1",
        conversationId: "conversation-app",
        sessionChatId: "session-thread-1",
        anchor: {
          messageId: "post-7",
          requestId: "req-7",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
          excerpt: null,
        },
        replyCount: 1,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ];
    useBotTabLandingStore.setState({ byBotId: {} });
    render(surface());
    await user.click(screen.getByTestId("stub-sidebar-threads"));

    act(() =>
      useBotTabLandingStore.getState().request(BOT_ID, {
        kind: "thread",
        threadId: "thread-1",
        messageId: null,
      }),
    );

    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expect(
      screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
    ).toBe("post-7");
    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-sidebar").getAttribute("data-threads-shown"),
    ).toBe("false");
    expect(useBotTabLandingStore.getState().byBotId).toEqual({});
  });
});
