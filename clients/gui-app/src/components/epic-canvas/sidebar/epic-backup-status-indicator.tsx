import { CircleAlert, CloudUpload } from "lucide-react";
import type {
  ChatBackupHaltCause,
  ChatBackupStatusRow,
} from "@traycer/protocol/host/epic/chat-backup-status";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useRelativeTimestamp } from "@/lib/relative-time";

export interface EpicBackupStatusIndicatorProps {
  readonly epicId: string;
}

/**
 * Quiet local publication health, shown only when somebody can act on it.
 *
 * Scoped to the host that owns the surrounding Epic SESSION, not to the app-wide
 * active host. The two differ whenever a retained Epic tab is bound to one host
 * while another is active, and `epic.chatBackupStatus` is a question about THIS
 * Epic's publisher: asked of the wrong machine it either hides the bound host's
 * halted backup or reports a status for a task that host is not running. Same
 * contract every other sidebar RPC follows - the sidebar is a sibling of the
 * canvas, outside every tile `TabHostProvider`, so it reads the session's host.
 */
export function EpicBackupStatusIndicator(
  props: EpicBackupStatusIndicatorProps,
) {
  const client = useHostClientForHostId(useEpicSessionHostId());
  if (client === null) return null;
  return <BoundEpicBackupStatusIndicator {...props} client={client} />;
}

function BoundEpicBackupStatusIndicator(
  props: EpicBackupStatusIndicatorProps & {
    readonly client: HostRequester<HostRpcRegistry>;
  },
) {
  const { client } = props;
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
  const behind = chats.filter((chat) => chat.status === "behind");
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
        cause === "conflict" || cause === "too-large" || cause === "escalation",
    )
  ) {
    return "Backup failing";
  }
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
  return "Backup paused by plan";
}
