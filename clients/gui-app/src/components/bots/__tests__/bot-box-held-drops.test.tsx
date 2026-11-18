/**
 * What the bot box's hold of dropped and picked files does across the changes
 * a box lives through (T386), through the REAL `BotChannelView`, drafts store,
 * box and ingest: the hold is never faked. The channel is mounted over a stored
 * draft whose image read each case holds, releases or fails; a file's bytes
 * are gated where a case needs a conversion that is slow. The tree and the
 * lifecycle are the question-card harness's.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
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
import { BOT_CONVERSATION_ATTACHMENTS_MAX } from "@traycer/protocol/host/bot/conversation-schemas";
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { MAX_IMAGE_SOURCE_BYTES } from "@/hooks/composer/use-composer-paste";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { activityStore, mocks } from "./bot-channel-question-card-state";
import { chatMessagesMock } from "./bot-channel-question-card-mocks";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  installQuestionCardCaseLifecycle,
} from "./bot-channel-question-card-harness";
import { negotiateBotSend } from "@/components/bots/__tests__/bot-failed-request-test-support";
import { resetImageReads } from "@/components/bots/__tests__/bot-drop-image-reads";
import {
  accounts,
  chips,
  chipsAre,
  COMPOSER,
  HELD,
  mountReading,
  newAccounts,
  pane,
  READING,
  release,
  signInAs,
  until,
} from "@/components/bots/__tests__/bot-drop-reading-support";
import {
  dropOn,
  filesTransfer,
  imageFile,
  PNG_BYTES,
  spyOnNotices,
} from "@/components/bots/__tests__/bot-drop-test-support";

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

let refusals: MockInstance<typeof toast.error>;
let notices: MockInstance<typeof toast.info>;

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

/** An image whose bytes the case hands over when it chooses: a conversion that is slow until `open`. */
function gatedImage(name: string): {
  readonly file: File;
  readonly asked: () => number;
  readonly open: () => void;
} {
  const file = imageFile(name);
  const gate = Promise.withResolvers<ArrayBuffer>();
  let asked = 0;
  Object.defineProperty(file, "arrayBuffer", {
    value: () => {
      asked += 1;
      return gate.promise;
    },
  });
  return {
    file,
    asked: () => asked,
    open: () => gate.resolve(new Uint8Array(PNG_BYTES).buffer),
  };
}

/** A file whose reported size is `size`, with the bytes of a small image. */
function imageOfSize(name: string, size: number): File {
  const file = imageFile(name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function picker(): HTMLInputElement {
  const input = screen
    .getByTestId(`${COMPOSER}-picker`)
    .querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("the box's slot has no file input");
  return input;
}

function newUser(): UserEvent {
  return userEvent.setup({
    advanceTimers: vi.advanceTimersByTime,
    applyAccept: false,
  });
}

async function settleLong(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
}

describe("<BotChannelView tiles={null} /> files picked while the box reads its draft", () => {
  it("takes nothing, and lands nothing in the next account's box, when the account retires between opening the picker and the selection", async () => {
    await mountReading(1);
    const input = picker();
    await newUser().click(screen.getByTestId(`${COMPOSER}-attach`));

    signInAs(accounts.b);
    await newUser().upload(input, imageFile("late.png"));
    await until(() => expect(screen.queryByTestId(READING)).toBeNull());
    await settleLong();

    expect(chips()).toEqual([]);
    expect(screen.queryByTestId(HELD)).toBeNull();
  });

  it("takes nothing, and does not hold again, when the bot is forgotten between opening the picker and the selection", async () => {
    await mountReading(1);
    const input = picker();
    await newUser().click(screen.getByTestId(`${COMPOSER}-attach`));

    act(() => useBotDraftsStore.getState().forgetBot(BOT_ID));
    await newUser().upload(input, imageFile("late.png"));
    await settleLong();

    expect(chips()).toEqual([]);
    expect(screen.queryByTestId(HELD)).toBeNull();
  });

  it("still takes a selection that arrives after the read-back mounted the box and its first drain ran", async () => {
    const { hash } = await mountReading(1);
    const input = picker();
    const user = newUser();
    await user.click(screen.getByTestId(`${COMPOSER}-attach`));
    release(hash);
    await chipsAre(["shot.png"]);

    await user.upload(input, imageFile("after.png"));

    await chipsAre(["shot.png", "after.png"]);
    expect(document.contains(input)).toBe(true);
  });
});

describe("<BotChannelView tiles={null} /> held files landing in the box", () => {
  it("lands the held drop in an empty box when the draft is discarded, once its editor is ready", async () => {
    await mountReading(1);
    dropOn(pane(), filesTransfer(imageFile("one.png")));

    await newUser().click(screen.getByTestId(`${COMPOSER}-discard`));

    await chipsAre(["one.png"]);
    expect(refusals).not.toHaveBeenCalled();
  });

  it("lands each held file exactly once under a replayed effect", async () => {
    const { hash } = await mountReading(1);
    dropOn(pane(), filesTransfer(imageFile("one.png")));
    dropOn(pane(), filesTransfer(imageFile("two.png")));

    release(hash);

    await chipsAre(["shot.png", "one.png", "two.png"]);
    await settleLong();
    expect(chips()).toEqual(["shot.png", "one.png", "two.png"]);
  });

  it("lands an entry a cross-window re-read interrupted once, when the next editor drains it, and none twice", async () => {
    const { hash } = await mountReading(1);
    const slow = gatedImage("slow.png");
    dropOn(pane(), filesTransfer(slow.file));
    release(hash);
    await until(() => expect(slow.asked()).toBeGreaterThan(0));

    act(() => {
      useBotDraftsStore.setState({
        boxesReading: {
          [BOT_ID]: {
            [CHANNEL_ID]: { text: "Rewritten elsewhere", replyTo: null },
          },
        },
      });
    });
    expect(screen.getByTestId(READING)).toBeTruthy();
    act(() => slow.open());
    act(() => {
      useBotDraftsStore.setState({
        boxesReading: {},
        threadBoxes: {
          [BOT_ID]: {
            [CHANNEL_ID]: {
              text: "Rewritten elsewhere",
              content: null,
              seedId: 2,
              replyTo: null,
            },
          },
        },
      });
    });

    await chipsAre(["slow.png"]);
    await settleLong();
    expect(chips()).toEqual(["slow.png"]);
  });

  it("lands two batches in drop order when the first is slow to prepare and the second fast", async () => {
    const { hash } = await mountReading(1);
    const slow = gatedImage("slow.png");
    dropOn(pane(), filesTransfer(slow.file));
    dropOn(pane(), filesTransfer(imageFile("fast.png")));
    release(hash);
    await chipsAre(["shot.png"]);
    await until(() => expect(slow.asked()).toBeGreaterThan(0));

    expect(chips()).toEqual(["shot.png"]);
    act(() => slow.open());

    await chipsAre(["shot.png", "slow.png", "fast.png"]);
  });

  it("keeps the restored images in place, fills the rest of the box from the held files, and refuses the excess with the box's count refusal", async () => {
    const restored = BOT_CONVERSATION_ATTACHMENTS_MAX - 2;
    const { hash } = await mountReading(restored);
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) {
      dropOn(pane(), filesTransfer(imageFile(name)));
    }

    release(hash);

    await chipsAre([
      ...Array.from({ length: restored }, () => "shot.png"),
      "a.png",
      "b.png",
    ]);
    await until(() => expect(refusals).toHaveBeenCalled());
  });
});

describe("<BotChannelView tiles={null} /> what the hold admits at the drop", () => {
  it("refuses a 21st entry at the drop with the box's count refusal, and lands the first twenty", async () => {
    await mountReading(1);
    const names = Array.from(
      { length: BOT_CONVERSATION_ATTACHMENTS_MAX },
      (_unused, index) => `held-${String(index + 1)}.png`,
    );
    for (const name of names) {
      dropOn(pane(), filesTransfer(imageFile(name)));
    }
    expect(refusals).not.toHaveBeenCalled();

    const over = dropOn(pane(), filesTransfer(imageFile("over.png")));

    expect(over.prevented).toBe(true);
    expect(refusals).toHaveBeenCalledTimes(1);
    await newUser().click(screen.getByTestId(`${COMPOSER}-discard`));
    await chipsAre(names);
    expect(refusals).toHaveBeenCalledTimes(1);
  });

  it("refuses a carried image above the source ceiling at the drop, and holds nothing", async () => {
    await mountReading(1);

    const drop = dropOn(
      pane(),
      filesTransfer(imageOfSize("huge.png", MAX_IMAGE_SOURCE_BYTES + 1)),
    );

    expect(drop.prevented).toBe(true);
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(HELD)).toBeNull();
  });

  it("holds a carried image above 5 MiB and under the ceiling, with no refusal at the drop", async () => {
    await mountReading(1);

    const drop = dropOn(
      pane(),
      filesTransfer(imageOfSize("big.png", 6 * 1024 * 1024)),
    );

    expect(drop.prevented).toBe(true);
    expect(refusals).not.toHaveBeenCalled();
    expect(screen.getByTestId(HELD)).toBeTruthy();
  });
});
