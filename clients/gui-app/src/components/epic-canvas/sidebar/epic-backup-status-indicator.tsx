import { CircleAlert, CloudUpload } from "lucide-react";
import type {
  ChatBackupHaltCause,
  ChatBackupStatusRow,
} from "@traycer/protocol/host/epic/chat-backup-status";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useRelativeTimestamp } from "@/lib/relative-time";

export interface EpicBackupStatusIndicatorProps {
  readonly epicId: string;
}

/** Quiet local publication health, shown only when somebody can act on it. */
export function EpicBackupStatusIndicator(
  props: EpicBackupStatusIndicatorProps,
) {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.chatBackupStatus",
    params: { epicId: props.epicId },
    options: { poll: true },
  });

  if (!readiness.isReady || query.data === undefined) return null;
  const view = backupStatusView(query.data.chats);
  if (view === null) return null;

  const Icon = view.halted ? CircleAlert : CloudUpload;
  return (
    <div
      className="flex w-full items-start gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-foreground/80">{view.label}</div>
        {view.behindCount > 0 ? (
          <div>
            {view.behindCount === 1
              ? "1 chat not backed up"
              : `${view.behindCount} chats not backed up`}
            {view.lastPublishedAt === null ? (
              " · never backed up"
            ) : (
              <LastBackupTimestamp timestamp={view.lastPublishedAt} />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LastBackupTimestamp(props: { readonly timestamp: number }) {
  const relative = useRelativeTimestamp(props.timestamp);
  return <> · last backup {relative.toLowerCase()}</>;
}

interface BackupStatusView {
  readonly halted: boolean;
  readonly label: string;
  readonly behindCount: number;
  readonly lastPublishedAt: number | null;
}

function backupStatusView(
  chats: readonly ChatBackupStatusRow[],
): BackupStatusView | null {
  const halted = chats.filter((chat) => chat.halted !== null);
  const behind = chats.filter((chat) => !chat.upToDate);
  if (halted.length === 0 && behind.length === 0) return null;

  const lastPublished = behind
    .map((chat) => chat.lastPublishedAt)
    .filter((timestamp): timestamp is number => timestamp !== null);
  return {
    halted: halted.length > 0,
    label:
      halted.length === 0
        ? "Chat backup behind"
        : labelForHaltCauses(
            halted.map((chat) => chat.halted?.cause).filter(isHaltCause),
          ),
    behindCount: behind.length,
    lastPublishedAt:
      lastPublished.length === 0 ? null : Math.max(...lastPublished),
  };
}

function isHaltCause(
  cause: ChatBackupHaltCause | undefined,
): cause is ChatBackupHaltCause {
  return cause !== undefined;
}

function labelForHaltCauses(causes: readonly ChatBackupHaltCause[]): string {
  if (
    causes.some(
      (cause) =>
        cause === "quarantined" ||
        cause === "repair-pending" ||
        cause === "forked-lineage",
    )
  ) {
    return "Backup paused on a fork decision";
  }
  if (
    causes.some(
      (cause) =>
        cause === "conflict" ||
        cause === "too-large" ||
        cause === "escalation",
    )
  ) {
    return "Backup failing";
  }
  return "Backup paused by plan";
}
