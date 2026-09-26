import { useLayoutEffect, useRef, type RefObject } from "react";
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
import {
  describeFallbackOutcome,
  describeManualRungRefusal,
} from "./fallback-copy";
import type { ConfirmedManualActionPublisher } from "./use-confirmed-manual-action";
import type { UnattendedFallbackOutcomePublisher } from "./use-unattended-fallback-outcome";

/**
 * The fallback verbs, as mutations.
 *
 * The headings below are common to all four and are why they share this module
 * rather than living beside their cards. Unnumbered on purpose - the count
 * here already read "three" over four of them.
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
 *
 * **No shared `MutationScope`, and that is a decision rather than an
 * omission.** `host-method-policy-table.ts` points here for it - `fifo` buys
 * these four LANDING and never order, and "a surface that does need arrival
 * order has to ask for it where the ordering primitive lives - a shared
 * `MutationScope` on the hooks in `use-fallback-actions.ts`". This surface
 * does not need it, and taking it would be a regression. Four reasons, in the
 * order they bite:
 *
 * 1. **The repeat case is already ordered, one layer down.**
 *    `HostRequestCoordinator.keyFor` is `[hostId, userId, method,
 *    stableWireJson(params)]`, so two sends with IDENTICAL params are ONE
 *    queue, and `fifo` runs them one at a time and answers each separately
 *    rather than coalescing. The double-click - the only race a client-side
 *    order could plausibly protect - is therefore already serialized, and the
 *    host's own guard chain refuses the second (a retry whose twin already
 *    launched a turn answers `rung_unavailable`).
 *
 * 2. **The differing-params case is decided by the HOST, not by arrival
 *    order.** Two sends that differ do so precisely in the `revision`, or the
 *    attempt, that they name; a request naming a superseded one is refused
 *    whenever it arrives. Ordering them changes which refusal gets printed,
 *    never which press applies.
 *
 * 3. **Across two verbs a client FIFO makes the WRONG press win.** That race
 *    is real - the grace card renders "Don't switch" and the destination menu
 *    side by side and neither disables the other - but a shared scope resolves
 *    it by letting the EARLIER press land, so a user who picks a destination
 *    and then changes their mind loses to their own previous click BY
 *    CONSTRUCTION. The policy table's argument is that the later press carries
 *    the newer intent; a scope is the mechanism that guarantees it never gets
 *    it.
 *
 * 4. **A scope adds a failure mode these verbs do not have.** Scoped mutations
 *    are held in the CLIENT until the one ahead of them settles, so an earlier
 *    request stuck in flight would stop a later "Don't switch" from being
 *    dispatched at all - trading "the host refused your second press" for
 *    "your second press was never sent".
 *
 * The asymmetry with `providers.fallbackPolicy.*`, which DID take a shared
 * host-keyed scope, is the first heading above. Those three fold their
 * response into a query cache with `setQueriesData`, so an unordered pair
 * leaves the cache holding whichever response LANDED last - a durable wrong
 * answer with no authority to correct it. These four write no cache at all:
 * the chat stream republishes the state after every committed transition, so
 * what the UI reads is the authoritative frame and never a response.
 *
 * **Every report is HOOK-level.** Which channel answers a refusal is still a
 * per-call fact, but the choosing happens here, because a per-call
 * `mutate(vars, { onSuccess })` handler belongs to the OBSERVER and TanStack
 * skips it once that observer has no listeners. These surfaces are removed by
 * the traversal's own transitions - which is what a refusal usually MEANS - so
 * a per-call reporter is silent in exactly the case it exists for.
 * {@link FallbackOutcomeReporting} states the whole rule.
 */

type FallbackMethod =
  | "chat.fallback.cancel"
  | "chat.fallback.chooseTarget"
  | "chat.fallback.runManualRung"
  | "chat.fallback.returnToPreferred"
  | "chat.fallback.proceed";

export type FallbackActionResult<Method extends FallbackMethod> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>,
    { readonly hostId: string | null; readonly captured: undefined }
  >;

/**
 * Reports a non-`applied` outcome of a COMPOSER-card verb as a toast.
 *
 * A toast rather than inline text: by the time a refusal of a cancel, a
 * proceed or a switch-back lands, the card it was pressed on has usually gone -
 * that is what the refusal MEANS - so there is no surface left to write on, and
 * a toast is not anchored to one.
 *
 * Never for a manual rung. The failed-turn card answers those inline, where the
 * button was, and the chat's announcer takes the answer once that card is gone
 * (see `useFallbackRunManualRung`): a toast was the only sentence the user got
 * for twenty different refusals, which is the complaint the inline note
 * answers.
 */
function toastFallbackOutcome(response: {
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
    // Neutral on purpose: this one mutation backs BOTH "Don't switch" and
    // "Stop waiting", so naming either action here would be wrong half the
    // time.
    errorMessage: "Couldn't stop model routing.",
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

/**
 * Where a non-`applied` answer goes, decided once for both pick verbs.
 *
 * The rule the two channels implement, in order:
 *
 * 1. a surface that is ON SCREEN and answers inline - an open chooser's footer
 *    line, or the failed-turn card's refusal note under its buttons - answers
 *    there, because that is where the click came from and where the user is
 *    looking;
 * 2. anything else - a pick whose chooser has closed, a card the traversal or
 *    a newer turn has already removed - reaches the chat's persistent
 *    announcer.
 *
 * There is no toast branch any more. The bare Retry and Wait buttons used to
 * toast, on the argument that an unchanged row had nowhere to write; the
 * failed-turn card now writes the refusal where the button was (spec Flow 4:
 * "a toast never carries a refusal").
 *
 * `inlineMenuOpen` rather than "is the component mounted", because mounted is
 * not the question - and the name predates the failed-turn card's note, which
 * sets it `true` for as long as its buttons are on screen: read it as "an
 * inline surface answers". A chooser still mounted with its popover CLOSED renders a
 * refusal into a subtree nobody can see, which is the same non-delivery as no
 * surface at all; and after unmount the hook forces this false itself, since a
 * torn-down surface is showing nothing whatever its last render said.
 *
 * That last clause is a claim about UNMOUNTING, so a caller whose surface stops
 * rendering WITHOUT unmounting defeats the whole rule: the cleanup never runs,
 * this stays `true`, and branch 2 defers forever to an inline line that is not
 * on screen. `ManualRungAffordances` exists to make that impossible for the
 * error row - see the "why this is a THIRD component" note in
 * `fallback-manual-rungs.tsx`. A new caller must be a component that genuinely
 * unmounts when its affordances stop rendering.
 *
 * **Branch 2 is the announcer alone, and deliberately not a toast beside it.**
 * One outcome, one channel. The announcer is `sr-only`, so this branch is heard
 * and not seen - which is the right trade rather than a gap: the cases that
 * reach it are cases where the surface the user was looking at has just changed
 * under them (the waiting card became the switching card, a newer turn replaced
 * the error row), so a sighted user has already been told by the thing that
 * moved. Adding a visible toast would report one outcome twice, which is the
 * defect this rule exists to remove.
 */
export interface FallbackOutcomeReporting {
  /** A surface on screen renders the answer itself, so it is the channel. */
  readonly inlineMenuOpen: boolean;
  readonly publishUnattended: UnattendedFallbackOutcomePublisher;
}

/**
 * The reporting contract as the mutation sees it: latest value while mounted,
 * `inlineMenuOpen: false` forever after unmount.
 *
 * A REF and not a dependency, deliberately. These callbacks belong to the
 * Mutation in the query cache and run after the call site's last render - a
 * value captured in the options closure would be whatever the component last
 * rendered before it went away, including an `inlineMenuOpen: true` that is now
 * a claim about a surface that no longer exists.
 *
 * LAYOUT effects, not passive ones, and that is not a style choice. A passive
 * cleanup is scheduled after paint, while an RPC response is a microtask - so a
 * pick answered in the window between the commit that removed this surface and
 * the passive cleanup would read `inlineMenuOpen: true`, hand the sentence to a
 * surface that no longer exists, and lose it. That window is precisely the one
 * MF11 is about: the frame that removes the surface is usually the same frame
 * whose arrival makes the pick lose.
 */
function useFallbackOutcomeReporting(
  reporting: FallbackOutcomeReporting,
): RefObject<FallbackOutcomeReporting> {
  const reportingRef = useRef(reporting);
  useLayoutEffect(() => {
    reportingRef.current = reporting;
  });
  useLayoutEffect(
    () => () => {
      reportingRef.current = {
        inlineMenuOpen: false,
        publishUnattended: reportingRef.current.publishUnattended,
      };
    },
    [],
  );
  return reportingRef;
}

export function useFallbackChooseTarget(
  client: HostClient<HostRpcRegistry> | null,
  chatId: string,
  /**
   * Required rather than optional so every pick site states which channel
   * answers it.
   */
  reporting: FallbackOutcomeReporting,
): FallbackActionResult<"chat.fallback.chooseTarget"> {
  const reportingRef = useFallbackOutcomeReporting(reporting);
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.chooseTarget",
    mutationKey: chatFallbackMutationKeys.chooseTarget(chatId),
    errorMessage: "Couldn't switch this chat.",
    invalidateMethods: [],
    // NOT a toast, and not nothing either - the third channel (MF11).
    //
    // An OPEN menu answers a refusal on its own line, which is where the click
    // came from and where the user is looking; that path is the per-call
    // `mutate(vars, { onSuccess })` handler at the two card menus and it is
    // unchanged. What this arm exists for is the case that handler cannot
    // reach: TanStack skips a per-call handler once its observer has no
    // listeners, and the traversal's own next transition is what removes these
    // surfaces (`waiting -> switching` replaces the waiting subtree, a pick
    // closes the popover on `applied`). A losing pick answered a beat later
    // then had nowhere at all to land - not late, LOST. This callback belongs
    // to the Mutation in the query cache, so it still runs, and hands the
    // sentence to the chat's persistent announcer.
    //
    // `applied` returns `null` here and is therefore never delivered twice: the
    // frame that follows and the host's own durable notice are that outcome's
    // feedback, and the announcer already speaks the notice.
    onSuccess: (data) => {
      const message = describeFallbackOutcome(data.outcome);
      if (message === null) return;
      if (reportingRef.current.inlineMenuOpen) return;
      reportingRef.current.publishUnattended(message);
    },
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
  /**
   * Which channel answers a refusal - the same contract the pick verb takes.
   *
   * This verb serves three rungs from ONE hook instance (deliberate: a second
   * would split `isPending` and the buttons would stop disabling together), so
   * the branch is on `variables.rung` below rather than on three hooks.
   */
  reporting: FallbackOutcomeReporting,
): FallbackActionResult<"chat.fallback.runManualRung"> {
  const reportingRef = useFallbackOutcomeReporting(reporting);
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.runManualRung",
    mutationKey: chatFallbackMutationKeys.runManualRung(chatId),
    errorMessage: "Couldn't retry this message.",
    invalidateMethods: [],
    // RECORD and REPORT both live here, and both for the same reason: this
    // callback belongs to the Mutation in the query cache, so it runs after
    // the popover has unmounted, and a `mutate(vars, { onSuccess })` handler
    // does not run at all then. The surface that sends a switch is normally
    // gone by the time the host answers - closing on `applied` is what the
    // pick DOES, and the error card itself is removed the moment
    // `lastFailedAttempt` names a newer turn, which is precisely what
    // `attempt_not_latest` MEANS.
    //
    // The report used to be a per-call handler at the two call sites, which
    // made both channels die with the row (MF11's class). The per-call
    // handlers that remain are the on-screen surfaces' - the open chooser's
    // footer and the failed-turn card's refusal note - and only for the case
    // this arm hands back to them.
    onSuccess: (data, variables) => {
      if (data.outcome === "applied") {
        onConfirmed({
          rung: variables.rung,
          userMessageId: variables.userMessageId,
          turnId: variables.turnId,
          target: variables.target,
        });
        return;
      }
      // An inline surface answers every rung itself while it is on screen - a
      // Retry or Wait staged in the chooser, or pressed on the failed-turn
      // card, as much as a switch.
      if (reportingRef.current.inlineMenuOpen) return;
      // The surface is gone, so the announcer speaks the answer - in the same
      // words the card would have used, host reason included. No host label
      // here: this hook has no tab host, and the sentence stands without it.
      const copy = describeManualRungRefusal({
        outcome: data.outcome,
        detail: data.detail,
        rung: variables.rung,
        hostLabel: null,
      });
      if (copy === null || copy.text === null) return;
      reportingRef.current.publishUnattended(copy.text);
    },
    captureContext: undefined,
  });
}

/**
 * "Switch now", "Wait now" and "Retry now" - end the countdown and let the
 * step the host already planned run (`chat.fallback.proceed`).
 *
 * The card that sends it is the countdown card, which the applied answer
 * removes (the traversal leaves `hold`), so a refusal is TOASTED from here,
 * like a cancel's: the surface it was pressed on is usually the thing that
 * moved. The only outcomes are `applied`, `traversal_advanced` and
 * `no_active_traversal`, and both refusals are facts about the chat, never a
 * cause this client made up.
 */
export function useFallbackProceed(
  client: HostClient<HostRpcRegistry> | null,
  chatId: string,
): FallbackActionResult<"chat.fallback.proceed"> {
  return useHostScopedMutationForClient(client, {
    method: "chat.fallback.proceed",
    mutationKey: chatFallbackMutationKeys.proceed(chatId),
    errorMessage: "Couldn't reach this chat's host just now.",
    invalidateMethods: [],
    onSuccess: toastFallbackOutcome,
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
