import type { SecretsNotificationDetail } from "@/lib/notifications/secrets-notification-detail";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

type ExportDetail = Extract<
  SecretsNotificationDetail,
  { kind: "export-minted" }
>;

export interface ChatSecretExportNotice {
  readonly feedId: string;
  readonly detail: ExportDetail;
}

/** The most notices one chat shows at once; the newest. */
export const CHAT_SECRET_EXPORT_NOTICE_LIMIT = 3;

/**
 * The short-lived exports an agent in THIS chat minted that are still live:
 * the notice a chat carries so that whoever is reading it knows a credential
 * left the gateway and works wherever it was copied, until its expiry.
 *
 * A notice ends when its export expires, or when its row is read in the
 * notification center - whichever comes first. Rows arrive newest first, and
 * that order is kept.
 */
export function chatSecretExportNotices(
  rows: readonly MergedNotificationRow[],
  chatId: string,
  now: number,
): readonly ChatSecretExportNotice[] {
  const notices: ChatSecretExportNotice[] = [];
  for (const row of rows) {
    if (notices.length === CHAT_SECRET_EXPORT_NOTICE_LIMIT) break;
    const detail = row.secrets ?? null;
    if (detail === null || detail.kind !== "export-minted") continue;
    if (row.readAt !== null || detail.expiresAt <= now) continue;
    if (row.payload === null || row.payload.kind !== "chat") continue;
    if (row.payload.chatId !== chatId) continue;
    notices.push({ feedId: row.feedId, detail });
  }
  return notices;
}
