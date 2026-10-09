import type { EpicStateFileRecord } from "@traycer/protocol/host/epic/files";
import {
  EPIC_FILE_MCP_APPS_PREFIX,
  EPIC_FILE_PAGES_PREFIX,
  parseEpicFileRef,
} from "@traycer/protocol/persistence/epic/files";
import {
  epicFileViewer,
  type EpicFileViewerEntry,
} from "@/lib/files/viewer-registry";

/**
 * What the Files panel and the epic-file tile make of the files lane's raw
 * records: which are shown, how they group, and which are versions of which.
 * Pure, so the rules are pinned without a store.
 */

const FILES_ROOT_PREFIX = "files/";

/** One file as a row shows it. */
export interface EpicFileItem {
  readonly path: string;
  /** What the row calls it: {@link epicFileLabel}. */
  readonly name: string;
  readonly record: EpicStateFileRecord;
  readonly viewer: EpicFileViewerEntry;
  /** Earlier versions of this file, newest first. Empty for a file with none. */
  readonly earlier: readonly EpicFileItem[];
}

export type EpicFilesGroupKind = "pages" | "mcp-apps" | "folder" | "root";

export interface EpicFilesGroup {
  readonly kind: EpicFilesGroupKind;
  /** Stable across renders: the folder path for a folder, the kind otherwise. */
  readonly id: string;
  readonly label: string;
  readonly items: readonly EpicFileItem[];
}

export function epicFileDisplayName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The manifest's title for a file (a page's title, an app's `<server> ·
 * <tool>`), or `null`: a host that predates titles, and a drop-zone file, have
 * none, and a blank one counts as none.
 */
export function epicFileTitle(record: EpicStateFileRecord): string | null {
  const title = record.entry.title?.trim() ?? "";
  return title.length > 0 ? title : null;
}

/** What a reader calls a file: its title, else its file name. */
export function epicFileLabel(record: EpicStateFileRecord): string {
  return epicFileTitle(record) ?? epicFileDisplayName(record.path);
}

/** The directory between `files/` and the file name, or `""` at the root. */
export function epicFileFolder(path: string): string {
  const relative = path.slice(FILES_ROOT_PREFIX.length);
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

function isTombstoned(record: EpicStateFileRecord): boolean {
  return record.entry.deletedAt !== null;
}

/** The path a record says it replaced, or `null`. */
function derivedFromPath(record: EpicStateFileRecord): string | null {
  const derivedFrom = record.entry.derivedFrom;
  if (derivedFrom === null) return null;
  return parseEpicFileRef(derivedFrom)?.path ?? null;
}

/**
 * The versions of one file, oldest first, ending at the newest descendant:
 * walk `derivedFrom` back to the first version, then forward through whichever
 * record replaced it (the newest, if an edit was made twice from the same
 * parent). Tombstoned versions stay in the chain - a deleted file still reads
 * by sha, and a version nav that skipped it would renumber history.
 */
export function epicFileVersionChain(
  records: readonly EpicStateFileRecord[],
  path: string,
): readonly EpicStateFileRecord[] {
  const byPath = new Map(records.map((record) => [record.path, record]));
  const start = byPath.get(path);
  if (start === undefined) return [];
  const seen = new Set<string>([start.path]);
  const back: EpicStateFileRecord[] = [];
  let cursor: EpicStateFileRecord = start;
  for (;;) {
    const parentPath = derivedFromPath(cursor);
    const parent = parentPath === null ? undefined : byPath.get(parentPath);
    if (parent === undefined || seen.has(parent.path)) break;
    seen.add(parent.path);
    back.unshift(parent);
    cursor = parent;
  }
  const childrenOf = new Map<string, EpicStateFileRecord[]>();
  for (const record of records) {
    const parentPath = derivedFromPath(record);
    if (parentPath === null) continue;
    const siblings = childrenOf.get(parentPath);
    if (siblings === undefined) childrenOf.set(parentPath, [record]);
    else siblings.push(record);
  }
  const forward: EpicStateFileRecord[] = [];
  cursor = start;
  for (;;) {
    const children = (childrenOf.get(cursor.path) ?? []).filter(
      (child) => !seen.has(child.path),
    );
    if (children.length === 0) break;
    const newest = children.reduce((best, child) =>
      child.entry.createdAt >= best.entry.createdAt ? child : best,
    );
    seen.add(newest.path);
    forward.push(newest);
    cursor = newest;
  }
  return [...back, start, ...forward];
}

function itemFor(
  record: EpicStateFileRecord,
  earlier: readonly EpicFileItem[],
): EpicFileItem {
  return {
    path: record.path,
    name: epicFileLabel(record),
    record,
    viewer: epicFileViewer(record.path),
    earlier,
  };
}

function groupKindOf(path: string): EpicFilesGroupKind {
  if (path.startsWith(EPIC_FILE_PAGES_PREFIX)) return "pages";
  if (path.startsWith(EPIC_FILE_MCP_APPS_PREFIX)) return "mcp-apps";
  return epicFileFolder(path) === "" ? "root" : "folder";
}

const GROUP_LABELS: Readonly<Record<"pages" | "mcp-apps" | "root", string>> = {
  pages: "Pages",
  "mcp-apps": "MCP apps",
  root: "Other files",
};

function newestFirst(a: EpicFileItem, b: EpicFileItem): number {
  return b.record.entry.createdAt - a.record.entry.createdAt;
}

/**
 * The panel's groups, in the order the artboard draws them: Pages, MCP apps,
 * the drop-zone folders alphabetically, then files at the root.
 *
 * A tombstoned file is hidden. A page edit is a new file naming the old one in
 * `derivedFrom`, so a file that a visible file replaced is shown as that file's
 * "Earlier version" child rather than as a row of its own.
 */
export function buildEpicFilesGroups(
  records: readonly EpicStateFileRecord[],
): readonly EpicFilesGroup[] {
  const visible = records.filter((record) => !isTombstoned(record));
  const replaced = new Set<string>();
  for (const record of visible) {
    const parentPath = derivedFromPath(record);
    if (parentPath !== null) replaced.add(parentPath);
  }
  const byPath = new Map(visible.map((record) => [record.path, record]));

  function earlierOf(record: EpicStateFileRecord): readonly EpicFileItem[] {
    const items: EpicFileItem[] = [];
    const seen = new Set<string>([record.path]);
    let cursor = record;
    for (;;) {
      const parentPath = derivedFromPath(cursor);
      const parent = parentPath === null ? undefined : byPath.get(parentPath);
      if (parent === undefined || seen.has(parent.path)) break;
      seen.add(parent.path);
      items.push(itemFor(parent, []));
      cursor = parent;
    }
    return items;
  }

  const buckets = new Map<string, EpicFileItem[]>();
  const groupOrder = new Map<string, EpicFilesGroup["kind"]>();
  for (const record of visible) {
    if (replaced.has(record.path)) continue;
    const kind = groupKindOf(record.path);
    const id = kind === "folder" ? epicFileFolder(record.path) : kind;
    groupOrder.set(id, kind);
    const bucket = buckets.get(id) ?? [];
    bucket.push(itemFor(record, earlierOf(record)));
    buckets.set(id, bucket);
  }

  const groups: EpicFilesGroup[] = [];
  for (const [id, items] of buckets) {
    const kind = groupOrder.get(id) ?? "folder";
    groups.push({
      kind,
      id,
      label: kind === "folder" ? id : GROUP_LABELS[kind],
      items: [...items].sort(newestFirst),
    });
  }
  const rank = (group: EpicFilesGroup): number => {
    switch (group.kind) {
      case "pages":
        return 0;
      case "mcp-apps":
        return 1;
      case "folder":
        return 2;
      case "root":
        return 3;
    }
  };
  return groups.sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label),
  );
}

/** Whether this host already holds the file's bytes. */
export function epicFileIsLocal(record: EpicStateFileRecord): boolean {
  return record.localState.kind === "present";
}

/**
 * True for a file the host did not mirror eagerly and that nobody has asked
 * for yet - the row's cloud-download icon (the artboard's "downloads on first
 * open").
 */
export function epicFileDownloadsOnOpen(record: EpicStateFileRecord): boolean {
  return record.localState.kind === "absent";
}
