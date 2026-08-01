import {
  describeMissingPayload,
  describeUnknownVariant,
  type ChatPayloadRef,
  type PresentedChatEvent,
  type PresentedChat,
  type PresentedContentBlock,
  type PresentedMessage,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import type { SnapshotContentBlock } from "@traycer/protocol/persistence/chat-sync/open-harness";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

/**
 * Presented snapshot -> the flat rows the cloud transcript renders.
 *
 * A DELIBERATE reduction, not renderer parity. A published chat read from
 * another device is a read-only archival copy: it has no live session, no
 * fetchable blobs, no approval to answer, and no tool to re-run. Re-modelling
 * the fifteen live block cards here would buy a second renderer to keep in
 * sync with the real one, for a surface that cannot act on any of it.
 *
 * What this must NOT do is drop anything. A block this build cannot interpret
 * still gets a row, with the presenter's shared generic label - a dropped
 * block is indistinguishable from a chat that never had one, and the same
 * chat must read the same way in the GUI and in cloud-ui.
 */

/**
 * A payload the reader MAY fetch, as the row that offers it.
 *
 * The counterpart of `missingPayloads`, and deliberately a separate field: a
 * reader whose host cannot answer `epic.listCloudChatPayloads` produces an
 * empty one of these and exactly the markers it produced before the channel
 * existed. The bytes are not carried here - they arrive per ref, on demand,
 * when the reader asks for them.
 */
export type TranscriptPayloadFetch = {
  readonly key: string;
  readonly ref: ChatPayloadRef;
  /** What the control offers to show, e.g. "File contents (after)". */
  readonly label: string;
};

export type TranscriptBlockDisplay = {
  /** Stable within one transcript. Never `blockId` alone - it may be null. */
  readonly key: string;
  /** Human title for the block's kind. */
  readonly label: string;
  /** The block's main text, when it has one. */
  readonly body: string | null;
  /** Short secondary facts (status, exit code, path) - no fabricated content. */
  readonly details: readonly string[];
  readonly isUnknown: boolean;
  /**
   * One message per payload this reader cannot fetch. Rendered explicitly:
   * a blank card would read as "no changes", which is both plausible and
   * wrong.
   */
  readonly missingPayloads: readonly string[];
  /** One entry per payload this reader CAN fetch, in record order. */
  readonly fetchablePayloads: readonly TranscriptPayloadFetch[];
};

export type TranscriptMessageDisplay = {
  readonly key: string;
  /** `"user"` / `"assistant"`, or the raw variant tag when unknown. */
  readonly variant: string;
  readonly isUnknown: boolean;
  readonly author: string;
  readonly timestamp: number | null;
  readonly body: string | null;
  readonly blocks: readonly TranscriptBlockDisplay[];
};

export type TranscriptEventDisplay = {
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  readonly timestamp: number | null;
  readonly isUnknown: boolean;
};

export type CloudChatTranscript = {
  readonly messages: readonly TranscriptMessageDisplay[];
  readonly events: readonly TranscriptEventDisplay[];
};

export function buildCloudChatTranscript(
  presented: PresentedChat,
): CloudChatTranscript {
  return {
    messages: presented.messages.map((message, index) =>
      buildMessage(message, index),
    ),
    events: presented.events.map((event, index) => buildEvent(event, index)),
  };
}

/**
 * A one-line summary of what this build could not fully render, or `null`
 * when the read was lossless. Stated once at the top rather than repeated as
 * an apology per row.
 */
export function describeTranscriptFidelity(
  presented: PresentedChat,
): string | null {
  const { fidelity } = presented;
  const parts: string[] = [];
  const unknownItems =
    fidelity.unknownMessages + fidelity.unknownBlocks + fidelity.unknownEvents;
  if (unknownItems > 0) {
    parts.push(
      `${unknownItems} ${unknownItems === 1 ? "item needs" : "items need"} a newer version of Traycer`,
    );
  }
  if (fidelity.missingPayloads > 0) {
    parts.push(
      `${fidelity.missingPayloads} ${
        fidelity.missingPayloads === 1 ? "attachment is" : "attachments are"
      } stored on the originating device`,
    );
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

function buildMessage(
  message: PresentedMessage,
  index: number,
): TranscriptMessageDisplay {
  const known = message.known;
  if (known === null) {
    return {
      key: rowKey("m", index, message.messageId),
      variant: message.variant,
      isUnknown: true,
      author: "Unknown",
      timestamp: message.timestamp,
      body: describeUnknownVariant("message", message.variant),
      blocks: [],
    };
  }

  if (known.role === "user") {
    return {
      key: rowKey("m", index, message.messageId),
      variant: "user",
      isUnknown: false,
      author:
        known.message.kind === "agent"
          ? (known.message.senderTitle ?? "Agent")
          : "You",
      timestamp: message.timestamp,
      // The composer's own extractor, not a private copy: a user message is
      // rich JSON content, and two different plain-text derivations of the
      // same message would read differently in the two places we show it.
      body: extractPlainTextFromComposerJSONContent(known.message.content),
      blocks: [],
    };
  }

  return {
    key: rowKey("m", index, message.messageId),
    variant: "assistant",
    isUnknown: false,
    author: known.sender.displayName ?? "Agent",
    timestamp: message.timestamp,
    body: null,
    blocks: message.blocks.map((block, blockIndex) =>
      buildBlock(block, blockIndex),
    ),
  };
}

function buildBlock(
  block: PresentedContentBlock,
  index: number,
): TranscriptBlockDisplay {
  const missingPayloads = block.payloadRefs
    .filter((payload) => payload.availability === "missing")
    .map((payload) => describeMissingPayload(payload.ref));
  const fetchablePayloads = block.payloadRefs
    .filter((payload) => payload.availability === "resolvable")
    .map((payload, payloadIndex) => ({
      // The index rides the key because a `file_change` whose before and after
      // are identical carries the SAME digest twice, and two rows keyed on the
      // ref alone would collide.
      key: `${rowKey("b", index, block.blockId)}:p:${payloadIndex}`,
      ref: payload.ref,
      label: describeFetchablePayload(payload.ref),
    }));

  const known = block.known;
  if (known === null) {
    return {
      key: rowKey("b", index, block.blockId),
      label: describeUnknownVariant("block", block.variant),
      body: null,
      details: [],
      isUnknown: true,
      missingPayloads,
      fetchablePayloads,
    };
  }

  const summary = summarizeBlock(known);
  return {
    key: rowKey("b", index, block.blockId),
    label: summary.label,
    body: summary.body,
    details: summary.details,
    isUnknown: false,
    missingPayloads,
    fetchablePayloads,
  };
}

/**
 * The label on the control that fetches a payload.
 *
 * Names the SIDE for a file snapshot: a `file_change` offers two, and two
 * controls reading "File contents" would leave the reader guessing which is
 * which.
 */
function describeFetchablePayload(ref: ChatPayloadRef): string {
  if (ref.kind === "plan-content") return "Full plan text";
  return ref.side === "before"
    ? "File contents (before)"
    : "File contents (after)";
}

type BlockSummary = {
  readonly label: string;
  readonly body: string | null;
  readonly details: readonly string[];
};

const NO_DETAILS: readonly string[] = [];

/**
 * Reduces a known block to a title, its text (when it HAS text), and a few
 * short facts.
 *
 * Every arm reads persisted fields only. Nothing here reconstructs content the
 * record deliberately does not carry - tool output, command stdout and file
 * bodies are all absent by design, and inventing a stand-in for them would
 * misrepresent the chat.
 */
// One arm per block type; splitting it would only scatter the same table.
// eslint-disable-next-line complexity
function summarizeBlock(block: SnapshotContentBlock): BlockSummary {
  switch (block.type) {
    case "text":
      return { label: "Response", body: block.text, details: NO_DETAILS };
    case "reasoning":
      return { label: "Thinking", body: block.content, details: NO_DETAILS };
    case "tool_call":
      return {
        label: `Tool · ${block.toolName}`,
        body: block.inputSummary,
        details: [block.status],
      };
    case "file_change":
      return {
        label: `File · ${block.filePath}`,
        body: null,
        details: [block.operation, block.status],
      };
    case "command":
      return {
        label: "Command",
        body: block.command,
        details: compact([
          block.cwd,
          block.exitCode === null ? null : `exit ${block.exitCode}`,
          block.status,
        ]),
      };
    case "subagent":
      return {
        label: `Subagent${block.name === null ? "" : ` · ${block.name}`}`,
        body: block.result ?? block.task,
        details: [block.status],
      };
    case "approval":
      return {
        label: `Approval${block.toolName === null ? "" : ` · ${block.toolName}`}`,
        body: block.description ?? block.inputSummary,
        details: compact([approvalDecisionLabel(block.decision)]),
      };
    case "todo":
      return {
        label: "Plan checklist",
        body: block.items
          .map((item) => `${item.status} · ${item.text}`)
          .join("\n"),
        details: NO_DETAILS,
      };
    case "plan":
      return {
        label: `Plan${block.title === null ? "" : ` · ${block.title}`}`,
        body: block.summary ?? block.markdownPreview,
        details: [block.planStatus],
      };
    case "error":
      return {
        label: "Error",
        body: block.message,
        details: compact([block.code]),
      };
    case "compaction":
      return {
        label: "Conversation compacted",
        body: null,
        details: compact([block.trigger]),
      };
    case "autonomous_resume":
      return { label: "Autonomous resume", body: null, details: NO_DETAILS };
    case "steer":
      return {
        label: "Steer",
        body: extractPlainTextFromComposerJSONContent(block.content),
        details: NO_DETAILS,
      };
    case "interview":
      return {
        label: `Question${block.title === null ? "" : ` · ${block.title}`}`,
        body: block.questions.map((question) => question.question).join("\n"),
        details: NO_DETAILS,
      };
    case "artifact_operation":
      return {
        label: "Artifact",
        body: null,
        details: compact([block.operation, block.kind, block.title]),
      };
  }
}

/** `null` while an approval is still pending - not yet decided is not "denied". */
function approvalDecisionLabel(
  decision: { readonly approved: boolean } | null,
): string | null {
  if (decision === null) return null;
  return decision.approved ? "approved" : "denied";
}

function buildEvent(
  event: PresentedChatEvent,
  index: number,
): TranscriptEventDisplay {
  const known = event.known;
  if (known === null) {
    return {
      key: rowKey("e", index, event.eventId),
      label: describeUnknownVariant("event", event.variant),
      detail: null,
      timestamp: event.timestamp,
      isUnknown: true,
    };
  }
  return {
    key: rowKey("e", index, event.eventId),
    label: known.type,
    detail: known.message,
    timestamp: event.timestamp,
    isUnknown: false,
  };
}

/**
 * A list key that is unique even when the record carries no id.
 *
 * The index alone would be unstable across a re-read, and the id alone can be
 * null (or, for an unknown variant, absent entirely). Both together are stable
 * within one rendered transcript, which is all a list key has to be.
 */
function rowKey(prefix: string, index: number, id: string | null): string {
  return `${prefix}:${index}:${id ?? ""}`;
}

function compact(values: readonly (string | null)[]): readonly string[] {
  const kept = values.filter((value): value is string => value !== null);
  return kept.length === 0 ? NO_DETAILS : kept;
}
