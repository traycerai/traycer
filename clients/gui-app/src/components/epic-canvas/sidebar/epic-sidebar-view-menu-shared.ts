/**
 * The option sets and label text behind the Agents / Artifacts view menus.
 *
 * Everything here is data or a pure string builder, kept apart from the menu
 * components so the sidebar's nested desktop menu and the mobile switcher's
 * flat one offer the same choices in the same order and describe the resulting
 * view with the same words. A surface that reworded a summary - or listed its
 * facet values in a different order - would be describing a different view than
 * the one the shared store actually holds.
 */
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import {
  SORT_DIRECTION,
  SORT_FIELD_LABELS,
  type SortMode,
} from "@/lib/epic-sort";
import {
  ARTIFACT_READ,
  ARTIFACT_STATUS,
  CHAT_ARCHIVE_VISIBILITY,
  CHAT_ORIGIN,
  CHAT_OWNERSHIP,
  isSortModeActive,
  type ArtifactReadFilter,
  type ArtifactStatusFilter,
  type ChatArchiveVisibility,
  type ChatOriginFilter,
  type ChatOwnershipFilter,
} from "@/stores/epics/left-panel-store";

/** The facets an Agents view menu can offer. */
export type ChatViewDetail = "ordering" | "show" | "interface" | "ownership";
/** The facets an Artifacts view menu can offer. */
export type ArtifactViewDetail = "ordering" | "status" | "type" | "read";

export const CHAT_DETAIL_LABELS: Readonly<Record<ChatViewDetail, string>> = {
  ordering: "Ordering",
  show: "Show",
  interface: "Interface",
  ownership: "Ownership",
};

export const ARTIFACT_DETAIL_LABELS: Readonly<
  Record<ArtifactViewDetail, string>
> = {
  ordering: "Ordering",
  status: "Status",
  type: "Type",
  read: "Read state",
};

export const CHAT_ORIGIN_OPTIONS: ReadonlyArray<{
  readonly value: ChatOriginFilter;
  readonly label: string;
}> = [
  { value: CHAT_ORIGIN.All, label: "All" },
  { value: CHAT_ORIGIN.Gui, label: "Chat" },
  { value: CHAT_ORIGIN.Tui, label: "Terminal" },
];

export const CHAT_OWNERSHIP_OPTIONS: ReadonlyArray<{
  readonly value: ChatOwnershipFilter;
  readonly label: string;
}> = [
  { value: CHAT_OWNERSHIP.All, label: "All" },
  { value: CHAT_OWNERSHIP.Mine, label: "Mine" },
  { value: CHAT_OWNERSHIP.Others, label: "Others" },
];

export const CHAT_ARCHIVE_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: ChatArchiveVisibility;
  readonly label: string;
}> = [
  {
    value: CHAT_ARCHIVE_VISIBILITY.Unarchived,
    label: "Unarchived only",
  },
  { value: CHAT_ARCHIVE_VISIBILITY.Archived, label: "Archived only" },
  { value: CHAT_ARCHIVE_VISIBILITY.All, label: "All chats" },
];

export function archiveVisibilityLabel(
  visibility: ChatArchiveVisibility,
): string {
  return (
    CHAT_ARCHIVE_VISIBILITY_OPTIONS.find(
      (option) => option.value === visibility,
    )?.label ?? "Unarchived only"
  );
}

export const ARTIFACT_STATUS_OPTIONS: ReadonlyArray<ArtifactStatusFilter> = [
  ARTIFACT_STATUS.Todo,
  ARTIFACT_STATUS.InProgress,
  ARTIFACT_STATUS.Done,
];

export const ARTIFACT_KIND_OPTIONS: ReadonlyArray<EpicArtifactKind> = [
  "spec",
  "ticket",
  "story",
  "review",
];

export const ARTIFACT_READ_OPTIONS: ReadonlyArray<{
  readonly value: ArtifactReadFilter;
  readonly label: string;
}> = [
  { value: ARTIFACT_READ.All, label: "All" },
  { value: ARTIFACT_READ.Unread, label: "Unread" },
  { value: ARTIFACT_READ.Read, label: "Read" },
];

/**
 * Summary for a multi-select facet: the single choice when there is one, a
 * count once there are several. Spelling out three or four labels would push
 * the summary past the width a menu row can show, and a truncated list reads as
 * if the hidden entries were not selected.
 */
export function selectedSummary(labels: readonly string[]): string {
  if (labels.length === 0) return "All";
  if (labels.length === 1) return labels[0];
  return `${labels.length} selected`;
}

/** One-line "how is this list ordered" summary: field plus a direction arrow. */
export function sortSummary(sort: SortMode): string {
  return `${SORT_FIELD_LABELS[sort.field]} ${
    sort.direction === SORT_DIRECTION.Asc ? "↑" : "↓"
  }`;
}

/**
 * Accessible name for the view-menu trigger. The count badge is `aria-hidden`
 * decoration, and the ordering and visibility have no badge at all, so
 * everything the view is currently doing has to be said here - otherwise a
 * screen reader hears "Filter agents" no matter how narrowed, reordered, or
 * reversed the list is.
 *
 * Each detail names its VALUE, never just that it changed: a direction the
 * label omits leaves ascending and descending indistinguishable, and a bare
 * "visibility changed" tells the user something is hidden without saying what,
 * which is the one thing they would act on. `visibilityLabel` is `null` for a
 * panel showing its default visibility, and for a surface with no visibility
 * control at all.
 */
export function viewTriggerLabel(args: {
  readonly base: string;
  readonly filterCount: number;
  readonly sort: SortMode;
  readonly visibilityLabel: string | null;
}): string {
  const details: string[] = [];
  if (args.filterCount > 0) {
    details.push(
      `${args.filterCount} ${args.filterCount === 1 ? "filter" : "filters"} active`,
    );
  }
  if (isSortModeActive(args.sort)) {
    const direction =
      args.sort.direction === SORT_DIRECTION.Asc ? "ascending" : "descending";
    details.push(
      `ordered by ${SORT_FIELD_LABELS[args.sort.field]} ${direction}`,
    );
  }
  if (args.visibilityLabel !== null) {
    details.push(`showing ${args.visibilityLabel.toLowerCase()}`);
  }
  return details.length === 0
    ? args.base
    : `${args.base}, ${details.join(", ")}`;
}
