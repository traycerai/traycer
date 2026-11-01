import type { NotificationPayload } from "@/lib/notifications/payload";

/** The bot a row is about (its conversation's own kinds), `null` for any other. */
export function notificationRowBotId(row: {
  readonly payload: NotificationPayload | null;
}): string | null {
  return row.payload?.kind === "chat" ? (row.payload.bot?.botId ?? null) : null;
}
