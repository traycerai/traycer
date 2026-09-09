import type { UseMutationResult } from "@tanstack/react-query";
import type { FallbackActionOutcome } from "@traycer/protocol/host/chat-fallback";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { toast } from "sonner";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { chatFallbackMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { describeFallbackOutcome } from "./fallback-copy";
import type { ConfirmedManualActionPublisher } from "./use-confirmed-manual-action";

/**
 * The fallback verbs, as mutations.
 *
 * Three things are common to all four and are why they share this module rather
 * than living beside their cards.
 *
 * **No invalidation.** Every one of them changes state the CHAT STREAM
 * republishes - the pending-fallback DTO is derived per frame and the host
 * publishes this chat's state after every committed transition. Invalidating a
 * query here would re-fetch something no query holds, and an optimistic write
 * would fight the frame that is already on its way.
 *
 * **A refusal is a normal answer, not an error.** `traversal_advanced`,
 * `no_active_traversal`, `choice_lease_stale`, `rung_unavailable` and
 * `return_unavailable` all arrive in a SUCCESSFUL response, by deliberate
 * protocol design: a pick that lost a race is not a failed call, and routing it
 * through the retry machinery would re-send it against a world that has moved
 * again. So the outcome is inspected in `onSuccess` and reported as a fact
 * about the chat; only a transport failure reaches the error toast.
 *
 * **Keyed per chat.** Several chats can hold a grace window at once, and a
 * chat-blind mutation key would let one card's in-flight press disable the
 * buttons on every other card.
 */

type FallbackMethod =
  | "chat.fallback.cancel"
  | "chat.fallback.chooseTarget"
  | "chat.fallback.runManualRung"
  | "chat.fallback.returnToPreferred";

export type FallbackActionResult<Method extends FallbackMethod> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    { readonly hostId: string | null; readonly captured: undefined }
  >;

/**
 * Reports a non-`applied` outcome as a toast.
 *
 * A toast rather than inline text, for the cards: by the time a refusal lands
 * the card it was pressed on has usually gone - that is what the refusal MEANS -
 * so there is no surface left to write on. The destination menu is the
 * exception; it renders its own inline line and then closes.
 *
 * EXPORTED because that exception is per CALL, not per verb.
 * `chat.fallback.runManualRung` serves three rungs from one hook instance: two
 * of them (retry, wait-until) are bare buttons with nowhere to write, and the
 * third opens the menu. A hook-level `onSuccess` fires for all three, and
 * TanStack runs it *in addition to* a per-call one - so wiring it into the hook
 * made the menu report a single refusal twice, once as a toast and once inline.
 * The channel is chosen at the two call sites instead, which is where the fact
 * that decides it lives. One hook instance is deliberate: a second one would
 * split `isPending` and the buttons would stop disabling together.
 */
export function toastFallbackOutcome(response: {
  readonly outcome: FallbackActionOutcome;
}): void {
  const message = describeFallbackOutcome(response.outcome);
  if (message === null) return;
  toast(message);
}

export function useFallbackCancel(
  client: HostClient<HostRpcRegistry> | null,
  chatId: string,
  /**
   * The host's answer, delivered even if the card has gone.
   *
   * A cancel that APPLIES settles the traversal, and the settled frame clears
   * `pendingFallback` - which unmounts the very card the button is on. So a
   * caller that needs to act on the outcome cannot use a
   * `mutate(vars, { onSuccess })` handler: those belong to the observer and do
   * not run after unmount, and the one outcome that matters is precisely the
   * one that guarantees it. This runs from the mutation itself.
   *
   * Required rather than optional so a caller with nothing to do says so.
   */
  onOutcome: (outcome: FallbackActionOutcome) => void,
): FallbackActionResult<"chat.fallback.cancel"> {
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.cancel",
    mutationKey: chatFallbackMutationKeys.cancel(chatId),
    errorMessage: "Couldn't stop the fallback.",
    invalidateMethods: [],
    onSuccess: (data) => {
      toastFallbackOutcome(data);
      onOutcome(data.outcome);
    },
    captureContext: undefined,
  });
}

/** For a cancel whose caller has nothing to do with the outcome. */
export const IGNORE_FALLBACK_OUTCOME = (): void => undefined;

export function useFallbackChooseTarget(
  client: HostClient<HostRpcRegistry> | null,
  chatId: string,
): FallbackActionResult<"chat.fallback.chooseTarget"> {
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.chooseTarget",
    mutationKey: chatFallbackMutationKeys.chooseTarget(chatId),
    errorMessage: "Couldn't switch this chat.",
    invalidateMethods: [],
    // The menu renders its own line for a refusal and then closes, so it opts
    // out of the toast by handling the outcome at the call site.
    onSuccess: undefined,
    captureContext: undefined,
  });
}

export function useFallbackRunManualRung(
  client: HostClient<HostRpcRegistry> | null,
  chatId: string,
  /**
   * Where a CONFIRMED action is recorded for the transcript announcer.
   *
   * A required parameter rather than something this module reaches for
   * itself: the publisher is bound to a `(epicId, chatId, hostId)` triple the
   * call site holds and this hook does not, and taking it here keeps the
   * fallback verbs free of the chat-session registry.
   */
  onConfirmed: ConfirmedManualActionPublisher,
): FallbackActionResult<"chat.fallback.runManualRung"> {
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.runManualRung",
    mutationKey: chatFallbackMutationKeys.runManualRung(chatId),
    errorMessage: "Couldn't retry this message.",
    invalidateMethods: [],
    // Still no hook-level REPORT - that stays at the two call sites, because
    // this verb serves three rungs and only two of them have nowhere to write
    // a refusal (see `toastFallbackOutcome`). What is here instead is a
    // RECORD, and it has to be here rather than at those call sites: this
    // callback belongs to the Mutation in the query cache, so it runs after
    // the popover has unmounted, and a `mutate(vars, { onSuccess })` handler
    // does not run at all then. The surface that sends a switch is normally
    // gone by the time the host answers - closing on `applied` is what the
    // pick DOES - and the announcement is owed regardless.
    onSuccess: (data, variables) => {
      if (data.outcome !== "applied") return;
      onConfirmed({
        rung: variables.rung,
        userMessageId: variables.userMessageId,
        turnId: variables.turnId,
        target: variables.target,
      });
    },
    captureContext: undefined,
  });
}

export function useFallbackReturnToPreferred(
  client: HostClient<HostRpcRegistry> | null,
  chatId: string,
): FallbackActionResult<"chat.fallback.returnToPreferred"> {
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.returnToPreferred",
    mutationKey: chatFallbackMutationKeys.returnToPreferred(chatId),
    errorMessage: "Couldn't switch back.",
    invalidateMethods: [],
    // `return_unavailable` MUST reach the user: the banner closes either way,
    // and without this the chat silently stays on the fallback after the user
    // asked it to move. That arm is the whole reason the outcome exists.
    onSuccess: toastFallbackOutcome,
    captureContext: undefined,
  });
}
