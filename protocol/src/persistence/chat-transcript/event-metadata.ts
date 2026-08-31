import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";

/**
 * # Reading a chat event's metadata bag
 *
 * `ChatEvent.metadata` is an untyped `Record<string, unknown>`, so every reader
 * has to narrow. These are the narrowings, in one place, because both the
 * renderer and the host's row numbering read the same keys and a reader that
 * disagreed with its counterpart would shift ordinals.
 *
 * ## These are NOT `renderableMetadataString`
 *
 * `row-order.ts` has a near-identical helper that additionally rejects the
 * EMPTY string, and the difference is deliberate on both sides:
 *
 * - {@link readMetadataString} is the RAW narrowing - `""` reads as a present
 *   empty string. Callers that treat empty as absent do so explicitly, at the
 *   call site, where the reason is visible (the setup-card walk drops an
 *   empty `workspacePath`; an empty `triggeringMessageId` anchors nothing
 *   because no row carries that id).
 * - `renderableMetadataString` folds empty into `null` because for a fork
 *   link the presence of the key IS the decision to draw a row.
 *
 * Do not "unify" them. The first version of the fork predicate used the raw
 * narrowing and would have materialized a row the renderer does not draw -
 * putting every later body under the wrong row. Two narrowings with two
 * documented meanings is the state that survived review; one narrowing used
 * for both meanings is the bug.
 */

export function readMetadataString(
  event: ChatEvent,
  key: string,
): string | null {
  const metadata = event.metadata;
  if (metadata === null) return null;
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

export function readMetadataNumber(
  event: ChatEvent,
  key: string,
): number | null {
  const metadata = event.metadata;
  if (metadata === null) return null;
  const value = metadata[key];
  return typeof value === "number" ? value : null;
}

/**
 * Raw metadata value for structured payloads (objects the caller validates
 * with a schema - e.g. the `folderIntent` a `setup.failed` event carries).
 * Returns `undefined` when the event has no metadata or the key is absent.
 */
export function readMetadataValue(event: ChatEvent, key: string): unknown {
  const metadata = event.metadata;
  if (metadata === null) return undefined;
  return metadata[key];
}
