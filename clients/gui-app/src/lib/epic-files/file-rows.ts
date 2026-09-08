/**
 * Turning the projected `files` manifest into the rows the `Files` panel
 * renders: grouping, recording collapse, and the display bits each row needs.
 *
 * Pure, and separate from the panel, because all of it is decided by the path
 * and the entry - nothing here reads React, a store or a host.
 */
import {
  Bot,
  Code,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  User,
  Video,
  type LucideIcon,
} from "lucide-react";
import { mediaTypeFamily } from "@/lib/files/media-type-family";
import { normalizeEpicFileStatus } from "@traycer/protocol/persistence/epic/files";
import type { EpicFileStatusOrUnknown } from "@traycer/protocol/persistence/epic/files";
import type {
  EpicFileRecord,
  FilesSlice,
} from "@/stores/epics/open-epic/types";

/** Every manifest key starts here (`EPIC_FILE_PATH_PREFIXES`). */
const FILES_PREFIX = "files/";

/**
 * Top-level folders under `files/` whose contents this app produced rather than
 * the user: capture output and migrated artifact images. Hidden behind a toggle
 * because a recorded session or a ported artifact image is not something the
 * user filed there, and an epic with either can bury the files they did.
 */
const SYSTEM_GROUP_IDS: ReadonlySet<string> = new Set([
  "recordings",
  "artifact-images",
]);

/** The bare file name - the last path segment. */
export function epicFileName(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

/**
 * The top-level folder under `files/` a path belongs to, or `""` for a file
 * sitting directly in `files/`. Deeper nesting collapses into its top-level
 * folder: the panel is a two-level list, not a tree.
 */
export function epicFileGroupId(path: string): string {
  const relative = path.startsWith(FILES_PREFIX)
    ? path.slice(FILES_PREFIX.length)
    : path;
  const firstSlash = relative.indexOf("/");
  return firstSlash === -1 ? "" : relative.slice(0, firstSlash);
}

export function isSystemEpicFileGroup(groupId: string): boolean {
  return SYSTEM_GROUP_IDS.has(groupId);
}

export interface EpicFileGroup {
  readonly id: string;
  readonly label: string;
  readonly isSystem: boolean;
  readonly records: readonly EpicFileRecord[];
}

/**
 * One recording is THREE manifest entries sharing a `recordingId` (D14): the
 * clip, its rrweb event log and its poster frame. They collapse to a single
 * row keyed by that id, and the row is the clip when there is one - opening a
 * poster instead of the video it belongs to is never what a click meant.
 */
function collapseRecordings(
  records: readonly EpicFileRecord[],
): readonly EpicFileRecord[] {
  const slotByRecordingId = new Map<string, number>();
  const out: EpicFileRecord[] = [];
  for (const record of records) {
    const recordingId = record.entry.recordingId;
    if (recordingId === null) {
      out.push(record);
      continue;
    }
    const slot = slotByRecordingId.get(recordingId);
    if (slot === undefined) {
      slotByRecordingId.set(recordingId, out.length);
      out.push(record);
      continue;
    }
    if (
      out[slot].entry.kind !== "recording" &&
      record.entry.kind === "recording"
    ) {
      out[slot] = record;
    }
  }
  return out;
}

/**
 * Group in path order, which is the order the projector already sorted into -
 * so the group sequence is deterministic without a second sort, and a group's
 * rows keep their path order inside it.
 */
export function groupEpicFiles(
  records: readonly EpicFileRecord[],
  includeSystem: boolean,
): readonly EpicFileGroup[] {
  const byGroupId = new Map<string, EpicFileRecord[]>();
  for (const record of records) {
    const groupId = epicFileGroupId(record.path);
    if (!includeSystem && isSystemEpicFileGroup(groupId)) continue;
    const existing = byGroupId.get(groupId);
    if (existing === undefined) {
      byGroupId.set(groupId, [record]);
    } else {
      existing.push(record);
    }
  }
  return [...byGroupId.entries()].map(([id, groupRecords]) => ({
    id,
    label: id === "" ? "files/" : `${id}/`,
    isSystem: isSystemEpicFileGroup(id),
    records: collapseRecordings(groupRecords),
  }));
}

/**
 * Bytes this epic has committed, tombstones INCLUDED (D25): a deleted file's
 * cloud object stays until the epic itself goes, so it still counts. The panel
 * labels the figure "used" rather than "live" for exactly that reason.
 */
export function totalEpicFileBytes(slice: FilesSlice): number {
  const sum = (total: number, record: EpicFileRecord): number =>
    total + record.entry.current.byteLength;
  return slice.records.reduce(sum, 0) + slice.deleted.reduce(sum, 0);
}

/**
 * Row icon, keyed by the SNIFFED media type through the same family function
 * the viewer core uses - so the icon a row shows and the viewer a click opens
 * can never disagree about what the file is.
 */
export function epicFileIcon(mediaType: string): LucideIcon {
  switch (mediaTypeFamily(mediaType)) {
    case "image":
      return ImageIcon;
    case "video":
      return Video;
    case "pdf":
      return FileText;
    case "text":
      return FileCode;
    case "html":
      return Code;
    case "binary":
      return File;
  }
}

/** Who produced the bytes (D02): the user at the keyboard, or an agent. */
export function epicFileProducerIcon(record: EpicFileRecord): LucideIcon {
  return record.entry.current.producer.type === "agent" ? Bot : User;
}

export function epicFileProducerLabel(record: EpicFileRecord): string {
  return record.entry.current.producer.type === "agent"
    ? "Added by an agent"
    : "Added by a person";
}

/**
 * The status a row badges. `available` earns no badge - it is the resting
 * state, and badging it would put a chip on every row. An unrecognized status
 * badges as `unknown` rather than disappearing: a newer host's vocabulary is
 * something to show, not to swallow.
 */
export function epicFileBadgedStatus(
  record: EpicFileRecord,
): EpicFileStatusOrUnknown | null {
  const status = normalizeEpicFileStatus(record.entry.status);
  return status === "available" ? null : status;
}
