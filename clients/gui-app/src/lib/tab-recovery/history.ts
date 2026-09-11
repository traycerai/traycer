import {
  findStripItemForRef,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import {
  captureHeaderLocation,
  closedHeaderPlacementSchema,
  type ClosedHeaderPlacement,
} from "./header-layout";
import type { LandingDraftTab } from "@/stores/home/landing-draft-store";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { create } from "zustand";
import {
  createStore,
  get,
  set,
  del,
  entries as databaseEntries,
} from "idb-keyval";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/schemas";
import { taskRepoIdentifierSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { parseEpicCanvasState } from "@/stores/epics/canvas/migrate-canvas";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicViewTab,
} from "@/stores/epics/canvas/types";

import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
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
const draftSchema = z.object({
  id: z.string(),
  content: z.custom<JsonContent>((value) => isJsonContent(value, 0)),
  selection: z.object({ from: z.number(), to: z.number() }).nullable(),
  lastTouchedAt: z.number(),
  settings: chatRunSettingsSchema.nullable(),
  composerMode: z.enum(["chat", "terminal"]),
  workspace: z.object({
    folders: z.array(z.string()),
    primaryPath: z.string().nullable(),
    folderInfoByPath: z.record(
      z.string(),
      z.object({
        path: z.string(),
        name: z.string(),
        repoIdentifier: taskRepoIdentifierSchema.nullable(),
        hostId: z.string().nullable(),
      }),
    ),
  }),
});
export type LegacyRecoveryDraft = Pick<
  LandingDraftTab,
  | "id"
  | "content"
  | "selection"
  | "lastTouchedAt"
  | "settings"
  | "composerMode"
  | "workspace"
>;
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
    legacyDraft: draftSchema.optional(),
    index: z.number().int().nonnegative(),
    placement: closedHeaderPlacementSchema.optional().catch(undefined),
  }),
]);
const currentEntrySchema = z.discriminatedUnion("kind", [
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
const entrySchema = z.preprocess((value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    return value;
  return {
    ...value,
    items: value.items.map((item: unknown) => {
      if (typeof item !== "object" || item === null || !("draft" in item))
        return item;
      const legacy = draftSchema.safeParse(item.draft);
      return legacy.success
        ? {
            ...item,
            draftId: legacy.data.id,
            hostId: null,
            legacyDraft: legacy.data,
          }
        : item;
    }),
  };
}, currentEntrySchema);
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
      /** Present only when reading a journal written before saved drafts. */
      readonly legacyDraft?: LegacyRecoveryDraft;
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
let batch: ClosedHeaderTab[] | null = null;
let batchLayout: PersistedTabStripLayout | null = null;
let writes: Promise<void> = Promise.resolve();
const pendingEpicPrunes = new Set<string>();
const pendingDraftPrunes = new Set<string>();
// Compatibility only: new recovery entries contain no draft content. Legacy
// journals in OTHER accounts still own image bytes until imported or expired.
const persistedHistories = new Map<string, readonly TabRecoveryEntry[]>();
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

let recoveryDatabase: import("idb-keyval").UseStore | null = null;
function database() {
  recoveryDatabase ??= createStore(persistKey("tab-recovery"), "history");
  return recoveryDatabase;
}
function meaningfulEntry(entry: TabRecoveryEntry): TabRecoveryEntry[] {
  if (entry.kind === "header") {
    const items = entry.items.filter(
      (item) =>
        item.kind === "epic" ||
        item.legacyDraft === undefined ||
        !isEmptyLandingDraftContent(item.legacyDraft.content),
    );
    return items.length === 0
      ? []
      : [items.length === entry.items.length ? entry : { ...entry, items }];
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
  persistedHistories.set(key, entries);
  writes = writes
    .then(() => set(key, { version: 2, entries }, database()))
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
// A failed open is cached inside idb-keyval's store closure. Retry with a fresh
// connection, closing the old one when possible, without modifying its data.
async function discardFailedHistoryConnection(): Promise<void> {
  const connection = recoveryDatabase;
  recoveryDatabase = null;
  if (connection === null) return;
  await connection("readonly", (transaction) => {
    transaction.transaction.db.close();
    return Promise.resolve();
  }).catch(() => undefined);
}

const HISTORY_READ_RETRY_DELAYS = [100, 300] as const;
async function readRecoveryJournal(
  key: string,
  token: number,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    if (token !== generation) return undefined;
    try {
      await persistedRecoveryImageRootHashes();
      if (token !== generation) return undefined;
      return await get(key, database());
    } catch (error) {
      if (token !== generation) return undefined;
      const delay = HISTORY_READ_RETRY_DELAYS.at(attempt);
      if (delay === undefined) throw error;
      await discardFailedHistoryConnection();
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
      persistedHistories.delete(previous);
      writes = writes
        .then(() => del(previous, database()))
        .catch(() => undefined);
    }
    return;
  }
  let restored: TabRecoveryEntry[] = [];
  try {
    const raw = await readRecoveryJournal(next, token);
    const envelope = z
      .object({
        version: z.union([z.literal(1), z.literal(2)]),
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
  layout: PersistedTabStripLayout | null,
): void {
  if (batch !== null) {
    run();
    return;
  }
  batch = [];
  batchLayout = layout;
  try {
    run();
  } finally {
    const items = batch;
    batch = null;
    batchLayout = null;
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
    if (
      batchLayout !== null &&
      findStripItemForRef(batchLayout, ref) !== null
    ) {
      batch.push({
        ...item,
        ...captureHeaderLocation(batchLayout, ref, item.index),
      });
      return;
    }
    // Legacy/source-only callers can have no coordinated layout to capture.
    let index = item.index;
    for (const earlier of batch.toSorted((a, b) => a.index - b.index)) {
      if (earlier.index <= index) index += 1;
    }
    batch.push({ ...item, index });
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
export function recoveryDrafts(): readonly LegacyRecoveryDraft[] {
  return useTabRecoveryHistory
    .getState()
    .entries.flatMap((entry) =>
      entry.kind === "header"
        ? entry.items.flatMap((item) =>
            item.kind === "draft" && item.legacyDraft !== undefined
              ? [item.legacyDraft]
              : [],
          )
        : [],
    );
}
function recoveryEntryImageHashes(entry: TabRecoveryEntry): readonly string[] {
  if (entry.kind !== "header") return [];
  return entry.items.flatMap((item) =>
    item.kind === "draft" && item.legacyDraft !== undefined
      ? collectImageAtoms(item.legacyDraft.content).flatMap((atom) =>
          atom.hash === null ? [] : [atom.hash],
        )
      : [],
  );
}

/** Image bytes are window-scoped, so inactive accounts remain deletion roots.
 * Read from disk on each sweep to cover a fresh renderer as well as account switches.
 * A failed read must reject: collecting with an incomplete root set loses drafts.
 */
export async function persistedRecoveryImageRootHashes(): Promise<
  readonly string[]
> {
  const pendingWrites = writes;
  await pendingWrites;
  const records = await databaseEntries<IDBValidKey, unknown>(database());
  const suffix = `:${landingImagePartition()}`;
  const loaded = new Map<string, readonly TabRecoveryEntry[]>();
  for (const [key, raw] of records) {
    if (typeof key !== "string" || !key.endsWith(suffix)) continue;
    const envelope = z
      .object({
        version: z.union([z.literal(1), z.literal(2)]),
        entries: z.array(z.unknown()),
      })
      .safeParse(raw);
    if (!envelope.success) continue;
    loaded.set(
      key,
      envelope.data.entries.flatMap((value) => {
        const parsed = entrySchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    );
  }
  // A history update during the read already updated our cache synchronously.
  // Never replace that newer view with the older disk snapshot.
  if (writes === pendingWrites) {
    persistedHistories.clear();
    for (const [key, entries] of loaded) persistedHistories.set(key, entries);
  }
  return [
    ...new Set(
      [...loaded.values()].flatMap((entries) =>
        entries.flatMap(recoveryEntryImageHashes),
      ),
    ),
  ];
}

function legacyRecoveryHistories(): ReadonlyMap<
  string,
  readonly TabRecoveryEntry[]
> {
  const histories = new Map(persistedHistories);
  if (bucket !== null)
    histories.set(bucket, useTabRecoveryHistory.getState().entries);
  else histories.set("", useTabRecoveryHistory.getState().entries);
  return histories;
}
function legacyRecoveryContents(): readonly JsonContent[] {
  return [...legacyRecoveryHistories().values()].flatMap((entries) =>
    entries.flatMap((entry) =>
      entry.kind !== "header"
        ? []
        : entry.items.flatMap((item) =>
            item.kind === "draft" && item.legacyDraft !== undefined
              ? [item.legacyDraft.content]
              : [],
          ),
    ),
  );
}
registerExtraImageRootSource({
  hashes: () =>
    legacyRecoveryContents().flatMap((content) =>
      collectImageAtoms(content).flatMap((atom) =>
        atom.hash === null ? [] : [atom.hash],
      ),
    ),
  contents: legacyRecoveryContents,
});

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

/** Drain queued writes before the app deletes local databases and reloads. */
export async function resetTabRecoveryHistory(): Promise<void> {
  persistedHistories.clear();
  suspendedHistoryWork.clear();
  pendingDraftPrunes.clear();
  bucket = null;
  generation += 1;
  useTabRecoveryHistory.setState({ entries: [], ready: true });
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
