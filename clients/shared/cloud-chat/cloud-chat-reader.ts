import {
  assembleChat,
  CHAT_ASSEMBLY_CORRUPTION_MESSAGES,
  type ChatAssemblyIntegrityReason,
  type ChatPartRequest,
  type StagedChatPart,
} from "@traycer/protocol/persistence/chat-sync/assembly";
import {
  CHAT_SYNC_READER_VERSION,
  decodeChatHeadDocument,
  type ChatHeadDocumentCorruptionReason,
  type ChatHeadRefusalReason,
} from "@traycer/protocol/persistence/chat-sync/head";
import type { AssembledChat } from "@traycer/protocol/persistence/chat-sync/assembly";
import type {
  CloudChatIdentity,
  CloudChatSummary,
  ReadCloudChatPartResponse,
  ResolveCloudChatHeadResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import {
  decodeBase64,
  utf8Bytes,
  utf8Text,
  type Sha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import type { ChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";

/**
 * The client half of the cloud-chat read path: resolve, gate, fetch what is
 * missing, verify, assemble.
 *
 * ```
 *   resolveHead ──> verify head digest ──> decode document ──> GATE
 *                                                               │
 *                        ┌──────────────────────────────────────┘
 *                        │  (refused: zero part requests, by construction)
 *                        ▼
 *   for each part the head names, CONCURRENTLY:
 *        cache hit? ──yes──> re-hash ──matches?──yes──────┐
 *              │ no                    │ no              │
 *              └────────────────<──────┘                 │
 *              └──> readCloudChatPart ──> verify ──> cache ──> stage
 *                                                              │
 *                            assemble IN HEAD ORDER  <─────────┘
 *                                     │
 *                                  present
 * ```
 *
 * Environment-agnostic on purpose. The renderer supplies a host-RPC port and a
 * Cache-API store; the CLI supplies the same port over its own transport and a
 * disk store; a test supplies a map and counts calls. All three run this
 * pipeline, so none of them can drift on which check happens when - which was
 * the whole reason 02 shaped `assembleChat` around an injected fetch port.
 *
 * ## Requests, which is the property this exists to make true
 *
 * One `resolveHead`, plus one `readCloudChatPart` for each part digest NOT in
 * the cache. Nothing else. After one new turn a chat's head names one new tail
 * shard and the same digests as before for everything else, so reopening costs a
 * head and a single part. That is measurable at the port, and the tests measure
 * it there rather than inferring it from what rendered.
 *
 * ## Where each verdict is decided, and why it is not here
 *
 * The version gate, the per-part length and digest checks, the head<->shard
 * cross-check and the head-order assembly all live in `assembleChat`. This
 * module supplies transport, a cache and a digest, and translates outcomes for a
 * UI. That split is deliberate: the moment a second place decides whether a part
 * is acceptable, the two can disagree, and the one that renders will win.
 *
 * The one integrity check that IS here is the head's own digest, because
 * `assembleChat` never sees the document bytes - it takes a parsed record. The
 * row carries the digest of the exact bytes the publisher committed, so checking
 * it costs one hash and closes the only gap in the chain: every part is verified
 * against the head, and the head is verified against the row.
 */

// ---- Ports -------------------------------------------------------------- //

/**
 * The two calls a read makes. Narrowed to exactly these so a test stands in for
 * the transport without asserting its way past the type system, and so the call
 * COUNT is observable at a boundary the reader cannot route around.
 */
export interface CloudChatReadPort {
  resolveHead(
    identity: CloudChatIdentity,
  ): Promise<ResolveCloudChatHeadResponse>;
  readPart(request: {
    readonly identity: CloudChatIdentity;
    readonly sha256: string;
    readonly declaredByteLength: number;
  }): Promise<ReadCloudChatPartResponse>;
}

export interface ReadCloudChatOptions {
  readonly identity: CloudChatIdentity;
  readonly port: CloudChatReadPort;
  readonly cache: ChatPartCache;
  readonly sha256Hex: Sha256Hex;
}

// ---- Outcomes ----------------------------------------------------------- //

export type CloudChatReadOutcome =
  | { readonly kind: "ok"; readonly chat: AssembledChat }
  /** The owning host has never published this chat. */
  | { readonly kind: "unpublished" }
  /**
   * This build cannot interpret the publication. Decided on the HEAD, before any
   * part request - a refusal costs one row read and no part egress.
   */
  | {
      readonly kind: "needs-newer-app";
      readonly reason: ChatHeadRefusalReason;
      readonly message: string;
    }
  /**
   * `(task, chat)` resolved to a row owned by somebody else. Never rendered as
   * the chat that was asked for.
   */
  | {
      readonly kind: "ambiguous-identity";
      readonly resolvedOwnerUserId: string | null;
    }
  /**
   * The cloud answered and what it said was wrong. Distinct from a transport
   * failure, which throws: this is diagnosable against a specific publication,
   * and a retry does not fix it.
   */
  | {
      readonly kind: "corrupt";
      readonly reason: CloudChatCorruptionReason;
      /** Renderer-safe. Carries no object coordinates. */
      readonly message: string;
      /** Host-internal detail: digests, parser complaints. Log, never render. */
      readonly diagnostic: string;
    };

/**
 * Every way a read can end in "the cloud answered and what it said was wrong".
 *
 * Three sources, unioned rather than flattened, because each names a different
 * layer and a support report needs the difference: the protocol's per-part
 * integrity reasons, the protocol's head-document reasons, and the two this
 * hop adds because it is the only place that can see them.
 */
export type CloudChatCorruptionReason =
  | ChatAssemblyIntegrityReason
  | ChatHeadDocumentCorruptionReason
  /** The head document's bytes do not hash to the digest the row carries. */
  | "head-digest-mismatch"
  /** A part the live head names is not in storage. */
  | "part-missing";

export type CloudChatRead = {
  /**
   * Null exactly when the cloud holds NO ROW for the identity (the resolve's
   * `missing` outcome) - there is no summary to carry. Every other outcome,
   * refusals included, has the row's summary.
   */
  readonly chat: CloudChatSummary | null;
  readonly outcome: CloudChatReadOutcome;
};

/**
 * Renderer-safe phrasing for the two failures this module adds on top of the
 * protocol's own tables. Fixed strings, so a digest cannot be interpolated into
 * a user-visible message by accident - there is nowhere in these to put one.
 */
export const CLOUD_CHAT_CORRUPTION_MESSAGES: Readonly<
  Record<"head-digest-mismatch" | "part-missing", string>
> = {
  "head-digest-mismatch":
    "This chat's stored record did not match its expected contents and could not be opened.",
  "part-missing":
    "Part of this chat's stored copy is no longer available and it could not be opened.",
};

// ---- Reading ------------------------------------------------------------ //

export async function readCloudChat(
  options: ReadCloudChatOptions,
): Promise<CloudChatRead> {
  const { identity, port } = options;

  const resolved = await port.resolveHead(identity);
  const { chat, outcome } = resolved;

  if (outcome.status === "unpublished") {
    return { chat, outcome: { kind: "unpublished" } };
  }
  // Row-absent reads the same as row-without-head to a READER: there is
  // nothing published to show. The distinction (no row vs no head) matters
  // to publishers and to the server's RBAC shape, not to this surface - and
  // the server deliberately answers "absent" and "not readable" identically,
  // so inventing a third user-facing state here would claim knowledge the
  // wire does not carry.
  if (outcome.status === "missing") {
    return { chat: null, outcome: { kind: "unpublished" } };
  }
  // The wire contract pins `chat: null` to the `missing` arm alone; a
  // response that violates it is malformed, and reading it as unpublished is
  // the arm that promises nothing.
  if (chat === null) {
    return { chat: null, outcome: { kind: "unpublished" } };
  }
  if (outcome.status === "ambiguous-identity") {
    return {
      chat,
      outcome: {
        kind: "ambiguous-identity",
        resolvedOwnerUserId: outcome.resolvedOwnerUserId,
      },
    };
  }

  // The head is verified against the ROW's digest before it is parsed, so a
  // substituted head cannot even reach the schema - let alone name parts a
  // reader would then go and spend egress on. Hashed over the DOCUMENT string
  // exactly as received: the document bytes are the digest identity, and
  // anything that re-serialized them on the way to a hash would be checking a
  // number nobody stored.
  const documentDigest = await options.sha256Hex(utf8Bytes(outcome.head));
  if (documentDigest !== outcome.headSha256) {
    return corruptRead(
      chat,
      "head-digest-mismatch",
      `Head document hashes to ${documentDigest} but the row promises ${outcome.headSha256}`,
    );
  }

  // The SAME string that was hashed goes into the codec - which is why the
  // codec takes a string. It strips and cross-checks the server's `parts`
  // envelope, so the envelope can neither be trusted nor land in the record's
  // residual bag and be re-emitted, stale, by a clone's re-publication.
  const decoded = decodeChatHeadDocument(outcome.head);
  if (decoded.status === "corrupt") {
    return {
      chat,
      outcome: {
        kind: "corrupt",
        reason: decoded.reason,
        message: decoded.message,
        diagnostic: decoded.diagnostic,
      },
    };
  }

  // The head is verified against the ROW above; this is the other end of the
  // same chain - the row against the REQUEST. A row can only be reached through
  // its identity, but nothing in the bytes forces the document filed under it
  // to describe that chat: the digest proves the head is the one the row
  // promises, and the shard checks prove the parts belong to that head, so an
  // identity substituted at publication time would be internally consistent all
  // the way down and render another transcript under this row. Decided before
  // any part is fetched, like every other refusal on this path.
  const core = decoded.record.core;
  if (
    core.chatId !== identity.chatId ||
    core.ownerUserId !== identity.ownerUserId
  ) {
    return {
      chat,
      outcome: {
        kind: "ambiguous-identity",
        resolvedOwnerUserId: core.ownerUserId,
      },
    };
  }

  // `assembleChat` gates BEFORE it builds the request list and invokes the fetch
  // port, so a refusal here reaches `fetchPart` zero times. That is structural
  // rather than a discipline this module keeps, which is what makes "no part
  // egress for a chat we cannot read" assertable as a call count.
  const assembly = await assembleChat({
    head: decoded.record,
    readerSupports: CHAT_SYNC_READER_VERSION,
    fetch: (request) => stagePart(request, options),
  }).catch((error: unknown) => {
    if (error instanceof PartUnavailableError) return error;
    if (error instanceof PartOversizedError) return error;
    throw error;
  });

  if (assembly instanceof PartOversizedError) {
    return {
      chat,
      outcome: {
        kind: "corrupt",
        reason: "byte-length-mismatch",
        message: CHAT_ASSEMBLY_CORRUPTION_MESSAGES["byte-length-mismatch"],
        diagnostic: assembly.message,
      },
    };
  }
  if (assembly instanceof PartUnavailableError) {
    return assembly.ambiguousIdentity
      ? {
          chat,
          outcome: { kind: "ambiguous-identity", resolvedOwnerUserId: null },
        }
      : corruptRead(chat, "part-missing", assembly.message);
  }

  if (assembly.status === "refused") {
    return {
      chat,
      outcome: {
        kind: "needs-newer-app",
        reason: assembly.reason,
        message: assembly.message,
      },
    };
  }
  if (assembly.status === "corrupt") {
    return {
      chat,
      outcome: {
        kind: "corrupt",
        reason: assembly.reason,
        message: assembly.message,
        diagnostic: assembly.diagnostic,
      },
    };
  }

  return { chat, outcome: { kind: "ok", chat: assembly.chat } };
}

/**
 * A part the head names that the cloud will not serve.
 *
 * Thrown rather than returned because it happens INSIDE the fetch port, where
 * `assembleChat`'s contract is that a rejection is the caller's transport
 * failure and propagates. It is caught by identity immediately outside, so it
 * never surfaces to a caller as an unhandled transport error - the distinction
 * that matters is "a retry might work" (a dropped socket) versus "a retry
 * cannot" (the bytes are not there), and only this class knows which it is.
 */
class PartUnavailableError extends Error {
  constructor(
    message: string,
    readonly ambiguousIdentity: boolean,
  ) {
    super(message);
    this.name = "PartUnavailableError";
  }
}

/**
 * A part answered with a body too large to be the part the head named.
 *
 * Its own class rather than an arm of the one above, because the outcomes
 * differ where it matters: those bytes are not ABSENT, they are wrong, which is
 * the corrupt-publication verdict `assembleChat` would have reached had the
 * response been decoded - `byte-length-mismatch`, reported without paying for
 * the decode that would have proved it.
 */
class PartOversizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartOversizedError";
  }
}

/**
 * One part into staging: the cache first, the wire only on a miss.
 *
 * Returns a `StagedChatPart` whose `sha256` is computed from the bytes in hand,
 * never assumed - including on a cache HIT. That re-hash is the point: the cache
 * is a store, not a trust boundary, so an entry that was corrupted on disk, or
 * written by something else under the same key, is caught by the same check that
 * catches a substituted download. It costs one hash of ~64 KiB per cached part,
 * which is nothing next to the round trip it saved.
 *
 * A hit that fails that check is treated as a MISS rather than as a verdict: the
 * bytes the cloud holds are still the authority, and a store fault is not a
 * corrupt publication.
 */
async function stagePart(
  request: ChatPartRequest,
  options: ReadCloudChatOptions,
): Promise<StagedChatPart> {
  const cached = await options.cache.get(request.part.sha256);
  if (cached !== null) {
    const staged = await stageBytes(cached, options.sha256Hex);
    // A cache entry that does not answer to the key it was filed under is a
    // STORE fault, and a store fault must not read as a corrupt publication.
    // Accepting it would hand `assembleChat` bytes it can only reject, and
    // since nothing evicts the entry every reopen would reject them again -
    // one bad 64 KiB on disk making a healthy chat permanently unreadable.
    // Falling through to the port costs one request and re-files the correct
    // bytes under the same key, so the miss is self-healing.
    if (matchesRequestedPart(staged, request)) return staged;
  }

  const response = await options.port.readPart({
    identity: options.identity,
    sha256: request.part.sha256,
    // From the HEAD, so the host can bound the transfer without parsing it.
    declaredByteLength: request.part.byteLength,
  });

  if (response.outcome.status === "not-found") {
    throw new PartUnavailableError(
      `Chat ${request.section} part ${request.index} is named by the head but is not in storage`,
      false,
    );
  }
  if (response.outcome.status === "ambiguous-identity") {
    throw new PartUnavailableError(
      `Chat ${request.section} part ${request.index} was answered from a different owner's row`,
      true,
    );
  }

  // Bounded BEFORE `atob`, which expands the whole string in one allocation
  // before any length or digest check can run. The head already promised this
  // part's byte length and base64 is exactly `ceil(n / 3) * 4` characters for
  // `n` bytes, so a longer body cannot be the named part whatever it decodes
  // to - and refusing it unread is the difference between one rejected
  // response and an unbounded allocation from a single bad answer. The payload
  // path takes the same pre-decode ceiling (`MAX_ENCODED_PAYLOAD_CHARS`).
  if (
    response.outcome.bytesBase64.length >
    encodedCharsFor(request.part.byteLength)
  ) {
    throw new PartOversizedError(
      `Chat ${request.section} part ${request.index} answered with more base64 than ${request.part.byteLength} bytes can encode`,
    );
  }

  const bytes = decodeBase64(response.outcome.bytesBase64);
  const staged = await stageBytes(bytes, options.sha256Hex);

  // ## Cache admission is a different question from read verification
  //
  // `assembleChat` decides whether this part is acceptable, and it has not run
  // yet - it cannot, it is waiting on this call. So the store is guarded by its
  // OWN precondition, which is the only one a content-addressed store can have:
  // may these bytes be filed under this key? Writing first and verifying later
  // would poison the cache with exactly the bytes that failed, and every
  // subsequent read would serve them from disk instead of asking again.
  //
  // Awaited, but nothing is BRANCHED on it: a `put` that fails is a no-op by
  // the cache contract, so there is nothing here to handle. Awaiting keeps the
  // store ordered before the part is staged, which is what makes a concurrent
  // second read of the same digest find it.
  if (matchesRequestedPart(staged, request)) {
    await options.cache.put(request.part.sha256, bytes);
  }

  return staged;
}

/**
 * Whether these bytes are the part the head asked for.
 *
 * The same two comparisons `assembleChat` makes, and deliberately not a third
 * opinion: this decides cache ADMISSION and cache TRUST, both of which happen
 * before assembly can run. What assembly does with a part that fails is still
 * assembly's call - nothing here reports a verdict.
 */
function matchesRequestedPart(
  staged: StagedChatPart,
  request: ChatPartRequest,
): boolean {
  return (
    staged.sha256 === request.part.sha256 &&
    staged.byteLength === request.part.byteLength
  );
}

/** Base64 characters `byteLength` bytes encode to, padding included. */
function encodedCharsFor(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function stageBytes(
  bytes: Uint8Array,
  sha256Hex: Sha256Hex,
): Promise<StagedChatPart> {
  return sha256Hex(bytes).then((sha256) => ({
    byteLength: bytes.byteLength,
    sha256,
    // Lazy, per 02's contract: a part that FAILS verification is discarded
    // without ever being decoded, so substituted bytes cost a hash comparison
    // rather than a decode of attacker-chosen input.
    readText: () => Promise.resolve(utf8Text(bytes)),
  }));
}

function corruptRead(
  chat: CloudChatSummary,
  reason: "head-digest-mismatch" | "part-missing",
  diagnostic: string,
): CloudChatRead {
  return {
    chat,
    outcome: {
      kind: "corrupt",
      reason,
      message: CLOUD_CHAT_CORRUPTION_MESSAGES[reason],
      diagnostic,
    },
  };
}
