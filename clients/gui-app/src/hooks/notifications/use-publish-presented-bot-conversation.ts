import { useEffect } from "react";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import {
  setBotSurfaceFocused,
  setPresentedBotConversation,
} from "@/lib/notifications/notification-presence";

/**
 * Holds the bot surface as this window's focused surface while its pane is
 * focused, whichever view it shows, so a view with no conversation never reads
 * as the canvas tile retained behind it.
 */
export function useClaimBotSurfaceFocus(): void {
  const paneFocused = usePaneFocused();
  useEffect(() => {
    if (!paneFocused) return;
    setBotSurfaceFocused(true);
    return () => setBotSurfaceFocused(false);
  }, [paneFocused]);
}

/**
 * Publishes the conversation a bot surface presents as this window's focused
 * notification presence, so its rows are consumed the way a focused task chat's
 * are; with neither presented, it is withdrawn. Presence names one entity, so a
 * presented thread wins over the channel beside it, and an unfocused split pane
 * publishes nothing, leaving it to the focused partner.
 */
export function usePublishPresentedBotConversation(
  botId: string,
  presentedThreadId: string | null,
  presentedChannelId: string | null,
): void {
  const paneFocused = usePaneFocused();
  const presentedId = paneFocused
    ? (presentedThreadId ?? presentedChannelId)
    : null;
  useEffect(() => {
    setPresentedBotConversation(
      presentedId === null ? null : { epicId: botId, chatId: presentedId },
    );
  }, [botId, presentedId]);
  // Withdrawal on unmount is its own effect: in the publish effect's cleanup, a
  // channel switch would announce an empty entity between the two conversations
  // instead of replacing one with the other.
  useEffect(() => () => setPresentedBotConversation(null), []);
}
