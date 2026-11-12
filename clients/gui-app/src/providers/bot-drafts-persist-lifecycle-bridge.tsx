import { useCallback, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { appendBelow } from "@/components/chat/quote/append-comment-text-to-draft";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { botBoxContentOf, botBoxText } from "@/lib/bots/bot-box-content";
import { retireLegacyBotBoxDrafts } from "@/lib/bots/bot-box-draft-storage";
import { botBoxDraftsKey } from "@/lib/persist";
import { botMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useBotDraftsStore,
  type BotRetiredPart,
  type BotThreadBoxDraft,
} from "@/stores/bots/bot-drafts-store";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";

export interface BotDraftsPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Keeps each account's bot drafts apart (T186). A box can hold a member's
 * private answer to a team bot's question, moved there when a teammate
 * answered first, so whoever signs in next on this profile must never read
 * it.
 *
 * Every change of account first retires the one signed in: each box's failed
 * send offered back, and the answers moved off its cards that no box holds
 * yet, go into that box's draft; its drafts are written under its own key,
 * and the store is emptied, so nothing of it reaches the next account. Its
 * answers to surface cards and its settled sends go from the stores that kept
 * them. A card, send or box of it that answers late changes nothing
 * (`useBotDraftActions`), and the bot tab's tree starts again for the next
 * account (`BotTabSurface`). Its stored drafts stay, for when it signs in
 * again. Then a signed-in account's own drafts are read. Signed out, none are
 * read and nothing is written.
 */
export function BotDraftsPersistLifecycleBridge(
  props: BotDraftsPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const queryClient = useQueryClient();

  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      useBotDraftsStore.getState().retire(withRetiredParts);
      useBotSurfaceActionsStore.setState({ entries: {} });
      forgetSettledSends(queryClient);
      const account =
        transition.kind === "signedOut" ? null : transition.userId;
      useBotDraftsStore.persist.setOptions({ name: botBoxDraftsKey(account) });
      // An identity without an account id has no drafts of its own to read.
      if (account === null) return;
      retireLegacyBotBoxDrafts();
      void useBotDraftsStore.persist.rehydrate();
    },
    [queryClient],
  );

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}

/**
 * Drops the bot sends and surface actions that have settled from the query
 * cache, which keeps each one's text, attachments or answers for minutes
 * after. One still out stays until it settles: what it sends is held by the
 * send itself.
 */
function forgetSettledSends(queryClient: QueryClient): void {
  const cache = queryClient.getMutationCache();
  for (const mutationKey of [
    botMutationKeys.conversationSend(),
    botMutationKeys.surfaceAct(),
  ]) {
    for (const mutation of cache.findAll({ mutationKey })) {
      if (mutation.state.status !== "pending") cache.remove(mutation);
    }
  }
}

/**
 * A box's kept draft with `parts` below what it holds, a blank line between
 * each, as the box itself adds them.
 */
function withRetiredParts(
  kept: BotThreadBoxDraft | null,
  parts: ReadonlyArray<BotRetiredPart>,
): BotThreadBoxDraft {
  const seedId = kept?.seedId ?? 0;
  // Text put there from outside the box stays text: the box makes its
  // document, chips included, when it loads it.
  const blocks = movedBlocksOnly(parts);
  if (blocks !== null && (kept === null || kept.content === null)) {
    const text = [...(kept === null ? [] : [kept.text]), ...blocks]
      .filter((part) => part.length > 0)
      .join("\n\n");
    return { text, content: null, seedId };
  }
  let content: JsonContent | null =
    kept === null ? null : (kept.content ?? contentOfLines(kept.text));
  for (const part of parts) {
    const below =
      part.kind === "move" ? contentOfLines(part.block) : part.content;
    content =
      content === null ? below : appendBelow(content, below.content ?? []);
  }
  return {
    text: content === null ? "" : botBoxText(content),
    content,
    seedId,
  };
}

/** The moved blocks `parts` holds, `null` once it holds a failed send. */
function movedBlocksOnly(
  parts: ReadonlyArray<BotRetiredPart>,
): ReadonlyArray<string> | null {
  const blocks: Array<string> = [];
  for (const part of parts) {
    if (part.kind !== "move") return null;
    blocks.push(part.block);
  }
  return blocks;
}

/** Lines as a box's document; a mention token stays as written: no box is there to name it. */
function contentOfLines(lines: string): JsonContent {
  return botBoxContentOf(lines, noMentionNames);
}

function noMentionNames(): null {
  return null;
}
