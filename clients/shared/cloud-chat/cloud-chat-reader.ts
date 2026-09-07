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
 * The client half of the cloud-chat read path: resolve, gate, fetch what is missing, verify, assemble.
 * ``` resolveHead ──> verify head digest ──> decode document ──> gate │ ┌──────────────────────────────────────┘ │ (refused: zero part requests, by construction) ▼ for each part the head names, concurrently: cache hit?
 */

 // ---- Ports -------------------------------------------------------------- //

/**
 * The two calls a read makes.
 * Narrowed to exactly these so a test stands in for the transport without asserting its way past the type system, and so the call count is observable at a boundary the reader cannot route around.
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

export const CLOUD_CHAT_PART_FETCH_CONCURRENCY = 12;

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
  /** The cloud answered and what it said was wrong. */
  | {
      readonly kind: "corrupt";
      readonly reason: CloudChatCorruptionReason;
      /** Renderer-safe. Carries no object coordinates. */
      readonly message: string;
      /** Host-internal detail: digests, parser complaints. Log, never render. */
      readonly diagnostic: string;
    };

export type CloudChatCorruptionReason =
  | ChatAssemblyIntegrityReason
  | ChatHeadDocumentCorruptionReason
  /** The head document's bytes do not hash to the digest the row carries. */
  | "head-digest-mismatch"
  /** A part the live head names is not in storage. */
  | "part-missing";

export type CloudChatRead = {
  /**
   * Null exactly when the cloud holds NO row for the identity (the resolve's `missing` outcome) - there is no summary to carry.
   */
  readonly chat: CloudChatSummary | null;
  readonly outcome: CloudChatReadOutcome;
};

/**
 * Renderer-safe phrasing for the two failures this module adds on top of the protocol's own tables.
 * Fixed strings, so a digest cannot be interpolated into a user-visible message by accident - there is nowhere in these to put one.
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
  // Row-absent reads the same as row-without-head to a reader: there is nothing published to show.
  if (outcome.status === "missing") {
    return { chat: null, outcome: { kind: "unpublished" } };
  }
  // The wire contract pins `chat: null` to the `missing` arm alone; a response that violates it is malformed, and reading it as unpublished is the arm that promises nothing.
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

  // The head is verified against the row's digest before it is parsed, so a substituted head cannot even reach the schema - let alone name parts a reader would then go and spend egress on.
  const documentDigest = await options.sha256Hex(utf8Bytes(outcome.head));
  if (documentDigest !== outcome.headSha256) {
    return corruptRead(
      chat,
      "head-digest-mismatch",
      `Head document hashes to ${documentDigest} but the row promises ${outcome.headSha256}`,
    );
  }

  // The same string that was hashed goes into the codec - which is why the codec takes a string.
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

  // The head is verified against the row above; this is the other end of the same chain - the row against the request.
  // Decided before any part is fetched, like every other refusal on this path.
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

  // `assembleChat` gates before it builds the request list and invokes the fetch port, so a refusal here reaches `fetchPart` zero times.
  // That is structural rather than a discipline this module keeps, which is what makes "no part egress for a chat we cannot read" assertable as a call count.
  const partFetchGate = new ConcurrencyGate(CLOUD_CHAT_PART_FETCH_CONCURRENCY);
  const assembly = await assembleChat({
    head: decoded.record,
    readerSupports: CHAT_SYNC_READER_VERSION,
    fetch: (request) => stagePart(request, options, partFetchGate),
  })
    .catch((error: unknown) => {
      if (error instanceof PartUnavailableError) return error;
      if (error instanceof PartOversizedError) return error;
      throw error;
    })
    // The read is over either way, so nothing queued behind the ceiling is still wanted.
    .finally(() => partFetchGate.abandonQueued());

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
 * Thrown rather than returned because it happens inside the fetch port, where `assembleChat`'s contract is that a rejection is the caller's transport failure and propagates.
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

class PartOversizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartOversizedError";
  }
}

/**
 * One part into staging: the cache first, the wire only on a miss.
 * Returns a `StagedChatPart` whose `sha256` is computed from the bytes in hand, never assumed - including on a cache hit.
 */
async function stagePart(
  request: ChatPartRequest,
  options: ReadCloudChatOptions,
  partFetchGate: ConcurrencyGate,
): Promise<StagedChatPart> {
  const cached = await options.cache.get(request.part.sha256);
  if (cached !== null) {
    const staged = await stageBytes(cached, options.sha256Hex);
    // A cache entry that does not answer to the key it was filed under is a store fault, and a store fault must not read as a corrupt publication.
    // Accepting it would hand `assembleChat` bytes it can only reject, and since nothing evicts the entry every reopen would reject them again - one bad 64 KiB on disk making a healthy chat permanently unreadable.
    if (matchesRequestedPart(staged, request)) return staged;
  }

  const response = await partFetchGate.run(() =>
    options.port.readPart({
      identity: options.identity,
      sha256: request.part.sha256,
      // From the HEAD, so the host can bound the transfer without parsing it.
      declaredByteLength: request.part.byteLength,
    }),
  );

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

  // Bounded before `atob`, which expands the whole string in one allocation before any length or digest check can run.
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

  // `assembleChat` decides whether this part is acceptable, and it has not run yet - it cannot, it is waiting on this call.
  // So the store is guarded by its own precondition, which is the only one a content-addressed store can have: may these bytes be filed under this key?
  if (matchesRequestedPart(staged, request)) {
    await options.cache.put(request.part.sha256, bytes);
  }

  return staged;
}

/**
 * Whether these bytes are the part the head asked for.
 * The same two comparisons `assembleChat` makes, and deliberately not a third opinion: this decides cache admission and cache trust, both of which happen before assembly can run.
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
    // Lazy, per 02's contract: a part that fails verification is discarded without ever being decoded, so substituted bytes cost a hash comparison rather than a decode of attacker-chosen input.
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

type QueuedWork = {
  readonly start: () => void;
  readonly drop: (reason: Error) => void;
};

class PartFetchAbandonedError extends Error {
  constructor() {
    super("cloud-chat-reader: part fetch abandoned after the read settled");
    this.name = "PartFetchAbandonedError";
  }
}

class ConcurrencyGate {
  private active = 0;
  private readonly queued: QueuedWork[] = [];
  private abandoned: Error | null = null;

  constructor(private readonly ceiling: number) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.abandoned !== null) {
        reject(this.abandoned);
        return;
      }
      const start = (): void => {
        this.active += 1;
        Promise.resolve()
          .then(work)
          .then(resolve, (error: unknown) => {
            // This gate serves exactly one `assembleChat`, and that fails the whole read on the first bad part - so a rejected fetch means nothing still queued can be wanted.
            // Abandoning here rather than waiting for the outer `finally` matters because this callback runs several microtask hops earlier: otherwise the completing request's own dequeue admits one more part on the way out.
            reject(error);
            this.abandonQueued();
          })
          .finally(() => {
            this.active -= 1;
            this.startNext();
          });
      };
      if (this.active < this.ceiling) start();
      else this.queued.push({ start, drop: reject });
    });
  }

  /** Stop admitting queued parts, because the read they belong to has already settled. */
  abandonQueued(): void {
    if (this.abandoned !== null) return;
    this.abandoned = new PartFetchAbandonedError();
    for (const entry of this.queued.splice(0)) entry.drop(this.abandoned);
  }

  private startNext(): void {
    if (this.abandoned !== null) return;
    this.queued.shift()?.start();
  }
}
