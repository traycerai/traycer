const UTF8_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of `value`. Uses `TextEncoder` (not `Buffer`) so this stays
 * callable from browser-hosted surfaces, not just Node.
 *
 * Lives here rather than beside either of its callers because it has two
 * unrelated ones - the A2A message-size gate (`host/agent/shared.ts`) and the
 * transcript skeleton's byte hints (`persistence/chat-transcript/record-bytes.ts`)
 * - and a byte count they disagreed about would be a budget spent in units the
 * measurement did not use.
 */
export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}
