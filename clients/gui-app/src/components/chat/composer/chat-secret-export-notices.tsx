import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { SecretExportNoticeLine } from "@/components/notifications/secret-export-notice-line";
import { chatSecretExportNotices } from "@/lib/notifications/chat-secret-export-notices";
import { useSampledNow } from "@/lib/relative-time";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";

/**
 * One line per short-lived export an agent in this chat minted and that is
 * still live (`chatSecretExportNotices`), above the composer: what was
 * exported, its expiry, and that it works until then wherever it is copied.
 * Nothing for a chat with none.
 */
export function ChatSecretExportNotices(props: {
  readonly chatId: string;
}): ReactNode {
  const rows = useMergedNotificationRows();
  const now = useSampledNow();
  const notices = chatSecretExportNotices(rows, props.chatId, now);
  if (notices.length === 0) return null;
  return (
    <ul
      className="mb-2 flex flex-col gap-1"
      data-testid="chat-secret-export-notices"
    >
      {notices.map((notice) => (
        <li
          key={notice.feedId}
          className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-2 py-1.5"
        >
          <KeyRound
            className="mt-0.5 size-3.5 shrink-0 text-info-foreground"
            aria-hidden
          />
          <SecretExportNoticeLine detail={notice.detail} />
        </li>
      ))}
    </ul>
  );
}
