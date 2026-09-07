import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ChatHeadCore } from "@traycer/protocol/persistence/chat-sync/core";
import type {
  PreservedChatEvent,
  PreservedChatMessage,
} from "@traycer/protocol/persistence/chat-sync/entries";
import {
  gateChatHeadVersion,
  type ChatHeadPart,
  type ChatHeadRecord,
  type ChatHeadRefusalReason,
} from "@traycer/protocol/persistence/chat-sync/head";
import type { ChatSyncHostPrivate } from "@traycer/protocol/persistence/chat-sync/host-private";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";
import {
  chatShardReaderSchema,
  type ChatShardRecord,
  type ChatShardSection,
} from "@traycer/protocol/persistence/chat-sync/shard";
import type { ChatSyncPayloadVersion } from "@traycer/protocol/persistence/chat-sync/version";

/**
 * The reader half of the chat-sync contract: how a cloud renderer or a clone target turns a head into a chat it may act on.
 * A caller physically cannot spend the egress on a chat it was not allowed to read.
 */

// ---- Fetching ----------------------------------------------------------- //

export type StagedChatPart = {
  readonly byteLength: number;
  /** Lowercase hex SHA-256 of the staged bytes, computed while staging. */
  readonly sha256: string;
  readonly readText: () => Promise<string>;
};

/** Which of the head's part lists a fetch is being asked for. */
export type ChatPartRequest = {
  readonly section: ChatShardSection;
  /** Position within that section's list. `0` for `host-private`. */
  readonly index: number;
  readonly part: ChatHeadPart;
};

/** Brings one part into staging. */
export type ChatPartFetcher = (
  request: ChatPartRequest,
) => Promise<StagedChatPart>;

// ---- Results ------------------------------------------------------------ //

export type ChatAssemblyIntegrityReason =
  /** Staged length disagrees with the head - a truncated or padded transfer. */
  | "byte-length-mismatch"
  /** Staged digest disagrees with the head - substituted or corrupt bytes. */
  | "digest-mismatch"
  /** Verified bytes are not JSON. */
  | "malformed-json"
  /** Verified JSON is not a shard this build can parse. */
  | "schema-rejected"
  /** A parsed shard contradicts the head that named it. */
  | "head-mismatch";

/** The chat a head describes, once every part it names has been verified and assembled. */
export type AssembledChat = {
  readonly schemaVersion: ChatSyncPayloadVersion;
  /** Lineage of the head this was assembled from. `null` for a first head. */
  readonly parentHeadSha256: string | null;
  readonly throughRecordSeq: number;
  readonly capturedAt: number;
  readonly core: ChatHeadCore;
  readonly messages: readonly PreservedChatMessage[];
  readonly events: readonly PreservedChatEvent[];
  readonly hostPrivate: ChatSyncHostPrivate;
  /** The head's own top-level residual bag, carried for re-publication. */
  readonly residual: JsonObject;
};

export type ChatAssemblyResult =
  | { readonly status: "ok"; readonly chat: AssembledChat }
  | {
      readonly status: "refused";
      readonly reason: ChatHeadRefusalReason;
      readonly message: string;
    }
  | {
      readonly status: "corrupt";
      readonly reason: ChatAssemblyIntegrityReason;
      /**
       * Renderer-safe. A fixed phrase per reason, carrying NO object
       * coordinates - see {@link CHAT_ASSEMBLY_CORRUPTION_MESSAGES}.
       */
      readonly message: string;
      /**
       * The detail a human needs to diagnose this: the digests that disagreed, the parser's complaint, the chat id that did not line up.
       */
      readonly diagnostic: string;
    };

/**
 * Renderer-safe phrasing for each integrity failure.
 * Fixed strings rather than interpolated ones, so a coordinate cannot be added to a user-visible message by accident: there is nowhere in these to put one.
 */
export const CHAT_ASSEMBLY_CORRUPTION_MESSAGES: Readonly<
  Record<ChatAssemblyIntegrityReason, string>
> = {
  "byte-length-mismatch":
    "Part of this chat's stored copy is incomplete and could not be opened.",
  "digest-mismatch":
    "Part of this chat's stored copy did not match its expected contents and could not be opened.",
  "malformed-json":
    "Part of this chat's stored copy is damaged and could not be read.",
  "schema-rejected":
    "This chat's stored copy is not in a form this version can read.",
  "head-mismatch":
    "Part of this chat's stored copy belongs to a different chat and could not be opened.",
};

function corrupt(
  reason: ChatAssemblyIntegrityReason,
  diagnostic: string,
): ChatAssemblyResult {
  return {
    status: "corrupt",
    reason,
    message: CHAT_ASSEMBLY_CORRUPTION_MESSAGES[reason],
    diagnostic,
  };
}

// ---- Assembling --------------------------------------------------------- //

export type AssembleChatOptions = {
  readonly head: ChatHeadRecord;
  readonly readerSupports: SchemaVersion;
  readonly fetch: ChatPartFetcher;
};

/**
 * Gate, fetch in parallel, verify, parse, cross-check, assemble in head order.
 * It cannot, by design - that is what the passthrough is for, and a chat full of variants this build has never heard of is a successful assembly (see `presentation.ts` for how those surface).
 */
export async function assembleChat(
  options: AssembleChatOptions,
): Promise<ChatAssemblyResult> {
  const { head, fetch } = options;

  const gate = gateChatHeadVersion(head, options.readerSupports);
  if (!gate.ok) {
    return { status: "refused", reason: gate.reason, message: gate.message };
  }

  const requests: ChatPartRequest[] = [
    ...head.messageShards.map((part, index) => ({
      section: "messages" as const,
      index,
      part,
    })),
    ...head.eventShards.map((part, index) => ({
      section: "events" as const,
      index,
      part,
    })),
    ...(head.hostPrivateShard === null
      ? []
      : [
          {
            section: "host-private" as const,
            index: 0,
            part: head.hostPrivateShard,
          },
        ]),
  ];

  const failures = new Map<number, ChatAssemblyResult>();
  const verified: {
    readonly index: number;
    readonly record: ChatShardRecord;
  }[] = [];

  try {
    await Promise.all(
      requests.map(async (request, index) => {
        // A rejection here is the CALLER's transport failure and propagates
        // unchanged - see the doc comment.
        const staged = await fetch(request);

        const outcome = await verifyStagedChatPart(staged, request, head);
        if ("status" in outcome) {
          failures.set(index, outcome);
          throw PART_FAILED;
        }
        verified.push({ index, record: outcome.record });
      }),
    );
  } catch (error) {
    if (error !== PART_FAILED) throw error;
    return earliestFailure(failures);
  }

  // Head order, not completion order: `verified` is filled as parts finish, so
  // it is sorted back onto the request list before assembly.
  const shards: ChatShardRecord[] = [];
  for (const entry of [...verified].sort((a, b) => a.index - b.index)) {
    shards.push(entry.record);
  }

  return { status: "ok", chat: assembleFromShards(head, requests, shards) };
}

/** Sentinel for "a part failed integrity checks". */
const PART_FAILED = Symbol("chat-part-failed");

function earliestFailure(
  failures: ReadonlyMap<number, ChatAssemblyResult>,
): ChatAssemblyResult {
  let earliest: {
    readonly index: number;
    readonly failure: ChatAssemblyResult;
  } | null = null;

  for (const [index, failure] of failures) {
    if (earliest === null || index < earliest.index) {
      earliest = { index, failure };
    }
  }

  if (earliest === null) {
    throw new Error("Chat assembly ended on a part failure but recorded none");
  }
  return earliest.failure;
}

export async function verifyStagedChatPart(
  staged: StagedChatPart,
  request: ChatPartRequest,
  head: {
    readonly schemaVersion: ChatSyncPayloadVersion;
    readonly core: { readonly chatId: string };
  },
): Promise<{ readonly record: ChatShardRecord } | ChatAssemblyResult> {
  const label = `${request.section} part ${request.index}`;

  if (staged.byteLength !== request.part.byteLength) {
    return corrupt(
      "byte-length-mismatch",
      `Chat ${label} is ${staged.byteLength} bytes but the head promises ${request.part.byteLength}`,
    );
  }

  if (staged.sha256 !== request.part.sha256) {
    return corrupt(
      "digest-mismatch",
      `Chat ${label} hashes to ${staged.sha256} but the head promises ${request.part.sha256}`,
    );
  }

  // Decoding is part of "can these verified bytes be read", not part of the transport.
  let text: string;
  try {
    text = await staged.readText();
  } catch (error) {
    return corrupt(
      "malformed-json",
      `Chat ${label} verified against the head but did not decode as text: ${describeError(error)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return corrupt(
      "malformed-json",
      `Chat ${label} verified against the head but is not JSON: ${describeError(error)}`,
    );
  }

  // The forward-compatible READER schema, not the registered writer one.
  const parsed = chatShardReaderSchema.safeParse(payload);
  if (!parsed.success) {
    return corrupt(
      "schema-rejected",
      `Chat ${label} is not a readable chat-shard record: ${parsed.error.message}`,
    );
  }

  const record: ChatShardRecord = parsed.data;
  const mismatch = describeShardMismatch(record, request, head);
  if (mismatch !== null) return corrupt("head-mismatch", mismatch);

  return { record };
}

/** The head <-> payload cross-check, run after the digest and before assembly. */
function describeShardMismatch(
  shard: ChatShardRecord,
  request: ChatPartRequest,
  head: {
    readonly schemaVersion: ChatSyncPayloadVersion;
    readonly core: { readonly chatId: string };
  },
): string | null {
  if (shard.chatId !== head.core.chatId) {
    return `Chat ${request.section} part ${request.index} belongs to chat ${shard.chatId} but the head is for ${head.core.chatId}`;
  }

  if (shard.section !== request.section) {
    return `Chat ${request.section} part ${request.index} declares section ${shard.section}`;
  }

  if (
    shard.schemaVersion.major !== head.schemaVersion.major ||
    shard.schemaVersion.minor !== head.schemaVersion.minor
  ) {
    return `Chat ${request.section} part ${request.index} claims ${shard.schemaVersion.major}.${shard.schemaVersion.minor} but the head claims ${head.schemaVersion.major}.${head.schemaVersion.minor}`;
  }

  // The 1.1 cut-plan claims, checked against the parsed shard in hand.
  const claim = request.part;
  if (claim.recordCount !== undefined && request.section !== "host-private") {
    const records: readonly { readonly raw: JsonObject }[] =
      request.section === "messages" ? shard.messages : shard.events;
    const idKey = request.section === "messages" ? "messageId" : "eventId";
    if (records.length !== claim.recordCount) {
      return `Chat ${request.section} part ${request.index} carries ${records.length} records but the head claims ${claim.recordCount}`;
    }
    const first = records[0];
    const last = records[records.length - 1];
    const firstId = first === undefined ? undefined : first.raw[idKey];
    const lastId = last === undefined ? undefined : last.raw[idKey];
    if (claim.firstRecordId !== undefined && firstId !== claim.firstRecordId) {
      return `Chat ${request.section} part ${request.index} starts at ${String(firstId)} but the head claims ${claim.firstRecordId}`;
    }
    if (claim.lastRecordId !== undefined && lastId !== claim.lastRecordId) {
      return `Chat ${request.section} part ${request.index} ends at ${String(lastId)} but the head claims ${claim.lastRecordId}`;
    }
  }

  return null;
}

/** Head order, not fetch order. */
function assembleFromShards(
  head: ChatHeadRecord,
  requests: readonly ChatPartRequest[],
  shards: readonly ChatShardRecord[],
): AssembledChat {
  const messages: PreservedChatMessage[] = [];
  const events: PreservedChatEvent[] = [];
  let graduatedHostPrivate: ChatSyncHostPrivate | null = null;

  for (const [index, shard] of shards.entries()) {
    switch (requests[index].section) {
      case "messages":
        messages.push(...shard.messages);
        break;
      case "events":
        events.push(...shard.events);
        break;
      case "host-private":
        graduatedHostPrivate = shard.hostPrivate;
        break;
    }
  }

  const hostPrivate = head.hostPrivate ?? graduatedHostPrivate;
  if (hostPrivate === null) {
    throw new Error(
      "Assembled a chat head with neither an inline nor a graduated hostPrivate section",
    );
  }

  return {
    schemaVersion: head.schemaVersion,
    parentHeadSha256: head.parentHeadSha256,
    throughRecordSeq: head.throughRecordSeq,
    capturedAt: head.capturedAt,
    core: head.core,
    messages,
    events: head.events ?? events,
    hostPrivate,
    residual: head.residual,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
