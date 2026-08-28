import { AUTH_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { AssistantMessage } from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";

/**
 * # "Did this chat's last turn fail on a provider credential?"
 *
 * The question the store asks on every authoritative snapshot so a failure that
 * happened with no live subscriber - a headless A2A turn, a turn that ran while
 * the tab was closed - still invalidates the stale `providers.list` query and
 * mounts the re-auth banner when the user comes back.
 *
 * ## Why it is a whole-transcript derivation
 *
 * The store answered it by scanning the snapshot's records backwards for the
 * last assistant one. That is sound only while `messages` IS the transcript. On
 * the windowed line it is the hydrated subset, and the failing turn is outside
 * it in exactly the case the legacy suite already covers: a headless failure
 * followed by user rows, which pushes the assistant record out of the inline
 * tail. The scan then finds a LATER assistant record with no error block - or
 * none at all - and reports "no failure", permanently, because nothing re-sends
 * a snapshot to correct it. The banner never mounts and the composer keeps
 * sending against a credential the host has already poisoned.
 *
 * So the answer travels as a scalar on `chatTranscriptDerived`, and the
 * selection lives here because BOTH lines run it: the renderer against a legacy
 * peer's full array, the host against the whole transcript. Two copies that
 * agreed by inspection would drift on the first change to what counts as a
 * failure, and the drift would be invisible - a banner that mounts against one
 * host version and not another reads as a flaky host, not as a code defect.
 *
 * ## Why the answer is a KEY rather than a boolean
 *
 * The nudge is deduped by the failed turn, not once per store lifetime: a
 * reconnect can surface a NEW headless failure after the user has already
 * re-authed the previous one, and that later snapshot must still invalidate the
 * query. A boolean cannot distinguish "the same failure again" from "another
 * one", so the derivation returns the marker the store compares.
 */

/**
 * The nudge key of the latest assistant record when THAT record carries a
 * recoverable provider-auth error block; `null` when it does not, or when the
 * transcript has no assistant record at all.
 *
 * ## Why the LATEST record and not "any record with an auth error"
 *
 * A recovered chat still holds its old failure rows forever. What decides
 * whether the credential is broken NOW is whether the most recent turn ended
 * that way, which is the condition the store has always used - preserved here
 * verbatim rather than improved, because the two lines have to agree and the
 * legacy line is the one already in the field.
 *
 * ## Why RECORD order rather than display order
 *
 * `upsertEntry` appends an unseen record at the array tail, so a checkpoint
 * restore re-adds an older record after newer ones while its display position
 * stays historical - the drift `fork-boundary.ts` documents. This walks the raw
 * array anyway, because the value being preserved is the LEGACY store's answer
 * and that is what the legacy store computes. Switching to canonical order here
 * would make the same chat mount the banner on one host version and not on
 * another, which is the exact failure this module exists to prevent. If that
 * ordering is wrong it is wrong on both lines, and it is one change to both.
 *
 * The key mirrors the store's own marker so the live `blockDelta` path and this
 * one dedupe against each other: `turnId` when the record has one, and the
 * record id otherwise. Note this is deliberately NOT `assistantTurnKey`, whose
 * fallback is the timestamp - a record dedupes against the live path by the
 * turn the runtime named, and a record with no `turnId` never had one.
 */
export function latestAssistantAuthFailureTurnKey(
  messages: readonly Message[],
): string | null {
  const lastAssistant = messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  if (lastAssistant === undefined) return null;
  const hasAuthError = lastAssistant.blocks.some(
    (block) => block.type === "error" && block.code === AUTH_ERROR_CODE,
  );
  if (!hasAuthError) return null;
  return lastAssistant.turnId ?? lastAssistant.messageId;
}
