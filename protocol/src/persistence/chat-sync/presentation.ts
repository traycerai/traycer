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
 * Assembled chat -> render model, shared by every reader that displays a published chat it does not own: the GUI's cloud-chat view, cloud-ui's transcript, and anything that comes after them.
 * It exists because the two hard parts of rendering a foreign chat are exactly the two parts a UI must not get to re-invent per surface
 */

// ---- Payload refs ------------------------------------------------------- //

/** A pointer, inside a chat, at content stored somewhere else. */
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

/** Decides whether THIS reader can fetch the content a ref names. */
export type ChatPayloadResolver = (
  ref: ChatPayloadRef,
) => ChatPayloadAvailability;

/** The cloud reader's answer: nothing referenced out of the chat is reachable from here. */
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
  readonly blocks: readonly PresentedContentBlock[];
};

export type PresentedChatEvent = {
  readonly eventId: string | null;
  readonly variant: string;
  readonly known: SnapshotChatEvent | null;
  readonly raw: JsonObject;
  readonly timestamp: number | null;
};

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

/** Takes `AssembledChat`, not a registered record value. */
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
 * Payload refs a v1.0 block can carry - the enumeration a publisher uploads against and a reader reports gaps against.
 */
export function collectPayloadRefs(
  block: PreservedContentBlock,
): readonly ChatPayloadRef[] {
  const known = block.value;
  if (known === null) return [];

  if (known.type === "file_change") {
    const refs: ChatPayloadRef[] = [];
    if (known.beforeHash !== null) {
      refs.push({
        kind: "file-snapshot",
        side: "before",
        hash: known.beforeHash,
      });
    }
    if (known.afterHash !== null) {
      refs.push({
        kind: "file-snapshot",
        side: "after",
        hash: known.afterHash,
      });
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
 * Surfaces are free to render something richer; what they must not do is render nothing.
 */
export function describeUnknownVariant(
  domain: UnknownVariantDomain,
  variant: string,
): string {
  const noun =
    domain === "message"
      ? "message"
      : domain === "block"
        ? "content"
        : "activity";
  return variant.length === 0
    ? `Unsupported ${noun} — this chat needs a newer version of Traycer`
    : `Unsupported ${noun} (${variant}) — this chat needs a newer version of Traycer`;
}

/** Fallback copy for a payload the reader cannot fetch. */
export function describeMissingPayload(ref: ChatPayloadRef): string {
  return ref.kind === "plan-content"
    ? "Full plan text is stored on the originating device and is not available here"
    : "File contents are stored on the originating device and are not available here";
}

// ---- Raw readers -------------------------------------------------------- //


function readString(raw: JsonObject, key: string): string | null {
  const value = readJsonProperty(raw, key);
  return typeof value === "string" ? value : null;
}

function readNumber(raw: JsonObject, key: string): number | null {
  const value = readJsonProperty(raw, key);
  return typeof value === "number" ? value : null;
}
