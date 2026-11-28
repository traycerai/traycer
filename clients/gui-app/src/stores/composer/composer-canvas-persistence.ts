import type { StateStorage } from "zustand/middleware";
import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";
import type {
  DraftBase,
  DraftCloudDocument,
} from "@traycer/protocol/host/drafts";
import {
  currentOrdinaryScopeProjection,
  openOrdinaryScopeProjection,
  retireOrdinaryScopeProjection,
  saveOrdinaryDraftEditor,
  type OrdinaryScopeProjection,
} from "@/lib/drafts/ordinary-draft-scope";
import { appLogger } from "@/lib/logger";
import {
  onOrdinaryDraftSiblingWipe,
  readRootedOrdinaryDraftBytes,
  type OrdinaryDraftEditor,
  type OrdinaryDraftRow,
} from "@/lib/drafts/ordinary-draft-db";
import type { ImageBytes } from "@/lib/attachments/image-bytes";

import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  collectAnnotationImageHashes,
  parseBrowserAnnotationRecords,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  composerCanvasAnnotationsKey,
  composerCanvasAnnotationsKeyPrefix,
} from "@/lib/persist";

export type CanvasAnnotationsByChat = Partial<
  Record<string, ReadonlyArray<CanvasAnnotationRecord>>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canvasAnnotations(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): ReadonlyArray<CanvasAnnotationRecord> {
  return records.filter(
    (record): record is CanvasAnnotationRecord =>
      record.source.kind === "canvas",
  );
}

function windowStorage(): {
  readonly storage: Storage;
  readonly key: string;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
    const windows: unknown = isRecord(runnerHost) ? runnerHost.windows : null;
    if (
      isRecord(windows) &&
      typeof windows.windowId === "string" &&
      windows.windowId.length > 0
    ) {
      return {
        storage: window.localStorage,
        key: composerCanvasAnnotationsKey(windows.windowId),
      };
    }
    // A web tab has no shell window identity. Its session storage survives a
    // reload without making the draft part of the shared localStorage bucket.
    return {
      storage: window.sessionStorage,
      key: composerCanvasAnnotationsKey("session"),
    };
  } catch {
    return null;
  }
}

function parseCanvasAnnotations(raw: string | null): CanvasAnnotationsByChat {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([chatId, records]) => [
        chatId,
        canvasAnnotations(parseBrowserAnnotationRecords(records)),
      ]),
    );
  } catch {
    return {};
  }
}

/** Complete sidecars stay local to their native window, including across reload. */
export function persistWindowCanvasAnnotations(
  drafts: Partial<
    Record<
      string,
      { readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord> }
    >
  >,
): void {
  const target = windowStorage();
  if (target === null) return;
  const entries = Object.entries(drafts).flatMap(([chatId, draft]) => {
    const records =
      draft === undefined ? [] : canvasAnnotations(draft.browserAnnotations);
    return records.length === 0 ? [] : [[chatId, records]];
  });
  try {
    if (entries.length === 0) target.storage.removeItem(target.key);
    else
      target.storage.setItem(
        target.key,
        JSON.stringify(Object.fromEntries(entries)),
      );
  } catch {
    // Storage may be unavailable or full; the in-memory draft remains sendable.
  }
}

export function readWindowCanvasAnnotations(): CanvasAnnotationsByChat {
  const target = windowStorage();
  if (target === null) return {};
  try {
    return parseCanvasAnnotations(target.storage.getItem(target.key));
  } catch {
    return {};
  }
}

/** A second renderer's shared image GC must retain crops saved by other windows. */
export function persistedCanvasAnnotationImageHashes(): ReadonlyArray<string> {
  if (typeof window === "undefined") return [];
  const records: CanvasAnnotationRecord[] = [];
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (
          key === null ||
          !key.startsWith(composerCanvasAnnotationsKeyPrefix())
        )
          continue;
        records.push(
          ...Object.values(
            parseCanvasAnnotations(storage.getItem(key)),
          ).flatMap((annotations) => annotations ?? []),
        );
      }
    }
  } catch {
    // In-memory roots still protect the current window if storage is blocked.
  }
  return collectAnnotationImageHashes(records);
}

export type OrdinaryRecoveryDrafts = Partial<
  Record<string, DraftCloudDocument>
>;

export interface OrdinaryDraftScopeBinding {
  readonly ownerId: string;
  readonly scopeId: string;
}

export interface PersistedOrdinaryDraftBase {
  readonly draftId: string;
  readonly base: DraftBase;
  readonly kind: "live" | "tombstone";
  readonly operationId: string | null | undefined;
  readonly identity: string | null;
  readonly writeIdentity?: string;
  readonly accepted: DraftBase | null;
  readonly ambiguous: boolean;
}

export interface PersistedModalDraftSidecar {
  readonly records: ReadonlyArray<BrowserAnnotationRecord>;
  readonly dirty: boolean;
}

export type PersistedModalDraftSidecars = Readonly<
  Partial<Record<string, PersistedModalDraftSidecar>>
>;

export type OrdinaryDraftEditorSurface = "chat" | "modal" | "landing";
interface OrdinaryDraftWindowScope {
  readonly binding: OrdinaryDraftScopeBinding;
  readonly drafts: OrdinaryRecoveryDrafts;
  readonly bases: ReadonlyArray<PersistedOrdinaryDraftBase>;
  readonly modalSidecars: PersistedModalDraftSidecars;
  readonly editors: Readonly<Record<OrdinaryDraftEditorSurface, unknown>>;
  readonly frontiers: ReadonlyArray<{
    readonly peerId: string;
    readonly seq: number;
  }>;
}

export async function loadWindowOrdinaryDraftScope(
  ownerId: string,
  scopeId: string | null,
): Promise<OrdinaryDraftWindowScope | null> {
  await openOrdinaryScopeProjection(ownerId, scopeId);
  return readWindowOrdinaryDraftScope(ownerId, scopeId);
}

let applyingOrdinaryRows = false;
const ordinaryRowListeners = new Set<
  (rows: readonly OrdinaryDraftRow[]) => void
>();

export function isApplyingOrdinaryDraftRows(): boolean {
  return applyingOrdinaryRows;
}

export function ordinaryDraftOverlayStorage(): StateStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => {
      if (!applyingOrdinaryRows) window.localStorage.setItem(key, value);
    },
    removeItem: (key) => window.localStorage.removeItem(key),
  };
}

export function onCommittedOrdinaryDraftRows(
  listener: (rows: readonly OrdinaryDraftRow[]) => void,
): void {
  ordinaryRowListeners.add(listener);
}

export function showCommittedOrdinaryDraftRows(
  binding: OrdinaryDraftScopeBinding,
  rows: readonly OrdinaryDraftRow[],
): void {
  if (ordinaryDraftScopeBinding !== binding) return;
  for (const row of rows) {
    for (const ids of visibleEditors.values()) ids.delete(row.draftId);
    visibleEditorRows.delete(row.draftId);
    if (row.editor === null || row.recovery !== null) continue;
    const ids = visibleEditors.get(row.editor.surface) ?? new Set<string>();
    ids.add(row.draftId);
    visibleEditors.set(row.editor.surface, ids);
    visibleEditorRows.set(row.draftId, row);
  }
  applyingOrdinaryRows = true;
  try {
    for (const listener of ordinaryRowListeners) listener(rows);
  } finally {
    applyingOrdinaryRows = false;
  }
}

let ordinaryDraftScopeBinding: OrdinaryDraftScopeBinding | null = null;
const ordinaryDraftScopeListeners = new Set<
  (binding: OrdinaryDraftScopeBinding | null) => void
>();
const ordinaryDraftPartitionListeners = new Set<() => void>();

export function currentOrdinaryDraftScopeBinding(): OrdinaryDraftScopeBinding | null {
  return ordinaryDraftScopeBinding;
}

export async function readCurrentOrdinaryDraftImageBytes(
  hash: string,
): Promise<ImageBytes | undefined> {
  const binding = ordinaryDraftScopeBinding;
  if (binding === null) return undefined;
  const projection = currentOrdinaryScopeProjection(
    binding.ownerId,
    binding.scopeId,
  );
  if (projection === null) return undefined;
  const bytes = await readRootedOrdinaryDraftBytes(
    projection.scope.partition,
    hash,
  );
  return ordinaryDraftScopeBinding === binding &&
    currentOrdinaryScopeProjection(binding.ownerId, binding.scopeId) ===
      projection
    ? bytes
    : undefined;
}

export function setOrdinaryDraftScopeBinding(
  binding: OrdinaryDraftScopeBinding | null,
): void {
  if (
    ordinaryDraftScopeBinding?.ownerId === binding?.ownerId &&
    ordinaryDraftScopeBinding?.scopeId === binding?.scopeId
  )
    return;
  const previous = ordinaryDraftScopeBinding;
  ordinaryDraftScopeBinding = binding;
  if (previous !== null)
    retireOrdinaryScopeProjection(previous.ownerId, previous.scopeId);
  visibleEditors.clear();
  visibleEditorRows.clear();
  ordinaryEditorIntents.clear();
  applyingOrdinaryRows = true;
  try {
    for (const listener of ordinaryDraftScopeListeners) listener(binding);
  } finally {
    applyingOrdinaryRows = false;
  }
  for (const listener of ordinaryDraftPartitionListeners) listener();
}

export function onOrdinaryDraftScopeChanged(
  listener: (binding: OrdinaryDraftScopeBinding | null) => void,
): () => void {
  ordinaryDraftScopeListeners.add(listener);
  return () => {
    ordinaryDraftScopeListeners.delete(listener);
  };
}

export function currentOrdinaryDraftPartition(): string | null {
  const binding = ordinaryDraftScopeBinding;
  if (binding === null) return null;
  return (
    currentOrdinaryScopeProjection(binding.ownerId, binding.scopeId)?.scope
      .partition ?? null
  );
}

export function onOrdinaryDraftPartitionChanged(
  listener: () => void,
): () => void {
  ordinaryDraftPartitionListeners.add(listener);
  return () => {
    ordinaryDraftPartitionListeners.delete(listener);
  };
}

function activeOrdinaryLandingStorage(): {
  readonly storage: Storage;
  readonly key: string;
} | null {
  const partition = currentOrdinaryDraftPartition();
  const windowScope = windowStorage();
  if (partition === null || windowScope === null) return null;
  return {
    storage: windowScope.storage,
    key: `${windowScope.key}:ordinary-landing-active:${partition}`,
  };
}

export function readActiveOrdinaryLandingDraft(): string | null {
  const target = activeOrdinaryLandingStorage();
  if (target === null) return null;
  try {
    return target.storage.getItem(target.key);
  } catch {
    return null;
  }
}

export function saveActiveOrdinaryLandingDraft(draftId: string | null): void {
  const target = activeOrdinaryLandingStorage();
  if (target === null) return;
  try {
    if (draftId === null) target.storage.removeItem(target.key);
    else target.storage.setItem(target.key, draftId);
  } catch {
    // A denied view preference must not prevent editing the durable draft.
  }
}

export function readOrdinaryDraftEditor(
  surface: OrdinaryDraftEditorSurface,
): unknown {
  const binding = ordinaryDraftScopeBinding;
  return binding === null
    ? undefined
    : readWindowOrdinaryDraftScope(binding.ownerId, binding.scopeId)?.editors[
        surface
      ];
}

export interface OrdinaryDraftEditorChange {
  readonly draftId: string;
  readonly slot: string;
  readonly value: unknown;
  readonly roots: readonly string[];
  readonly dirty: boolean;
  readonly sidecar?: PersistedModalDraftSidecar;
}

const editorTails = new Map<string, Promise<void>>();
const pendingEditorRetries = new Map<string, TimerHandle>();
const ORDINARY_WRITE_RETRY_MS = 1_000;
const visibleEditors = new Map<OrdinaryDraftEditorSurface, Set<string>>();
const visibleEditorRows = new Map<string, OrdinaryDraftRow>();
interface OrdinaryEditorIntent {
  readonly source: OrdinaryDraftRow;
  readonly editor: OrdinaryDraftEditor;
  readonly roots: readonly string[];
}
const ordinaryEditorIntents = new Map<string, OrdinaryEditorIntent>();
let reopeningScope: OrdinaryDraftScopeBinding | null = null;

onOrdinaryDraftSiblingWipe(() => {
  for (const retry of pendingEditorRetries.values()) clearTimeout(retry);
  pendingEditorRetries.clear();
  const binding = ordinaryDraftScopeBinding;
  if (binding === null) return;
  reopeningScope = binding;
  for (const listener of ordinaryDraftPartitionListeners) listener();
  void openOrdinaryScopeProjection(binding.ownerId, binding.scopeId)
    .then((projection) => {
      if (projection === null || ordinaryDraftScopeBinding !== binding) return;
      for (const listener of ordinaryDraftPartitionListeners) listener();
      for (const intent of ordinaryEditorIntents.values())
        queueOrdinaryEditorIntent(projection, intent);
    })
    .catch(() => {})
    .finally(() => {
      if (reopeningScope === binding) reopeningScope = null;
    });
});

export function shownOrdinaryDraftBase(
  draftId: string,
  ownerId: string | null,
  scopeId: string,
): DraftBase | null | undefined {
  const binding = ordinaryDraftScopeBinding;
  if (
    binding === null ||
    binding.ownerId !== ownerId ||
    binding.scopeId !== scopeId
  )
    return undefined;
  return visibleEditorRows.get(draftId)?.accepted;
}

export function acknowledgeShownOrdinaryDraftRow(row: OrdinaryDraftRow): void {
  if (
    visibleEditorRows.get(row.draftId)?.editor?.occurrence ===
      row.editor?.occurrence &&
    row.editor !== null
  )
    visibleEditorRows.set(row.draftId, row);
}

const editorDeliveries = new Map<string, Set<Promise<void>>>();

export function holdOrdinaryDraftEditorWrites(
  partition: string,
  draftIds: readonly string[],
): () => void {
  const completion = Promise.withResolvers<void>();
  const keys = draftIds.map((id) => `${partition}:${id}`);
  for (const key of keys) {
    const holds = editorDeliveries.get(key) ?? new Set<Promise<void>>();
    holds.add(completion.promise);
    editorDeliveries.set(key, holds);
  }
  return () => {
    for (const key of keys) {
      const holds = editorDeliveries.get(key);
      holds?.delete(completion.promise);
      if (holds?.size === 0) editorDeliveries.delete(key);
    }
    completion.resolve();
  };
}

export function ordinaryDraftEditorWriteIsPending(
  partition: string,
  draftId: string,
): boolean {
  const key = `${partition}:${draftId}`;
  return editorTails.has(key) || pendingEditorRetries.has(key);
}

const ordinaryEditorSettledListeners = new Set<() => void>();

export function onOrdinaryDraftEditorWriteCommitted(
  listener: () => void,
): void {
  ordinaryEditorSettledListeners.add(listener);
}

export async function waitForOrdinaryDraftEditorWrite(
  partition: string,
  draftId: string,
): Promise<boolean> {
  const key = `${partition}:${draftId}`;
  let pending = editorTails.get(key);
  while (pending !== undefined) {
    await pending;
    pending = editorTails.get(key);
  }
  return !pendingEditorRetries.has(key);
}

function enqueueOrdinaryEditorWrite(
  projection: OrdinaryScopeProjection,
  draftId: string,
  persist: () => Promise<void>,
): void {
  const key = `${projection.scope.partition}:${draftId}`;
  const scheduled = pendingEditorRetries.get(key);
  if (scheduled !== undefined) {
    clearTimeout(scheduled);
    pendingEditorRetries.delete(key);
  }
  const binding = ordinaryDraftScopeBinding;
  const isCurrent = () =>
    binding === ordinaryDraftScopeBinding &&
    currentOrdinaryScopeProjection(
      projection.scope.ownerId,
      projection.scope.scopeId,
    ) === projection;
  const before = editorTails.get(key);
  const deliveries = editorDeliveries.get(key);
  let wrote = false;
  const tail = Promise.all([before, ...(deliveries ?? [])])
    .then(async () => {
      if (!isCurrent()) return;
      await persist();
      wrote = true;
    })
    .catch(() => {
      appLogger.debug("[draft-mirror] ordinary editor write withheld", {
        code: "ordinary-draft-editor-write-refused",
        draftId,
      });
      if (!isCurrent() || editorTails.get(key) !== tail) return;
      const retry = setTimeout(() => {
        pendingEditorRetries.delete(key);
        if (isCurrent())
          enqueueOrdinaryEditorWrite(projection, draftId, persist);
      }, ORDINARY_WRITE_RETRY_MS);
      pendingEditorRetries.set(key, retry);
    })
    .finally(() => {
      if (editorTails.get(key) !== tail) return;
      editorTails.delete(key);
      if (wrote && isCurrent())
        for (const listener of ordinaryEditorSettledListeners) listener();
    });
  editorTails.set(key, tail);
}

function trackVisibleOrdinaryEditors(
  surface: OrdinaryDraftEditorSurface,
  changes: readonly OrdinaryDraftEditorChange[],
  previous: ReadonlySet<string>,
  projection: OrdinaryScopeProjection | null,
): ReadonlySet<string> {
  const visible = new Set(
    changes.flatMap(({ draftId }) => {
      const row = projection?.rows.get(draftId);
      return previous.has(draftId) ||
        (row?.editor?.surface === surface && row.recovery === null)
        ? [draftId]
        : [];
    }),
  );
  visibleEditors.set(surface, visible);
  if (applyingOrdinaryRows) {
    for (const draftId of visible) {
      const row = projection?.rows.get(draftId);
      if (
        row?.editor?.surface === surface &&
        row.recovery === null &&
        !visibleEditorRows.has(draftId)
      )
        visibleEditorRows.set(draftId, row);
    }
  }
  return visible;
}

export function persistOrdinaryDraftEditor(
  surface: OrdinaryDraftEditorSurface,
  changes: readonly OrdinaryDraftEditorChange[],
): boolean {
  const binding = ordinaryDraftScopeBinding;
  if (binding === null) return false;
  const projection = currentOrdinaryScopeProjection(
    binding.ownerId,
    binding.scopeId,
  );
  if (projection === null && reopeningScope !== binding) return false;
  const previousVisible = visibleEditors.get(surface) ?? new Set<string>();
  const visible = trackVisibleOrdinaryEditors(
    surface,
    changes,
    previousVisible,
    projection,
  );
  if (applyingOrdinaryRows) return true;
  removeClosedOrdinaryEditors(surface, previousVisible, visible, projection);
  for (const change of changes) {
    const { draftId, slot, roots, dirty, value, sidecar } = change;
    const source =
      visibleEditorRows.get(draftId) ?? projection?.rows.get(draftId);
    if (source === undefined) continue;
    const intent: OrdinaryEditorIntent = {
      source,
      editor: {
        surface,
        slot: source.editor?.surface === surface ? source.editor.slot : slot,
        value: { value, sidecar },
        dirty,
        roots,
        occurrence: crypto.randomUUID(),
      },
      roots,
    };
    ordinaryEditorIntents.set(draftId, intent);
    if (projection !== null) queueOrdinaryEditorIntent(projection, intent);
  }
  return true;
}

function removeClosedOrdinaryEditors(
  surface: OrdinaryDraftEditorSurface,
  previousVisible: ReadonlySet<string>,
  visible: ReadonlySet<string>,
  projection: OrdinaryScopeProjection | null,
): void {
  for (const draftId of previousVisible) {
    if (visible.has(draftId)) continue;
    const source =
      visibleEditorRows.get(draftId) ?? projection?.rows.get(draftId);
    visibleEditorRows.delete(draftId);
    ordinaryEditorIntents.delete(draftId);
    if (projection === null || source?.editor?.surface !== surface) continue;
    enqueueOrdinaryEditorWrite(projection, draftId, async () => {
      await saveOrdinaryDraftEditor({
        projection,
        source,
        editor: null,
        roots: [],
      });
    });
  }
}

function queueOrdinaryEditorIntent(
  projection: OrdinaryScopeProjection,
  intent: OrdinaryEditorIntent,
): void {
  const { source, editor, roots } = intent;
  const { draftId } = source;
  enqueueOrdinaryEditorWrite(projection, draftId, async () => {
    const previous = projection.rows.get(draftId)?.editor;
    if (
      previous?.surface !== editor.surface ||
      previous.slot !== editor.slot ||
      previous.dirty !== editor.dirty ||
      JSON.stringify(previous.value) !== JSON.stringify(editor.value)
    ) {
      const saved = await saveOrdinaryDraftEditor({
        projection,
        source,
        editor,
        roots,
      });
      if (
        currentOrdinaryScopeProjection(
          projection.scope.ownerId,
          projection.scope.scopeId,
        ) === projection &&
        visibleEditors.get(editor.surface)?.has(draftId)
      )
        visibleEditorRows.set(draftId, saved);
    }
    if (
      ordinaryEditorIntents.get(draftId) === intent &&
      currentOrdinaryScopeProjection(
        projection.scope.ownerId,
        projection.scope.scopeId,
      ) === projection
    )
      ordinaryEditorIntents.delete(draftId);
  });
}

export function readWindowOrdinaryDraftScope(
  ownerId: string,
  scopeId: string | null,
): OrdinaryDraftWindowScope | null {
  const projection = currentOrdinaryScopeProjection(ownerId, scopeId);
  if (projection === null) return null;
  const drafts: [string, DraftCloudDocument][] = [];
  const bases: PersistedOrdinaryDraftBase[] = [];
  const modalSidecars: [string, PersistedModalDraftSidecar][] = [];
  const chat: [string, unknown][] = [];
  const modal: [string, unknown][] = [];
  const landing: unknown[] = [];
  for (const row of projection.rows.values()) {
    if (row.evidence !== null)
      bases.push({
        draftId: row.draftId,
        ...row.evidence,
        accepted: row.accepted,
      });
    if (row.recovery !== null) drafts.push([row.draftId, row.recovery]);
    const editor = row.editor;
    if (editor === null || row.recovery !== null || !isRecord(editor.value))
      continue;
    const { value, sidecar } = editor.value;
    if (editor.surface === "chat") chat.push([editor.slot, value]);
    else if (editor.surface === "landing") landing.push(value);
    else {
      modal.push([editor.slot, value]);
      if (isRecord(sidecar))
        modalSidecars.push([
          editor.slot,
          {
            records: parseBrowserAnnotationRecords(sidecar.records),
            dirty: sidecar.dirty === true,
          },
        ]);
    }
  }
  return {
    binding: projection.scope,
    drafts: Object.fromEntries(drafts),
    bases,
    modalSidecars: Object.fromEntries(modalSidecars),
    frontiers: [...projection.cursors.values()],
    editors: {
      chat: Object.fromEntries(chat),
      modal: Object.fromEntries(modal),
      landing: { drafts: landing, activeDraftId: null },
    },
  };
}
