import { parseKnownHostNotificationPayloadForKind } from "@traycer/protocol/host/notifications/contracts";
import type { HostNotificationFeedEntry } from "@/stores/notifications/host-notifications-store";
import { compareFeedIdAscending } from "@/lib/notifications/notification-lifecycle";
import type { NotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

export interface BotNotificationMessage {
  readonly botId: string;
  readonly destination: {
    readonly kind: "thread" | "conversation";
    readonly id: string;
  };
  readonly messageId: string;
}

export interface NotificationPresentation {
  readonly key: string;
  readonly row: MergedNotificationRow;
  readonly members: ReadonlyArray<MergedNotificationRow>;
  readonly group: {
    readonly kind: "thread" | "conversation";
    readonly messageCount: number;
    readonly unreadCount: number;
  } | null;
}

export function botNotificationMessage(
  entry: Pick<
    HostNotificationFeedEntry,
    "kind" | "outcome" | "severity" | "payload"
  >,
): BotNotificationMessage | null {
  if (
    entry.kind !== "host.operation.finished" ||
    entry.outcome !== "completed" ||
    (entry.severity !== "done" && entry.severity !== "info")
  )
    return null;
  const payload = parseKnownHostNotificationPayloadForKind(
    entry.kind,
    entry.payload,
  );
  if (payload?.kind === "bot_thread_verdict") {
    return {
      botId: payload.botId,
      destination: { kind: "thread", id: payload.threadId },
      messageId: payload.replyMessageId,
    };
  }
  if (
    payload?.kind !== "bot_conversation" ||
    operationForEvent(payload.event) !== payload.operation
  )
    return null;
  return {
    botId: payload.botId,
    destination:
      payload.threadId === null
        ? { kind: "conversation", id: payload.conversationId }
        : { kind: "thread", id: payload.threadId },
    messageId: payload.messageId,
  };
}

function operationForEvent(event: string): string | null {
  switch (event) {
    case "reply":
      return "bot.reply";
    case "verdict":
    case "directAnswer":
      return "bot.thread.verdict";
    case "announcement":
      return "bot.announcement";
    case "post":
      return "bot.post";
    default:
      return null;
  }
}

export interface NotificationGroupScope {
  readonly accountId: string | null;
  readonly feedMode: NotificationFeedMode;
  readonly cloudEpoch: number;
  readonly localHostId: string | null;
  readonly localEpoch: number;
}

/** Presentation keys stay independent of the newest member and of its read mark. */
export function foldNotificationGroups(
  rows: ReadonlyArray<MergedNotificationRow>,
  scope: NotificationGroupScope,
): ReadonlyArray<NotificationPresentation> {
  const groups = new Map<string, MergedNotificationRow[]>();
  for (const row of rows) {
    const message = row.botMessage ?? null;
    const generation =
      row.source === "cloud"
        ? scope.cloudEpoch
        : [scope.localHostId, scope.localEpoch];
    const key =
      message === null
        ? row.feedId
        : JSON.stringify([
            "notification-group",
            scope.accountId,
            scope.feedMode,
            row.source,
            generation,
            message.botId,
            message.destination.kind,
            message.destination.id,
          ]);
    const members = groups.get(key);
    if (members === undefined) groups.set(key, [row]);
    else members.push(row);
  }
  return [...groups].map(([key, members]) => presentGroup(key, members));
}

function presentGroup(
  key: string,
  members: MergedNotificationRow[],
): NotificationPresentation {
  members.sort(
    (a, b) =>
      b.createdAt - a.createdAt || compareFeedIdAscending(a.feedId, b.feedId),
  );
  const latest = members[0];
  const message = latest.botMessage ?? null;
  if (message === null) return { key, row: latest, members, group: null };
  const messages = new Set<string>();
  const unreadMessages = new Set<string>();
  for (const member of members) {
    const id = member.botMessage?.messageId;
    if (id === undefined) continue;
    messages.add(id);
    if (member.readAt === null) unreadMessages.add(id);
  }
  return {
    key,
    row: {
      ...latest,
      readAt: unreadMessages.size > 0 ? null : latest.readAt,
      botAnswer: members.some(
        (member) => member.readAt === null && member.botAnswer === true,
      ),
    },
    members,
    group: {
      kind: message.destination.kind,
      messageCount: messages.size,
      unreadCount: unreadMessages.size,
    },
  };
}

const GROUP_LABELS = {
  thread: { title: "Thread", one: "reply", many: "replies" },
  conversation: { title: "Channel", one: "message", many: "messages" },
};

export function notificationGroupTitle(
  kind: "thread" | "conversation",
): string {
  return GROUP_LABELS[kind].title;
}

export function notificationGroupCount(
  group: NonNullable<NotificationPresentation["group"]>,
): string {
  const words = GROUP_LABELS[group.kind];
  const count = `${group.messageCount} ${group.messageCount === 1 ? words.one : words.many}`;
  return group.unreadCount === 0
    ? count
    : `${count} · ${group.unreadCount} unread`;
}
