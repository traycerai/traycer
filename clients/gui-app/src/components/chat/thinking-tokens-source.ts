import { createContext, use, useCallback, useSyncExternalStore } from "react";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { formatTokens } from "@/components/chat/context-usage";
import {
  selectActiveThinkingTokensEstimate,
  type ChatThinkingTokensReading,
} from "@/stores/chats/chat-thinking-tokens";

/**
 * Where the streaming "Thinking" label reads the thinking-token estimate from:
 * the chat session store, narrowed to the two fields the read needs.
 *
 * A SOURCE rather than a value on purpose. The estimate moves up to once a
 * second while a turn thinks, and a context carrying the number would
 * re-render every consumer below the provider - the whole transcript - on
 * each move. Carrying the store instead lets the one label that shows it
 * subscribe on its own, so nothing else renders.
 */
export interface ThinkingTokensSource {
  readonly getState: () => {
    readonly activeTurn: ChatActiveTurn | null;
    readonly thinkingTokens: ChatThinkingTokensReading | null;
  };
  readonly subscribe: (listener: () => void) => () => void;
}

/** `null` outside a chat tile (isolated renders): the label draws nothing. */
export const ThinkingTokensSourceContext =
  createContext<ThinkingTokensSource | null>(null);

function subscribeToNothing(): () => void {
  return () => undefined;
}

/** The estimate for the live active turn, or `null`. */
export function useActiveThinkingTokensEstimate(): number | null {
  const source = use(ThinkingTokensSourceContext);
  const getSnapshot = useCallback(
    (): number | null =>
      source === null
        ? null
        : selectActiveThinkingTokensEstimate(source.getState()),
    [source],
  );
  return useSyncExternalStore(
    source === null ? subscribeToNothing : source.subscribe,
    getSnapshot,
  );
}

/** "~1.2k tokens" - an approximation, and the copy says so. */
export function formatThinkingTokensEstimate(estimate: number): string {
  return `~${formatTokens(estimate)} tokens`;
}
