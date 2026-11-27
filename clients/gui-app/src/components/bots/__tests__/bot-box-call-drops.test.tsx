/**
 * A file dropped on a Tracy pane while the box has a call, through the
 * REAL `BotChannelView`, drafts store, box and ingest: while the call bar (or the
 * line about how the call went) stands where the field was, the editor is gone,
 * so the pane takes no file: no overlay, no conversion, no notice. Before the
 * call and after it the box takes drops as ever. The call is placed through the
 * voice store, as `bot-box-held-drops.test.tsx` does. The tree and the lifecycle
 * are the question-card harness's.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, screen } from "@testing-library/react";
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
import { BOT_CONVERSATION_IMAGES_VERSION } from "@/hooks/bots/use-bot-send-version";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import { activityStore, mocks } from "./bot-channel-question-card-state";
import { chatMessagesMock } from "./bot-channel-question-card-mocks";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  installQuestionCardCaseLifecycle,
  mountChannel,
  session,
} from "./bot-channel-question-card-harness";
import { negotiateBotSend } from "@/components/bots/__tests__/bot-failed-request-test-support";
import { resetImageReads } from "@/components/bots/__tests__/bot-drop-image-reads";
import {
  chipsAre,
  COMPOSER,
  overlayShown,
  pane,
  settleLong,
  until,
} from "@/components/bots/__tests__/bot-drop-reading-support";
import {
  dragEnter,
  dragOver,
  dropOn,
  filesTransfer,
  gatedImage,
  imageFile,
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

let notices: MockInstance<typeof toast.info>;
let errors: MockInstance<typeof toast.error>;
let warnings: MockInstance<typeof toast.warning>;

beforeEach(() => {
  localStorage.clear();
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  resetImageReads();
  negotiateBotSend(HOST_ID, BOT_CONVERSATION_IMAGES_VERSION);
  notices = spyOnNotices();
  errors = vi.spyOn(toast, "error");
  warnings = vi.spyOn(toast, "warning");
});

afterEach(() => {
  notices.mockRestore();
  errors.mockRestore();
  warnings.mockRestore();
  useVoiceSessionStore.setState({
    phase: "idle",
    placedFrom: null,
    endReason: null,
    refusal: null,
  });
});

function editorOf(): Element | null {
  return screen.getByTestId(COMPOSER).querySelector("[data-composer-editor]");
}

/** A live box, its editor mounted. */
async function mountLiveBox(): Promise<void> {
  session(CHANNEL_ID, []);
  mountChannel(null);
  await until(() => expect(editorOf()).not.toBeNull());
}

function placeCall(): void {
  act(() => {
    useVoiceSessionStore
      .getState()
      .sessionConnecting(
        { botId: BOT_ID, hostId: HOST_ID, threadId: null },
        "Tracy",
      );
    useVoiceSessionStore.setState({ phase: "live" });
  });
}

/** The call is over and its line says how it went: the field stays gone. */
function endCallWithOutcomeLine(): void {
  act(() => {
    useVoiceSessionStore.setState({ phase: "idle", endReason: "ended" });
  });
}

/** The line is cleared. */
function clearCall(): void {
  act(() => {
    useVoiceSessionStore.setState({
      phase: "idle",
      placedFrom: null,
      endReason: null,
      refusal: null,
    });
  });
}

function expectNoToasts(): void {
  expect(notices).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  expect(warnings).not.toHaveBeenCalled();
}

/** A gated image dropped on `target`: refused whole, with nothing shown and its bytes never asked for. */
async function expectRefused(target: Element): Promise<void> {
  const gated = gatedImage("during.png", "same");
  const transfer = filesTransfer(gated.file);

  dragEnter(target, transfer);
  const over = dragOver(target, transfer);
  expect(overlayShown()).toBe(false);
  expect(over.dropEffect).toBe("none");
  const drop = dropOn(target, transfer);

  expect(drop).toEqual({ prevented: true, dropEffect: "none" });
  act(() => gated.open());
  await settleLong();
  expect(gated.asked()).toBe(0);
}

describe("<BotChannelView tiles={null} /> a file dropped on the pane while the box has a call", () => {
  it("refuses a drop on the transcript for the whole call, with no overlay, no conversion and no toast, and takes the next one after it", async () => {
    await mountLiveBox();
    dropOn(pane(), filesTransfer(imageFile("before.png")));
    await chipsAre(["before.png"]);
    placeCall();
    expect(screen.getByTestId(`${COMPOSER}-call-bar`)).toBeTruthy();
    expect(editorOf()).toBeNull();

    await expectRefused(pane());
    clearCall();
    await until(() => expect(editorOf()).not.toBeNull());

    await chipsAre(["before.png"]);
    expectNoToasts();
    dropOn(pane(), filesTransfer(imageFile("after.png")));
    // A drop lands at the caret, and the field that comes back holds its caret at its start.
    await chipsAre(["after.png", "before.png"]);
  });

  it("refuses a drop on the box frame, through the outcome line that stays after the call, until the line is cleared", async () => {
    await mountLiveBox();
    dropOn(pane(), filesTransfer(imageFile("before.png")));
    await chipsAre(["before.png"]);
    placeCall();
    const frame = screen.getByTestId(`${COMPOSER}-call-bar`);

    await expectRefused(frame);
    endCallWithOutcomeLine();
    expect(editorOf()).toBeNull();
    await expectRefused(screen.getByTestId(COMPOSER));
    clearCall();
    await until(() => expect(editorOf()).not.toBeNull());

    await chipsAre(["before.png"]);
    expectNoToasts();
  });
});
