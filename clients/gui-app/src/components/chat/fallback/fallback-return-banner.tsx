import { useCallback } from "react";
import { CheckCircle2 } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PendingReturn } from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import type { HostRpcRegistry } from "@/lib/host";
import { queuedMessagesReturningText } from "./fallback-copy";
import {
  TERMINAL_ACCOUNT_LABEL,
  fallbackTupleIdentity,
  useFallbackProfileLabels,
  type FallbackTupleIdentity,
} from "./fallback-identity";
import { useFallbackReturnToPreferred } from "./use-fallback-actions";

/**
 * The offer to move this chat back to the provider it started on.
 *
 * Surfaced only once the host says so - `pendingReturn` is present BY VALUE on
 * the frame, and the traversal reaches this state at the preferred account's own
 * verified reset boundary. This banner never infers a reset from a timestamp of
 * its own, and never re-offers after the user answers: all three answers end the
 * traversal, and a dismissal is durable so it does not come back after a
 * restart.
 *
 * The one-sentence rule the copy has to state is that **switching back moves the
 * queued messages too**. Leaving them on the fallback while the next fresh send
 * routes to the preferred account would interleave two providers in one chat
 * with nobody told - the worst available outcome, and the reason the count is on
 * the wire at all.
 */
export function FallbackReturnBanner({
  offer,
  client,
  chatId,
  epicId,
  canAct,
}: {
  readonly offer: PendingReturn;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly chatId: string;
  readonly epicId: string;
  readonly canAct: boolean;
}) {
  const labelFor = useFallbackProfileLabels(client, true);
  const returnToPreferred = useFallbackReturnToPreferred(client, chatId);

  const preferred = fallbackTupleIdentity(offer.preferredTuple, labelFor);
  const fallback = fallbackTupleIdentity(offer.fallbackTuple, labelFor);

  const answer = useCallback(
    (action: "switch_back" | "stay" | "dismiss_for_chat") => {
      returnToPreferred.mutate({
        epicId,
        chatId,
        traversalId: offer.traversalId,
        revision: offer.revision,
        action,
      });
    },
    [chatId, epicId, offer.revision, offer.traversalId, returnToPreferred],
  );

  const busy = returnToPreferred.isPending || !canAct;
  const movedText = queuedMessagesReturningText(offer.queuedItemsMoving);

  return (
    <div
      data-testid="fallback-return-banner"
      className="flex w-full flex-col gap-2 rounded-md border border-emerald-600/40 bg-emerald-600/5 px-3 py-2 text-ui-sm"
    >
      <div className="flex items-center gap-2 text-ui-sm font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{resetHeadline(preferred)}</span>
      </div>
      <div className="text-ui-sm">
        Switch back from{" "}
        <span className="font-medium">
          {destinationName(fallback, preferred)}
        </span>
        ? Applies to your next message{movedText ?? ""}. Starts a fresh session
        from this transcript.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            answer("switch_back");
          }}
        >
          Switch back
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            answer("stay");
          }}
        >
          Stay on {destinationName(fallback, preferred)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            answer("dismiss_for_chat");
          }}
        >
          Don't ask for this chat
        </Button>
      </div>
    </div>
  );
}

/**
 * "personal-account's limit has reset", or the Terminal-account variant.
 *
 * The ambient account has no name of its own, so "Terminal account's limit"
 * would read as a possessive on a label the user never chose. Naming the
 * provider instead - "Claude Code's Terminal account limit has reset" - is both
 * the shipped phrasing and the one that identifies the account.
 */
function resetHeadline(preferred: FallbackTupleIdentity): string {
  if (preferred.profileLabel === TERMINAL_ACCOUNT_LABEL) {
    return `${preferred.providerLabel}'s ${TERMINAL_ACCOUNT_LABEL} limit has reset`;
  }
  return `${preferred.profileLabel}'s limit has reset`;
}

/**
 * What to call the account the chat is on now.
 *
 * Within one provider a profile label is the whole difference and is enough
 * ("work-account"). Across providers it is not: a chat that fell back from
 * Claude Code to Codex is running a different product, and "Stay on
 * work-account" would hide the only part that matters - hence the shipped
 * cross-provider form, "Codex · gpt-5".
 *
 * The ambient account takes the same form for a different reason: it has no
 * name of its own, so the provider and model ARE its identity.
 */
function destinationName(
  fallback: FallbackTupleIdentity,
  preferred: FallbackTupleIdentity,
): string {
  const crossProvider = fallback.providerId !== preferred.providerId;
  if (crossProvider || fallback.profileLabel === TERMINAL_ACCOUNT_LABEL) {
    return `${fallback.providerLabel} · ${fallback.model}`;
  }
  return fallback.profileLabel;
}
