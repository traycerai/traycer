import { create, useStore } from "zustand";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { fallbackComposerCardVisible } from "./fallback-state";
import {
  composerRateLimitAdvisory,
  type ComposerRateLimitAdvisory,
} from "./fallback-return-low-usage";
import {
  failedTurnSwitchOffered,
  failedTurnSwitchSeed,
  refusalForAttempt,
  useFailedTurnRefusal,
  type FailedTurnRefusal,
} from "./failed-turn-actions";

type SettledCardSlice = Pick<
  ChatSessionState,
  "lastFailedAttempt" | "pendingFallback" | "access" | "messages" | "chat"
>;

/**
 * The account the composer's rate-limit banner speaks about: its selected
 * harness and profile (`null` is the Terminal account).
 */
export interface ComposerBannerAccount {
  readonly harnessId: string;
  readonly profileId: string | null;
}

/**
 * Stand-in for a chat with no live session: no failed attempt, so no card.
 */
const emptySlice = create<SettledCardSlice>()(() => ({
  lastFailedAttempt: undefined,
  pendingFallback: undefined,
  access: null,
  messages: [],
  chat: null,
}));

/**
 * Whether the transcript is showing a settled routing card that DRAWS "Switch
 * to…" for the account the composer's banner would name - the gap the
 * composer's one-at-a-time chain could not see (clutter cuts, 2026-09-27).
 *
 * The chain already keeps the rate-limit banner off while a countdown, a wait
 * or a switch-back offer is drawn. A settled card is transcript, not composer,
 * so it never entered the chain, and the banner's "Switch to" sat beside the
 * card's own "Switch to…" for the same limit. This answers the one question the
 * composer needs: is that card on screen, drawing its switch, about this
 * account?
 *
 * The SWITCH, not any button: the banner's one action is a switch, and a card
 * left with only Retry or a wait does not offer it - so the banner returns
 * beside those (review F4, 2026-09-27). Drawn counts even while greyed: a
 * press in flight and a reconnect both keep the trigger on screen, and both
 * end in a new attempt or a refusal, which this reads again.
 *
 * Each term is the card's own render condition, read from the same session
 * and the same refusal record:
 *
 * - `lastFailedAttempt` defined. It is what `FallbackManualRungActions` draws
 *   from.
 * - No routing card live in the composer - while one is, the transcript row
 *   stands down (`useChatFallbackTraversalIsLive`), and the chain handles the
 *   banner anyway.
 * - Not a viewer: a viewer's card has no actions.
 * - The card draws "Switch to…" - `failedTurnSwitchOffered`, the very function
 *   the card asks, over the refusal the card recorded for this attempt. A
 *   refusal that took the switch away brings the banner back.
 * - The failed tuple is the composer's account. A composer switched to another
 *   account that is itself limited still gets the banner about THAT account.
 *   With no failed tuple (its replay envelope is gone) the card is about this
 *   chat, which is the only account the composer is showing.
 * - The attempt's turn carries a top-level notice with a receipt - the
 *   settled card's own predicate (`routingSettledNoticeSegmentId`). Without
 *   one routing never ran on that turn (routing off, or nothing to try), the
 *   row is the plain failed-turn card, and the banner stays: it is the one
 *   surface for a limit routing did not handle. A user's own refusal writes
 *   no receipt either (a host that writes its notice writes `receipt: null`,
 *   and the transcript hides it), so the banner stays after a refusal too, by
 *   ruling (2026-09-27): the account is still limited, and a failed-turn card
 *   beside it is the case this keeps.
 *
 * Asked of the TURN, where the card's pairing is asked of one rendered row. A
 * steer that splits the notice from the error leaves a divider above and the
 * failed-turn card below; routing did settle that turn, and the card below
 * carries the same actions, so the banner stays off there too.
 */
export function settledRoutingCardOffersSwitch(
  state: SettledCardSlice,
  refusal: FailedTurnRefusal | null,
  account: ComposerBannerAccount,
): boolean {
  const attempt = state.lastFailedAttempt;
  if (attempt === undefined) return false;
  if (fallbackComposerCardVisible(state.pendingFallback)) return false;
  if (state.access !== null && !state.access.canAct) return false;
  const drawsSwitch = failedTurnSwitchOffered({
    attempt,
    refusal: refusalForAttempt(refusal, attempt),
    seedTuple: failedTurnSwitchSeed(
      attempt,
      state.chat === null ? null : state.chat.settings,
    ),
  });
  if (!drawsSwitch) return false;
  const failed = attempt.failedTuple;
  if (
    failed !== null &&
    (failed.harnessId !== account.harnessId ||
      failed.profileId !== account.profileId)
  ) {
    return false;
  }
  return turnCarriesSettledReceipt(state.messages, attempt.turnId);
}

/**
 * Whether the assistant messages of `turnId` hold a top-level provider notice
 * with a receipt.
 *
 * Walked from the tail: the failed attempt is the latest one (a later turn
 * makes the host stop defining it), so its messages are the last assistant
 * messages, and the walk stops at the first assistant message of another turn
 * once it has seen this one.
 */
function turnCarriesSettledReceipt(
  messages: ReadonlyArray<Message>,
  turnId: string,
): boolean {
  let seen = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (message.turnId !== turnId) {
      if (seen) return false;
      continue;
    }
    seen = true;
    const carries = message.blocks.some(
      (block) =>
        block.type === "text" &&
        block.providerNotice !== null &&
        (block.providerNotice.receipt ?? null) !== null &&
        (block.parentBlockId ?? null) === null,
    );
    if (carries) return true;
  }
  return false;
}

/**
 * {@link settledRoutingCardOffersSwitch}, read off the chat's session.
 *
 * A boolean selector, so a session frame that changes nothing it reads
 * re-renders nothing. `epicId` is `null` outside an epic (the home composer),
 * which has no transcript and so no card.
 */
export function useSettledRoutingCardOffersSwitch(input: {
  readonly epicId: string | null;
  readonly chatId: string;
  readonly hostId: string;
  readonly account: ComposerBannerAccount;
}): boolean {
  const { epicId, chatId, hostId, account } = input;
  // A `null` host makes the registry answer `null` without a lookup, which is
  // the answer outside an epic.
  const handle = useExistingChatSessionHandle(
    epicId ?? "",
    chatId,
    epicId === null ? null : hostId,
  );
  const store = handle === null ? emptySlice : handle.store;
  const refusal = useFailedTurnRefusal({ hostId, chatId });
  const { harnessId, profileId } = account;
  return useStore(store, (state) =>
    settledRoutingCardOffersSwitch(state, refusal, { harnessId, profileId }),
  );
}

/**
 * The composer's rate-limit advisory - the switch prompt, unless a sign-out or
 * the settled card's own "Switch to…" already answers this limit.
 *
 * The composer's mount point, as a hook, so the banner's half can be rendered
 * beside the card's action row over one session: that pairing is where the two
 * halves meet, and neither half's own suite could see them disagree.
 */
export function useComposerRateLimitAdvisory(input: {
  readonly epicId: string | null;
  readonly chatId: string;
  readonly hostId: string;
  readonly account: ComposerBannerAccount;
  readonly prompt: ProfileRateLimitSwitchPrompt;
  readonly signedOut: boolean;
}): ComposerRateLimitAdvisory | null {
  const { epicId, chatId, hostId, account, prompt, signedOut } = input;
  const settledCardOffersSwitch = useSettledRoutingCardOffersSwitch({
    epicId,
    chatId,
    hostId,
    account,
  });
  return composerRateLimitAdvisory(
    prompt,
    signedOut || settledCardOffersSwitch,
  );
}
