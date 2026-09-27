import type * as Y from "yjs";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Top-level `Y.Map` on the per-user notifications room that holds the Home
 * status board: `rowKey -> row`, where each row is an immutable plain JSON
 * object (without its key). Every write replaces the whole value, never edits
 * it in place: under Yjs a concurrent `set` survives a concurrent `delete` of
 * the same key, whereas an edit into a nested map another replica deleted
 * lands in a detached map and is lost.
 */
export const HOME_STATUS_MAP_KEY = "homeStatusV1";

export const HOME_STATUS_VALUES = ["needs-you", "in-progress", "done"] as const;
export type HomeStatus = (typeof HOME_STATUS_VALUES)[number];

/** An `in-progress` row untouched for longer than this renders as stale. */
export const HOME_STATUS_STALE_MS = 2 * 60 * 60 * 1000;
/**
 * Any row older than this is hidden and pruned, whatever its status - `done`
 * rows included, so how long a finished row stays in view is each reader's
 * own display choice. Hosts from before this rule also pruned `done` rows at
 * 24 h, so on a board one of them still writes to, a finished row can vanish
 * sooner than a reader asked.
 */
export const HOME_STATUS_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Writers prune the board down to this many entries. */
export const HOME_STATUS_MAX_ROWS = 200;

export const HOME_STATUS_KEY_MAX_LENGTH = 128;
export const HOME_STATUS_ITEM_MAX_LENGTH = 200;
export const HOME_STATUS_NOTE_MAX_LENGTH = 2000;
export const HOME_STATUS_ID_MAX_LENGTH = 256;

export const homeStatusSchema = lazySchema(() => z.enum(HOME_STATUS_VALUES));

export const homeStatusKeySchema = lazySchema(() =>
  z.string().min(1).max(HOME_STATUS_KEY_MAX_LENGTH),
);

/** The stored value under a row key. Unknown fields are ignored on read. */
export const homeStatusRowValueSchema = lazySchema(() =>
  z.object({
    status: homeStatusSchema,
    item: z.string().min(1).max(HOME_STATUS_ITEM_MAX_LENGTH),
    /** Markdown. Render only through a sanitizing markdown renderer. */
    note: z.string().max(HOME_STATUS_NOTE_MAX_LENGTH),
    agentId: z.string().min(1).max(HOME_STATUS_ID_MAX_LENGTH),
    agentName: z.string().max(HOME_STATUS_ID_MAX_LENGTH),
    epicId: z.string().min(1).max(HOME_STATUS_ID_MAX_LENGTH),
    hostId: z.string().min(1).max(HOME_STATUS_ID_MAX_LENGTH),
    /**
     * The writing agent's harness, for its icon. Absent on rows written
     * before the field existed, and a value that fails the bound reads the
     * same way: either is `null`, never a dropped row.
     */
    harnessId: z
      .string()
      .min(1)
      .max(HOME_STATUS_ID_MAX_LENGTH)
      .nullable()
      .catch(null),
    /** Epoch milliseconds of the last write. */
    updatedAt: z.number().int().nonnegative(),
  }),
);

export type HomeStatusRowValue = z.infer<typeof homeStatusRowValueSchema>;

export const homeStatusRowSchema = lazySchema(() =>
  homeStatusRowValueSchema.extend({
    key: homeStatusKeySchema,
  }),
);

export type HomeStatusRow = z.infer<typeof homeStatusRowSchema>;

export function getHomeStatusMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(HOME_STATUS_MAP_KEY);
}

/**
 * Parses one stored entry. Returns `undefined` for anything that does not
 * match the row schema, so a malformed or future-shaped row is skipped
 * rather than failing the whole board.
 */
export function parseHomeStatusRow(
  key: string,
  value: unknown,
): HomeStatusRow | undefined {
  if (!homeStatusKeySchema.safeParse(key).success) return undefined;
  const parsed = homeStatusRowValueSchema.safeParse(value);
  return parsed.success ? { key, ...parsed.data } : undefined;
}

/** Every valid row on the board, in map order. Invalid rows are dropped. */
export function readHomeStatusRows(doc: Y.Doc): HomeStatusRow[] {
  const rows: HomeStatusRow[] = [];
  getHomeStatusMap(doc).forEach((value, key) => {
    const row = parseHomeStatusRow(key, value);
    if (row) rows.push(row);
  });
  return rows;
}

const STATUS_ORDER: Record<HomeStatus, number> = {
  "needs-you": 0,
  "in-progress": 1,
  done: 2,
};

/** Board order: needs-you, then in-progress, then done; newest first within each. */
export function compareHomeStatusRows(
  a: HomeStatusRow,
  b: HomeStatusRow,
): number {
  const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (byStatus !== 0) return byStatus;
  const byTime = b.updatedAt - a.updatedAt;
  if (byTime !== 0) return byTime;
  return compareKeys(a.key, b.key);
}

export function sortHomeStatusRows(
  rows: readonly HomeStatusRow[],
): HomeStatusRow[] {
  return [...rows].sort(compareHomeStatusRows);
}

/** `in-progress` rows go stale after {@link HOME_STATUS_STALE_MS}; other statuses never do. */
export function isHomeStatusRowStale(row: HomeStatusRow, now: number): boolean {
  return (
    row.status === "in-progress" && now - row.updatedAt > HOME_STATUS_STALE_MS
  );
}

/**
 * Whether a row has outlived {@link HOME_STATUS_ROW_TTL_MS}, whatever its
 * status. Expired rows are pruned by writers and hidden by readers.
 */
export function isHomeStatusRowExpired(
  row: HomeStatusRow,
  now: number,
): boolean {
  return now - row.updatedAt > HOME_STATUS_ROW_TTL_MS;
}

/** Valid, unexpired rows in board order. */
export function readVisibleHomeStatusRows(
  doc: Y.Doc,
  now: number,
): HomeStatusRow[] {
  return sortHomeStatusRows(
    readHomeStatusRows(doc).filter((row) => !isHomeStatusRowExpired(row, now)),
  );
}

type PruneCandidate = {
  readonly key: string;
  readonly done: boolean;
  readonly updatedAt: number;
};

/**
 * Keys a writer should delete, never including `keepKey`:
 *
 * 1. valid rows that have expired, and entries of any shape whose numeric
 *    `updatedAt` is past {@link HOME_STATUS_ROW_TTL_MS} (an entry that fails
 *    to parse but is not provably old is otherwise kept, since it may be a
 *    newer writer's row shape);
 * 2. while more than {@link HOME_STATUS_MAX_ROWS} entries remain, the oldest
 *    `done` rows, then the oldest entries of any kind (an entry without a
 *    numeric `updatedAt` counts as oldest).
 */
export function listPrunableHomeStatusKeys(
  doc: Y.Doc,
  now: number,
  keepKey: string | null,
): string[] {
  const pruned: string[] = [];
  const survivors: PruneCandidate[] = [];
  let keptCount = 0;
  getHomeStatusMap(doc).forEach((value, key) => {
    if (key === keepKey) {
      keptCount += 1;
      return;
    }
    const row = parseHomeStatusRow(key, value);
    if (row) {
      if (isHomeStatusRowExpired(row, now)) pruned.push(key);
      else
        survivors.push({
          key,
          done: row.status === "done",
          updatedAt: row.updatedAt,
        });
      return;
    }
    const updatedAt = readRawUpdatedAt(value);
    if (updatedAt !== null && now - updatedAt > HOME_STATUS_ROW_TTL_MS) {
      pruned.push(key);
      return;
    }
    survivors.push({
      key,
      done: false,
      updatedAt: updatedAt ?? Number.NEGATIVE_INFINITY,
    });
  });
  const excess = survivors.length + keptCount - HOME_STATUS_MAX_ROWS;
  if (excess > 0) {
    const evictionOrder = [...survivors].sort((a, b) => {
      if (a.done !== b.done) return a.done ? -1 : 1;
      if (a.updatedAt !== b.updatedAt)
        return a.updatedAt < b.updatedAt ? -1 : 1;
      return compareKeys(a.key, b.key);
    });
    for (const candidate of evictionOrder.slice(0, excess)) {
      pruned.push(candidate.key);
    }
  }
  return pruned;
}

/**
 * Replaces `row.key`'s value with a fresh immutable object and prunes the
 * board (see {@link listPrunableHomeStatusKeys}), in one transaction. The
 * written row itself is never pruned. Returns how many other entries were
 * deleted.
 */
export function writeHomeStatusRow(
  doc: Y.Doc,
  row: HomeStatusRow,
  now: number,
): number {
  const { key, ...value } = row;
  let prunedCount = 0;
  doc.transact(() => {
    const map = getHomeStatusMap(doc);
    map.set(key, value);
    const keys = listPrunableHomeStatusKeys(doc, now, key);
    for (const prunable of keys) map.delete(prunable);
    prunedCount = keys.length;
  });
  return prunedCount;
}

/** Deletes one row. Returns whether the key was present. */
export function removeHomeStatusRow(doc: Y.Doc, key: string): boolean {
  const map = getHomeStatusMap(doc);
  if (!map.has(key)) return false;
  doc.transact(() => {
    map.delete(key);
  });
  return true;
}

/** Deletes every key {@link listPrunableHomeStatusKeys} reports. Returns how many. */
export function pruneHomeStatusRows(doc: Y.Doc, now: number): number {
  const keys = listPrunableHomeStatusKeys(doc, now, null);
  if (keys.length === 0) return 0;
  const map = getHomeStatusMap(doc);
  doc.transact(() => {
    for (const key of keys) map.delete(key);
  });
  return keys.length;
}

function readRawUpdatedAt(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("updatedAt" in value)) return null;
  const updatedAt: unknown = value.updatedAt;
  return typeof updatedAt === "number" && Number.isFinite(updatedAt)
    ? updatedAt
    : null;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
