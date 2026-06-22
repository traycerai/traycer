import {
  isNoOpCheckpointEntry,
  turnCheckpointManifestSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  ChatEvent,
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";

/**
 * True when the turn triggered by `fromMessageId` - or any turn after it -
 * captured at least one undoable file change. Drives whether the
 * "Submit from a previous message?" modal appears when editing a message:
 * the modal only matters when there are reversible edits below the edit point.
 *
 * Mirrors the host's `scopedCheckpointEvents`: checkpoint manifests are
 * keyed to their triggering user message via `ChatEvent.messageId`, so
 * "below the message" is resolved by message index, not timestamp.
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
    // A no-op entry (touched but net-unchanged) reverts to nothing, so it must
    // not count as a reversible edit below the edit point - otherwise the
    // "Submit from a previous message?" modal would appear with nothing to undo.
    return parsed.data.entries.some(
      (entry) => entry.undoable && !isNoOpCheckpointEntry(entry),
    );
  });
}

/**
 * Count of distinct undoable artifacts that a revert from `fromMessageId` (its
 * turn + every turn after) would touch - drives the "Also revert N artifacts"
 * opt-out in the revert-on-edit dialog. Deduped by FILE PATH (the artifact's
 * stable `index.md`), matching how the revert collapses entries per path
 * (`restoreCumulative` → `earliestEntriesByPath`) - so the shown count equals
 * what is actually reverted, even if an artifact's id was unresolved in one turn
 * and resolved in a later one. Scoping mirrors `hasUndoableFileEditsFromMessage`.
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
