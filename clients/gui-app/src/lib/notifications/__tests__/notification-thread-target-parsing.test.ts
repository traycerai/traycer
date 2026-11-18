import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationFeedEntry } from "@/stores/notifications/host-notifications-store";
import type { NotificationShowOutcome } from "@traycer-clients/shared/platform/runner-host";
import { displayNotificationRows } from "@/lib/notifications/notification-display";
import { parseNotificationActivationPayload } from "@/lib/notifications/notification-activation-envelope";
import type { NotificationPayload } from "@/lib/notifications/payload";
import { rowFromHostEntry } from "@/stores/notifications/merged-notifications";
import { EMPTY_DIRECTORY_STATE } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { activationPayloadFromPushData } from "../../../../../mobile/src/push-registration";
import type { NotificationShowRequest } from "@/hooks/notifications/use-notifications";

/**
 * A thread notification names its bot, thread and message the same way
 * whichever door the app is opened by: the operating system's notification
 * (an activation envelope the shell hands back as plain data), a mobile push,
 * or the in-app list. Each decodes to one target, or to none.
 */

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THREAD = "thread-1";
const REPLY = "reply-1";

const THREAD_TARGET = { botId: BOT_ID, threadId: THREAD, messageId: REPLY };

function replyEntry(): HostNotificationFeedEntry {
  return {
    id: "n-1",
    updatedAt: 10,
    readAt: null,
    kind: "host.operation.finished",
    sourceRef: "n-1",
    severity: "done",
    outcome: "completed",
    epicId: BOT_ID,
    chatId: THREAD,
    payload: {
      kind: "bot_conversation",
      event: "bot.reply",
      operation: "bot.reply",
      title: "Tracy",
      message: "A reply in the thread",
      botId: BOT_ID,
      conversationId: "conversation-main",
      threadId: THREAD,
      messageId: REPLY,
      authorUserId: null,
      mention: false,
    },
  };
}

/** The route a parsed activation opens, or `null` where it opens none. */
function routeOf(value: unknown): NotificationPayload | null {
  const parsed = parseNotificationActivationPayload(value);
  if (parsed.kind === "v1") return parsed.envelope.route;
  if (parsed.kind === "legacy") return parsed.payload;
  return null;
}

function botOf(route: NotificationPayload | null): unknown {
  return route !== null && route.kind === "chat" ? route.bot : undefined;
}

/** The raw route, as a flat or nested payload carries it. */
function chatRoute(extra: Record<string, unknown>): Record<string, unknown> {
  return { kind: "chat", epicId: BOT_ID, chatId: THREAD, ...extra };
}

beforeEach(() => {
  useStandaloneBotsStore.setState({ ...EMPTY_DIRECTORY_STATE, settled: true });
});

describe("a thread notification shown by the operating system", () => {
  it("hands back the bot, thread and message it was shown for", async () => {
    const shown: NotificationShowRequest[] = [];
    displayNotificationRows(
      [rowFromHostEntry(replyEntry())],
      {
        showNotification: vi.fn((input: NotificationShowRequest) => {
          shown.push(input);
          return Promise.resolve<NotificationShowOutcome>("presented");
        }),
        playChime: vi.fn(),
        onToastClick: vi.fn(),
        notifies: () => true,
      },
      null,
    );
    await vi.waitFor(() => {
      expect(shown).toHaveLength(1);
    });

    // The shell relays the payload as plain data.
    const handedBack: unknown = JSON.parse(JSON.stringify(shown[0].payload));
    const route = routeOf(handedBack);

    expect(botOf(route)).toEqual(THREAD_TARGET);
    expect(route).toMatchObject({ kind: "chat", chatId: THREAD });
  });
});

describe("a thread notification pushed to a phone", () => {
  it("decodes to the bot, thread and message it was sent for", () => {
    const route = routeOf(
      activationPayloadFromPushData({
        entryId: "entry-1",
        epicId: BOT_ID,
        chatId: THREAD,
        botId: BOT_ID,
        threadId: THREAD,
        messageId: REPLY,
      }),
    );

    expect(botOf(route)).toEqual(THREAD_TARGET);
  });
});

describe("a raw chat route naming a thread message", () => {
  it.each([
    ["nested", chatRoute({ bot: THREAD_TARGET })],
    ["flat", chatRoute(THREAD_TARGET)],
    [
      "nested and flat that agree",
      chatRoute({ bot: THREAD_TARGET, ...THREAD_TARGET }),
    ],
  ])("keeps the whole target when it is %s", (_name, raw) => {
    expect(botOf(routeOf(raw))).toEqual(THREAD_TARGET);
  });

  it.each([
    [
      "nested and flat name different threads",
      chatRoute({ bot: THREAD_TARGET, ...THREAD_TARGET, threadId: "thread-2" }),
    ],
    [
      "nested and flat name different messages",
      chatRoute({ bot: THREAD_TARGET, ...THREAD_TARGET, messageId: "reply-2" }),
    ],
    [
      "nested and flat name different bots",
      chatRoute({ bot: THREAD_TARGET, ...THREAD_TARGET, botId: "bot-other" }),
    ],
    ["the nested target is not an object", chatRoute({ bot: "bot-1" })],
    [
      "the nested bot id is not a string",
      chatRoute({ bot: { ...THREAD_TARGET, botId: 42 } }),
    ],
    [
      "the nested thread id is not a string",
      chatRoute({ bot: { ...THREAD_TARGET, threadId: 7 } }),
    ],
    [
      "the flat thread id is not a string",
      chatRoute({ ...THREAD_TARGET, threadId: 7 }),
    ],
    [
      "the nested message id is not a string",
      chatRoute({ bot: { ...THREAD_TARGET, messageId: 7 } }),
    ],
    ["the nested target is explicitly null", chatRoute({ bot: null })],
    [
      "the flat bot id is explicitly null",
      chatRoute({ ...THREAD_TARGET, botId: null }),
    ],
    [
      "the nested bot id is empty",
      chatRoute({ bot: { ...THREAD_TARGET, botId: "" } }),
    ],
    [
      "the nested thread id is empty",
      chatRoute({ bot: { ...THREAD_TARGET, threadId: "" } }),
    ],
    [
      "the nested message id is empty",
      chatRoute({ bot: { ...THREAD_TARGET, messageId: "" } }),
    ],
    [
      "the flat thread id is empty",
      chatRoute({ ...THREAD_TARGET, threadId: "" }),
    ],
    [
      "the nested target lacks its bot id",
      chatRoute({ bot: { threadId: THREAD, messageId: REPLY } }),
    ],
    [
      "the nested target lacks its thread field",
      chatRoute({ bot: { botId: BOT_ID, messageId: REPLY } }),
    ],
    [
      "the nested target lacks its message field",
      chatRoute({ bot: { botId: BOT_ID, threadId: THREAD } }),
    ],
    [
      "the thread has no message to land on",
      chatRoute({ bot: { ...THREAD_TARGET, messageId: null } }),
    ],
    [
      "the flat thread has no message to land on",
      chatRoute({ botId: BOT_ID, threadId: THREAD }),
    ],
  ])(
    "opens no route when %s, rather than a chat the target was dropped from",
    (_name, raw) => {
      expect(routeOf(raw)).toBeNull();
    },
  );

  it("keeps a channel row, which names no thread, as a channel target", () => {
    expect(
      botOf(
        routeOf(
          chatRoute({
            bot: { botId: BOT_ID, threadId: null, messageId: "post-1" },
          }),
        ),
      ),
    ).toEqual({ botId: BOT_ID, threadId: null, messageId: "post-1" });
  });

  it("leaves a chat route that names no bot as the chat it names", () => {
    expect(routeOf(chatRoute({ messageId: "message-1" }))).toEqual({
      kind: "chat",
      epicId: BOT_ID,
      chatId: THREAD,
      messageId: "message-1",
    });
  });
});
