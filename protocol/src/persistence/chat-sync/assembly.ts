import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ChatHeadCore } from "@traycer/protocol/persistence/chat-sync/core";
import type { PreservedChatEvent, PreservedChatMessage } from "@traycer/protocol/persistence/chat-sync/entries";
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
 * The reader half of the chat-sync contract: how a cloud renderer or a clone
 * target turns a head into a chat it may act on.
 *
 * The order is the contract:
 *
 * 1. gate on the HEAD, before any part is fetched;
 * 2. fetch every part IN PARALLEL, hashing each as it arrives;
 * 3. verify each part's length and digest against the address the head gave;
 * 4. parse each through the forward-compatible shard reader schema;
 * 5. cross-check each shard against the head that named it;
 * 6. assemble IN HEAD ORDER - never in completion order;
 * 7. only then promote.
 *
 * Step 1 is enforced structurally rather than by discipline: the fetch port is
 * a CALLBACK this module invokes, so on a refusal there is no call to forget to
 * skip. A caller physically cannot spend the egress on a chat it was not
 * allowed to read.
 *
 * **Parallel fetch, ordered assembly.** Parts are immutable and independently
 * verifiable, so there is nothing to serialize: a p99 chat is ~165 parts, and
 * fetching them one at a time would pay 165 round trips for no property the
 * per-part digest does not already give. The two concerns are kept apart on
 * purpose - completion order is a network accident, and the head's list is the
 * only thing that says what the transcript IS. The property test pins that:
 * the same head with parts completing in any order assembles to the same chat.
 *
 * **Failing closed, and failing promptly.** A part whose bytes do not hash to
 * the address the head named ends the read. It is not skipped, not rendered as
 * a gap, and not retried here - a chat assembled from parts one of which was
 * substituted is not a degraded chat, it is a different one. And the read ends
 * as soon as that is KNOWN: it does not wait for siblings that have not
 * settled, so one stalled request cannot stretch an already-decided outcome out
 * to its timeout. With a p99 chat's fan-out that difference is the whole
 * latency budget.
 *
 * Environment-agnostic on purpose. The GUI's host reads through its cloud data
 * client, cloud-ui streams through its own server, a test fetches from a map.
 * All three differ only in the fetch port, so all three run the same pipeline
 * and cannot drift on which check happens when.
 */

// ---- Fetching ----------------------------------------------------------- //

/**
 * Bytes a caller has brought down for one part, described by what the head
 * promises about them.
 *
 * `sha256` and `byteLength` are computed by the FETCHER, incrementally, as the
 * bytes arrive - not read back off a finished buffer. That is what lets a
 * clone path spool a part to disk and still content-address it without holding
 * it in memory, and it is why this type carries the digest rather than the
 * bytes.
 *
 * `readText` is separate and lazy so a part that FAILS verification is
 * discarded without ever being parsed - substituted bytes should cost a hash
 * comparison, not a `JSON.parse` of attacker-chosen input.
 */
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

/**
 * Brings one part into staging. Invoked ONLY after the gate admits the head,
 * which is what makes "no egress on a refused chat" structural. Called
 * concurrently for every part; a caller that needs a concurrency ceiling
 * imposes it inside its own port.
 */
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

/**
 * The chat a head describes, once every part it names has been verified and
 * assembled. Shaped like a record rather than like a head so nothing
 * downstream has to know a chat arrived in pieces.
 */
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
       * The detail a human needs to diagnose this: the digests that disagreed,
       * the parser's complaint, the chat id that did not line up.
       *
       * HOST-INTERNAL. Log it, never wire it. A part's `sha256` is an object
       * coordinate the read APIs deliberately withhold from readers, and a
       * corruption message is a silly place to hand it back.
       */
      readonly diagnostic: string;
    };

/**
 * Renderer-safe phrasing for each integrity failure. Fixed strings rather than
 * interpolated ones, so a coordinate cannot be added to a user-visible message
 * by accident: there is nowhere in these to put one.
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
 *
 * Returns a result rather than throwing for every outcome a healthy system
 * really produces: a refusal is a UX state ("this chat needs a newer app"), and
 * an integrity failure is a diagnosable condition a caller reports against a
 * specific `(chat, part)`. Errors from the FETCHER itself - a dead socket, a
 * 403 - propagate unchanged: those are the caller's transport failures, and
 * flattening them into this union would lose the distinction between "the cloud
 * is unreachable" and "the cloud handed us the wrong bytes".
 *
 * Note what is NOT checked here: whether the reader can render every block. It
 * cannot, by design - that is what the passthrough is for, and a chat full of
 * variants this build has never heard of is a successful assembly (see
 * `presentation.ts` for how those surface).
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

  // Every part is fetched and verified concurrently, and the read ends as soon
  // as ANY part is known to have failed - it does not wait on siblings that
  // have not settled. `Promise.all` is what gives that: it rejects on the first
  // rejection, and it installs handlers on every input, so a sibling that
  // rejects later is still observed rather than surfacing as an unhandled
  // rejection. (`allSettled` was the earlier construction and was wrong on
  // liveness: one stalled request became the latency bound for every outcome,
  // including a transport failure already known.)
  //
  // What determinism survives: `failures` collects every integrity failure
  // recorded up to the moment the read ends, and the HEAD-earliest of those is
  // what surfaces. So a publication whose bad parts fail together reports the
  // same one every time; one whose parts fail at genuinely different times
  // reports the earliest among those known when the first failure landed. That
  // is a diagnostic-quality property, not a contract a caller may lean on.
  const failures = new Map<number, ChatAssemblyResult>();
  const verified: { readonly index: number; readonly record: ChatShardRecord }[] =
    [];

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

/**
 * Sentinel for "a part failed integrity checks". Thrown rather than returned so
 * `Promise.all` ends the read at once; distinguishable from a transport error
 * by identity, with no class or `instanceof` needed.
 */
const PART_FAILED = Symbol("chat-part-failed");

function earliestFailure(
  failures: ReadonlyMap<number, ChatAssemblyResult>,
): ChatAssemblyResult {
  let earliest: { readonly index: number; readonly failure: ChatAssemblyResult } | null =
    null;

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

/**
 * The post-fetch half for ONE part, exposed on its own for a caller that owns
 * its download (a clone path that spools to disk and then promotes) and for
 * tests that want to drive a specific corruption without a transport.
 *
 * Length before digest deliberately: a truncated transfer is the common case,
 * and naming it as such is more actionable than "the hash did not match".
 */
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

  // Decoding is part of "can these verified bytes be read", not part of the
  // transport. A reader whose `readText` is fatal on invalid UTF-8 rejects
  // here, and letting that rejection escape would classify an immutable,
  // digest-valid shard as a transient fetch failure - so the caller retries
  // forever against bytes that can never parse. Same outcome as unparseable
  // JSON, because it is the same fact one layer down.
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

  // The forward-compatible READER schema, not the registered writer one. The
  // gate admits every same-major publication whatever its minor - that is what
  // makes the passthrough reachable at all - so parsing with the pinned writer
  // schema would reject a genuine 1.1 shard the instant it arrived, and the
  // end-to-end promise could never fire.
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

/**
 * The head <-> payload cross-check, run after the digest and before assembly.
 *
 * Content addressing already proves the BYTES are the ones the head named; this
 * proves the bytes MEAN what the head assumed. The two failures are different:
 * a hash mismatch says the transfer was wrong, and this says the publication is
 * internally inconsistent - a part from another chat, or a part filed under the
 * wrong section.
 */
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

  return null;
}

/**
 * Head order, not fetch order. `requests` and `shards` are index-aligned by
 * construction above, and `requests` was built by walking the head's own lists,
 * so concatenating in index order IS the head's order.
 */
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

  // One of the two is non-null by the head's own refinement, and the shard's
  // refinement guarantees a `host-private` part carries an envelope - so this
  // fallback is unreachable rather than a silent default.
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
