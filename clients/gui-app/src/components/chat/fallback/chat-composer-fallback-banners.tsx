import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { ChatComposerBannerPortal } from "@/components/chat/composer/chat-composer-banner-portal";
import type { ComposerTopBannerKind } from "@/components/chat/composer/chat-composer-top-banner";
import type { HostRpcRegistry } from "@/lib/host";
import { FallbackGraceMenu, FallbackWaitingMenu } from "./fallback-card-menus";
import { FallbackGraceCard } from "./fallback-grace-card";
import { FallbackReturnBanner } from "./fallback-return-banner";
import {
  fallbackGraceCardVisible,
  fallbackWaitingCardVisible,
  type ChatProviderFallbackState,
} from "./fallback-state";
import { FallbackWaitingCard } from "./fallback-waiting-card";

/**
 * The composer's two provider-fallback banner slots.
 *
 * Extracted from `ChatComposerImpl` rather than inlined there for two reasons,
 * and the second is the one that matters.
 *
 * The composer is a shared file that was already near its complexity ceiling,
 * and six branch points for a feature that renders nothing on the overwhelming
 * majority of chats is not where that budget should go.
 *
 * And the inline version had a real defect. It read
 * `waitingCardVisible ? <Waiting/> : <Grace/>` - a FALL-THROUGH, under a
 * comment claiming the opposite: that the two predicates are kept separate
 * "so a traversal state that neither claims must fail to render rather than
 * fall through to whichever branch happens to be last." A sixth traversal
 * state added upstream would have rendered a grace card describing a state it
 * knows nothing about. Here each predicate is checked on its own and an
 * unclaimed state renders nothing, which is what the comment always said.
 */
export function ChatComposerFallbackBanners({
  topBannerKind,
  fallback,
  client,
  chatId,
  epicId,
  hostId,
  canAct,
}: {
  readonly topBannerKind: ComposerTopBannerKind;
  readonly fallback: ChatProviderFallbackState;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  /**
   * `null` outside an epic - the home composer, which has no chat and
   * therefore no traversal. Both slots render nothing rather than the cards
   * guessing at an epic id.
   */
  readonly epicId: string | null;
  readonly hostId: string;
  readonly canAct: boolean;
}) {
  if (epicId === null) return null;
  return (
    <>
      <FallbackPendingBanner
        visible={topBannerKind === "fallback"}
        pending={fallback.pending}
        client={client}
        chatId={chatId}
        epicId={epicId}
        hostId={hostId}
        canAct={canAct}
      />
      <FallbackReturnBannerSlot
        visible={topBannerKind === "fallback-return"}
        offer={fallback.pendingReturn}
        client={client}
        chatId={chatId}
        epicId={epicId}
        canAct={canAct}
      />
    </>
  );
}

/**
 * The waiting card and the grace card share one slot and are chosen by two
 * INDEPENDENT predicates - never by an else-branch. See the note above.
 */
function FallbackPendingBanner({
  visible,
  pending,
  client,
  chatId,
  epicId,
  hostId,
  canAct,
}: {
  readonly visible: boolean;
  readonly pending: ChatProviderFallbackState["pending"];
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly canAct: boolean;
}) {
  // BY VALUE, never by key presence: on a live `chat.subscribe@1.9` frame the
  // host sets the key unconditionally and `undefined` is what CLEARS the card,
  // so a `"pending" in ...` test would pin it open for the life of the chat.
  if (!visible || pending === undefined) return null;
  if (fallbackWaitingCardVisible(pending)) {
    return (
      <FallbackBannerSlot>
        <FallbackWaitingCard
          pending={pending}
          client={client}
          chatId={chatId}
          epicId={epicId}
          hostId={hostId}
          canAct={canAct}
          menu={
            <FallbackWaitingMenu
              pending={pending}
              client={client}
              epicId={epicId}
              chatId={chatId}
              canAct={canAct}
            />
          }
        />
      </FallbackBannerSlot>
    );
  }
  if (fallbackGraceCardVisible(pending)) {
    return (
      <FallbackBannerSlot>
        <FallbackGraceCard
          pending={pending}
          client={client}
          chatId={chatId}
          epicId={epicId}
          hostId={hostId}
          canAct={canAct}
          menu={
            <FallbackGraceMenu
              pending={pending}
              client={client}
              epicId={epicId}
              chatId={chatId}
              hostId={hostId}
              canAct={canAct}
            />
          }
        />
      </FallbackBannerSlot>
    );
  }
  return null;
}

function FallbackReturnBannerSlot({
  visible,
  offer,
  client,
  chatId,
  epicId,
  canAct,
}: {
  readonly visible: boolean;
  readonly offer: ChatProviderFallbackState["pendingReturn"];
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly canAct: boolean;
}) {
  if (!visible || offer === undefined) return null;
  return (
    <FallbackBannerSlot>
      <FallbackReturnBanner
        offer={offer}
        client={client}
        chatId={chatId}
        epicId={epicId}
        canAct={canAct}
      />
    </FallbackBannerSlot>
  );
}

/**
 * The composer's banner geometry, shared by both slots.
 *
 * The full-width layer stays pointer- and paint-transparent so it cannot cover
 * the transcript scrollbar or its edge lanes; the centred column restores
 * pointer handling and owns the opaque backplate. Written once here rather than
 * copied per card, which is how the rate-limit banner's copy of it and this one
 * would have drifted.
 */
function FallbackBannerSlot({ children }: { readonly children: ReactNode }) {
  return (
    <ChatComposerBannerPortal>
      <div className="pointer-events-none px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl bg-canvas pt-4">
          {children}
        </div>
      </div>
    </ChatComposerBannerPortal>
  );
}
