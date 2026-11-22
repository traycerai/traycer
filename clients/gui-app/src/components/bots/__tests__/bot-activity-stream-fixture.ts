import {
  botSubscribeServerFrameSchema,
  type BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const HOST_ID = mockLocalHostEntry.hostId;

/** A task entry as a host sends it: every wire field, and no check-in history. */
export function wireTask(
  taskId: string,
  fields: Record<string, unknown>,
): object {
  return {
    taskId,
    cadence: { kind: "on-completion" },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: true,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
    ...fields,
  };
}

export function snapshotWith(
  tasks: ReadonlyArray<object>,
  notificationSubscriptions: ReadonlyArray<object> | null,
): BotSubscribeServerFrame {
  return botSubscribeServerFrameSchema.parse({
    kind: "snapshot",
    bot: {
      botId: BOT_ID,
      environmentId: "env-1",
      createdByUserId: "user-1",
      title: "Tracy",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: HOST_ID,
      hostEpoch: 0,
      createdAt: 1,
      archivedAt: null,
      directive: null,
      replyMode: "thread",
      appConversationChatId: null,
    },
    tasks,
    openRequestCount: 0,
    conversationsRevision: 1,
    notificationSubscriptions,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
    activity: null,
    hasBinaryPayload: false,
  });
}
