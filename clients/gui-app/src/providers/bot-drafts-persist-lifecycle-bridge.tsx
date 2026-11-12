import { useCallback, type ReactNode } from "react";
import { appendBelow } from "@/components/chat/quote/append-comment-text-to-draft";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { botBoxContentOf, botBoxText } from "@/lib/bots/bot-box-content";
import { retireLegacyBotBoxDrafts } from "@/lib/bots/bot-box-draft-storage";
import { botBoxDraftsKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useBotDraftsStore,
  type BotThreadBoxDraft,
} from "@/stores/bots/bot-drafts-store";

export interface BotDraftsPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Keeps each account's bot drafts apart (T186). A box can hold a member's
 * private answer to a team bot's question, moved there when a teammate
 * answered first, so whoever signs in next on this profile must never read
 * it.
 *
 * Every change of account first retires the one signed in: answers moved off
 * its cards that no box holds yet go into that box's draft, its drafts are
 * written under its own key, and the store is emptied, so nothing of it
 * reaches the next account; a card, send or box of it that answers late
 * changes nothing (`useBotDraftActions`). Its stored drafts stay, for when it
 * signs in again. Then a signed-in account's own drafts are read. Signed out,
 * none are read and nothing is written.
 */
export function BotDraftsPersistLifecycleBridge(
  props: BotDraftsPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    useBotDraftsStore.getState().retire(withMovedAnswers);
    const account = transition.kind === "signedOut" ? null : transition.userId;
    useBotDraftsStore.persist.setOptions({ name: botBoxDraftsKey(account) });
    // An identity without an account id has no drafts of its own to read.
    if (account === null) return;
    retireLegacyBotBoxDrafts();
    void useBotDraftsStore.persist.rehydrate();
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}

/**
 * A box's kept draft with the answers moved there below what it holds, a
 * blank line between, as the box itself adds them.
 */
function withMovedAnswers(
  kept: BotThreadBoxDraft | null,
  blocks: ReadonlyArray<string>,
): BotThreadBoxDraft {
  const seedId = kept?.seedId ?? 0;
  // Text put there from outside the box stays text: the box makes its
  // document, chips included, when it loads it.
  if (kept === null || kept.content === null) {
    const text = [...(kept === null ? [] : [kept.text]), ...blocks]
      .filter((part) => part.length > 0)
      .join("\n\n");
    return { text, content: null, seedId };
  }
  const content = blocks.reduce(
    (doc, block) =>
      appendBelow(doc, botBoxContentOf(block, noMentionNames).content ?? []),
    kept.content,
  );
  return { text: botBoxText(content), content, seedId };
}

/** A mention token in the lines stays as written: no box is there to name it. */
function noMentionNames(): null {
  return null;
}
