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

/**
 * What a revert from `fromMessageId` would touch, or that the client cannot
 * say.
 *
 * Both scans above walk DOWNWARD from the edit point over `messages` and
 * `events`, and on the windowed line both arrays are a window. Neither can tell
 * a record that does not exist from one that is merely not hydrated, so on a
 * partly-hydrated transcript they answer "no undoable edits" and "0 artifacts"
 * with the same confidence they answer a genuinely clean history - which is the
 * wrong answer delivered silently, twice over: the revert prompt never opens,
 * and the artifact opt-out never appears for artifacts that WILL be reverted.
 *
 * `known: false` is that case named. It is not a failure - the host still
 * computes the true scope when it performs the revert, and the surfaces this
 * feeds degrade toward asking rather than toward assuming (see the call site).
 * What it removes is the silence.
 */
export type RevertScope =
  | {
      readonly known: true;
      readonly hasUndoableFileEdits: boolean;
      readonly artifactCount: number;
    }
  | { readonly known: false };

/**
 * Both scans and their precondition, resolved together.
 *
 * One entry point rather than two guarded call sites because the guard is the
 * same fact for both, and a caller that checked it for one and forgot it for
 * the other would show the prompt with an under-count - the most misleading of
 * the available wrong answers, since a number reads as a measurement.
 *
 * `transcriptWindow` is `null` on the legacy line, where `messages`/`events`
 * ARE the whole transcript and the answer is therefore always known.
 */
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

/**
 * Must submitting this edit go through the revert prompt first?
 *
 * An UNKNOWN scope prompts, and the asymmetry is the whole argument. Skipping
 * the prompt is not "do nothing" - it submits with `revertFileChanges: false`,
 * which makes the "Don't revert" choice on the user's behalf for file edits
 * they were never shown. Raising it over a history that turns out to hold
 * nothing costs one extra click on a dialog whose "Don't revert" button does
 * exactly what skipping it would have done.
 *
 * So the two errors are a stray dialog against a silent unasked-for decision,
 * and only one of them is recoverable by the person it happens to.
 */
export function editSubmitNeedsRevertPrompt(scope: RevertScope): boolean {
  return !scope.known || scope.hasUndoableFileEdits;
}

/**
 * The number the revert prompt's artifact opt-out shows, or `null` for none.
 *
 * The other half of {@link editSubmitNeedsRevertPrompt}, and here for the same
 * reason: these are the two questions the prompt asks of a scope, and both have
 * an answer that a `number` cannot carry. Collapsing this one to `0` reads as
 * "no artifacts" and HIDES the opt-out - which, since it defaults to checked,
 * reverts artifacts with nothing on screen having said so.
 */
export function revertPromptArtifactCount(
  scope: RevertScope | null,
): number | null {
  if (scope === null) return null;
  return scope.known ? scope.artifactCount : null;
}
