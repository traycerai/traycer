import type { PersistedTabStripLayout } from "@/stores/tabs/layout";
import {
  captureHeaderLocation,
  closedHeaderPlacementSchema,
  type ClosedHeaderPlacement,
} from "./header-layout";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { create } from "zustand";
import { createStore, get, set, del, type UseStore } from "idb-keyval";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { parseEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
} from "@/stores/epics/canvas/types";

import { landingImagePartition } from "@/lib/composer/landing-image-store";
import { tabRecoveryKey, persistKey } from "@/lib/persist/keys";
import { appLogger, describeLogError } from "@/lib/logger";

const canvasSchema = z.unknown().transform((value, ctx) => {
  const canvas = parseEpicCanvasState(value);
  if (canvas !== null) return canvas;
  ctx.addIssue({ code: "custom", message: "Invalid recovery canvas" });
  return z.NEVER;
});
const tabSchema = z.object({
  tabId: z.string(),
  epicId: z.string(),
  name: z.string(),
  surfaceMode: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("epic") }),
      z.object({ kind: z.literal("phase-migration"), phaseId: z.string() }),
    ])
    .optional(),
});
const headerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("epic"),
    tab: tabSchema,
    canvas: canvasSchema,
    index: z.number().int().nonnegative(),
    placement: closedHeaderPlacementSchema.optional().catch(undefined),
  }),
  z.object({
    kind: z.literal("draft"),
    draftId: z.string(),
    hostId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    placement: closedHeaderPlacementSchema.optional().catch(undefined),
  }),
]);
const entrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("header"),
    id: z.string(),
    items: z.array(headerSchema),
    bulk: z.boolean(),
  }),
  z.object({
    kind: z.literal("canvas"),
    id: z.string(),
    tab: tabSchema,
    before: canvasSchema,
    after: canvasSchema,
    instanceIds: z.array(z.string()),
    paneIds: z.array(z.string()).optional(),
    bulk: z.boolean(),
  }),
]);
export type ClosedHeaderTab =
  | {
      readonly kind: "epic";
      readonly tab: EpicViewTab;
      readonly canvas: EpicCanvasState;
      readonly index: number;
      readonly placement?: ClosedHeaderPlacement;
    }
  | {
      readonly kind: "draft";
      readonly draftId: string;
      readonly hostId: string | null;
      readonly index: number;
      readonly placement?: ClosedHeaderPlacement;
    };
export type TabRecoveryEntry =
  | {
      readonly kind: "header";
      readonly id: string;
      readonly items: readonly ClosedHeaderTab[];
      readonly bulk: boolean;
    }
  | {
      readonly kind: "canvas";
      readonly id: string;
      readonly tab: EpicViewTab;
      readonly before: EpicCanvasState;
      readonly after: EpicCanvasState;
      readonly instanceIds: readonly string[];
      readonly paneIds?: readonly string[];
      readonly bulk: boolean;
    };
export type ClosedCanvasEntry = Extract<TabRecoveryEntry, { kind: "canvas" }>;
export const MAX_RECOVERY_ACTIONS = 50;
const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;
interface RecoveryHistoryState {
  readonly entries: readonly TabRecoveryEntry[];
  readonly ready: boolean;
}
export const useTabRecoveryHistory = create<RecoveryHistoryState>(() => ({
  entries: [],
  ready: false,
}));
let bucket: string | null = null;
let generation = 0;
let suppressed = 0;
let batch: {
  readonly items: ClosedHeaderTab[];
  readonly layout: PersistedTabStripLayout;
} | null = null;
let writes: Promise<void> = Promise.resolve();
// Account switches preserve queued writes; a database wipe cancels them.
let resetEpoch = 0;
const pendingEpicPrunes = new Set<string>();
const pendingDraftPrunes = new Set<string>();
let pendingTilePrunes: Array<
  (tile: EpicCanvasTileRef, epicId: string) => boolean
> = [];

interface PendingHistoryWork {
  readonly entries: readonly TabRecoveryEntry[];
  readonly epicPrunes: readonly string[];
  readonly draftPrunes: readonly string[];
  readonly tilePrunes: typeof pendingTilePrunes;
}
const suspendedHistoryWork = new Map<string, PendingHistoryWork>();
const EMPTY_PENDING_HISTORY_WORK: PendingHistoryWork = {
  entries: [],
  epicPrunes: [],
  draftPrunes: [],
  tilePrunes: [],
};

function applyPendingHistoryWork(
  pending: PendingHistoryWork,
  ready: boolean,
): void {
  pendingEpicPrunes.clear();
  pendingDraftPrunes.clear();
  for (const id of pending.epicPrunes) pendingEpicPrunes.add(id);
  for (const id of pending.draftPrunes) pendingDraftPrunes.add(id);
  pendingTilePrunes = [...pending.tilePrunes];
  useTabRecoveryHistory.setState({ entries: pending.entries, ready });
}

function activateRecoveryBucket(
  previous: string | null,
  next: string | null,
): void {
  if (previous === next && next !== null) return;
  if (
    previous !== null &&
    next !== null &&
    !useTabRecoveryHistory.getState().ready
  ) {
    suspendedHistoryWork.set(previous, {
      entries: useTabRecoveryHistory.getState().entries,
      epicPrunes: [...pendingEpicPrunes],
      draftPrunes: [...pendingDraftPrunes],
      tilePrunes: [...pendingTilePrunes],
    });
  }
  if (next === null && previous !== null) suspendedHistoryWork.delete(previous);
  const pending = next === null ? undefined : suspendedHistoryWork.get(next);
  if (next !== null) suspendedHistoryWork.delete(next);
  applyPendingHistoryWork(pending ?? EMPTY_PENDING_HISTORY_WORK, next === null);
}

let recoveryDatabase: UseStore | null = null;
function database(): UseStore {
  if (recoveryDatabase !== null) return recoveryDatabase;
  const connection = createStore(persistKey("tab-recovery"), "history");
  const store: UseStore = (mode, callback) =>
    connection(mode, (objectStore) => {
      const db = objectStore.transaction.db;
      db.onversionchange = () => {
        db.close();
        if (recoveryDatabase !== store) return;
        recoveryDatabase = null;
        // A peer is deleting the shared database. Keep this window's account
        // binding, but forget its journal and cancel pre-wipe async work.
        invalidateRecoveryHistory();
      };
      return callback(objectStore);
    });
  recoveryDatabase = store;
  return recoveryDatabase;
}
function meaningfulEntry(entry: TabRecoveryEntry): TabRecoveryEntry[] {
  if (entry.kind === "header") {
    return entry.items.length === 0 ? [] : [entry];
  }
  const instanceIds = entry.instanceIds.filter((id) => {
    const tile = entry.before.tilesByInstanceId[id];
    return tile !== undefined && tile.type !== "blank";
  });
  const paneIds = (entry.paneIds ?? []).filter(
    (id) =>
      findPaneById(entry.before.root, id) !== null &&
      findPaneById(entry.after.root, id) === null,
  );
  return instanceIds.length === 0 && paneIds.length === 0
    ? []
    : [
        instanceIds.length === entry.instanceIds.length &&
        paneIds.length === (entry.paneIds ?? []).length
          ? entry
          : { ...entry, instanceIds, paneIds },
      ];
}

const entryBytes = new WeakMap<TabRecoveryEntry, number>();
function measuredEntryBytes(entry: TabRecoveryEntry): number {
  const cached = entryBytes.get(entry);
  if (cached !== undefined) return cached;
  const bytes = JSON.stringify(entry).length * 2;
  entryBytes.set(entry, bytes);
  return bytes;
}

function bounded(
  entries: readonly TabRecoveryEntry[],
): readonly TabRecoveryEntry[] {
  let bytes = 0;
  const kept: TabRecoveryEntry[] = [];
  for (const entry of entries
    .flatMap(meaningfulEntry)
    .slice(-MAX_RECOVERY_ACTIONS)
    .toReversed()) {
    bytes += measuredEntryBytes(entry);
    if (bytes > MAX_RECOVERY_BYTES && kept.length > 0) break;
    kept.push(entry);
  }
  return kept.reverse();
}
function persistHistory(): void {
  const key = bucket;
  if (key === null || !useTabRecoveryHistory.getState().ready) return;
  const entries = useTabRecoveryHistory.getState().entries;
  const epoch = resetEpoch;
  writes = writes
    .then(() =>
      epoch === resetEpoch
        ? set(key, { version: 2, entries }, database())
        : undefined,
    )
    .catch((error: unknown) => {
      appLogger.warn("[tab-recovery] history persistence failed", {
        error: describeLogError(error),
      });
    });
}
function replaceEntries(entries: readonly TabRecoveryEntry[]): void {
  useTabRecoveryHistory.setState({ entries: bounded(entries) });
  persistHistory();
}
const HISTORY_READ_RETRY_DELAYS = [100, 300] as const;
async function readRecoveryJournal(
  key: string,
  token: number,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    if (token !== generation) return undefined;
    try {
      // Account switches may return to a bucket whose last write is queued.
      await writes;
      if (token !== generation) return undefined;
      return await get(key, database());
    } catch (error) {
      if (token !== generation) return undefined;
      const delay = HISTORY_READ_RETRY_DELAYS.at(attempt);
      if (delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function configureTabRecoveryHistory(
  identity: string | null,
): Promise<void> {
  const next =
    identity === null
      ? null
      : tabRecoveryKey(identity, landingImagePartition());
  if (bucket === next && useTabRecoveryHistory.getState().ready) return;
  const previous = bucket;
  bucket = next;
  const token = ++generation;
  // Pending work belongs to the bucket where it was captured, even if its
  // read is still in flight or storage is unavailable when accounts switch.
  activateRecoveryBucket(previous, next);
  if (next === null) {
    if (previous !== null) {
      const epoch = resetEpoch;
      writes = writes
        .then(() =>
          epoch === resetEpoch ? del(previous, database()) : undefined,
        )
        .catch(() => undefined);
    }
    return;
  }
  let restored: TabRecoveryEntry[] = [];
  try {
    const raw = await readRecoveryJournal(next, token);
    const envelope = z
      .object({
        version: z.literal(2),
        entries: z.array(z.unknown()),
      })
      .safeParse(raw);
    if (envelope.success)
      restored = envelope.data.entries.flatMap((value) => {
        const parsed = entrySchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
  } catch (error) {
    appLogger.warn("[tab-recovery] history restore failed", {
      error: describeLogError(error),
    });
    // Remain unhydrated: neither this call nor subsequent closes may replace
    // an unread journal. Reconfiguration can retry and merge pending changes.
    return;
  }
  if (token !== generation) return;
  useTabRecoveryHistory.setState({
    entries: bounded([
      ...restored,
      ...useTabRecoveryHistory.getState().entries,
    ]),
    ready: true,
  });
  if (pendingEpicPrunes.size > 0) pruneRecoveryEpics([...pendingEpicPrunes]);
  for (const id of pendingDraftPrunes) pruneRecoveryDraft(id);
  pendingDraftPrunes.clear();
  for (const predicate of pendingTilePrunes) pruneRecoveryTiles(predicate);
  pendingEpicPrunes.clear();
  pendingTilePrunes = [];
  persistHistory();
}
export function withoutTabRecovery<T>(run: () => T): T {
  suppressed += 1;
  try {
    return run();
  } finally {
    suppressed -= 1;
  }
}
export function batchHeaderTabRecovery(
  run: () => void,
  layout: PersistedTabStripLayout,
): void {
  if (batch !== null) {
    run();
    return;
  }
  batch = { items: [], layout };
  try {
    run();
  } finally {
    const { items } = batch;
    batch = null;
    if (items.length > 0)
      append({ kind: "header", id: uuidv4(), items, bulk: true });
  }
}
function append(entry: TabRecoveryEntry): void {
  if (suppressed > 0) return;
  const kept = meaningfulEntry(entry);
  if (kept.length === 0) return;
  replaceEntries([...useTabRecoveryHistory.getState().entries, ...kept]);
}
export function recordClosedHeaderTab(item: ClosedHeaderTab): void {
  if (suppressed > 0) return;
  if (batch !== null) {
    const ref =
      item.kind === "epic"
        ? { kind: "epic" as const, id: item.tab.tabId }
        : { kind: "draft" as const, id: item.draftId };
    batch.items.push({
      ...item,
      ...captureHeaderLocation(batch.layout, ref, item.index),
    });
  } else append({ kind: "header", id: uuidv4(), items: [item], bulk: false });
}
export function recordClosedCanvas(
  tab: EpicViewTab | undefined,
  before: EpicCanvasState | undefined,
  after: EpicCanvasState | undefined,
  bulk: boolean,
): void {
  if (
    suppressed > 0 ||
    tab === undefined ||
    before === undefined ||
    after === undefined
  )
    return;
  const instanceIds = Object.keys(before.tilesByInstanceId).filter(
    (id) =>
      after.tilesByInstanceId[id] === undefined &&
      before.tilesByInstanceId[id]?.type !== "blank",
  );
  if (instanceIds.length > 0)
    append({
      kind: "canvas",
      id: uuidv4(),
      tab,
      before,
      after,
      instanceIds,
      bulk,
    });
}
/** Explicit pane closes can recover layout even when no content was open. */
export function recordClosedCanvasPane(
  tab: EpicViewTab | undefined,
  before: EpicCanvasState | undefined,
  after: EpicCanvasState | undefined,
  paneId: string,
): void {
  if (
    suppressed > 0 ||
    tab === undefined ||
    before === undefined ||
    after === undefined
  )
    return;
  if (
    before.root?.kind !== "group" ||
    findPaneById(after.root, paneId) !== null
  ) {
    recordClosedCanvas(tab, before, after, true);
    return;
  }
  if (!collectPanes(before.root).some((pane) => pane.id === paneId)) return;
  const instanceIds = Object.keys(before.tilesByInstanceId).filter(
    (id) =>
      after.tilesByInstanceId[id] === undefined &&
      before.tilesByInstanceId[id]?.type !== "blank",
  );
  append({
    kind: "canvas",
    id: uuidv4(),
    tab,
    before,
    after,
    instanceIds,
    paneIds: [paneId],
    bulk: true,
  });
}

export function removeRecoveryEntry(id: string): void {
  replaceEntries(
    useTabRecoveryHistory.getState().entries.filter((entry) => entry.id !== id),
  );
}
export function pruneRecoveryEpics(epicIds: readonly string[]): void {
  const ids = new Set(epicIds);
  if (!useTabRecoveryHistory.getState().ready)
    epicIds.forEach((id) => pendingEpicPrunes.add(id));
  if (
    !recoveryEpicIds(useTabRecoveryHistory.getState().entries).some((id) =>
      ids.has(id),
    )
  )
    return;
  replaceEntries(
    useTabRecoveryHistory
      .getState()
      .entries.flatMap<TabRecoveryEntry>((entry) => {
        if (entry.kind === "canvas")
          return ids.has(entry.tab.epicId) ? [] : [entry];
        const items = entry.items.filter(
          (item) => item.kind !== "epic" || !ids.has(item.tab.epicId),
        );
        if (items.length === entry.items.length) return [entry];
        return items.length === 0 ? [] : [{ ...entry, items }];
      }),
  );
}
export function pruneRecoveryTiles(
  isDeleted: (tile: EpicCanvasTileRef, epicId: string) => boolean,
): void {
  if (!useTabRecoveryHistory.getState().ready)
    pendingTilePrunes.push(isDeleted);
  const affected = useTabRecoveryHistory.getState().entries.some((entry) => {
    const canvases =
      entry.kind === "canvas"
        ? [{ canvas: entry.before, epicId: entry.tab.epicId }]
        : entry.items.flatMap((item) =>
            item.kind === "epic"
              ? [{ canvas: item.canvas, epicId: item.tab.epicId }]
              : [],
          );
    return canvases.some(({ canvas, epicId }) =>
      Object.values(canvas.tilesByInstanceId).some(
        (tile) => tile !== undefined && isDeleted(tile, epicId),
      ),
    );
  });
  if (!affected) return;
  const clean = (canvas: EpicCanvasState, epicId: string): EpicCanvasState => {
    if (
      !Object.values(canvas.tilesByInstanceId).some(
        (tile) => tile !== undefined && isDeleted(tile, epicId),
      )
    )
      return canvas;
    const tilesByInstanceId = Object.fromEntries(
      Object.entries(canvas.tilesByInstanceId).filter(
        ([, tile]) => tile !== undefined && !isDeleted(tile, epicId),
      ),
    );
    return parseEpicCanvasState({ ...canvas, tilesByInstanceId }) ?? canvas;
  };
  replaceEntries(
    useTabRecoveryHistory
      .getState()
      .entries.flatMap<TabRecoveryEntry>((entry) => {
        if (entry.kind === "header") {
          const items = entry.items.map((item) => {
            if (item.kind === "draft") return item;
            const canvas = clean(item.canvas, item.tab.epicId);
            return canvas === item.canvas ? item : { ...item, canvas };
          });
          return [
            items.every((item, index) => item === entry.items[index])
              ? entry
              : { ...entry, items },
          ];
        }
        const instanceIds = entry.instanceIds.filter((id) => {
          const tile = entry.before.tilesByInstanceId[id];
          return tile !== undefined && !isDeleted(tile, entry.tab.epicId);
        });
        if (instanceIds.length === 0 && (entry.paneIds ?? []).length === 0)
          return [];
        const before = clean(entry.before, entry.tab.epicId);
        const after = clean(entry.after, entry.tab.epicId);
        return [
          before === entry.before &&
          after === entry.after &&
          instanceIds.length === entry.instanceIds.length
            ? entry
            : { ...entry, instanceIds, before, after },
        ];
      }),
  );
}
/** Permanent deletion must not be undone by a later reopen command. */
export function pruneRecoveryDraft(draftId: string): void {
  if (!useTabRecoveryHistory.getState().ready) pendingDraftPrunes.add(draftId);
  replaceEntries(
    useTabRecoveryHistory
      .getState()
      .entries.flatMap<TabRecoveryEntry>((entry) => {
        if (entry.kind !== "header") return [entry];
        const items = entry.items.filter(
          (item) => item.kind !== "draft" || item.draftId !== draftId,
        );
        if (items.length === entry.items.length) return [entry];
        return items.length === 0 ? [] : [{ ...entry, items }];
      }),
  );
}

export function recoveryEpicIds(
  entries: readonly TabRecoveryEntry[],
): readonly string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === "canvas"
          ? [entry.tab.epicId]
          : entry.items.flatMap((item) =>
              item.kind === "epic" ? [item.tab.epicId] : [],
            ),
      ),
    ),
  ];
}
/** Keep referenced saved rows locally available while their close action exists. */
export function recoveryDraftIds(): ReadonlySet<string> {
  return new Set(
    useTabRecoveryHistory
      .getState()
      .entries.flatMap((entry) =>
        entry.kind === "header"
          ? entry.items.flatMap((item) =>
              item.kind === "draft" ? [item.draftId] : [],
            )
          : [],
      ),
  );
}
export function discardRecoveryTab(tabId: string): void {
  replaceEntries(
    useTabRecoveryHistory
      .getState()
      .entries.flatMap<TabRecoveryEntry>((entry) => {
        if (entry.kind === "canvas")
          return entry.tab.tabId === tabId ? [] : [entry];
        const items = entry.items.filter(
          (item) => item.kind !== "epic" || item.tab.tabId !== tabId,
        );
        if (items.length === entry.items.length) return [entry];
        return items.length === 0 ? [] : [{ ...entry, items }];
      }),
  );
}

export function recoveryTiles(): ReadonlyArray<{
  readonly epicId: string;
  readonly tile: EpicCanvasTileRef;
}> {
  return useTabRecoveryHistory.getState().entries.flatMap((entry) => {
    const canvases =
      entry.kind === "canvas"
        ? [{ canvas: entry.before, epicId: entry.tab.epicId }]
        : entry.items.flatMap((item) =>
            item.kind === "epic"
              ? [{ canvas: item.canvas, epicId: item.tab.epicId }]
              : [],
          );
    return canvases.flatMap(({ canvas, epicId }) =>
      Object.values(canvas.tilesByInstanceId).flatMap((tile) =>
        tile === undefined ? [] : [{ epicId, tile }],
      ),
    );
  });
}

function invalidateRecoveryHistory(): void {
  suspendedHistoryWork.clear();
  resetEpoch += 1;
  generation += 1;
  applyPendingHistoryWork(EMPTY_PENDING_HISTORY_WORK, true);
}

/** Cancel queued history work and release this renderer before database deletion. */
export async function resetTabRecoveryHistory(): Promise<void> {
  bucket = null;
  invalidateRecoveryHistory();
  await writes;
  const connection = recoveryDatabase;
  recoveryDatabase = null;
  if (connection !== null)
    await connection("readonly", (transaction) => {
      transaction.transaction.db.close();
      return Promise.resolve();
    });
}

export function flushTabRecoveryHistory(): Promise<void> {
  return writes;
}

export function updateRecoveryEntry(entry: TabRecoveryEntry): void {
  replaceEntries(
    useTabRecoveryHistory
      .getState()
      .entries.map((current) => (current.id === entry.id ? entry : current)),
  );
}
export function recoveryHistoryGeneration(): number {
  return generation;
}
