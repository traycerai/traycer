import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

/** The encoding every measurement of a record is taken over. */
export function encodeRecord(record: Message | ChatEvent): string {
  return JSON.stringify(record);
}

/**
 * What this record costs to ship: the byte length of its JSON encoding, which is what a hydration response actually carries.
 */
export function recordByteLength(record: Message | ChatEvent): number {
  return utf8ByteLength(encodeRecord(record));
}
