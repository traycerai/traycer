import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

/**
 * The encoding every measurement of a record is taken over.
 *
 * Exported so a caller that needs the STRING - the skeleton's body fingerprint
 * absorbs it - can take the length from the same encoding rather than
 * stringifying a second time, and, more importantly, rather than re-declaring
 * what "a record's bytes" means. Two definitions that agree by inspection is
 * the drift this module exists to prevent.
 */
export function encodeRecord(record: Message | ChatEvent): string {
  return JSON.stringify(record);
}

/**
 * What this record costs to ship: the byte length of its JSON encoding, which
 * is what a hydration response actually carries.
 *
 * Used for two different jobs, and they want the same number: the skeleton's
 * scroll-height hint, and the range reader's byte budget. Deriving them from
 * one function is what keeps a budget from being spent in units the hint did
 * not measure.
 */
export function recordByteLength(record: Message | ChatEvent): number {
  return utf8ByteLength(encodeRecord(record));
}
