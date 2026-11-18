/**
 * What the bot's message box does with a file dropped on its pane, through the
 * REAL `BotChannelView` and its zone (T386): a host that takes no images
 * refuses with a notice, a box still reading its stored draft's images takes
 * the drop and hands it to the box once it mounts, and a box that changes
 * under a drag keeps the pane's overlay. The tree, the host client and the
 * per-case lifecycle are in `bot-channel-question-card-harness.tsx`; the drags
 * and the stored draft are in `bot-drop-test-support.tsx`. Faked: the host,
 * and the image store's read, which each case releases or fails.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  DROP_WITHOUT_IMAGE_HOST,
  DROPS_WAIT_FOR_DRAFT_IMAGES,
} from "@/components/bots/bot-drop-lines";
import { Toaster } from "@/components/ui/sonner";
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { activityStore, mocks } from "./bot-channel-question-card-state";
import { chatMessagesMock } from "./bot-channel-question-card-mocks";
import {
  BOT_ID,
  CHANNEL_ID,
  channelBox,
  HOST_ID,
  installQuestionCardCaseLifecycle,
  mountChannel,
  session,
} from "./bot-channel-question-card-harness";
import { negotiateBotSend } from "@/components/bots/__tests__/bot-failed-request-test-support";
import { typeInto } from "@/components/bots/__tests__/bot-box-test-support";
import {
  dragEnter,
  dragOver,
  dropOn,
  fileReferenceTransfer,
  filesTransfer,
  imageFile,
  linkTransfer,
  noticeIds,
  noticeMessages,
  spyOnNotices,
  STORED_TEXT,
  textFile,
  textTransfer,
} from "@/components/bots/__tests__/bot-drop-test-support";
import {
  failImageReads,
  resetImageReads,
} from "@/components/bots/__tests__/bot-drop-image-reads";
import {
  accounts,
  chips,
  chipsAre,
  COMPOSER,
  HELD,
  mountReading,
  newAccounts,
  overlayShown,
  pane,
  READING,
  release,
  signInAs,
  until,
} from "@/components/bots/__tests__/bot-drop-reading-support";

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/lib/composer/landing-image-store", async () =>
  (
    await import("@/components/bots/__tests__/bot-drop-image-reads")
  ).landingImageStoreMock(),
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => mocks.handles.get(chatId) ?? null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.threads, threadAnchors: null },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/components/chat/chat-messages", () => chatMessagesMock());

installQuestionCardCaseLifecycle();

const NO_IMAGES_HOST = { major: 1, minor: 3 };

let notices: MockInstance<typeof toast.info>;
let refusals: MockInstance<typeof toast.error>;

beforeEach(() => {
  newAccounts();
  localStorage.clear();
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  resetImageReads();
  negotiateBotSend(HOST_ID, BOT_CONVERSATION_IMAGES_VERSION);
  notices = spyOnNotices();
  refusals = vi.spyOn(toast, "error");
});

afterEach(() => {
  notices.mockRestore();
  refusals.mockRestore();
  useBotDraftsStore.setState({ boxesReading: {} });
});

describe("<BotChannelView tiles={null} /> a box whose host takes no images", () => {
  beforeEach(() => {
    negotiateBotSend(HOST_ID, NO_IMAGES_HOST);
    session(CHANNEL_ID, []);
  });

  it("shows no overlay for a file dragged over the pane, and refuses it with no notice", () => {
    mountChannel(null);
    const transfer = filesTransfer(imageFile("shot.png"));

    dragEnter(pane(), transfer);
    const over = dragOver(pane(), transfer);

    expect(overlayShown()).toBe(false);
    expect(over).toEqual({ prevented: true, dropEffect: "none" });
    expect(notices).not.toHaveBeenCalled();
  });

  it("refuses a dropped file and a dropped file reference, one notice each under one id, and ingests nothing", () => {
    mountChannel(null);

    const file = dropOn(pane(), filesTransfer(imageFile("shot.png")));
    const reference = dropOn(pane(), fileReferenceTransfer("/tmp/shot.png"));

    expect(file).toEqual({ prevented: true, dropEffect: "none" });
    expect(reference).toEqual({ prevented: true, dropEffect: "none" });
    expect(noticeMessages(notices)).toEqual([
      DROP_WITHOUT_IMAGE_HOST,
      DROP_WITHOUT_IMAGE_HOST,
    ]);
    const [first, second] = noticeIds(notices);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(chips()).toEqual([]);
    expect(refusals).not.toHaveBeenCalled();
  });

  it("announces the notice in the toaster's live region", async () => {
    render(<Toaster />);
    mountChannel(null);

    dropOn(pane(), filesTransfer(imageFile("shot.png")));

    await until(() =>
      expect(
        within(
          screen.getByRole("region", { name: /notifications/i }),
        ).getByText(DROP_WITHOUT_IMAGE_HOST),
      ).toBeTruthy(),
    );
  });

  it("leaves text and an https link alone, raising no notice beyond the file's", () => {
    mountChannel(null);
    expect(dropOn(pane(), filesTransfer(imageFile("shot.png"))).prevented).toBe(
      true,
    );

    const text = dropOn(pane(), textTransfer("some words"));
    const link = dropOn(pane(), linkTransfer("https://example.com/a"));

    expect(text.prevented).toBe(false);
    expect(link.prevented).toBe(false);
    expect(noticeMessages(notices)).toEqual([DROP_WITHOUT_IMAGE_HOST]);
  });
});

describe("<BotChannelView tiles={null} /> a box that takes images, then none, then images, without remounting", () => {
  it("takes the drop, then refuses it with no overlay, then takes it again", async () => {
    session(CHANNEL_ID, []);
    const view = mountChannel(null);
    const input = channelBox();

    dropOn(pane(), filesTransfer(imageFile("first.png")));
    await chipsAre(["first.png"]);

    act(() => negotiateBotSend(HOST_ID, NO_IMAGES_HOST));
    view.reopen(null);
    dragEnter(pane(), filesTransfer(imageFile("second.png")));
    expect(overlayShown()).toBe(false);
    const refused = dropOn(pane(), filesTransfer(imageFile("second.png")));
    expect(refused).toEqual({ prevented: true, dropEffect: "none" });
    expect(noticeMessages(notices)).toEqual([DROP_WITHOUT_IMAGE_HOST]);

    act(() => negotiateBotSend(HOST_ID, BOT_CONVERSATION_IMAGES_VERSION));
    view.reopen(null);
    const transfer = filesTransfer(imageFile("third.png"));
    dragEnter(pane(), transfer);
    expect(overlayShown()).toBe(true);
    dropOn(pane(), transfer);

    await chipsAre(["first.png", "third.png"]);
    expect(channelBox()).toBe(input);
  });
});

describe("<BotChannelView tiles={null} /> a box that changes while a file is dragged over its pane", () => {
  it("keeps the overlay while typing in the box, and takes the drop once", async () => {
    session(CHANNEL_ID, []);
    mountChannel(null);
    const transfer = filesTransfer(imageFile("shot.png"));
    dragEnter(pane(), transfer);
    expect(overlayShown()).toBe(true);

    typeInto(channelBox(), "typing under the drag");

    expect(overlayShown()).toBe(true);
    dropOn(pane(), transfer);
    await chipsAre(["shot.png"]);
    expect(overlayShown()).toBe(false);
  });

  it("drops the overlay when the box is swapped for its reading view mid-drag, restores it on the next dragover, and holds the drop until the read ends", async () => {
    session(CHANNEL_ID, []);
    mountChannel(null);
    const transfer = filesTransfer(imageFile("dropped.png"));
    dragEnter(pane(), transfer);
    expect(overlayShown()).toBe(true);

    act(() => {
      useBotDraftsStore.setState({
        boxesReading: {
          [BOT_ID]: { [CHANNEL_ID]: { text: STORED_TEXT, replyTo: null } },
        },
      });
    });
    expect(screen.getByTestId(READING)).toBeTruthy();
    expect(overlayShown()).toBe(false);
    dragOver(pane(), transfer);
    expect(overlayShown()).toBe(true);
    const drop = dropOn(pane(), transfer);

    expect(drop.prevented).toBe(true);
    expect(screen.getByTestId(HELD).textContent).toBe(
      DROPS_WAIT_FOR_DRAFT_IMAGES,
    );
    act(() => {
      useBotDraftsStore.setState({
        boxesReading: {},
        threadBoxes: {
          [BOT_ID]: {
            [CHANNEL_ID]: {
              text: STORED_TEXT,
              content: null,
              seedId: 1,
              replyTo: null,
            },
          },
        },
      });
    });
    await chipsAre(["dropped.png"]);
  });
});

describe("<BotChannelView tiles={null} /> a box still reading its stored draft's images", () => {
  it("shows the box's own overlay over the pane for a file drag, with no notice", async () => {
    await mountReading(1);
    const transfer = filesTransfer(imageFile("shot.png"));

    dragEnter(pane(), transfer);
    const over = dragOver(pane(), transfer);

    expect(overlayShown()).toBe(true);
    expect(over.prevented).toBe(true);
    expect(over.dropEffect).toBe("copy");
    expect(notices).not.toHaveBeenCalled();
  });

  it("holds a dropped file and a dropped file reference, says so, and ingests nothing yet", async () => {
    await mountReading(1);
    expect(screen.queryByTestId(HELD)).toBeNull();

    const file = dropOn(pane(), filesTransfer(imageFile("one.png")));
    const reference = dropOn(pane(), fileReferenceTransfer("/tmp/two.png"));

    expect(file.prevented).toBe(true);
    expect(reference.prevented).toBe(true);
    expect(screen.getByTestId(HELD).textContent).toBe(
      DROPS_WAIT_FOR_DRAFT_IMAGES,
    );
    expect(screen.getByTestId(READING)).toBeTruthy();
    expect(chips()).toEqual([]);
    expect(notices).not.toHaveBeenCalled();
    expect(refusals).not.toHaveBeenCalled();
  });

  it("leaves the stored draft as it was during the read, and still takes the read-back", async () => {
    const { hash, stored } = await mountReading(1);
    const waiting = useBotDraftsStore.getState().boxesReading;

    dropOn(pane(), filesTransfer(imageFile("one.png")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(useBotDraftsStore.getState().boxesReading).toEqual(waiting);
    expect(
      useBotDraftsStore.getState().threadBoxes[BOT_ID]?.[CHANNEL_ID],
    ).toBeUndefined();
    expect(localStorage.getItem(botBoxDraftsKey(accounts.a))).toBe(stored);

    release(hash);
    await chipsAre(["shot.png", "one.png"]);
    expect(screen.queryByTestId(READING)).toBeNull();
  });

  it("puts the restored images first and the held files after them, in drop order", async () => {
    const { hash } = await mountReading(1);
    dropOn(pane(), filesTransfer(imageFile("one.png")));
    dropOn(pane(), filesTransfer(imageFile("two.png")));
    dropOn(pane(), filesTransfer(imageFile("three.png")));

    release(hash);

    await chipsAre(["shot.png", "one.png", "two.png", "three.png"]);
    expect(screen.queryByTestId(HELD)).toBeNull();
  });

  it("refuses a file of a type the box does not carry at the drop, with the box's refusal, and holds nothing", async () => {
    const { hash } = await mountReading(1);

    const drop = dropOn(pane(), filesTransfer(textFile("notes.txt")));

    expect(drop.prevented).toBe(true);
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(HELD)).toBeNull();
    release(hash);
    await chipsAre(["shot.png"]);
    expect(refusals).toHaveBeenCalledTimes(1);
  });

  it("lands the held files in an empty box when the draft is discarded", async () => {
    await mountReading(1);
    dropOn(pane(), filesTransfer(imageFile("one.png")));

    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByTestId(`${COMPOSER}-discard`));

    await chipsAre(["one.png"]);
    expect(screen.queryByTestId(READING)).toBeNull();
  });

  it("lands the held files in an empty box when the read fails", async () => {
    const { hash } = await mountReading(1);
    dropOn(pane(), filesTransfer(imageFile("one.png")));

    act(() => failImageReads(hash));

    await chipsAre(["one.png"]);
    expect(screen.queryByTestId(READING)).toBeNull();
  });

  it("lands nothing held in the next account's box after an account change", async () => {
    const { hash } = await mountReading(1);
    expect(dropOn(pane(), filesTransfer(imageFile("one.png"))).prevented).toBe(
      true,
    );
    expect(screen.getByTestId(HELD)).toBeTruthy();

    signInAs(accounts.b);
    await until(() => expect(screen.queryByTestId(READING)).toBeNull());
    release(hash);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(chips()).toEqual([]);
    expect(screen.queryByTestId(HELD)).toBeNull();
  });

  it("refuses with the host line, one notice per drop, and holds nothing, when the host takes no images", async () => {
    negotiateBotSend(HOST_ID, NO_IMAGES_HOST);
    const { hash } = await mountReading(1);
    const transfer = filesTransfer(imageFile("one.png"));

    dragEnter(pane(), transfer);
    expect(overlayShown()).toBe(false);
    const drop = dropOn(pane(), transfer);

    expect(drop.prevented).toBe(true);
    expect(noticeMessages(notices)).toEqual([DROP_WITHOUT_IMAGE_HOST]);
    expect(screen.queryByTestId(HELD)).toBeNull();
    release(hash);
    await until(() => expect(screen.queryByTestId(READING)).toBeNull());
    expect(chips()).toEqual([]);
  });

  it("enables Attach, and holds a picked file like a dropped one", async () => {
    const { hash } = await mountReading(1);
    const attach = screen.getByTestId(`${COMPOSER}-attach`);
    expect(attach).toHaveProperty("disabled", false);
    const picker = screen
      .getByTestId(`${COMPOSER}-picker`)
      .querySelector<HTMLInputElement>('input[type="file"]');
    if (picker === null) throw new Error("the reading view has no file input");

    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime,
      applyAccept: false,
    });
    await user.click(attach);
    await user.upload(picker, imageFile("picked.png"));

    expect(screen.getByTestId(HELD).textContent).toBe(
      DROPS_WAIT_FOR_DRAFT_IMAGES,
    );
    release(hash);
    await chipsAre(["shot.png", "picked.png"]);
  });

  it("leaves text and an https link untouched", async () => {
    await mountReading(1);
    dropOn(pane(), filesTransfer(imageFile("one.png")));
    expect(screen.getByTestId(HELD)).toBeTruthy();

    const text = dropOn(pane(), textTransfer("some words"));
    const link = dropOn(pane(), linkTransfer("https://example.com/a"));

    expect(text.prevented).toBe(false);
    expect(link.prevented).toBe(false);
    expect(screen.getByTestId(HELD)).toBeTruthy();
    expect(notices).not.toHaveBeenCalled();
  });
});
