import { useSyncExternalStore } from "react";
import type {
  ChatBackupHaltCause,
  ChatBackupStatusRow,
} from "@traycer/protocol/host/epic/chat-backup-status";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  useEpicChatBackupHasNoCloudTask,
  useRegisteredEpicActiveAgentIds,
} from "@/lib/epic-selectors";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export interface EpicChatBackupStatus {
  readonly severity: "activity" | "warning";
  readonly tooltip: string;
  readonly ariaLabel: string;
}

/**
 * How long a chat may sit untouched while its backup is behind before that lag
 * stops being expected.
 *
 * The publisher DEBOUNCES. It waits for a chat to go quiet and publishes
 * roughly fifteen minutes later, which means a chat reads `behind` for the
 * entire time the user is watching an agent write it. Treating that as "not
 * backed up" fired the warning at exactly the moment nothing was wrong, and the
 * same debounce sets this constant's floor: any threshold at or below fifteen
 * minutes re-creates that alarm one step further along.
 *
 * Forty-five minutes is three of those windows. The first is the wait itself,
 * the second covers a sweep the publisher skipped or backed off from, and the
 * third covers a tail large enough to need more than one pass. Past that there
 * is no benign explanation left - and the user is still inside the session the
 * chat was written in, which is the only time the warning is something they can
 * act on.
 */
const IDLE_BACKUP_ALARM_MS = 45 * 60_000;

/**
 * Local chat-publication health for the Epic header's shared status dot.
 *
 * Scoped to the host that owns the surrounding Epic SESSION, not to the app-wide
 * active host. The two differ whenever a retained Epic tab is bound to one host
 * while another is active, and `epic.chatBackupStatus` is a question about THIS
 * Epic's publisher: asked of the wrong machine it either hides the bound host's
 * halted backup or reports a status for a task that host is not running. Same
 * contract every pane-level RPC follows: the header is outside every tile
 * `TabHostProvider`, so it reads the Epic session's host.
 *
 * ## `behind` is two states wearing one name
 *
 * The host reports `behind` whenever its durable store is ahead of its
 * publication receipt, and that is true of every chat an agent is currently
 * writing - the publisher deliberately waits for a chat to quiesce first. So
 * the alarm copy fired for the whole time the user watched a chat being
 * created, which is noise rather than signal.
 *
 * Each behind row is therefore classified locally before anything is
 * aggregated:
 *
 * - working right now, or written inside {@link IDLE_BACKUP_ALARM_MS} - the
 *   publisher is doing its job, and the row renders as a neutral
 *   "Backing up…".
 * - untouched for longer - the debounce has had every chance to fire and the
 *   receipt still has not moved, so it renders the warning it always did.
 *
 * Both signals are LOCAL and already on this machine (host-published agent
 * activity for the epic, and the chat projection's own `updatedAt`). No new
 * host round trip was added for the distinction.
 */
export function useEpicChatBackupStatus(
  epicId: string,
): EpicChatBackupStatus | null {
  const client = useHostClientForHostId(useEpicSessionHostId());
  const readiness = useReactiveHostReadiness(client);
  // A local-homed (or mid-promotion) epic has no cloud task to back chats up
  // into, so every chat is honestly `behind` forever - a by-design state, not
  // the actionable failure this indicator exists to surface. Read from the
  // open epic's own stream (the session provider keeps it live), so promotion
  // completing reveals the indicator without a refetch race. The query is
  // disabled rather than the result discarded: there is nothing worth polling
  // for while the answer is known to be structural.
  const noCloudTask = useEpicChatBackupHasNoCloudTask();
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.chatBackupStatus",
    params: { epicId },
    options: { poll: true, enabled: !noCloudTask },
  });
  const workingChatIds = useRegisteredEpicActiveAgentIds(epicId);
  const chatsById = useEpicChatProjections(epicId);
  // The shared 60s clock, so a chat that crosses the idle threshold while the
  // Task is open starts alarming on the next tick rather than waiting for
  // whatever re-renders this component next.
  const now = useSampledNow();

  if (noCloudTask) return null;
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
 * Every chat record this window currently projects for the epic, or an empty
 * map when it holds no session for it.
 *
 * Resolved through the session REGISTRY rather than a throwing handle accessor
 * so the explicit `epicId` remains safe while a retained pane is tearing down.
 *
 * `chats.byId` is handed back as-is. The projector already gives that record a
 * stable identity - it is rebuilt only when a chat record actually changes -
 * which is exactly the snapshot contract `useSyncExternalStore` needs. It also
 * carries the `updatedAt` the projection bumps on every message, unlike the
 * tree node's deliberately lagging copy (see `useEpicNodeUpdatedAt`).
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
 * Whether this chat's publication lag is the publisher working rather than the
 * publisher stuck.
 *
 * Two facts qualify, and the second is what makes the first survive a restart.
 * A chat in the epic's working set is being written right now, so of course the
 * receipt trails it. A chat that is idle but was written recently is inside the
 * publisher's own debounce - and after the app reopens, the working set is
 * empty for a chat that quiesced a minute ago, so `updatedAt` is the only thing
 * left that can tell "quiet for a minute" from "quiet for a day".
 *
 * `lastPublishedAt` counts as recency too: a receipt that moved recently is
 * direct proof the pipeline is alive for this chat, whatever the projection has
 * to say.
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
  // No local recency evidence at all - an epic with no mounted projection and a
  // chat that has never published. Nothing here says the lag is expected, so it
  // is not claimed to be.
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
    // Everything behind is behind on purpose. The row still renders, because
    // "your work is being copied off this machine" is worth saying - but it
    // says only that, with no count of chats to be alarmed about and no
    // timestamp implying the last backup is late.
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

/**
 * Copy for a halt, and only ever for a halt the HOST reported
 * (`row.halted !== null`). Nothing this component infers gets to borrow this
 * vocabulary - a chat the client classified as stale says "behind", because
 * behind is all the host claimed.
 *
 * `too-large` no longer sits with the other failures. The publisher used to
 * stop dead on a chat above its pre-encode ceiling; it now publishes the
 * largest prefix that fits and reports the remainder as ordinary `behind`. So a
 * `too-large` HALT now means something narrower, and worth naming: the host
 * could not read the chat's owner out of any prefix of it either, which leaves
 * nothing to publish and no retry that would change the answer. Still an alarm,
 * because a halt is still a halt - but "Backup failing" read as a transient
 * upload problem the user could wait out, and this one they cannot.
 */
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
