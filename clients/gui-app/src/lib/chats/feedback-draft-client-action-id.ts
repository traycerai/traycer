import { v4 as uuidv4 } from "uuid";

/**
 * The `clientActionId` of one Send or Skip click. `crypto.randomUUID` throws
 * outside a secure context (plain http), and `uuid`'s bare `v4()` calls it
 * too; random bytes from `getRandomValues` work in either.
 */
export function newFeedbackDraftClientActionId(): string {
  return uuidv4({ random: crypto.getRandomValues(new Uint8Array(16)) });
}
