import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * Names the exact generation of a composer's canonical content at the moment
 * a stash capture starts. `identity` is the owner's key (task/draft/epic id);
 * `revision` is a monotonic counter the owner bumps on every real content
 * change. `clearIfUnchanged` only clears when both still match at that later
 * point, so an edit made while the stash was saving is never erased.
 */
export type PromptStashSurface =
  "chat" | "landing" | "new-conversation" | "test";

export interface PromptStashSourceToken {
  readonly surface: PromptStashSurface;
  readonly identity: string;
  readonly revision: number;
}

export interface PromptStashSourceSnapshot {
  readonly content: JsonContent;
  readonly token: PromptStashSourceToken;
}

/**
 * Reads content out of and clears content back into the canonical owner of a
 * composer surface (chat draft store / landing draft runtime / new-
 * conversation modal draft) rather than the live Tiptap editor, so a stash
 * capture survives edits, task/draft switches, and unmounts that happen while
 * the durable save is still in flight.
 */
export interface PromptStashSourceAdapter {
  /** Current content/token from the canonical owner, or `null` when there is none. */
  readonly capture: () => PromptStashSourceSnapshot | null;
  /**
   * Clears the canonical owner only if it still matches `token` (same
   * identity and revision as when it was captured). Returns whether it
   * cleared.
   */
  readonly clearIfUnchanged: (token: PromptStashSourceToken) => boolean;
}
