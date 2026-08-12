import type { AssembledChat } from "@traycer/protocol/persistence/chat-sync/assembly";
import type {
  ChatLifecycle,
  ChatSyncRunSettings,
} from "@traycer/protocol/persistence/chat-sync/core";
import type {
  ChatSyncMessage,
  PreservedChatEvent,
  PreservedChatMessage,
  PreservedContentBlock,
} from "@traycer/protocol/persistence/chat-sync/entries";
import {
  readJsonProperty,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import type {
  SnapshotChatEvent,
  SnapshotContentBlock,
} from "@traycer/protocol/persistence/chat-sync/open-harness";

/**
 * Assembled chat -> render model, shared by every reader that displays a
 * published chat it does not own: the GUI's cloud-chat view, cloud-ui's
 * transcript, and anything that comes after them.
 *
 * It exists because the two hard parts of rendering a foreign chat are exactly
 * the two parts a UI must not get to re-invent per surface:
 *
 * 1. **Unknown variants.** A block type, message role or event type this build
 *    has never heard of arrives with `known: null` and its `raw` intact. Every
 *    reader must show SOMETHING for it rather than dropping it - a dropped
 *    block is indistinguishable from a chat that never had one - and every
 *    reader must show the same something, or the same chat reads differently
 *    depending on where you opened it.
 * 2. **Unresolvable payload refs.** A chat's heavy content is not in the
 *    shards: file diffs live as content-addressed blobs in the ORIGIN host's
 *    SnapshotStore, and a plan's full text lives behind a content ref. A reader
 *    on another machine cannot fetch either, and the gap must be rendered
 *    EXPLICITLY - "diff unavailable" rather than a blank card, which would read
 *    as "no changes".
 *
 * Blob-ref enumeration stays coupled to presentation on purpose. The publisher
 * and the reader have to agree on exactly which refs a chat carries - the
 * publisher uploads that set, the reader reports what it cannot resolve - and
 * splitting the two would let them drift into a chat that publishes blobs
 * nothing asks for, or asks for blobs nothing published.
 *
 * What this deliberately does NOT do is model how a known block looks. Known
 * blocks come through as their parsed `SnapshotContentBlock`, and each surface
 * renders them with whatever it already has.
 */

// ---- Payload refs ------------------------------------------------------- //

/**
 * A pointer, inside a chat, at content stored somewhere else.
 *
 * Closed union over the refs that exist in v1.0 content. A block type this
 * build cannot interpret may well carry refs of its own; they are invisible
 * here by construction, and that is correct rather than a gap - the block
 * itself already renders as unknown, so its content is not being silently
 * misrepresented.
 */
export type ChatPayloadRef =
  | {
      readonly kind: "file-snapshot";
      readonly side: "before" | "after";
      readonly hash: string;
    }
  | { readonly kind: "plan-content"; readonly hash: string };

export type ChatPayloadAvailability = "resolvable" | "missing";

export type PresentedPayloadRef = {
  readonly ref: ChatPayloadRef;
  readonly availability: ChatPayloadAvailability;
};

/**
 * Decides whether THIS reader can fetch the content a ref names.
 *
 * A port rather than a constant because the answer is genuinely
 * reader-specific: the owning host can resolve its own SnapshotStore blobs,
 * and a cloud reader can resolve nothing. Passed explicitly at every call site
 * (the repo forbids defaulted parameters) so no surface can accidentally
 * inherit the wrong answer and render a confident empty diff.
 */
export type ChatPayloadResolver = (
  ref: ChatPayloadRef,
) => ChatPayloadAvailability;

/**
 * The cloud reader's answer: nothing referenced out of the chat is reachable
 * from here. Named so the assumption is visible at call sites instead of being
 * spelled `() => "missing"` in five places.
 */
export const NO_PAYLOADS_RESOLVABLE: ChatPayloadResolver = () => "missing";

// ---- Presented leaves --------------------------------------------------- //

export type PresentedContentBlock = {
  /** `blockId` off the persisted block, or `null` when it carries none. */
  readonly blockId: string | null;
  /** The block's `type`, known or not. */
  readonly variant: string;
  /** Parsed block, or `null` for a type outside this build's vocabulary. */
  readonly known: SnapshotContentBlock | null;
  /** Persisted form, always present. Authoritative for re-emission. */
  readonly raw: JsonObject;
  readonly payloadRefs: readonly PresentedPayloadRef[];
};

export type PresentedMessage = {
  readonly messageId: string | null;
  /** The message's `role`, known or not. */
  readonly variant: string;
  readonly known: ChatSyncMessage | null;
  readonly raw: JsonObject;
  readonly timestamp: number | null;
  /**
   * Blocks of an assistant message. Empty for a user message, and empty for an
   * unknown role - an unrecognized role's internal shape is not something this
   * build may assume, so its content stays in `raw` rather than being guessed
   * at.
   */
  readonly blocks: readonly PresentedContentBlock[];
};

export type PresentedChatEvent = {
  readonly eventId: string | null;
  readonly variant: string;
  readonly known: SnapshotChatEvent | null;
  readonly raw: JsonObject;
  readonly timestamp: number | null;
};

/**
 * Counts of what this build could not interpret, so a surface can say
 * "3 items need a newer version of Traycer" once at the top instead of
 * repeating an apology per row - and so the fidelity of a cloud read is
 * measurable rather than anecdotal.
 */
export type ChatFidelity = {
  readonly unknownMessages: number;
  readonly unknownBlocks: number;
  readonly unknownEvents: number;
  readonly missingPayloads: number;
};

export type PresentedChat = {
  readonly chatId: string;
  readonly parentChatId: string | null;
  readonly ownerUserId: string;
  /** Host that owned the chat at capture. Provenance, not a routing target. */
  readonly originHostId: string;
  readonly title: string;
  readonly isTitleEditedByUser: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lifecycle: ChatLifecycle;
  readonly settings: ChatSyncRunSettings | null;
  readonly throughRecordSeq: number;
  readonly capturedAt: number;
  /** Lineage of the head this was assembled from. `null` for a first head. */
  readonly parentHeadSha256: string | null;
  readonly messages: readonly PresentedMessage[];
  readonly events: readonly PresentedChatEvent[];
  readonly fidelity: ChatFidelity;
};

// ---- Presenting --------------------------------------------------------- //

/**
 * Takes `AssembledChat`, not a registered record value.
 *
 * The registered types pin `schemaVersion.minor` to this contract's literal,
 * which is right for a writer and wrong here: the reader deliberately admits
 * every same-major publication whatever its minor, so the value that reaches
 * this presenter routinely carries a newer one. Pinning it would break the
 * forward-compatibility chain at its LAST link - the chat would gate, fetch,
 * and assemble, only to be unrenderable without a cast.
 */
export function presentChat(
  chat: AssembledChat,
  options: { readonly resolvePayload: ChatPayloadResolver },
): PresentedChat {
  const { core } = chat;
  const messages = chat.messages.map((message) =>
    presentMessage(message, options.resolvePayload),
  );
  const events = chat.events.map((event) => presentEvent(event));

  return {
    chatId: core.chatId,
    parentChatId: core.parentChatId,
    ownerUserId: core.ownerUserId,
    originHostId: core.originHostId,
    title: core.title,
    isTitleEditedByUser: core.isTitleEditedByUser,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
    lifecycle: core.lifecycle,
    settings: core.settings,
    throughRecordSeq: chat.throughRecordSeq,
    capturedAt: chat.capturedAt,
    parentHeadSha256: chat.parentHeadSha256,
    messages,
    events,
    fidelity: measureFidelity(messages, events),
  };
}

function presentMessage(
  message: PreservedChatMessage,
  resolvePayload: ChatPayloadResolver,
): PresentedMessage {
  const known = message.value;

  return {
    messageId: readString(message.raw, "messageId"),
    variant: message.variant,
    known,
    raw: message.raw,
    timestamp: readNumber(message.raw, "timestamp"),
    blocks:
      known !== null && known.role === "assistant"
        ? known.blocks.map((block) => presentBlock(block, resolvePayload))
        : [],
  };
}

function presentBlock(
  block: PreservedContentBlock,
  resolvePayload: ChatPayloadResolver,
): PresentedContentBlock {
  return {
    blockId: readString(block.raw, "blockId"),
    variant: block.variant,
    known: block.value,
    raw: block.raw,
    payloadRefs: collectPayloadRefs(block).map((ref) => ({
      ref,
      availability: resolvePayload(ref),
    })),
  };
}

function presentEvent(event: PreservedChatEvent): PresentedChatEvent {
  return {
    eventId: readString(event.raw, "eventId"),
    variant: event.variant,
    known: event.value,
    raw: event.raw,
    timestamp: readNumber(event.raw, "timestamp"),
  };
}

/**
 * Payload refs a v1.0 block can carry - the enumeration a publisher uploads
 * against and a reader reports gaps against.
 *
 * Read off the PARSED block rather than the raw JSON: the parsed side has
 * already applied the defaults that make a pre-existing `file_change` block
 * without `beforeHash` legible, so scanning raw would miss nothing but would
 * have to re-implement those defaults to know what it was looking at.
 * `known === null` yields nothing, per the note on `ChatPayloadRef`.
 */
export function collectPayloadRefs(
  block: PreservedContentBlock,
): readonly ChatPayloadRef[] {
  const known = block.value;
  if (known === null) return [];

  if (known.type === "file_change") {
    const refs: ChatPayloadRef[] = [];
    if (known.beforeHash !== null) {
      refs.push({ kind: "file-snapshot", side: "before", hash: known.beforeHash });
    }
    if (known.afterHash !== null) {
      refs.push({ kind: "file-snapshot", side: "after", hash: known.afterHash });
    }
    return refs;
  }

  if (known.type === "plan" && known.fullContentRef !== null) {
    return [{ kind: "plan-content", hash: known.fullContentRef.hash }];
  }

  return [];
}

function measureFidelity(
  messages: readonly PresentedMessage[],
  events: readonly PresentedChatEvent[],
): ChatFidelity {
  let unknownMessages = 0;
  let unknownBlocks = 0;
  let missingPayloads = 0;

  for (const message of messages) {
    if (message.known === null) unknownMessages += 1;
    for (const block of message.blocks) {
      if (block.known === null) unknownBlocks += 1;
      for (const payload of block.payloadRefs) {
        if (payload.availability === "missing") missingPayloads += 1;
      }
    }
  }

  return {
    unknownMessages,
    unknownBlocks,
    unknownEvents: events.filter((event) => event.known === null).length,
    missingPayloads,
  };
}

// ---- Generic labels ----------------------------------------------------- //

export type UnknownVariantDomain = "message" | "block" | "event";

/**
 * Neutral fallback copy for a variant this build cannot interpret.
 *
 * Lives here rather than in each UI so the GUI and cloud-ui cannot describe the
 * same unreadable block differently. Surfaces are free to render something
 * richer; what they must not do is render nothing.
 *
 * The variant tag is included verbatim and on purpose: it is the one fact that
 * makes a support report actionable, and it comes from a writer we published,
 * not from user content.
 */
export function describeUnknownVariant(
  domain: UnknownVariantDomain,
  variant: string,
): string {
  const noun =
    domain === "message" ? "message" : domain === "block" ? "content" : "activity";
  return variant.length === 0
    ? `Unsupported ${noun} — this chat needs a newer version of Traycer`
    : `Unsupported ${noun} (${variant}) — this chat needs a newer version of Traycer`;
}

/**
 * Fallback copy for a payload the reader cannot fetch. Deliberately states the
 * CAUSE ("stored on the originating device"), because the alternative reading -
 * that the chat has no diff - is both plausible and wrong.
 */
export function describeMissingPayload(ref: ChatPayloadRef): string {
  return ref.kind === "plan-content"
    ? "Full plan text is stored on the originating device and is not available here"
    : "File contents are stored on the originating device and are not available here";
}

// ---- Raw readers -------------------------------------------------------- //

// Identity and timestamp are read off `raw` rather than the parsed value so an
// UNKNOWN variant still sorts and keys correctly when it happens to carry
// them - which every variant a future minor adds is expected to, since they
// are the fields the transcript itself is ordered by.

function readString(raw: JsonObject, key: string): string | null {
  const value = readJsonProperty(raw, key);
  return typeof value === "string" ? value : null;
}

function readNumber(raw: JsonObject, key: string): number | null {
  const value = readJsonProperty(raw, key);
  return typeof value === "number" ? value : null;
}
