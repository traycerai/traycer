import type { ReactNode } from "react";
import {
  secretExportNotice,
  type SecretsNotificationDetail,
} from "@/lib/notifications/secrets-notification-detail";

/**
 * The line an export carries, on its notification row and above the composer
 * of the chat whose agent minted it: what was minted and that it works until
 * its expiry wherever it is copied.
 */
export function SecretExportNoticeLine(props: {
  readonly detail: Extract<
    SecretsNotificationDetail,
    { kind: "export-minted" }
  >;
}): ReactNode {
  return (
    <p
      data-testid="secret-export-notice"
      className="text-ui-xs break-words text-muted-foreground"
    >
      {secretExportNotice(props.detail, formatExportExpiry)}
    </p>
  );
}

/** "Oct 12, 14:32": a date as well, since an export can outlive the day. */
function formatExportExpiry(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
