import { useSyncExternalStore } from "react";
import type {
  ChatBackupHaltCause,
  ChatBackupStatusRow,
} from "@traycer/protocol/host/epic/chat-backup-status";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useRegisteredEpicActiveAgentIds } from "@/lib/epic-selectors";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export interface EpicChatBackupStatus {
  readonly severity: "activity" | "warning";
  readonly tooltip: string;
  readonly ariaLabel: string;
}

/**
 * How long a chat may sit untouched while its backup is behind before that lag stops being expected.
 * Past that there is no benign explanation left - and the user is still inside the session the chat was written in, which is the only time the warning is something they can act on.
 */
const IDLE_BACKUP_ALARM_MS = 45 * 60_000;

/**
 * So the alarm copy fired for the whole time the user watched a chat being created, which is noise rather than signal.
 * Each behind row is therefore classified locally before anything is aggregated: - working right now, or written inside {@link IDLE_BACKUP_ALARM_MS} - the publisher is doing its job, and the row renders as a neutral "Backing up…". - untouched for longer - the debounce has had every chance to fire and the receipt still has not moved, so it renders the warning it always did.
 */
export function useEpicChatBackupStatus(
  epicId: string,
): EpicChatBackupStatus | null {
  const client = useHostClientForHostId(useEpicSessionHostId());
  const readiness = useReactiveHostReadiness(client);
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.chatBackupStatus",
    params: { epicId },
    options: { poll: true },
  });
  const workingChatIds = useRegisteredEpicActiveAgentIds(epicId);
  const chatsById = useEpicChatProjections(epicId);
  // The shared 60s clock, so a chat that crosses the idle threshold while the Task is open starts alarming on the next tick rather than waiting for whatever re-renders this component next.
  const now = useSampledNow();

  if (!readiness.isReady || query.data === undefined) return null;
  const view = backupStatusView(query.data.chats, {
    workingChatIds,
    chatsById,
    now,
  });
  return view === null ? null : statusFromView(view, now);
}

const NO_CHATS: ChatsSlice["byId"] = Object.freeze({});

/**
 * Resolved through the session REGISTRY rather than a throwing handle accessor so the explicit `epicId` remains safe while a retained pane is tearing down.
 * The projector already gives that record a stable identity - it is rebuilt only when a chat record actually changes - which is exactly the snapshot contract `useSyncExternalStore` needs.
 */
function useEpicChatProjections(epicId: string): ChatsSlice["byId"] {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.peek(epicId),
    () => null,
  );
  return useSyncExternalStore(
    (listener) =>
      handle === null ? () => undefined : handle.store.subscribe(listener),
    () => (handle === null ? NO_CHATS : handle.store.getState().chats.byId),
    () => NO_CHATS,
  );
}

/** The local evidence a `behind` row is classified against. */
interface BackupActivityEvidence {
  /** Host-published activity for this epic, unioned across every host. */
  readonly workingChatIds: ReadonlySet<string>;
  readonly chatsById: ChatsSlice["byId"];
  readonly now: number;
}

interface BackupStatusView {
  readonly severity: EpicChatBackupStatus["severity"];
  readonly label: string;
  /** Behind chats whose lag the publisher can no longer explain. */
  readonly staleCount: number;
  readonly lastPublishedAt: number | null;
}

/**
 * Whether this chat's publication lag is the publisher working rather than the publisher stuck.
 * A chat that is idle but was written recently is inside the publisher's own debounce - and after the app reopens, the working set is empty for a chat that quiesced a minute ago, so `updatedAt` is the only thing left that can tell "quiet for a minute" from "quiet for a day".
 */
function isSettling(
  row: ChatBackupStatusRow,
  evidence: BackupActivityEvidence,
): boolean {
  if (evidence.workingChatIds.has(row.chatId)) return true;
  const touchedAt = Math.max(
    Object.hasOwn(evidence.chatsById, row.chatId)
      ? evidence.chatsById[row.chatId].updatedAt
      : 0,
    row.lastPublishedAt ?? 0,
  );
  // No local recency evidence at all - an epic with no mounted projection and a chat that has never published.
  if (touchedAt === 0) return false;
  return evidence.now - touchedAt < IDLE_BACKUP_ALARM_MS;
}

function backupStatusView(
  chats: readonly ChatBackupStatusRow[],
  evidence: BackupActivityEvidence,
): BackupStatusView | null {
  const halted = chats.filter((chat) => chat.halted !== null);
  const behind = chats.filter((chat) => chat.status === "behind");
  if (halted.length === 0 && behind.length === 0) return null;

  // A halted chat is never settling, however recently it was written: the
  // publisher has stopped, so the gap is owed rather than pending.
  const stale = behind.filter(
    (chat) => chat.halted !== null || !isSettling(chat, evidence),
  );
  if (halted.length === 0 && stale.length === 0) {
    // The row still renders, because "your work is being copied off this machine" is worth saying - but it says only that, with no count of chats to be alarmed about and no timestamp implying the last backup is late.
    return {
      severity: "activity",
      label: "Backing up…",
      staleCount: 0,
      lastPublishedAt: null,
    };
  }

  const lastPublished = stale
    .map((chat) => chat.lastPublishedAt)
    .filter((timestamp): timestamp is number => timestamp !== null);
  return {
    severity: "warning",
    label:
      halted.length === 0
        ? "Chat backup behind"
        : labelForHaltCauses(
            halted.map((chat) => chat.halted?.cause).filter(isHaltCause),
          ),
    staleCount: stale.length,
    lastPublishedAt:
      lastPublished.length === 0 ? null : Math.max(...lastPublished),
  };
}

function statusFromView(
  view: BackupStatusView,
  now: number,
): EpicChatBackupStatus {
  if (view.severity === "activity") {
    return {
      severity: "activity",
      tooltip: "Backing up chats",
      ariaLabel: "Backing up chats",
    };
  }

  const count = chatCountSuffix(view.staleCount);
  const lastBackup = lastBackupSuffix(
    view.staleCount,
    view.lastPublishedAt,
    now,
  );
  const message = `${view.label}${count}${lastBackup}`;
  return {
    severity: "warning",
    tooltip: message,
    ariaLabel: message,
  };
}

function chatCountSuffix(staleCount: number): string {
  if (staleCount === 0) {
    return "";
  }
  if (staleCount === 1) {
    return " · 1 chat not backed up";
  }
  return ` · ${staleCount} chats not backed up`;
}

function lastBackupSuffix(
  staleCount: number,
  lastPublishedAt: number | null,
  now: number,
): string {
  if (staleCount === 0) {
    return "";
  }
  if (lastPublishedAt === null) {
    return " · never backed up";
  }
  return ` · last backup ${formatRelativeTimestamp(
    lastPublishedAt,
    now,
  ).toLowerCase()}`;
}

function isHaltCause(
  cause: ChatBackupHaltCause | undefined,
): cause is ChatBackupHaltCause {
  return cause !== undefined;
}

/** Copy for a halt, and only ever for a halt the HOST reported (`row.halted !== null`). */
function labelForHaltCauses(causes: readonly ChatBackupHaltCause[]): string {
  if (causes.some((cause) => cause === "conflict" || cause === "escalation")) {
    return "Chat backup failing";
  }
  if (causes.some((cause) => cause === "too-large")) {
    return "Chat backup stopped: chat too large";
  }
  if (
    causes.some(
      (cause) =>
        cause === "quarantined" ||
        cause === "repair-pending" ||
        cause === "forked-lineage",
    )
  ) {
    return "Chat backup paused on a fork decision";
  }
  return "Chat backup paused by plan";
}
