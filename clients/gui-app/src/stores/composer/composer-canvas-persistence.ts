import type {
  DraftBase,
  DraftCloudDocument,
} from "@traycer/protocol/host/drafts";
import {
  currentOrdinaryScopeProjection,
  openOrdinaryScopeProjection,
  retireOrdinaryScopeProjection,
  saveOrdinaryDraftEvidence,
  saveOrdinaryDraftEditor,
  type OrdinaryScopeProjection,
} from "@/lib/drafts/ordinary-draft-scope";
import { appLogger } from "@/lib/logger";
import {
  readRootedOrdinaryDraftBytes,
  type OrdinaryDraftEvidence,
  writeOrdinaryDraftCursor,
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

export function updateWindowOrdinaryDraftScope(
  binding: OrdinaryDraftScopeBinding,
  update: Pick<OrdinaryDraftWindowScope, "bases" | "frontiers"> & {
    readonly cursorDraftId?: string;
    readonly resolutions?: ReadonlyMap<string, OrdinaryDraftEvidence>;
  },
): boolean {
  const projection = currentOrdinaryScopeProjection(
    binding.ownerId,
    binding.scopeId,
  );
  if (projection === null) return false;
  const newer = update.frontiers.find(
    ({ peerId, seq }) => seq > (projection.cursors.get(peerId)?.seq ?? -1),
  );
  const cursor =
    newer === undefined
      ? null
      : { ...newer, partition: projection.scope.partition };
  let cursorScheduled = false;
  for (const { draftId, accepted: _accepted, ...evidence } of update.bases) {
    const advancesCursor =
      cursor !== null &&
      (update.cursorDraftId === undefined || update.cursorDraftId === draftId);
    const previous = projection.rows.get(draftId)?.evidence ?? null;
    if (
      !advancesCursor &&
      JSON.stringify(previous) === JSON.stringify(evidence)
    )
      continue;
    if (advancesCursor) cursorScheduled = true;
    void saveOrdinaryDraftEvidence({
      projection,
      draftId,
      evidence,
      cursor: advancesCursor ? cursor : null,
      resolved: update.resolutions?.get(draftId) ?? null,
      signal: null,
    }).catch(() => {
      appLogger.debug("[draft-mirror] ordinary evidence write withheld", {
        code: "ordinary-draft-evidence-write-refused",
        draftId,
      });
    });
  }
  if (cursor !== null && !cursorScheduled) {
    void writeOrdinaryDraftCursor(cursor)
      .then(() => {
        projection.cursors.set(cursor.peerId, cursor);
      })
      .catch(() => {});
  }
  return true;
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
  for (const listener of ordinaryDraftScopeListeners) listener(binding);
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
  const before = editorTails.get(key) ?? Promise.resolve();
  const tail = before
    .then(persist)
    .catch(() => {
      appLogger.debug("[draft-mirror] ordinary editor write withheld", {
        code: "ordinary-draft-editor-write-refused",
        draftId,
      });
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
