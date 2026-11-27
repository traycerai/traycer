import { isRecord } from "@/lib/editor/prosemirror-json";
import {
  canonicalJsonStringify,
  isJsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import type {
  DraftBase,
  DraftCloudDocument,
  DraftCloudTombstone,
} from "@traycer/protocol/host/drafts";
import { draftCloudDocumentSchema } from "@traycer/protocol/host/drafts";
import { getImageBytes, sha256Hex } from "@/lib/composer/landing-image-store";
import { sniffImageMimeType } from "@/lib/attachments/image-mime-signature";
import {
  holdOrdinaryDraftImages,
  readOrdinaryDraftBytes,
  readOrdinaryDraftPartition,
  recoverAbandonedOrdinaryDraftStages,
  resetOrdinaryDraftDatabaseForTests,
  resolveOrdinaryDraftScope,
  writeOrdinaryDraftRow,
  type OrdinaryDraftCursor,
  type OrdinaryDraftEditor,
  type OrdinaryDraftEvidence,
  type OrdinaryDraftRow,
  type OrdinaryDraftScope,
} from "./ordinary-draft-db";

export type OrdinaryDraftEntry = DraftCloudDocument | DraftCloudTombstone;

export interface OrdinaryScopeProjection {
  readonly scope: OrdinaryDraftScope;
  readonly rows: Map<string, OrdinaryDraftRow>;
  readonly cursors: Map<string, OrdinaryDraftCursor>;
}

const loadedProjections: OrdinaryScopeProjection[] = [];
let projectionGeneration = 0;

export function resetOrdinaryDraftScopeStorageForTests(): void {
  loadedProjections.length = 0;
  projectionGeneration += 1;
  resetOrdinaryDraftDatabaseForTests();
}

export function currentOrdinaryScopeProjection(
  ownerId: string,
  scopeId: string | null,
): OrdinaryScopeProjection | null {
  return (
    loadedProjections.findLast(
      ({ scope }) =>
        scope.ownerId === ownerId &&
        (scopeId === null || scope.scopeId === scopeId),
    ) ?? null
  );
}

export function retireOrdinaryScopeProjection(
  ownerId: string,
  scopeId: string,
): void {
  const index = loadedProjections.findIndex(
    ({ scope }) => scope.ownerId === ownerId && scope.scopeId === scopeId,
  );
  if (index >= 0) loadedProjections.splice(index, 1);
}

export async function openOrdinaryScopeProjection(
  ownerId: string,
  scopeId: string | null,
): Promise<OrdinaryScopeProjection | null> {
  const loaded = currentOrdinaryScopeProjection(ownerId, scopeId);
  if (loaded !== null) return loaded;
  const generation = projectionGeneration;
  const scope = await resolveOrdinaryDraftScope(ownerId, scopeId);
  if (scope === null) return null;
  const stored = await readOrdinaryDraftPartition(scope.partition);
  if (generation !== projectionGeneration) return null;
  const raced = currentOrdinaryScopeProjection(ownerId, scope.scopeId);
  if (raced !== null) return raced;
  const projection = {
    scope,
    rows: new Map(stored.rows.map((row) => [row.draftId, row])),
    cursors: new Map(stored.cursors.map((cursor) => [cursor.peerId, cursor])),
  };
  loadedProjections.push(projection);
  void recoverAbandonedOrdinaryDraftStages(scope.partition).catch(() => {});
  return projection;
}

export async function acceptOrdinaryDraftAtBase(input: {
  readonly projection: OrdinaryScopeProjection;
  readonly draftId: string;
  readonly base: DraftBase;
  readonly operationId: string;
}): Promise<void> {
  const { projection, draftId, base, operationId } = input;
  const row = await writeOrdinaryDraftRow({
    partition: projection.scope.partition,
    draftId,
    cursor: null,
    stageId: null,
    signal: null,
    decide(previous) {
      const evidence = previous?.evidence;
      if (previous === undefined || evidence === undefined || evidence === null)
        return undefined;
      if (
        evidence.ambiguous ||
        evidence.kind !== "live" ||
        evidence.operationId !== operationId ||
        !sameBase(evidence.base, base)
      )
        return undefined;
      return { ...previous, accepted: base };
    },
  });
  projection.rows.set(row.draftId, row);
}

function vacantRow(partition: string, draftId: string): OrdinaryDraftRow {
  return {
    partition,
    draftId,
    evidence: null,
    accepted: null,
    editor: null,
    recovery: null,
    roots: [],
  };
}

export function ordinaryEvidenceOf(
  entry: OrdinaryDraftEntry,
): OrdinaryDraftEvidence {
  const writeIdentity =
    "head" in entry ? ordinaryEntryWriteIdentity(entry) : undefined;
  if (!isJsonValue(entry)) throw new Error("Invalid ordinary draft evidence");
  return {
    base: entry.base,
    kind: "head" in entry ? "live" : "tombstone",
    operationId: entry.operationId,
    identity: canonicalJsonStringify(entry),
    ...(writeIdentity === undefined ? {} : { writeIdentity }),
    ambiguous: false,
  };
}

export function ordinaryEntryWriteIdentity(entry: DraftCloudDocument): string {
  const { head, draftId } = entry;
  const write = {
    draftId,
    kind: head.surfaceKind,
    target: head.target,
    lastTouchedAt: head.lastTouchedAt,
    workspace: head.hostLocal.workspace,
    portable: head.portable,
  };
  if (!isJsonValue(write)) throw new Error("Invalid ordinary draft evidence");
  return canonicalJsonStringify(write);
}

function sameBase(left: DraftBase, right: DraftBase): boolean {
  return (
    left.revision === right.revision &&
    left.ownerEpoch === right.ownerEpoch &&
    left.headSha256 === right.headSha256
  );
}

function ordinaryEvidenceConflicts(
  previous: OrdinaryDraftEvidence,
  next: OrdinaryDraftEvidence,
): boolean {
  return (
    !sameBase(previous.base, next.base) ||
    previous.kind !== next.kind ||
    (previous.operationId !== undefined &&
      next.operationId !== undefined &&
      previous.operationId !== next.operationId) ||
    (previous.identity !== null &&
      next.identity !== null &&
      previous.identity !== next.identity) ||
    (previous.writeIdentity !== undefined &&
      next.writeIdentity !== undefined &&
      previous.writeIdentity !== next.writeIdentity)
  );
}

function sameOrdinaryEvidenceIdentity(
  left: OrdinaryDraftEvidence,
  right: OrdinaryDraftEvidence,
): boolean {
  return (
    sameBase(left.base, right.base) &&
    left.kind === right.kind &&
    left.operationId === right.operationId &&
    left.identity === right.identity &&
    left.writeIdentity === right.writeIdentity
  );
}

export function mergeOrdinaryEvidence(
  previous: OrdinaryDraftEvidence | null,
  next: OrdinaryDraftEvidence,
  resolved: OrdinaryDraftEvidence | null,
): OrdinaryDraftEvidence | undefined {
  if (previous === null || next.base.revision > previous.base.revision)
    return next;
  if (next.base.revision < previous.base.revision) return undefined;
  if (previous.ambiguous) {
    return resolved?.ambiguous &&
      sameOrdinaryEvidenceIdentity(resolved, previous)
      ? next
      : undefined;
  }
  if (ordinaryEvidenceConflicts(previous, next))
    return { ...previous, ambiguous: true };
  return {
    ...previous,
    operationId:
      previous.operationId === undefined
        ? next.operationId
        : previous.operationId,
    identity: previous.identity ?? next.identity,
    ...(previous.writeIdentity === undefined && next.writeIdentity !== undefined
      ? { writeIdentity: next.writeIdentity }
      : {}),
    ambiguous: next.ambiguous,
  };
}

export async function saveOrdinaryDraftEvidence(input: {
  readonly projection: OrdinaryScopeProjection;
  readonly draftId: string;
  readonly evidence: OrdinaryDraftEvidence;
  readonly cursor: OrdinaryDraftCursor | null;
  readonly resolved: OrdinaryDraftEvidence | null;
  readonly signal: AbortSignal | null;
}): Promise<OrdinaryDraftRow> {
  const { projection, draftId, evidence, cursor, signal, resolved } = input;
  const { partition } = projection.scope;
  const row = await writeOrdinaryDraftRow({
    partition,
    draftId,
    cursor,
    signal,
    stageId: null,
    decide(stored) {
      const previous = stored ?? vacantRow(partition, draftId);
      const current = mergeOrdinaryEvidence(
        previous.evidence,
        evidence,
        resolved,
      );
      return current === undefined
        ? undefined
        : { ...previous, evidence: current };
    },
  });
  projection.rows.set(row.draftId, row);
  if (cursor !== null) projection.cursors.set(cursor.peerId, cursor);
  return row;
}

export async function publishOrdinaryDraftEntry(input: {
  readonly projection: OrdinaryScopeProjection;
  readonly entry: OrdinaryDraftEntry;
  readonly stageId: string | null;
  readonly signal: AbortSignal;
  readonly expectedEditor: string | null;
  readonly isEligible: () => boolean;
}): Promise<OrdinaryDraftRow> {
  const { projection, entry, stageId, signal, expectedEditor, isEligible } =
    input;
  const { partition } = projection.scope;
  const evidence = ordinaryEvidenceOf(entry);
  const row = await writeOrdinaryDraftRow({
    partition,
    draftId: entry.draftId,
    cursor: null,
    stageId,
    signal,
    isCurrent: isEligible,
    decide(stored) {
      if (!isEligible()) return undefined;
      const previous = stored ?? vacantRow(partition, entry.draftId);
      if (
        previous.editor?.dirty ||
        (previous.editor?.occurrence ?? null) !== expectedEditor
      )
        return undefined;
      const current = mergeOrdinaryEvidence(previous.evidence, evidence, null);
      if (current === undefined || current.ambiguous) return undefined;
      return {
        ...previous,
        evidence: current,
        accepted: evidence.base,
        acceptedEntry: "head" in entry ? entry : null,
        editor: null,
        recovery: "head" in entry ? entry : null,
        roots: "head" in entry ? entry.head.portable.blobHashes : [],
      };
    },
  });
  projection.rows.set(row.draftId, row);
  return row;
}

function ordinaryEditorRecovery(
  row: OrdinaryDraftRow,
): DraftCloudDocument | null {
  const { editor, acceptedEntry } = row;
  if (editor === null || acceptedEntry === undefined || acceptedEntry === null)
    return null;
  if (!isRecord(editor.value) || !isRecord(editor.value.value)) return null;
  const { value, sidecar } = editor.value;
  const previous = acceptedEntry.head.portable;
  const modalAnnotations = isRecord(sidecar) ? sidecar.records : undefined;
  const annotations =
    editor.surface === "chat" ? value.browserAnnotations : modalAnnotations;
  const projected = {
    ...previous,
    content: value.content ?? previous.content,
    selection: value.selection,
    composerMode: value.composerMode ?? previous.composerMode,
    runSettings:
      editor.surface === "chat" ? previous.runSettings : value.settings,
    blobHashes: editor.roots ?? row.roots,
    ...("annotations" in previous
      ? { annotations: annotations ?? previous.annotations }
      : {}),
  };
  const result = draftCloudDocumentSchema.safeParse({
    ...acceptedEntry,
    head: { ...acceptedEntry.head, portable: projected },
  });
  return result.success ? result.data : acceptedEntry;
}

export async function parkOrdinaryDraftEditor(input: {
  readonly projection: OrdinaryScopeProjection;
  readonly draftId: string;
  readonly expectedEditor: string;
  readonly isOccupied: () => boolean;
}): Promise<DraftCloudDocument | null> {
  const { projection, draftId, expectedEditor, isOccupied } = input;
  const { partition } = projection.scope;
  const row = await writeOrdinaryDraftRow({
    partition,
    draftId,
    cursor: null,
    stageId: null,
    signal: null,
    decide(previous) {
      if (!isOccupied() || previous?.editor?.occurrence !== expectedEditor)
        return undefined;
      const recovery = ordinaryEditorRecovery(previous);
      if (recovery === null) return undefined;
      return { ...previous, recovery };
    },
  });
  projection.rows.set(row.draftId, row);
  return row.recovery;
}

export async function unparkOrdinaryDraftEditor(input: {
  readonly projection: OrdinaryScopeProjection;
  readonly draftId: string;
  readonly expectedEditor: string;
  readonly isFree: () => boolean;
}): Promise<void> {
  const { projection, draftId, expectedEditor, isFree } = input;
  const row = await writeOrdinaryDraftRow({
    partition: projection.scope.partition,
    draftId,
    cursor: null,
    stageId: null,
    signal: null,
    decide(previous) {
      if (
        !isFree() ||
        previous?.editor?.occurrence !== expectedEditor ||
        previous.recovery === null
      )
        return undefined;
      if (
        !previous.editor.dirty &&
        previous.evidence?.kind === "tombstone" &&
        !previous.evidence.ambiguous
      )
        return undefined;
      return { ...previous, recovery: null };
    },
  });
  projection.rows.set(row.draftId, row);
}

export async function saveOrdinaryDraftEditor(input: {
  readonly projection: OrdinaryScopeProjection;
  readonly draftId: string;
  readonly editor: OrdinaryDraftEditor | null;
  readonly roots: readonly string[];
  readonly expectedEditor: string | null;
  readonly accepted: DraftBase | null;
}): Promise<OrdinaryDraftRow> {
  const { projection, draftId, editor, roots, expectedEditor, accepted } =
    input;
  const { partition } = projection.scope;
  const previousRoots = new Set(projection.rows.get(draftId)?.roots);
  const missing = await Promise.all(
    roots
      .filter((hash) => !previousRoots.has(hash))
      .map(async (hash) => {
        if (await readOrdinaryDraftBytes(partition, hash)) return null;
        const bytes = await getImageBytes(hash);
        if (
          bytes === undefined ||
          sniffImageMimeType(bytes) === null ||
          (await sha256Hex(bytes)) !== hash
        )
          throw new Error("Ordinary draft image is unavailable");
        return [hash, bytes] as const;
      }),
  );
  const images = new Map(missing.filter((entry) => entry !== null));
  const stage =
    images.size === 0
      ? null
      : await holdOrdinaryDraftImages({
          partition,
          images,
          signal: new AbortController().signal,
        });
  try {
    const row = await writeOrdinaryDraftRow({
      partition,
      draftId,
      cursor: null,
      stageId: stage?.stageId ?? null,
      signal: null,
      decide(stored) {
        const previous = stored ?? vacantRow(partition, draftId);
        if ((previous.editor?.occurrence ?? null) !== expectedEditor)
          return undefined;
        if (
          accepted !== null &&
          (previous.accepted === null || !sameBase(previous.accepted, accepted))
        )
          return undefined;
        return {
          ...previous,
          editor,
          acceptedEntry:
            editor === null ? null : (previous.acceptedEntry ?? null),
          roots:
            editor === null
              ? []
              : [
                  ...new Set([
                    ...roots,
                    ...(previous.acceptedEntry?.head.portable.blobHashes ?? []),
                  ]),
                ],
          recovery: null,
        };
      },
    });
    projection.rows.set(row.draftId, row);
    return row;
  } finally {
    await stage?.release();
  }
}
