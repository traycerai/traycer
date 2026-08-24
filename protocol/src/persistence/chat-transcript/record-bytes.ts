import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

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
  return utf8ByteLength(JSON.stringify(record));
}
