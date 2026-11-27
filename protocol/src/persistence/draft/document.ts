import { z } from "zod";
import {
  canonicalJsonStringify,
  canonicalizeJsonObject,
  isJsonObject,
  isJsonValue,
  readJsonProperty,
  type JsonObject,
  type JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  chatHeadAddressPartSchema,
  type ChatHeadAddressPart,
} from "@traycer/protocol/persistence/chat-sync/head";
import type { ChatRunSettingsPreUltracode } from "@traycer/protocol/persistence/epic/foundation";
import {
  draftComposerHeadSchemaV11,
  draftHeadReaderSchema,
  draftOperationIdSchema,
  type DraftComposerPortable,
  type DraftComposerPortableV11,
  type DraftHeadRecord,
  type DraftHeadReaderRecord,
  type DraftHostLocal,
  type DraftInterviewPortable,
  type DraftStashPortable,
  type DraftWorkspaceSnapshot,
} from "@traycer/protocol/persistence/draft/schemas";
import {
  DRAFT_HEAD_DIALECT,
  DRAFT_HEAD_SCHEMA_VERSION,
  DRAFT_HEAD_SCHEMA_VERSION_V11,
  draftHeadSchemaVersionSchemaV11,
} from "@traycer/protocol/persistence/draft/version";
import { sha256HexSchema } from "@traycer/protocol/persistence/chat-sync/version";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The one key the sync layer reads inside a draft head document.
 *
 * **Reserved.** No modeled field of the `draft-head` record may ever be
 * called this. The decoder strips it before parsing so a stale envelope
 * cannot land on the payload and be re-emitted on the next publish.
 *
 * Same tenant seam as `CHAT_HEAD_PARTS_KEY`: when a head is swapped, the
 * parts the old head named and the new one does not are owed a deletion.
 */
export const DRAFT_HEAD_PARTS_KEY = "parts";

const draftMutationFields = {
  operationId: draftOperationIdSchema,
  requestSha256: sha256HexSchema,
} as const;

export const draftHeadDocumentPayloadSchemaV11 = lazySchema(() =>
  draftComposerHeadSchemaV11.extend(draftMutationFields),
);
export type DraftHeadDocumentV11 = z.infer<
  typeof draftHeadDocumentPayloadSchemaV11
>;

export const draftTombstoneDocumentSchemaV11 = lazySchema(() =>
  z.strictObject({
    dialect: z.literal(DRAFT_HEAD_DIALECT),
    schemaVersion: draftHeadSchemaVersionSchemaV11,
    kind: z.literal("tombstone"),
    parts: z.tuple([]),
    ...draftMutationFields,
  }),
);
export type DraftTombstoneDocumentV11 = z.infer<
  typeof draftTombstoneDocumentSchemaV11
>;

/**
 * `draft/v1` names no content-addressed shards. Images travel as chat-blobs
 * (`blobHashes`); the dialect document is small enough to live in the head.
 * The envelope is therefore always empty — it still has to exist, because
 * the sync server reads `parts` and interprets nothing else.
 */
export function listDraftHeadPartAddresses(
  _record: DraftHeadReaderRecord | DraftHeadDocumentV11,
): readonly ChatHeadAddressPart[] {
  return [];
}

function encodeJsonContent(content: JsonContent): JsonValue {
  if (!isJsonValue(content)) {
    throw new Error("Draft content is not JSON");
  }
  return content;
}

function encodeRunSettings(settings: ChatRunSettingsPreUltracode): JsonObject {
  return {
    harnessId: settings.harnessId,
    model: settings.model,
    permissionMode: settings.permissionMode,
    reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
    agentMode: settings.agentMode,
    profileId: settings.profileId,
  };
}

function encodeRunSettingsV11(
  runSettings: DraftComposerPortableV11["runSettings"],
): JsonValue {
  if (runSettings === null) return null;
  const { profileBinding, ...required } = runSettings;
  const settings =
    profileBinding === undefined ? required : { ...required, profileBinding };
  if (!isJsonValue(settings)) {
    throw new Error("Draft run settings are not JSON");
  }
  return settings;
}

function encodeComposerPortable(
  portable: DraftComposerPortable,
  runSettings: JsonValue,
): JsonObject {
  return {
    content: encodeJsonContent(portable.content),
    selection:
      portable.selection === null
        ? null
        : { from: portable.selection.from, to: portable.selection.to },
    runSettings,
    composerMode: portable.composerMode,
    blobHashes: [...portable.blobHashes],
    closed: portable.closed,
  };
}

function encodeInterviewPortable(portable: DraftInterviewPortable): JsonObject {
  return {
    pageIndex: portable.pageIndex,
    answers: portable.answers.map((answer) => ({
      selected: [...answer.selected],
      otherText: answer.otherText,
      otherSelected: answer.otherSelected,
    })),
  };
}

function encodeStashPortable(portable: DraftStashPortable): JsonObject {
  return {
    content: encodeJsonContent(portable.content),
    blobHashes: [...portable.blobHashes],
    createdAt: portable.createdAt,
    annotations: encodeAnnotations(portable.annotations),
  };
}

/**
 * Annotation records are already plain JSON by construction (the schema admits
 * nothing else), so this is a guard rather than a conversion - the same shape
 * `encodeJsonContent` uses, and for the same reason: a value that is not JSON
 * must fail HERE, not silently produce an undecodable document.
 */
function encodeAnnotations(
  annotations:
    | DraftStashPortable["annotations"]
    | DraftComposerPortableV11["annotations"],
): JsonValue {
  const records = [...annotations];
  if (!isJsonValue(records)) {
    throw new Error("Draft annotations are not JSON");
  }
  return records;
}

function encodeWorkspace(workspace: DraftWorkspaceSnapshot): JsonObject {
  const folderInfoByPath: JsonObject = Object.create(null);
  for (const [path, info] of Object.entries(workspace.folderInfoByPath)) {
    Object.defineProperty(folderInfoByPath, path, {
      value: {
        path: info.path,
        name: info.name,
        repoIdentifier:
          info.repoIdentifier === null
            ? null
            : {
                owner: info.repoIdentifier.owner,
                repo: info.repoIdentifier.repo,
              },
        hostId: info.hostId,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    folders: [...workspace.folders],
    folderInfoByPath,
    primaryPath: workspace.primaryPath,
  };
}

function encodeHostLocal(hostLocal: DraftHostLocal): JsonObject {
  return {
    hostId: hostLocal.hostId,
    workspace:
      hostLocal.workspace === null
        ? null
        : encodeWorkspace(hostLocal.workspace),
  };
}

function encodePortable(record: DraftHeadRecord): JsonObject {
  switch (record.kind) {
    case "draft":
      return encodeComposerPortable(
        record.portable,
        record.portable.runSettings === null
          ? null
          : encodeRunSettings(record.portable.runSettings),
      );
    case "interview":
      return encodeInterviewPortable(record.portable);
    case "stash-entry":
      return encodeStashPortable(record.portable);
  }
}

/**
 * Domain head -> canonical persisted JSON for the PAYLOAD.
 *
 * Building block only. Carries no `parts` envelope, so it is neither what
 * gets stored nor what a head is addressed by. There is no public
 * payload-only serializer — hashing these bytes would name a document
 * nobody stored (the chat-head trap).
 */
export function encodeDraftHead(record: DraftHeadRecord): JsonObject {
  return canonicalizeJsonObject(
    encodeDraftHeadPayload(record, encodePortable(record)),
  );
}

function encodeDraftHeadPayload(
  record: DraftHeadRecord | DraftHeadDocumentV11,
  portable: JsonObject,
): JsonObject {
  const payload: JsonObject = {
    dialect: DRAFT_HEAD_DIALECT,
    schemaVersion: {
      major: DRAFT_HEAD_SCHEMA_VERSION.major,
      minor: record.schemaVersion.minor,
    },
    kind: record.kind,
    lastTouchedAt: record.lastTouchedAt,
    target: {
      epicId: record.target.epicId,
      chatId: record.target.chatId,
      blockId: record.target.blockId,
    },
    portable,
    hostLocal: encodeHostLocal(record.hostLocal),
  };
  if (record.kind === "draft") {
    payload.surfaceKind = record.surfaceKind;
  }
  return payload;
}

function withPartsEnvelope(
  record: DraftHeadRecord | DraftHeadDocumentV11,
  payload: JsonObject,
): JsonObject {
  return canonicalizeJsonObject({
    ...payload,
    [DRAFT_HEAD_PARTS_KEY]: listDraftHeadPartAddresses(record).map((part) => ({
      sha256: part.sha256,
      byteLength: part.byteLength,
    })),
  });
}

/**
 * Stored document: payload plus the derived tenant envelope. Envelope
 * wins on collision so a stale `parts` cannot survive into the bytes.
 */
export function encodeDraftHeadDocument(record: DraftHeadRecord): JsonObject {
  return withPartsEnvelope(
    record,
    encodeDraftHeadPayload(record, encodePortable(record)),
  );
}

/**
 * Canonical bytes of the draft head document — the one public entry
 * point for bytes that travel. Store these, hash these, chain on these.
 */
export function serializeDraftHeadDocument(record: DraftHeadRecord): string {
  return canonicalJsonStringify(encodeDraftHeadDocument(record));
}

/** Bind the committed head to the exact request for replay adjudication. */
export function serializeDraftHeadDocumentV11(
  record: DraftHeadDocumentV11,
): string {
  const parsed = draftHeadDocumentPayloadSchemaV11.parse(record);
  const portable = {
    ...encodeComposerPortable(
      parsed.portable,
      encodeRunSettingsV11(parsed.portable.runSettings),
    ),
    annotations: encodeAnnotations(parsed.portable.annotations),
  };
  return canonicalJsonStringify(
    withPartsEnvelope(parsed, {
      ...encodeDraftHeadPayload(parsed, portable),
      operationId: parsed.operationId,
      requestSha256: parsed.requestSha256,
    }),
  );
}

type DraftTombstoneMutation = Pick<
  DraftTombstoneDocumentV11,
  "operationId" | "requestSha256"
>;

export function serializeDraftTombstoneDocumentV11(
  mutation: DraftTombstoneMutation,
): string {
  const document = draftTombstoneDocumentSchemaV11.parse({
    dialect: DRAFT_HEAD_DIALECT,
    schemaVersion: DRAFT_HEAD_SCHEMA_VERSION_V11,
    kind: "tombstone",
    [DRAFT_HEAD_PARTS_KEY]: [],
    ...mutation,
  });
  return canonicalJsonStringify(document);
}

export type DraftHeadDocumentCorruptionReason =
  | "malformed-json"
  | "parts-envelope-missing"
  | "schema-rejected"
  | "parts-envelope-mismatch";

type CorruptDraftHeadDocument = {
  readonly status: "corrupt";
  readonly reason: DraftHeadDocumentCorruptionReason;
  readonly message: string;
  /** HOST-INTERNAL. Log it, never wire it. */
  readonly diagnostic: string;
};

export type DraftHeadDocumentResult =
  | { readonly status: "ok"; readonly record: DraftHeadReaderRecord }
  | CorruptDraftHeadDocument;

export type DraftHeadDocumentResultV11 =
  | { readonly status: "ok"; readonly record: DraftHeadDocumentV11 }
  | CorruptDraftHeadDocument;

export const DRAFT_HEAD_DOCUMENT_CORRUPTION_MESSAGES: Readonly<
  Record<DraftHeadDocumentCorruptionReason, string>
> = {
  "malformed-json":
    "This draft's stored record is damaged and could not be read.",
  "parts-envelope-missing":
    "This draft's stored record is incomplete and could not be opened.",
  "schema-rejected":
    "This draft's stored record is not in a form this version can read.",
  "parts-envelope-mismatch":
    "This draft's stored record disagrees with itself and could not be opened.",
};

function corruptDocument(
  reason: DraftHeadDocumentCorruptionReason,
  diagnostic: string,
): CorruptDraftHeadDocument {
  return {
    status: "corrupt",
    reason,
    message: DRAFT_HEAD_DOCUMENT_CORRUPTION_MESSAGES[reason],
    diagnostic,
  };
}

const draftHeadPartsEnvelopeSchema = lazySchema(() =>
  z.array(chatHeadAddressPartSchema),
);

function withoutPartsEnvelope(document: JsonObject): JsonObject {
  const payload: JsonObject = Object.create(null);
  for (const key of Object.getOwnPropertyNames(document)) {
    if (key === DRAFT_HEAD_PARTS_KEY) continue;
    const descriptor = Object.getOwnPropertyDescriptor(document, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(payload, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return payload;
}

function describeEnvelopeMismatch(
  declared: readonly ChatHeadAddressPart[],
  derived: readonly ChatHeadAddressPart[],
): string | null {
  if (declared.length !== derived.length) {
    return `Draft head document declares ${declared.length} parts but its payload names ${derived.length}`;
  }
  for (const [index, part] of derived.entries()) {
    if (declared[index].sha256 !== part.sha256) {
      return `Draft head document's part ${index} is ${declared[index].sha256} but its payload names ${part.sha256}`;
    }
    if (declared[index].byteLength !== part.byteLength) {
      return `Draft head document's part ${index} declares ${declared[index].byteLength} bytes but its payload names ${part.byteLength}`;
    }
  }
  return null;
}

/**
 * Stored document bytes -> draft head record.
 *
 * Same order as `decodeChatHeadDocument`: parse JSON, read `parts`, strip
 * it, parse the payload, re-derive and require an exact envelope match.
 * `draft/v1` derives an empty list, so a non-empty envelope is corrupt.
 * Payload parse pins `{major:1, minor:0}` — a newer minor is
 * `schema-rejected`, never a silent strip of unknown fields.
 */
export function decodeDraftHeadDocument(
  documentBytes: string,
): DraftHeadDocumentResult {
  return decodeDraftHead(documentBytes, draftHeadReaderSchema);
}

export function decodeDraftHeadDocumentV11(
  documentBytes: string,
): DraftHeadDocumentResultV11 {
  return decodeDraftHead(documentBytes, draftHeadDocumentPayloadSchemaV11);
}

function decodeDraftHead<
  Record extends DraftHeadReaderRecord | DraftHeadDocumentV11,
>(
  documentBytes: string,
  schema: z.ZodType<Record>,
):
  | { readonly status: "ok"; readonly record: Record }
  | CorruptDraftHeadDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentBytes);
  } catch (error) {
    return corruptDocument(
      "malformed-json",
      `Draft head document is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isJsonObject(parsed)) {
    return corruptDocument(
      "malformed-json",
      "Draft head document is not a JSON object",
    );
  }

  const envelope = readJsonProperty(parsed, DRAFT_HEAD_PARTS_KEY);
  if (!Array.isArray(envelope)) {
    return corruptDocument(
      "parts-envelope-missing",
      `Draft head document has no "${DRAFT_HEAD_PARTS_KEY}" array; the sync layer cannot determine what a swap displaces`,
    );
  }

  const declared = draftHeadPartsEnvelopeSchema.safeParse(envelope);
  if (!declared.success) {
    return corruptDocument(
      "parts-envelope-missing",
      `Draft head document's "${DRAFT_HEAD_PARTS_KEY}" envelope is malformed: ${declared.error.message}`,
    );
  }

  const payload = withoutPartsEnvelope(parsed);
  const record = schema.safeParse(payload);
  if (!record.success) {
    return corruptDocument(
      "schema-rejected",
      `Draft head document payload is not a readable draft-head record: ${record.error.message}`,
    );
  }

  const derived = listDraftHeadPartAddresses(record.data);
  const mismatch = describeEnvelopeMismatch(declared.data, derived);
  if (mismatch !== null) {
    return corruptDocument("parts-envelope-mismatch", mismatch);
  }

  return { status: "ok", record: record.data };
}
