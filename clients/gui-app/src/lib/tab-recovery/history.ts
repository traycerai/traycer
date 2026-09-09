import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { create } from "zustand";
import { createStore, get, set, del } from "idb-keyval";
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
import type { LandingDraftTab } from "@/stores/home/landing-draft-store";
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
const headerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("epic"),
    tab: tabSchema,
    canvas: canvasSchema,
    index: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("draft"),
    draft: draftSchema,
    index: z.number().int().nonnegative(),
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
    paneIds: z.array(z.string()).default([]),
    bulk: z.boolean(),
  }),
]);
export type ClosedHeaderTab =
  | {
      readonly kind: "epic";
      readonly tab: EpicViewTab;
      readonly canvas: EpicCanvasState;
      readonly index: number;
    }
  | {
      readonly kind: "draft";
      readonly draft: LandingDraftTab;
      readonly index: number;
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
let writes: Promise<void> = Promise.resolve();
const pendingEpicPrunes = new Set<string>();
let pendingTilePrunes: Array<
  (tile: EpicCanvasTileRef, epicId: string) => boolean
> = [];

let recoveryDatabase: import("idb-keyval").UseStore | null = null;
function database() {
  recoveryDatabase ??= createStore(persistKey("tab-recovery"), "history");
  return recoveryDatabase;
}
function meaningfulEntry(entry: TabRecoveryEntry): TabRecoveryEntry[] {
  if (entry.kind === "header") {
    const items = entry.items.filter(
      (item) =>
        item.kind === "epic" || !isEmptyLandingDraftContent(item.draft.content),
    );
    return items.length === 0 ? [] : [{ ...entry, items }];
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
    : [{ ...entry, instanceIds, paneIds }];
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
    bytes += JSON.stringify(entry).length * 2;
    if (bytes > MAX_RECOVERY_BYTES && kept.length > 0) break;
    kept.push(entry);
  }
  return kept.reverse();
}
function persistHistory(): void {
  const key = bucket;
  if (key === null || !useTabRecoveryHistory.getState().ready) return;
  const entries = useTabRecoveryHistory.getState().entries;
  writes = writes
    .then(() => set(key, { version: 1, entries }, database()))
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
  pendingEpicPrunes.clear();
  pendingTilePrunes = [];
  useTabRecoveryHistory.setState({ entries: [], ready: next === null });
  if (next === null) {
    if (previous !== null)
      writes = writes
        .then(() => del(previous, database()))
        .catch(() => undefined);
    return;
  }
  let restored: TabRecoveryEntry[] = [];
  try {
    await writes;
    const raw: unknown = await get(next, database());
    const envelope = z
      .object({ version: z.literal(1), entries: z.array(z.unknown()) })
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
export function batchHeaderTabRecovery(run: () => void): void {
  if (batch !== null) {
    run();
    return;
  }
  batch = [];
  try {
    run();
  } finally {
    const items = batch;
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
  if (!recoveryEpicIds().some((id) => ids.has(id))) return;
  replaceEntries(
    useTabRecoveryHistory
      .getState()
      .entries.flatMap<TabRecoveryEntry>((entry) => {
        if (entry.kind === "canvas")
          return ids.has(entry.tab.epicId) ? [] : [entry];
        const items = entry.items.filter(
          (item) => item.kind !== "epic" || !ids.has(item.tab.epicId),
        );
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
        if (entry.kind === "header")
          return [
            {
              ...entry,
              items: entry.items.map((item) =>
                item.kind === "draft"
                  ? item
                  : { ...item, canvas: clean(item.canvas, item.tab.epicId) },
              ),
            },
          ];
        const instanceIds = entry.instanceIds.filter((id) => {
          const tile = entry.before.tilesByInstanceId[id];
          return tile !== undefined && !isDeleted(tile, entry.tab.epicId);
        });
        return instanceIds.length === 0 && (entry.paneIds ?? []).length === 0
          ? []
          : [
              {
                ...entry,
                instanceIds,
                before: clean(entry.before, entry.tab.epicId),
                after: clean(entry.after, entry.tab.epicId),
              },
            ];
      }),
  );
}
export function recoveryEpicIds(): readonly string[] {
  return [
    ...new Set(
      useTabRecoveryHistory
        .getState()
        .entries.flatMap((entry) =>
          entry.kind === "canvas"
            ? [entry.tab.epicId]
            : entry.items.flatMap((item) =>
                item.kind === "epic" ? [item.tab.epicId] : [],
              ),
        ),
    ),
  ];
}
export function recoveryDrafts(): readonly LandingDraftTab[] {
  return useTabRecoveryHistory
    .getState()
    .entries.flatMap((entry) =>
      entry.kind === "header"
        ? entry.items.flatMap((item) =>
            item.kind === "draft" ? [item.draft] : [],
          )
        : [],
    );
}
registerExtraImageRootSource({
  hashes: () =>
    recoveryDrafts().flatMap((draft) =>
      collectImageAtoms(draft.content).flatMap((atom) =>
        atom.hash === null ? [] : [atom.hash],
      ),
    ),
  contents: () => recoveryDrafts().map((draft) => draft.content),
  releaseOldest: () => {
    const entries = useTabRecoveryHistory.getState().entries;
    const oldest = entries.find(
      (entry) =>
        entry.kind === "header" &&
        entry.items.some(
          (item) =>
            item.kind === "draft" &&
            collectImageAtoms(item.draft.content).length > 0,
        ),
    );
    if (oldest?.kind !== "header") return false;
    const index = oldest.items.findIndex(
      (item) =>
        item.kind === "draft" &&
        collectImageAtoms(item.draft.content).length > 0,
    );
    const items = oldest.items.filter(
      (_item, itemIndex) => itemIndex !== index,
    );
    replaceEntries(
      entries.flatMap((entry) => {
        if (entry.id !== oldest.id) return [entry];
        return items.length === 0 ? [] : [{ ...oldest, items }];
      }),
    );
    return true;
  },
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
