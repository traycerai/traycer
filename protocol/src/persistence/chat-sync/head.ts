import {
  schemaVersionSchema,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import {
  chatHeadCoreSchema,
  chatHeadCoreStorageSchema,
  type ChatHeadCore,
} from "@traycer/protocol/persistence/chat-sync/core";
import {
  preservedChatEventSchema,
  type PreservedChatEvent,
} from "@traycer/protocol/persistence/chat-sync/entries";
import {
  chatSyncHostPrivateSchema,
  chatSyncHostPrivateStorageSchema,
  type ChatSyncHostPrivate,
} from "@traycer/protocol/persistence/chat-sync/host-private";
import {
  canonicalJsonStringify,
  canonicalizeJsonObject,
  isJsonObject,
  readJsonProperty,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  mergeResidual,
  reprojectResidualCapture,
  storageProjection,
  withResidualCapture,
} from "@traycer/protocol/persistence/chat-sync/residual";
import { encodeHostPrivate } from "@traycer/protocol/persistence/chat-sync/shard";
import {
  CHAT_SYNC_SCHEMA_VERSION,
  chatSyncReaderVersionSchema,
  chatSyncSchemaVersionSchema,
  sha256HexSchema,
  type ChatSyncPayloadVersion,
} from "@traycer/protocol/persistence/chat-sync/version";
import { z } from "zod";

/**
 * The `chat-head` record: the small, mutable pointer that IS a published chat.
 *
 * One head per chat lives as opaque JSON on the chat's cloud row, swapped by
 * CAS. It states the chat's identity, metadata, lifecycle and settings, and it
 * names - in order - the immutable `chat-shard` parts that hold the
 * transcript. Everything else about the publication is derivable from it: the
 * server drives part deletion from the address list and interprets nothing
 * else, and a reader needs the head and nothing else to fetch and assemble the
 * whole chat.
 *
 * ## Part addresses are content addresses
 *
 * The tenant envelope names a part by `(sha256, byteLength)` and by nothing
 * else. There is no key, no storage generation: the key layout is derived from
 * the hash under a `(task, tenant kind)` prefix and is a versioned spec readers
 * never parse. That is what makes a publish a hash-diff against the previous
 * head - unchanged cohorts keep their addresses and are not re-uploaded - and
 * what makes retries converge on the same object with no session state.
 *
 * The payload's message / event cohort entries carry the same address plus
 * the last-write extrema they cover (`firstSeq` / `lastSeq`) and the
 * exact membership key (`recordCount`, `firstRecordId`, `lastRecordId`).
 * That cut plan is chat-domain data and MUST NOT leak into the envelope -
 * the sync layer interprets nothing but the address. `hostPrivate` stays
 * address-only.
 *
 * ## Graduation
 *
 * Events and `hostPrivate` start INSIDE the head, because they are small and a
 * head is rewritten every publish anyway. Each graduates to its own part when
 * it alone outgrows the shard target: events cohort-style (they are id-keyed
 * like messages), `hostPrivate` whole. The head represents that as a
 * `null` inline section paired with a non-empty part list, and
 * `refineChatHeadSections` enforces the exclusivity - a head that states a
 * section twice would let a reader assemble two different chats from the same
 * bytes depending on which it believed.
 *
 * ## Lineage
 *
 * `parentHeadSha256` chains each publication to the one it superseded.
 * Continuity and ancestry are proven by IDENTITY, never by sequence ordering:
 * two forked histories both number their turns, so a seq comparison permits
 * exactly the dangerous "local is ahead, overwrite the cloud" case. The chain
 * is what makes a fork visible on first contact instead of after a silent
 * last-write-wins.
 */

// ---- Part addresses and the cut plan ----------------------------------- //

/**
 * The tenant-envelope address: content hash and length, nothing else.
 *
 * This is the only shape the sync server reads. Domain fields (seq ranges,
 * CDC params) stay on the payload.
 */
export const chatHeadAddressPartSchema = z.object({
  /** Lowercase hex SHA-256 of the part's canonical bytes. Its whole address. */
  sha256: sha256HexSchema,
  byteLength: z.number().int().nonnegative(),
});
export type ChatHeadAddressPart = z.infer<typeof chatHeadAddressPartSchema>;

/**
 * A head-named part as the payload carries it.
 *
 * 1.1 extends the address with an optional last-write seq range and the
 * exact membership key (`recordCount` + first/last record ids) so a
 * publisher can plan the next cut from the predecessor head. The five
 * fields are present together or absent together
 * (`refineChatHeadPartRanges`). 1.0 heads omit them; the 1.1 writer
 * requires them on message / event cohorts.
 *
 * `firstSeq` / `lastSeq` are last-write extrema, not a membership
 * interval. Tail membership is the `recordCount` records from
 * `firstRecordId` through `lastRecordId` in section order.
 */
export const chatHeadPartSchema = chatHeadAddressPartSchema.extend({
  firstSeq: z.number().int().nonnegative().optional(),
  lastSeq: z.number().int().nonnegative().optional(),
  recordCount: z.number().int().positive().optional(),
  firstRecordId: z.string().min(1).optional(),
  lastRecordId: z.string().min(1).optional(),
});
export type ChatHeadPart = z.infer<typeof chatHeadPartSchema>;

/** Writer-side cohort: the 1.1 cut plan is required. */
export const chatHeadCohortPartSchema = chatHeadAddressPartSchema
  .extend({
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    recordCount: z.number().int().positive(),
    firstRecordId: z.string().min(1),
    lastRecordId: z.string().min(1),
  })
  .superRefine((part, ctx) => {
    if (part.firstSeq > part.lastSeq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["firstSeq"],
        message: `firstSeq ${part.firstSeq} cannot exceed lastSeq ${part.lastSeq}`,
      });
    }
  });
export type ChatHeadCohortPart = z.infer<typeof chatHeadCohortPartSchema>;

/** Algorithm id recorded in the head so a cut is reproducible forever. */
export const CHAT_SYNC_CDC_ALGORITHM_FASTCDC_GEAR_V1 = "fastcdc-gear-v1" as const;

/**
 * Content-defined-chunking parameters the writer used to cut this head.
 *
 * `mask` is the unsigned integer AND-mask of the rolling hash: a record
 * boundary is a cut candidate when `(hash & mask) === 0`. `min` / `target`
 * / `max` are cohort sizes in bytes; `min <= target <= max`.
 */
export const chatHeadCdcParamsSchema = z
  .object({
    algorithm: z.literal(CHAT_SYNC_CDC_ALGORITHM_FASTCDC_GEAR_V1),
    mask: z.number().int().nonnegative(),
    target: z.number().int().positive(),
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .superRefine((cdc, ctx) => {
    if (cdc.min > cdc.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["min"],
        message: `cdc.min ${cdc.min} cannot exceed cdc.target ${cdc.target}`,
      });
    }
    if (cdc.target > cdc.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: `cdc.target ${cdc.target} cannot exceed cdc.max ${cdc.max}`,
      });
    }
  });
export type ChatHeadCdcParams = z.infer<typeof chatHeadCdcParamsSchema>;

/** Address projection used when deriving the tenant envelope. */
export function chatHeadPartAddress(part: ChatHeadPart): ChatHeadAddressPart {
  return { sha256: part.sha256, byteLength: part.byteLength };
}

// ---- The record -------------------------------------------------------- //

export const chatHeadRecordShape = {
  /**
   * Self-describing record version, carried inside the head rather than beside
   * it: the head is the row's opaque JSON, so there is no second place to put
   * it. Pinned to a literal (see `version.ts`) so a payload cannot claim to be
   * anything other than the contract that accepted it.
   */
  schemaVersion: chatSyncSchemaVersionSchema,
  /**
   * Canonical sha256 of the head this publication supersedes, or `null` for a
   * chat's first head.
   *
   * The publication lineage chain. A reader (or a reconciling host) proves
   * ancestry by walking identities, not by comparing `throughRecordSeq`: a
   * disk restore or a cloned host identity produces two histories that both
   * number their turns, and seq ordering cannot tell "I am ahead" from "I am a
   * fork". Consumed by the continuity verdict that arbitrates a fork.
   */
  parentHeadSha256: sha256HexSchema.nullable(),
  /**
   * Record sequence this publication was pinned at. The publisher must have
   * captured state exactly through this seq - never a projection already past
   * it, relabelled. A watermark, not an ordering authority: see
   * `parentHeadSha256`.
   */
  throughRecordSeq: z.number().int().nonnegative(),
  /** Wall-clock ms the head was serialized. */
  capturedAt: z.number(),
  /**
   * Lowest record version a reader must support to interpret this publication
   * SAFELY, or `null` when every same-major reader can.
   *
   * `null` is the normal case and the one this contract is designed for: a
   * minor that only adds passthrough-preserved vocabulary (a content-block
   * type, a message role, an event type) is readable by every shipped
   * same-major reader, which renders what it knows and round-trips the rest.
   * Gating those on `schemaVersion` would defeat the passthrough entirely -
   * the reader would bounce at the head and never reach the tolerant codec.
   *
   * A writer sets this only for a change an older reader cannot safely
   * INTERPRET - not one it merely fails to render or does not model.
   * Preservation is never a reason to set it: unmodeled fields ride the
   * residual bags and unknown variants ride the passthrough, so an older
   * reader re-publishes both untouched. Setting it is a deliberate, justified
   * act (see COMPATIBILITY.md). Defaulted so a head written before the field
   * existed parses as "no restriction".
   */
  minReaderVersion: schemaVersionSchema.nullable().default(null),
  /**
   * CDC parameters that produced this head's cut plan.
   *
   * Optional on the shared / reader shape so a 1.0 head still parses. The
   * 1.1 writer requires it (`chatHeadWriterRecordShape`).
   */
  cdc: chatHeadCdcParamsSchema.optional(),
  core: chatHeadCoreSchema,
  /**
   * Message-cohort shards, in transcript order. Assembly concatenates them in
   * THIS order regardless of the order they arrive in.
   */
  messageShards: z.array(chatHeadPartSchema),
  /**
   * The event log, inline. `null` once it has graduated into `eventShards`.
   * An empty array is an ordinary chat with no events, not a graduated one.
   */
  events: z.array(preservedChatEventSchema).nullable(),
  /** Event-cohort shards, in order. Empty while `events` is inline. */
  eventShards: z.array(chatHeadPartSchema),
  /** Opaque host state, inline. `null` once it has graduated. */
  hostPrivate: chatSyncHostPrivateSchema.nullable(),
  /** The graduated host-private part, or `null` while it is inline. */
  hostPrivateShard: chatHeadAddressPartSchema.nullable(),
} as const;

/**
 * The reader floor the 1.1 reshape imposes, as a value: a 1.0 reader meeting
 * a 1.1 head would misread the cut plan it cannot see, so every 1.1 head
 * must gate readers below 1.1. Pinned literally rather than derived from
 * `CHAT_SYNC_SCHEMA_VERSION`, because a future ADDITIVE minor (1.2+) keeps
 * this floor - raising it is a deliberate act reserved for a change an older
 * reader cannot safely interpret, exactly as `minReaderVersion`'s own doc
 * says.
 */
export const CHAT_SYNC_1_1_READER_FLOOR = { major: 1, minor: 1 } as const;

/**
 * Writer shape for the registered 1.1 contract: CDC params and per-cohort
 * seq ranges plus membership are required, and `minReaderVersion` must be
 * exactly the 1.1 floor - inherited nullable, an incorrectly-built
 * publication could omit it, and a 1.0 reader's same-major gate would then
 * ADMIT a head whose cut plan it misreads instead of refusing cleanly. The
 * reader shape above stays additive so a 1.0 head still opens.
 */
export const chatHeadWriterRecordShape = {
  ...chatHeadRecordShape,
  cdc: chatHeadCdcParamsSchema,
  minReaderVersion: z.object({
    major: z.literal(CHAT_SYNC_1_1_READER_FLOOR.major),
    minor: z.literal(CHAT_SYNC_1_1_READER_FLOOR.minor),
  }),
  messageShards: z.array(chatHeadCohortPartSchema),
  eventShards: z.array(chatHeadCohortPartSchema),
} as const;

/**
 * A section is either inline or graduated, never both and never neither.
 *
 * Without this a head could state its events twice - once inline, once in
 * parts - and two readers could assemble two different chats from the same
 * bytes. It also rejects the degenerate "graduated to nothing" head, which
 * would present as a chat that lost its event log.
 */
export function refineChatHeadSections(
  head: {
    readonly events: readonly unknown[] | null;
    readonly eventShards: readonly unknown[];
    readonly hostPrivate: unknown;
    readonly hostPrivateShard: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (head.events === null && head.eventShards.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eventShards"],
      message:
        "A head whose events have graduated must name at least one event shard",
    });
  }
  if (head.events !== null && head.eventShards.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eventShards"],
      message:
        "A head carrying inline events must not also name event shards; a section is inline or graduated, never both",
    });
  }

  if (head.hostPrivate === null && head.hostPrivateShard === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hostPrivateShard"],
      message:
        "A head must carry its hostPrivate section inline or name the part it graduated to",
    });
  }
  if (head.hostPrivate !== null && head.hostPrivateShard !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hostPrivateShard"],
      message:
        "A head carrying an inline hostPrivate section must not also name a hostPrivate shard",
    });
  }
}

/**
 * A head may not name the same part twice, anywhere across its lists.
 *
 * This is the payload half of the tenant envelope's one obligation. The sync
 * server refuses a head that names a part more than once, because "displaced =
 * previous minus current" stops being well-defined at exactly the moment that
 * set drives deletion - so a head with a repeated address is a head that cannot
 * be committed. Catching it at parse rather than at CAS means the publisher
 * sees it where the mistake is, not at the far end of a swap.
 *
 * It is also the more honest reading of the record: two message cohorts with
 * identical canonical bytes are the same object, so a chat naming one twice is
 * claiming the same messages appear twice in its own transcript.
 */
export function refineChatHeadPartUniqueness(
  head: {
    readonly messageShards: readonly { readonly sha256: string }[];
    readonly eventShards: readonly { readonly sha256: string }[];
    readonly hostPrivateShard: { readonly sha256: string } | null;
  },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();

  const check = (sha256: string, path: (string | number)[]): void => {
    if (seen.has(sha256)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `A head must not name the same part twice; the sync layer cannot tell what a swap displaces`,
      });
      return;
    }
    seen.add(sha256);
  };

  head.messageShards.forEach((part, index) =>
    check(part.sha256, ["messageShards", index, "sha256"]),
  );
  head.eventShards.forEach((part, index) =>
    check(part.sha256, ["eventShards", index, "sha256"]),
  );
  if (head.hostPrivateShard !== null) {
    check(head.hostPrivateShard.sha256, ["hostPrivateShard", "sha256"]);
  }
}

/**
 * Coherence of a `minReaderVersion` against the version it guards.
 *
 * A minimum on a different major is unopenable by construction: every reader
 * on the head's major is "below" it, and every reader on the minimum's major
 * rejects the head's major, so the head would name a chat no build can ever
 * read. A minimum newer than the head contradicts the ritual: the change that
 * forces a higher minimum is the change that cuts the record's own minor.
 */
export function refineMinReaderVersion(
  head: {
    readonly schemaVersion: SchemaVersion;
    readonly minReaderVersion: SchemaVersion | null;
  },
  ctx: z.RefinementCtx,
): void {
  const minimum = head.minReaderVersion;
  if (minimum === null) return;

  if (minimum.major !== head.schemaVersion.major) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minReaderVersion", "major"],
      message: `minReaderVersion major ${minimum.major} must match schemaVersion major ${head.schemaVersion.major}; no reader could satisfy both`,
    });
    return;
  }

  if (minimum.minor > head.schemaVersion.minor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minReaderVersion", "minor"],
      message: `minReaderVersion ${minimum.major}.${minimum.minor} cannot exceed the head's own ${head.schemaVersion.major}.${head.schemaVersion.minor}`,
    });
  }
}

/**
 * Cut-plan fields on a part are present together, ordered, and never
 * appear on hostPrivate.
 *
 * A 1.0 head omits them; a 1.1 writer requires them on message / event
 * cohorts via `chatHeadCohortPartSchema`. Either way a lone bound, a
 * reversed range, or a host-private part carrying membership is corrupt.
 */
export function refineChatHeadPartRanges(
  head: {
    readonly messageShards: readonly ChatHeadPart[];
    readonly eventShards: readonly ChatHeadPart[];
    readonly hostPrivateShard: ChatHeadPart | null;
  },
  ctx: z.RefinementCtx,
): void {
  const check = (part: ChatHeadPart, path: (string | number)[]): void => {
    const firstSeq = part.firstSeq;
    const lastSeq = part.lastSeq;
    const recordCount = part.recordCount;
    const firstRecordId = part.firstRecordId;
    const lastRecordId = part.lastRecordId;
    const flags = [
      firstSeq !== undefined,
      lastSeq !== undefined,
      recordCount !== undefined,
      firstRecordId !== undefined,
      lastRecordId !== undefined,
    ];
    if (flags.some((flag) => flag !== flags[0])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message:
          "firstSeq, lastSeq, recordCount, firstRecordId and lastRecordId must be present together on a cohort part",
      });
      return;
    }
    if (firstSeq !== undefined && lastSeq !== undefined && firstSeq > lastSeq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "firstSeq"],
        message: `firstSeq ${firstSeq} cannot exceed lastSeq ${lastSeq}`,
      });
    }
  };

  head.messageShards.forEach((part, index) =>
    check(part, ["messageShards", index]),
  );
  head.eventShards.forEach((part, index) =>
    check(part, ["eventShards", index]),
  );

  const hostPrivate = head.hostPrivateShard;
  if (
    hostPrivate !== null &&
    (hostPrivate.firstSeq !== undefined ||
      hostPrivate.lastSeq !== undefined ||
      hostPrivate.recordCount !== undefined ||
      hostPrivate.firstRecordId !== undefined ||
      hostPrivate.lastRecordId !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hostPrivateShard"],
      message: "A hostPrivate shard is not a seq-ranged cohort",
    });
  }
}

/**
 * A head CLAIMING 1.1 or later must actually carry the 1.1 cut plan.
 *
 * The reader schema keeps `cdc` and the per-cohort membership fields optional
 * so a 1.0 head still opens - but that tolerance is FOR 1.0. A payload whose
 * own `schemaVersion` says 1.1+ while omitting them is not a head any 1.1
 * writer produced: downstream would hold a nominal-1.1 head it cannot
 * reproduce cuts for, and every consumer of the claimed minor would have to
 * re-check field presence itself. Such a head decodes as schema-rejected, not
 * ok. Per-part all-or-none and ordering stay with
 * {@link refineChatHeadPartRanges}; this adds only the version-conditional
 * PRESENCE obligation.
 */
export function refineClaimedCutPlanCompleteness(
  head: {
    readonly schemaVersion: SchemaVersion;
    readonly cdc?: ChatHeadCdcParams;
    readonly messageShards: readonly ChatHeadPart[];
    readonly eventShards: readonly ChatHeadPart[];
  },
  ctx: z.RefinementCtx,
): void {
  if (head.schemaVersion.minor < CHAT_SYNC_1_1_READER_FLOOR.minor) return;

  if (head.cdc === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cdc"],
      message: `A head claiming ${head.schemaVersion.major}.${head.schemaVersion.minor} must record its CDC parameters; without them its cut is not reproducible`,
    });
  }

  const check = (part: ChatHeadPart, path: (string | number)[]): void => {
    // One field stands for all five: refineChatHeadPartRanges already
    // rejects a partial group, so presence of any is presence of every.
    if (part.recordCount !== undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `A head claiming ${head.schemaVersion.major}.${head.schemaVersion.minor} must carry the cut-plan membership fields on every cohort`,
    });
  };
  head.messageShards.forEach((part, index) =>
    check(part, ["messageShards", index]),
  );
  head.eventShards.forEach((part, index) =>
    check(part, ["eventShards", index]),
  );
}

function refineChatHead(
  head: {
    readonly schemaVersion: SchemaVersion;
    readonly minReaderVersion: SchemaVersion | null;
    readonly cdc?: ChatHeadCdcParams;
    readonly events: readonly unknown[] | null;
    readonly hostPrivate: unknown;
    readonly hostPrivateShard: ChatHeadPart | null;
    readonly messageShards: readonly ChatHeadPart[];
    readonly eventShards: readonly ChatHeadPart[];
  },
  ctx: z.RefinementCtx,
): void {
  refineMinReaderVersion(head, ctx);
  refineChatHeadSections(head, ctx);
  refineChatHeadPartUniqueness(head, ctx);
  refineChatHeadPartRanges(head, ctx);
  refineClaimedCutPlanCompleteness(head, ctx);
}

/**
 * The registered writer schema's inner value. `_internal/chat-sync-schemas.ts`
 * owns the single registered instance; this is the same construction, exported
 * so the reader schema below can mirror it without re-declaring the shape.
 */
export const chatHeadSchema = withResidualCapture(
  "head",
  chatHeadWriterRecordShape,
).superRefine(refineChatHead);

/**
 * The forward-compatible READER schema: same major, any minor, everything else
 * identical. Built through `reprojectResidualCapture`, which does NOT register
 * a capture site - this is the same `head` level, only more accepting.
 */
export const chatHeadReaderSchema = reprojectResidualCapture({
  ...chatHeadRecordShape,
  schemaVersion: chatSyncReaderVersionSchema,
}).superRefine(refineChatHead);

/** The persisted shape: declared fields, no `residual`, unmodeled keys open. */
export const chatHeadStorageSchema = storageProjection({
  ...chatHeadWriterRecordShape,
  core: chatHeadCoreStorageSchema,
  hostPrivate: chatSyncHostPrivateStorageSchema.nullable(),
});

/**
 * Public structural mirror of the registered record - see the note on
 * `ChatShardRecord` for why the type and the encoder live outside `_internal`.
 */
export type ChatHeadRecord = {
  readonly schemaVersion: ChatSyncPayloadVersion;
  readonly parentHeadSha256: string | null;
  readonly throughRecordSeq: number;
  readonly capturedAt: number;
  readonly minReaderVersion: SchemaVersion | null;
  readonly cdc?: ChatHeadCdcParams;
  readonly core: ChatHeadCore;
  // Array element types match what Zod infers from the registered schema
  // exactly, not a `readonly` narrowing of it: `chat-sync-record-shape.test.ts`
  // asserts the mirror and the registered value are MUTUALLY assignable, and a
  // `readonly T[]` is not assignable to a `T[]`. The properties are readonly,
  // which is the part callers see.
  readonly messageShards: ChatHeadPart[];
  readonly events: PreservedChatEvent[] | null;
  readonly eventShards: ChatHeadPart[];
  readonly hostPrivate: ChatSyncHostPrivate | null;
  readonly hostPrivateShard: ChatHeadPart | null;
  /** Top-level keys a newer minor added, preserved for re-emission. */
  readonly residual: JsonObject;
};

/**
 * Domain head -> canonical persisted JSON for the PAYLOAD.
 *
 * Same guarantees as `encodeChatShard`: the major is stamped from the constant,
 * the minor is carried, every residual bag merges back beside its declared
 * fields, and encoding is idempotent.
 *
 * This is a building block, not a publication API. It is the payload half of a
 * head document and carries no `parts` envelope, so it is neither what gets
 * stored nor what a head is addressed by - `encodeChatHeadDocument` wraps it,
 * and `serializeChatHeadDocument` produces the bytes that travel. Nothing may
 * hash the result of this function.
 */
export function encodeChatHead(record: ChatHeadRecord): JsonObject {
  const { core, events, hostPrivate, residual, cdc, ...declared } = record;

  return canonicalizeJsonObject(
    mergeResidual(
      {
        ...declared,
        schemaVersion: {
          major: CHAT_SYNC_SCHEMA_VERSION.major,
          minor: record.schemaVersion.minor,
        },
        ...(cdc === undefined ? {} : { cdc: encodeCdc(cdc) }),
        messageShards: record.messageShards.map(encodeChatHeadPart),
        eventShards: record.eventShards.map(encodeChatHeadPart),
        hostPrivateShard:
          record.hostPrivateShard === null
            ? null
            : chatHeadPartAddress(record.hostPrivateShard),
        core: encodeCore(core),
        events: events === null ? null : events.map((event) => event.raw),
        hostPrivate:
          hostPrivate === null ? null : encodeHostPrivate(hostPrivate),
      },
      residual,
    ),
  );
}

function encodeCdc(cdc: ChatHeadCdcParams): JsonObject {
  return {
    algorithm: cdc.algorithm,
    mask: cdc.mask,
    target: cdc.target,
    min: cdc.min,
    max: cdc.max,
  };
}

function encodeChatHeadPart(part: ChatHeadPart): JsonObject {
  const encoded: JsonObject = chatHeadPartAddress(part);
  if (part.firstSeq !== undefined) {
    encoded.firstSeq = part.firstSeq;
  }
  if (part.lastSeq !== undefined) {
    encoded.lastSeq = part.lastSeq;
  }
  if (part.recordCount !== undefined) {
    encoded.recordCount = part.recordCount;
  }
  if (part.firstRecordId !== undefined) {
    encoded.firstRecordId = part.firstRecordId;
  }
  if (part.lastRecordId !== undefined) {
    encoded.lastRecordId = part.lastRecordId;
  }
  return encoded;
}

function encodeCore(core: ChatHeadCore): JsonObject {
  const { lifecycle, settings, residual, ...declared } = core;

  return mergeResidual(
    {
      ...declared,
      lifecycle: encodeSimpleLevel(lifecycle),
      settings: settings === null ? null : encodeSimpleLevel(settings),
    },
    residual,
  );
}

function encodeSimpleLevel(level: { readonly residual: JsonObject }): JsonObject {
  const { residual, ...declared } = level;
  return mergeResidual({ ...declared }, residual);
}

// There is deliberately NO `serializeChatHead`. A payload serializer sitting
// beside `serializeChatHeadDocument` is a trap: both return canonical bytes of
// a head, only one is stored, and hashing the wrong one produces a lineage
// digest naming bytes nobody has - a publisher that chained on it would report
// a fork on its own next sync. The first version of this module had one, with a
// comment saying not to hash it, and this package's own fixture chained on it
// anyway. So the misuse is removed structurally rather than warned about: there
// is exactly one way to turn a head into bytes, and it is the right one.
//
// Payload-level assertions (canonical key order, lossless re-emission) compose
// `canonicalJsonStringify(encodeChatHead(record))` explicitly, which reads as
// the deliberate act it is.

/** Every part a head names, in the order assembly consumes them. */
export function listChatHeadParts(head: {
  readonly messageShards: readonly ChatHeadPart[];
  readonly eventShards: readonly ChatHeadPart[];
  readonly hostPrivateShard: ChatHeadPart | null;
}): readonly ChatHeadPart[] {
  return [
    ...head.messageShards,
    ...head.eventShards,
    ...(head.hostPrivateShard === null ? [] : [head.hostPrivateShard]),
  ];
}

/**
 * Envelope projection of `listChatHeadParts`: addresses only, in the same
 * order. This is what the sync layer sees.
 */
export function listChatHeadPartAddresses(head: {
  readonly messageShards: readonly ChatHeadPart[];
  readonly eventShards: readonly ChatHeadPart[];
  readonly hostPrivateShard: ChatHeadPart | null;
}): readonly ChatHeadAddressPart[] {
  return listChatHeadParts(head).map(chatHeadPartAddress);
}

// ---- The head DOCUMENT: tenant envelope + opaque payload ---------------- //

/**
 * The one key the sync layer reads inside a head document.
 *
 * **Reserved.** No modeled field of the `chat-head` record may ever be called
 * this, and the decoder strips it before parsing so it can never land in a
 * residual bag either - a re-published head must derive its envelope afresh,
 * never re-emit a stale index it happened to carry through.
 */
export const CHAT_HEAD_PARTS_KEY = "parts";

/**
 * The stored head DOCUMENT: this record's canonical payload plus one derived
 * envelope.
 *
 * ## The tenancy seam, stated at the byte level
 *
 * The sync server is tenant-generic. Enrolling in it costs exactly one
 * obligation: a top-level `parts` array of `{sha256, byteLength}`. That is not
 * a stylistic concession - it is the minimum a DELETION mechanism can be built
 * on. When a head is swapped, the parts the old head named and the new one does
 * not are owed a deletion, and nothing but the head knows which those are.
 *
 * So the document is two layers with a hard line between them:
 *
 * - the **envelope** (`parts`) is the server's, derived mechanically from the
 *   payload and read by nothing else;
 * - the **payload** is the chat's, and the server interprets none of it -
 *   cohorts, sections, ordering, versions and lineage are all present in the
 *   bytes it stores and none of them is ever looked at.
 *
 * The envelope is DERIVED, never authored. A head that stated its part list
 * independently of its shard lists could disagree with itself, and the
 * disagreement would surface as either a stranded object or a deleted live one.
 * `decodeChatHeadDocument` re-derives and compares rather than trusting.
 *
 * ## One digest identity
 *
 * `sha256(serializeChatHeadDocument(record))` is simultaneously the CAS witness
 * a publisher presents, the digest the chat row holds, and the value the NEXT
 * head carries as its `parentHeadSha256`. Over the DOCUMENT, not the payload:
 * the document is what is stored, and a chain anchored on anything else would
 * name bytes nobody has.
 *
 * Consequently the document bytes are the identity, and nothing may
 * re-serialize them on the way to a hash. Callers that hold a document hold the
 * string.
 *
 * ## The part ceiling
 *
 * The server caps a head at 4,096 parts (a p99 chat measures ~165, so that is
 * headroom, not a working limit). It is deliberately NOT re-asserted here: it
 * is a server-side bound on work an authenticated caller can request, and a
 * second copy of the constant would drift from the one that enforces it. A
 * publisher that exceeds it is refused at CAS.
 */
export function encodeChatHeadDocument(record: ChatHeadRecord): JsonObject {
  // Envelope wins on collision, which is what makes a stale `parts` carried in
  // a hand-built record's residual bag unable to survive into the document.
  return canonicalizeJsonObject(
    mergeResidual(
      { parts: listChatHeadPartAddresses(record).map((part) => ({ ...part })) },
      encodeChatHead(record),
    ),
  );
}

/**
 * Canonical bytes of the head document - the one public entry point for bytes
 * that travel. Store these, hash these, chain on these.
 */
export function serializeChatHeadDocument(record: ChatHeadRecord): string {
  return canonicalJsonStringify(encodeChatHeadDocument(record));
}

export type ChatHeadDocumentCorruptionReason =
  /** The stored bytes are not JSON, or not a JSON object. */
  | "malformed-json"
  /** No readable top-level `parts` envelope. */
  | "parts-envelope-missing"
  /** The payload is not a head this build can parse. */
  | "schema-rejected"
  /** The envelope disagrees with the part list the payload derives. */
  | "parts-envelope-mismatch";

export type ChatHeadDocumentResult =
  | { readonly status: "ok"; readonly record: ChatHeadRecord }
  | {
      readonly status: "corrupt";
      readonly reason: ChatHeadDocumentCorruptionReason;
      /** Renderer-safe: a fixed phrase per reason, carrying no coordinates. */
      readonly message: string;
      /** HOST-INTERNAL. Log it, never wire it. */
      readonly diagnostic: string;
    };

export const CHAT_HEAD_DOCUMENT_CORRUPTION_MESSAGES: Readonly<
  Record<ChatHeadDocumentCorruptionReason, string>
> = {
  "malformed-json": "This chat's stored record is damaged and could not be read.",
  "parts-envelope-missing":
    "This chat's stored record is incomplete and could not be opened.",
  "schema-rejected":
    "This chat's stored record is not in a form this version can read.",
  "parts-envelope-mismatch":
    "This chat's stored record disagrees with itself and could not be opened.",
};

function corruptDocument(
  reason: ChatHeadDocumentCorruptionReason,
  diagnostic: string,
): ChatHeadDocumentResult {
  return {
    status: "corrupt",
    reason,
    message: CHAT_HEAD_DOCUMENT_CORRUPTION_MESSAGES[reason],
    diagnostic,
  };
}

/**
 * Stored document bytes -> head record.
 *
 * The order is the contract:
 *
 * 1. parse the bytes as JSON;
 * 2. read the `parts` envelope;
 * 3. **strip** it - so it can never reach the record's residual bag, where a
 *    re-publication would re-emit a stale index beside a freshly derived one;
 * 4. parse the payload through the forward-compatible reader schema;
 * 5. re-derive the part list from the parsed record and require the envelope to
 *    match it exactly, in order.
 *
 * Step 5 fails CLOSED. An envelope that has lost an entry describes a swap that
 * strands an object; one that has gained an entry describes a swap that deletes
 * a live one; one that has merely been reordered is a document no honest
 * publisher produces. None of them is a chat this reader may act on.
 *
 * Takes the string rather than parsed JSON on purpose: the document bytes are
 * the digest identity, so the type that reaches this function is the type the
 * caller must have hashed.
 */
export function decodeChatHeadDocument(
  documentBytes: string,
): ChatHeadDocumentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentBytes);
  } catch (error) {
    return corruptDocument(
      "malformed-json",
      `Head document is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isJsonObject(parsed)) {
    return corruptDocument("malformed-json", "Head document is not a JSON object");
  }

  const envelope = readJsonProperty(parsed, CHAT_HEAD_PARTS_KEY);
  if (!Array.isArray(envelope)) {
    return corruptDocument(
      "parts-envelope-missing",
      `Head document has no "${CHAT_HEAD_PARTS_KEY}" array; the sync layer cannot determine what a swap displaces`,
    );
  }

  const declared = chatHeadPartsEnvelopeSchema.safeParse(envelope);
  if (!declared.success) {
    return corruptDocument(
      "parts-envelope-missing",
      `Head document's "${CHAT_HEAD_PARTS_KEY}" envelope is malformed: ${declared.error.message}`,
    );
  }

  const payload = withoutPartsEnvelope(parsed);
  const record = chatHeadReaderSchema.safeParse(payload);
  if (!record.success) {
    return corruptDocument(
      "schema-rejected",
      `Head document payload is not a readable chat-head record: ${record.error.message}`,
    );
  }

  const derived = listChatHeadPartAddresses(record.data);
  const mismatch = describeEnvelopeMismatch(declared.data, derived);
  if (mismatch !== null) {
    return corruptDocument("parts-envelope-mismatch", mismatch);
  }

  return { status: "ok", record: record.data };
}

const chatHeadPartsEnvelopeSchema = z.array(chatHeadAddressPartSchema);

/**
 * Every own key of the document except the envelope, rebuilt with
 * `Object.defineProperty` onto a null-prototype object so a legal own
 * `__proto__` survives the strip (see `json.ts`).
 */
function withoutPartsEnvelope(document: JsonObject): JsonObject {
  const payload: JsonObject = Object.create(null);

  for (const key of Object.getOwnPropertyNames(document)) {
    if (key === CHAT_HEAD_PARTS_KEY) continue;
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
  declared: readonly ChatHeadPart[],
  derived: readonly ChatHeadPart[],
): string | null {
  if (declared.length !== derived.length) {
    return `Head document declares ${declared.length} parts but its payload names ${derived.length}`;
  }

  for (const [index, part] of derived.entries()) {
    if (declared[index].sha256 !== part.sha256) {
      return `Head document's part ${index} is ${declared[index].sha256} but its payload names ${part.sha256}`;
    }
    if (declared[index].byteLength !== part.byteLength) {
      return `Head document's part ${index} declares ${declared[index].byteLength} bytes but its payload names ${part.byteLength}`;
    }
  }

  return null;
}

// ---- Version gating ---------------------------------------------------- //

/** The record version THIS build interprets. What callers gate with. */
export const CHAT_SYNC_READER_VERSION: SchemaVersion = {
  major: CHAT_SYNC_SCHEMA_VERSION.major,
  minor: CHAT_SYNC_SCHEMA_VERSION.minor,
};

export type ChatHeadRefusalReason = "unsupported-major" | "reader-below-minimum";

export type ChatHeadVersionGate =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ChatHeadRefusalReason;
      readonly message: string;
    };

/**
 * Decides whether a reader may assemble the chat a head describes.
 *
 * Called on the HEAD - which a reader already holds after one row read -
 * before any part is fetched, so a publication the reader cannot interpret
 * costs no part egress and is never half-materialized. That guarantee is worth
 * more here than it was for a single-object layout: a refused chat would
 * otherwise have cost every shard's egress.
 *
 * The rule, deliberately: **the major is the reject boundary.** A same-major
 * publication is admitted whatever its minor, because that is what makes the
 * unknown-variant passthrough worth having - a 1.0 renderer meeting a 1.4 chat
 * renders the blocks it knows and re-emits the rest intact, which is strictly
 * better than refusing the chat outright. Rejecting any newer minor would
 * guarantee the passthrough never fires in the field: the minor bump that
 * introduces a new block type is exactly the one that would bounce.
 *
 * `minReaderVersion` is the escape hatch for the case that rule cannot cover -
 * a change an older reader cannot safely INTERPRET. Preservation is not that
 * case. Reserve the minimum for a change that would make an old reader act on
 * a chat WRONGLY; when a writer sets it, the gate turns strict for that
 * publication alone.
 *
 * There is no ref-kind check to make: v2 has exactly one publication layout,
 * so the tagged-union gate the v1 design needed has nothing left to decide.
 */
export function gateChatHeadVersion(
  head: {
    readonly schemaVersion: SchemaVersion;
    readonly minReaderVersion: SchemaVersion | null;
  },
  readerSupports: SchemaVersion,
): ChatHeadVersionGate {
  if (head.schemaVersion.major !== readerSupports.major) {
    return {
      ok: false,
      reason: "unsupported-major",
      message: `Chat head major ${head.schemaVersion.major} is not readable by a reader on major ${readerSupports.major}`,
    };
  }

  const minimum = head.minReaderVersion;
  if (minimum !== null && isVersionBelow(readerSupports, minimum)) {
    return {
      ok: false,
      reason: "reader-below-minimum",
      message: `This chat requires a reader on ${minimum.major}.${minimum.minor} or newer; this reader is ${readerSupports.major}.${readerSupports.minor}`,
    };
  }

  return { ok: true };
}

function isVersionBelow(left: SchemaVersion, right: SchemaVersion): boolean {
  if (left.major !== right.major) return left.major < right.major;
  return left.minor < right.minor;
}
