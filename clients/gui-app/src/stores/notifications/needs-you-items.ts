import { useMemo } from "react";
import {
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationEntryV22,
  type HostNotificationsCloudFeedRowV11,
} from "@traycer/protocol/host/notifications/contracts";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { useHostNotificationsStore } from "@/stores/notifications/host-notifications-store";
import {
  useMergedNotificationRows,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";

/** What an agent is waiting on the person for. */
export type NeedsYouReason = "approval" | "reply";

/**
 * One agent prompt waiting on the person: the Notifications drawer's Needs you group, its
 * count, and the Activity view's Needs you block all read this (D10).
 */
export interface NeedsYouItem {
  /** The notification row behind the item; activating it opens the chat. */
  readonly row: MergedNotificationRow;
  readonly reason: NeedsYouReason;
  readonly ask: string;
  readonly taskTitle: string;
  readonly agentTitle: string | null;
  readonly createdAt: number;
}

const ASK_BY_REASON: Readonly<Record<NeedsYouReason, string>> = {
  approval: "Approval requested",
  reply: "Question waiting",
};

/**
 * The rows that light `pendingApproval` / `pendingInterview`: an agent
 * approval or interview whose prompt is not yet resolved, read or not - the
 * host's indicator SQL and `indicatorContribution` key on resolution alone.
 * Browser prompts belong to their browser tab and are not agent asks.
 *
 * An approval an auto-judge is still reviewing never reaches here: the host
 * files no notification until the judge escalates it (S-41).
 */
export function needsYouReasonOf(
  row: MergedNotificationRow,
): NeedsYouReason | null {
  if (row.resolvedAt !== null) return null;
  if (row.hostKind === "approval.requested") return "approval";
  if (row.hostKind === "interview.requested") return "reply";
  return null;
}

/**
 * The task a prompt belongs to: the epic its notification payload names, or
 * `null` when the payload names none (an approval may carry no epic).
 */
export function needsYouItemEpicId(item: NeedsYouItem): string | null {
  const payload = item.row.payload;
  if (payload?.kind === "approval" || payload?.kind === "interview") {
    return payload.epicId ?? null;
  }
  return null;
}

/** The chat a prompt belongs to, or `null` when its payload names none. */
export function needsYouItemChatId(item: NeedsYouItem): string | null {
  const payload = item.row.payload;
  if (payload?.kind === "approval" || payload?.kind === "interview") {
    return payload.chatId ?? null;
  }
  return null;
}

/**
 * The prompts grouped by the task they belong to, in the order given. An item
 * that names no task is in no group. The strip's task rows read their
 * prompts through this.
 */
export function groupNeedsYouByEpic(
  items: ReadonlyArray<NeedsYouItem>,
): ReadonlyMap<string, ReadonlyArray<NeedsYouItem>> {
  const byEpic = new Map<string, NeedsYouItem[]>();
  for (const item of items) {
    const epicId = needsYouItemEpicId(item);
    if (epicId === null) continue;
    const group = byEpic.get(epicId);
    if (group === undefined) byEpic.set(epicId, [item]);
    else group.push(item);
  }
  return byEpic;
}

/** The chat title a prompt entry carries, for the item's "task · agent" line. */
function agentTitleOfEntry(entry: HostNotificationEntryV22): string | null {
  const known = parseKnownHostNotificationPayloadForKind(
    entry.kind,
    entry.payload,
  );
  if (known === null) return null;
  if (known.kind !== "approval" && known.kind !== "interview") return null;
  return known.chatTitle.length > 0 ? known.chatTitle : null;
}

function cloudAgentTitle(
  row: HostNotificationsCloudFeedRowV11 | undefined,
): string | null {
  if (row === undefined) return null;
  const title = row.presentation.chatTitle;
  return title !== null && title.length > 0
    ? title
    : agentTitleOfEntry(row.entry);
}

export function selectNeedsYouItems(
  rows: ReadonlyArray<MergedNotificationRow>,
  agentTitleOf: (row: MergedNotificationRow) => string | null,
): ReadonlyArray<NeedsYouItem> {
  const items: NeedsYouItem[] = [];
  for (const row of rows) {
    const reason = needsYouReasonOf(row);
    if (reason === null) continue;
    items.push({
      row,
      reason,
      ask: ASK_BY_REASON[reason],
      taskTitle: row.title,
      agentTitle: agentTitleOf(row),
      createdAt: row.createdAt,
    });
  }
  return items;
}

/**
 * Every prompt waiting on the person, newest first (the merged feed's order).
 * One item per chat and kind: the host keys a prompt row per chat.
 */
export function useNeedsYouItems(): ReadonlyArray<NeedsYouItem> {
  const rows = useMergedNotificationRows();
  const hostById = useHostNotificationsStore((state) => state.byId);
  const cloudRows = useCloudNotificationsStore((state) => state.rows);
  return useMemo(
    () =>
      selectNeedsYouItems(rows, (row) => {
        // The cloud store keys its rows by feed id, not the bare entry id.
        if (row.source === "cloud")
          return cloudAgentTitle(cloudRows[row.feedId]);
        // A merged row can outlive its store entry for one render.
        return Object.hasOwn(hostById, row.sourceId)
          ? agentTitleOfEntry(hostById[row.sourceId])
          : null;
      }),
    [rows, hostById, cloudRows],
  );
}
