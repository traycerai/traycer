import { AUTH_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { AssistantMessage } from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";

/**
 * The question the store asks on every authoritative snapshot so a failure that happened with no live subscriber - a headless A2A turn, a turn that ran while the tab was closed - still invalidates the stale.
 * The banner never mounts and the composer keeps sending against a credential the host has already poisoned.
 */

/**
 * The nudge key of the latest assistant record when THAT record carries a recoverable provider-auth error block; `null` when it does not, or when the transcript has no assistant record at all.
 * Note this is deliberately NOT `assistantTurnKey`, whose fallback is the timestamp - a record dedupes against the live path by the turn the runtime named, and a record with no `turnId` never had one.
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
