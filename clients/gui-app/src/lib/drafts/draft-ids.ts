import { v4 as uuidv4 } from "uuid";

export function mintDraftId(): string {
  return uuidv4();
}

/**
 * The id a composer draft persisted BEFORE drafts carried ids takes on when
 * it is hydrated. Deterministic on purpose: hydration's `merge` result is
 * never written back by the persist middleware, so two windows hydrating
 * the same legacy draft would each mint their own id and publish both.
 * Deriving it from the composer key makes every window converge on one id
 * without a single-writer handshake. The key is a chat id, unique per
 * composer, and the prefix keeps it out of the minted-uuid space.
 */
export function legacyComposerDraftId(composerKey: string): string {
  return `legacy-composer-${composerKey}`;
}

export function interviewDraftBindingKey(
  chatId: string,
  blockId: string,
): string {
  return `${chatId}\u0000${blockId}`;
}
