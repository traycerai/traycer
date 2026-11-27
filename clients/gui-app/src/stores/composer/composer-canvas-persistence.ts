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
  readRootedOrdinaryDraftBytes,
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
export type OrdinaryDraftAcceptance = Pick<
  DraftCloudDocument,
  "draftId" | "base" | "operationId"
>;
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
    if (row.editor === null || row.recovery !== null) continue;
    const ids = visibleEditors.get(row.editor.surface) ?? new Set<string>();
    ids.add(row.draftId);
    visibleEditors.set(row.editor.surface, ids);
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
  return ordinaryDraftScopeBinding === binding ? bytes : undefined;
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
  applyingOrdinaryRows = true;
  try {
    for (const listener of ordinaryDraftScopeListeners) listener(binding);
  } finally {
    applyingOrdinaryRows = false;
  }
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

export async function waitForOrdinaryDraftEditorWrite(
  partition: string,
  draftId: string,
): Promise<void> {
  const key = `${partition}:${draftId}`;
  let pending = editorTails.get(key);
  while (pending !== undefined) {
    await pending;
    pending = editorTails.get(key);
  }
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
  const before = editorTails.get(key) ?? Promise.resolve();
  const tail = before
    .then(persist)
    .catch(() => {
      appLogger.debug("[draft-mirror] ordinary editor write withheld", {
        code: "ordinary-draft-editor-write-refused",
        draftId,
      });
      if (
        binding !== ordinaryDraftScopeBinding ||
        editorTails.get(key) !== tail
      )
        return;
      const retry = setTimeout(() => {
        pendingEditorRetries.delete(key);
        if (binding === ordinaryDraftScopeBinding)
          enqueueOrdinaryEditorWrite(projection, draftId, persist);
      }, ORDINARY_WRITE_RETRY_MS);
      pendingEditorRetries.set(key, retry);
    })
    .finally(() => {
      if (editorTails.get(key) === tail) editorTails.delete(key);
    });
  editorTails.set(key, tail);
}

export function persistOrdinaryDraftEditor(
  surface: OrdinaryDraftEditorSurface,
  changes: readonly OrdinaryDraftEditorChange[],
  accepted: OrdinaryDraftAcceptance | undefined,
): boolean {
  const binding = ordinaryDraftScopeBinding;
  if (binding === null) return false;
  if (applyingOrdinaryRows) return true;
  const projection = currentOrdinaryScopeProjection(
    binding.ownerId,
    binding.scopeId,
  );
  if (projection === null) return false;
  const previousVisible = visibleEditors.get(surface);
  const visible = new Set(changes.map((change) => change.draftId));
  visibleEditors.set(surface, visible);
  for (const draftId of previousVisible ?? []) {
    if (visible.has(draftId)) continue;
    enqueueOrdinaryEditorWrite(projection, draftId, async () => {
      const editor = projection.rows.get(draftId)?.editor;
      if (editor?.surface !== surface) return;
      await saveOrdinaryDraftEditor({
        projection,
        draftId,
        editor: null,
        roots: [],
        expectedEditor: editor.occurrence,
        accepted: null,
      });
    });
  }
  for (const change of changes) {
    const { draftId, slot, roots, dirty, value, sidecar } = change;
    if (!projection.rows.has(draftId)) continue;
    const next = { value, sidecar };
    enqueueOrdinaryEditorWrite(projection, draftId, async () => {
      const previous = projection.rows.get(draftId)?.editor ?? null;
      if (
        previous?.surface === surface &&
        previous.slot === slot &&
        previous.dirty === dirty &&
        JSON.stringify(previous.value) === JSON.stringify(next)
      )
        return;
      await saveOrdinaryDraftEditor({
        projection,
        draftId,
        editor: {
          surface,
          slot,
          value: next,
          dirty,
          roots,
          occurrence: crypto.randomUUID(),
        },
        roots,
        expectedEditor: previous?.occurrence ?? null,
        accepted: accepted?.draftId === draftId ? accepted.base : null,
      });
    });
  }
  return true;
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
