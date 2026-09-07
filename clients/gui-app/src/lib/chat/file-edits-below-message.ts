import {
  isNoOpCheckpointEntry,
  turnCheckpointManifestSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  ChatEvent,
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  holdsEveryRecordFrom,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * True when the turn triggered by `fromMessageId` - or any turn after it - captured at least one undoable file change.
 * Drives whether the "Submit from a previous message?" modal appears when editing a message: the modal only matters when there are reversible edits below the edit point.
 */
export function hasUndoableFileEditsFromMessage(
  messages: ReadonlyArray<Message>,
  events: ReadonlyArray<ChatEvent>,
  fromMessageId: string,
): boolean {
  const fromIndex = messages.findIndex(
    (message) => message.role === "user" && message.messageId === fromMessageId,
  );
  if (fromIndex === -1) return false;
  const includedMessageIds = new Set(
    messages
      .slice(fromIndex)
      .filter((message): message is UserMessage => message.role === "user")
      .map((message) => message.messageId),
  );
  return events.some((event) => {
    if (event.type !== "checkpoint.captured") return false;
    if (event.messageId === null || !includedMessageIds.has(event.messageId)) {
      return false;
    }
    const parsed = turnCheckpointManifestSchema.safeParse(event.metadata);
    if (!parsed.success) return false;
    // A no-op entry (touched but net-unchanged) reverts to nothing, so it must not count as a reversible edit below the edit point - otherwise the "Submit from a previous message?" modal would appear with nothing to undo.
    return parsed.data.entries.some(
      (entry) => entry.undoable && !isNoOpCheckpointEntry(entry),
    );
  });
}

/**
 * Count of distinct undoable artifacts that a revert from `fromMessageId` (its turn + every turn after) would touch - drives the "Also revert N artifacts" opt-out in the revert-on-edit dialog.
 */
export function scopedArtifactCountFromMessage(
  messages: ReadonlyArray<Message>,
  events: ReadonlyArray<ChatEvent>,
  fromMessageId: string,
): number {
  const fromIndex = messages.findIndex(
    (message) => message.role === "user" && message.messageId === fromMessageId,
  );
  if (fromIndex === -1) return 0;
  const includedMessageIds = new Set(
    messages
      .slice(fromIndex)
      .filter((message): message is UserMessage => message.role === "user")
      .map((message) => message.messageId),
  );
  const seen = new Set<string>();
  events
    .filter(
      (event) =>
        event.type === "checkpoint.captured" &&
        event.messageId !== null &&
        includedMessageIds.has(event.messageId),
    )
    .flatMap((event) => {
      const parsed = turnCheckpointManifestSchema.safeParse(event.metadata);
      return parsed.success ? parsed.data.entries : [];
    })
    .filter(
      (entry) =>
        entry.artifact && entry.undoable && !isNoOpCheckpointEntry(entry),
    )
    .forEach((entry) => seen.add(entry.filePath));
  return seen.size;
}

/** What a revert from `fromMessageId` would touch, or that the client cannot say. */
export type RevertScope =
  | {
      readonly known: true;
      readonly hasUndoableFileEdits: boolean;
      readonly artifactCount: number;
    }
  | { readonly known: false };

/** Both scans and their precondition, resolved together. */
export function resolveRevertScope(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly transcriptWindow: TranscriptWindow | null;
  readonly fromMessageId: string;
}): RevertScope {
  const { events, fromMessageId, messages, transcriptWindow } = input;
  if (
    transcriptWindow !== null &&
    !holdsEveryRecordFrom(transcriptWindow, fromMessageId)
  ) {
    return { known: false };
  }
  return {
    known: true,
    hasUndoableFileEdits: hasUndoableFileEditsFromMessage(
      messages,
      events,
      fromMessageId,
    ),
    artifactCount: scopedArtifactCountFromMessage(
      messages,
      events,
      fromMessageId,
    ),
  };
}

/** Must submitting this edit go through the revert prompt first? */
export function editSubmitNeedsRevertPrompt(scope: RevertScope): boolean {
  return !scope.known || scope.hasUndoableFileEdits;
}

/** The number the revert prompt's artifact opt-out shows, or `null` for none. */
export function revertPromptArtifactCount(
  scope: RevertScope | null,
): number | null {
  if (scope === null) return null;
  return scope.known ? scope.artifactCount : null;
}
