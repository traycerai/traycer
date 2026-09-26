import { useCallback } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { create, useStore } from "zustand";
import type {
  ChatRunSettings,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { HostRpcRegistry } from "@/lib/host";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { formatWaitTime, useSampledNow } from "@/lib/relative-time";
import { chatFallbackMutationKeys } from "@/lib/query-keys";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  SWITCH_LABEL,
  describeSwitchDisposition,
  describeWaitDisposition,
} from "./fallback-copy";
import {
  fallbackProviderModelLabel,
  useFallbackModelLabels,
  type FallbackModelLabelResolver,
} from "./fallback-identity";
import { FallbackNoticeSettingsLink } from "./fallback-notice-attribution";
import { useFallbackRunManualRung } from "./use-fallback-actions";
import {
  useChatFallbackTraversalIsLive,
  useChatLastFailedAttempt,
} from "./use-last-failed-attempt";
import { usePublishConfirmedManualFallbackAction } from "./use-confirmed-manual-action";
import { usePublishUnattendedFallbackOutcome } from "./use-unattended-fallback-outcome";
import { RoutingDestinationPicker } from "./routing-destination-picker";

/**
 * The error row's manual affordances: Retry, Switch…, and "Wait until <time>".
 *
 * ## Why this is two components
 *
 * `useHostClientForHostId` resolves through `useHostClient()`, which THROWS
 * outside a `<HostRuntimeProvider>` - and `ErrorSegment` is durable transcript
 * that several suites render on its own, with no transcript identity and no
 * host runtime around it. So the identity gate lives here, above any hook that
 * needs a host, and the resolution lives in {@link ManualRungActions} below,
 * which mounts only once a chat and an epic are actually in scope. Gating with
 * an early `return null` inside one component would not do: the host hooks
 * would already have run by then, and moving them below the gate makes the
 * hook order conditional.
 *
 * ## What decides whether these appear
 *
 * Mostly not this component, and deliberately. `lastFailedAttempt` is defined
 * by the HOST iff its own manual-rung guard chain would admit something - the
 * latest attempt is a terminal failure, nothing is running, and any terminal
 * traversal record settled as a failure. Those cannot be checked in a renderer
 * without racing, and a second copy disagrees on exactly the frames that
 * matter. So the rule here is short: render what the host named, on the row the
 * host named, and let `chat.fallback.runManualRung` answer `rung_unavailable`
 * for the rest.
 *
 * That list used to carry a fourth item - "no traversal holds dispatch" - and
 * this component genuinely needed no gating of its own while it held. It does
 * not hold any more: the grace card was given manual rungs, so the host now
 * defines the field during a `hold` as well, for the card. `ManualRungActions`
 * below carries the one gate that costs us, and its comment says why the row
 * cannot simply share the field.
 *
 * That also answers "hides them once a later turn exists": a later turn means
 * the host stops defining the value, and the affordances clear. There is no
 * hiding logic here to get wrong.
 *
 * ## Two rules that read as defensive and are not
 *
 * **`eligibleRungs: []` is a different fact from an absent value.** Absent
 * means no affordances at all; empty means the host walked its chain and
 * admitted nothing for this failure. The reflex on an empty list is to fall
 * back to offering everything, which rebuilds the dead-button case the field
 * exists to remove - so an empty array renders no buttons, and that is correct
 * rather than a degradation.
 *
 * **The wait button is gated on `wait_once` being eligible, never on
 * `resetsAt` being present.** A boundary beyond the policy's longest-wait cap
 * carries a `resetsAt` and no eligibility, and the cap is a number this client
 * may not know: a renderer that had to read the policy to decide whether to
 * draw a button would be re-deciding eligibility by another name.
 */
export function FallbackManualRungActions({
  turnId,
}: {
  /** The row's own host turn id. The affordances render only on a match. */
  readonly turnId: string;
}) {
  const transcript = useMaybeChatTranscript();
  const epicId = useMaybeOpenEpicHandle()?.epicId ?? null;
  if (transcript === null || epicId === null) return null;
  return (
    <ManualRungActions
      turnId={turnId}
      epicId={epicId}
      chatId={transcript.chatId}
      hostId={transcript.hostId}
    />
  );
}

function ManualRungActions({
  turnId,
  epicId,
  chatId,
  hostId,
}: {
  readonly turnId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}) {
  const client = useHostClientForHostId(hostId);
  const attempt = useChatLastFailedAttempt({ epicId, chatId, hostId });
  const traversalIsLive = useChatFallbackTraversalIsLive({
    epicId,
    chatId,
    hostId,
  });

  if (attempt === undefined) return null;
  // While a traversal is live the COMPOSER's card owns these affordances, and
  // this row must not offer a second copy of them.
  //
  // This gate is the price of the grace card's own rungs. The doc above still
  // says `lastFailedAttempt` means "no traversal holds dispatch" - that WAS the
  // host's whole guard chain, and it is why this component was written with no
  // hiding logic. Giving the countdown card manual rungs required the host to
  // define the field during a `hold` too, and this row reads the same field, so
  // it came back on with it: a `Switch…` here, EMPHASISED for rate_limit and
  // billing, directly above a countdown card offering its own.
  //
  // Two copies would be bad enough. The one that must not be reachable is this
  // one: `ManualRungAffordances` builds this surface's menu `preparing={false}`
  // - "No hold to take: there is no countdown here to freeze" - so a pick made
  // here does NOT freeze the window it is now racing. The user opens the menu,
  // the grace window expires under the popover, the ladder commits, and the
  // pick lands `rung_unavailable`. That race is precisely what the choice lease
  // exists to prevent, and the card's menu is the surface that takes it.
  //
  // Nothing has to be remembered: `pendingFallback` clearing is the same frame
  // that ends the traversal, so this row returns exactly when it becomes the
  // only surface again.
  //
  // One case DOES lose an affordance, and it is the right trade rather than an
  // oversight: a user who DISMISSES the card. A dismissal is not an answer to
  // the card's question - the banner returns null at its own `if (dismissed)`
  // while the traversal runs on, untouched and still holding dispatch - so
  // `pendingFallback` stays defined, this row stands down, and that chat has no
  // rungs anywhere until the ladder ends. Restoring them here would restore
  // them LEASELESS, into the exact race two paragraphs up, which the dismissal
  // did nothing to end: the countdown a pick would lose to is still running,
  // merely no longer drawn. No affordance and an affordance that silently
  // fails are not a close call. If that gap is ever worth closing, it closes by
  // giving this row the lease, not by ungating it.
  if (traversalIsLive) return null;
  // The row must be the one the host is describing. A transcript holding three
  // failed attempts offers these once, not three times - and a legacy record
  // (no turn identity, so no `turnId` prop) never reaches this component at
  // all, which is the correct answer rather than a missing one.
  if (attempt.turnId !== turnId) return null;
  // `auth` is the ticket's link-only case and stays link-only whatever
  // `eligibleRungs` says, so the two rules can never disagree. Checked first
  // for that reason. The re-auth banner is the way back in; a retry here would
  // send the same request to the same signed-out account.
  if (attempt.failure.reason === "auth") return null;

  return (
    <ManualRungAffordances
      attempt={attempt}
      client={client}
      epicId={epicId}
      chatId={chatId}
      hostId={hostId}
      surface="error_card"
    />
  );
}

/**
 * The same manual rungs, on the GRACE CARD instead of the error row.
 *
 * ## Why this exists
 *
 * The countdown card used to offer three things: "Don't switch", "Sign in
 * instead" and a destination menu - so a user who had already fixed the
 * failure by hand (topped up an account, switched a profile in Settings) had no
 * way to say so. The only controls were "abandon the recovery" and "go
 * somewhere else", and neither is "the thing you were trying to do will work
 * now, just run it". They watched the switch happen instead; that report is
 * what this closes.
 *
 * `retry` is the rung that says it, because `retry` re-runs whatever the chat
 * is set to NOW - which after a manual fix is the fixed tuple.
 *
 * ## No `turnId` here, deliberately
 *
 * The error-card wrapper takes one because durable transcript can hold several
 * failed attempts and the affordances belong to exactly one row. This card is
 * one per chat and is rendered from the LIVE traversal, and the host defines
 * `lastFailedAttempt` during a hold only for the attempt that hold armed for
 * (`fallbackHeldFailureFor` matches both attempt ids). So there is no "which
 * row" question to answer, and inventing one here would mean re-deriving an
 * identity the host has already scoped.
 *
 * Renders nothing when the host offers no attempt - which includes every
 * traversal state except `hold`, since that carve-out is the host's and this
 * component does not second-guess which state it is in.
 */
export function FallbackGraceRungActions({
  epicId,
  chatId,
  hostId,
  client,
}: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
}) {
  const attempt = useChatLastFailedAttempt({ epicId, chatId, hostId });
  if (attempt === undefined) return null;
  // The same link-only carve-out the error card makes, and it has to be
  // repeated rather than shared: a retry on a signed-out account sends the
  // identical request to the identical account. The re-auth banner is the way
  // back in, and on this card "Sign in instead" is already the control that
  // says so.
  if (attempt.failure.reason === "auth") return null;
  return (
    <ManualRungAffordances
      attempt={attempt}
      client={client}
      epicId={epicId}
      chatId={chatId}
      hostId={hostId}
      surface="grace_card"
    />
  );
}

type ChatActSlice = Pick<
  ChatSessionState,
  "access" | "connectionStatus" | "chat"
>;

/**
 * Stand-in for a chat with no live session - the same shape and the same
 * reason as `useChatLastFailedAttempt`'s `emptySlice`, and the same answer a
 * closed session gives: nothing may be dispatched.
 *
 * Unreachable in practice, because a chat with no session also has no
 * `lastFailedAttempt` and the gate above this component has already returned
 * `null`. It exists so the hook below is unconditional rather than because the
 * state is expected.
 */
const noSessionActSlice = create<ChatActSlice>()(() => ({
  access: null,
  connectionStatus: "closed",
  chat: null,
}));

/**
 * Whether this chat would accept a fallback action right now - the ACT
 * CAPABILITY, read off the chat's own session.
 *
 * The error card's affordances dispatch `chat.fallback.runManualRung`, a plain
 * unary RPC, and nothing on the client refused it: the buttons were gated on
 * `runManualRung.isPending` and on nothing else, so a VIEWER of someone else's
 * chat - or its owner while the chat stream is down - could fire a retry, a
 * wait, or a whole provider switch straight out of durable transcript. The
 * composer's copy of that hole was the same shape and was closed by reading
 * the capability it was already being handed under the name `sendDisabled`
 * (`fallbackControlsCanAct` in `chat-composer.tsx`).
 *
 * There is no such prop here. `ErrorSegment` is durable transcript rendered
 * from a message list, so nothing upstream of it knows the chat's access at
 * all - which is exactly why the three ids this component already resolves are
 * the right source: the SESSION knows. This reproduces `canSendAction`'s own
 * rule (`chat-session-store.ts`) rather than a paraphrase of it, so the card
 * refuses precisely what the stream-side lease refuses.
 *
 * Both halves, and neither is redundant. `access.canAct` is the role answer, a
 * settled fact about this user. `connectionStatus === "open"` is the transport
 * one, and it is what makes an OWNER'S buttons go quiet while the host is
 * reconnecting - the state the composer's `chatSendDisabledHint` calls
 * "Reconnecting to the host - sending is paused".
 *
 * Deliberately NOT the composer's third term (`profile !== null`, the signed-in
 * account): that is the tile's own send precondition and has no bearing on
 * whether this chat's fallback may be steered. Nor `sendBlocked`'s widenings -
 * a disabled profile or a signed-out provider is what a fallback action is the
 * ESCAPE from, and gating on it would strand a chat on a destination it is no
 * longer allowed to leave.
 */
function useChatFallbackActionsCanAct(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): boolean {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const store = handle === null ? noSessionActSlice : handle.store;
  return useStore(
    store,
    (state) =>
      state.connectionStatus === "open" && state.access?.canAct === true,
  );
}

/**
 * What the chooser seeds from when the host named no failed tuple: the chat's
 * own persisted settings. `null` when neither exists - there is then nothing
 * to stage a switch FROM, and the switch is not offered.
 */
function useChatPersistedSettings(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): ChatRunSettings | null {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const store = handle === null ? noSessionActSlice : handle.store;
  return useStore(store, (state) =>
    state.chat === null ? null : state.chat.settings,
  );
}

/**
 * The catalogue read the card below needs: its subject, and whether there is one.
 *
 * Gated on HAVING a failed tuple rather than on the switch disposition. The
 * durable failed tuple is the one thing this card always holds or does not,
 * whereas re-deriving `describeSwitchDisposition`'s branch here to decide
 * whether to read a catalogue would be a second copy of the copy module's rule
 * - the defect this module is organised against.
 */
function manualRungCatalogueRead(failedTuple: ChatRunSettings | null): {
  readonly subjects: ReadonlyArray<string | null>;
  readonly enabled: boolean;
} {
  return {
    subjects: [failedTuple === null ? null : failedTuple.harnessId],
    enabled: failedTuple !== null,
  };
}

/**
 * The affordances themselves, and the pick's in-flight state with them.
 *
 * ## Why this is a THIRD component
 *
 * The same reason the file already gives for the first split, applied to the
 * gate above: *"gating with an early `return null` inside one component would
 * not do"*. That doc was written about the host hooks; it is just as true of
 * the reporting state, and this component exists because the second gate was
 * originally the early return it warns against.
 *
 * The error row is NOT a stable surface for a delayed answer. `ErrorSegment`
 * renders `FallbackManualRungActions` for any row carrying a `turnId`, and
 * nothing about that changes when the attempt does - so the identity gate above
 * turning `false` used to leave this component **mounted and rendering
 * nothing**, with `menuOpen` still `true` from before and the per-render layout
 * effect in `useFallbackOutcomeReporting` still republishing
 * `inlineMenuOpen: true` on every null render.
 *
 * That is precisely the state MF11 exists to remove. The sequence: the menu is
 * open, the user picks, the frame carrying the newer turn arrives first (which
 * is what `attempt_not_latest` MEANS), the popover and its inline
 * `role="status"` line unmount with the gate - and then the host's answer finds
 * `inlineMenuOpen` still `true`, so the hook defers to an inline line that is no
 * longer rendering and the refusal is delivered **nowhere**.
 *
 * Splitting is what fixes it, rather than a cleverer predicate: unmounting runs
 * the reporting hook's cleanup, and destroys `menuOpen` and `refusal` with it,
 * so a returning attempt cannot reopen a menu onto a stale refusal either.
 * Losing the in-flight mutation costs nothing - the Mutation lives in the query
 * cache and its hook-level `onSuccess` runs whether or not this subtree is
 * still here, which is exactly how `RoutingDestinationPicker` already gets
 * this right.
 */
/**
 * The three switch decisions, resolved together because they are ONE decision
 * seen from three angles: whether this surface draws the switch, whether it
 * carries the emphasis, and what to say when it is missing.
 *
 * Extracted rather than left inline for two reasons. The honest one is the
 * complexity budget - adding the `surface` distinction pushed
 * `ManualRungAffordances` past it. The better one is that all three were
 * already reading `surface` separately, and three separate reads of the same
 * fact is how two of them end up disagreeing.
 *
 * ## The grace card draws no switch
 *
 * That card's own leased chooser (`<RoutingDestinationPicker>`) is the switch there, and
 * it is not a duplicate of this one: it takes a grace-hold lease that pauses
 * the countdown while the popover is open. Rendering both would put two switch
 * controls side by side and the wrong one would be the leaseless one.
 *
 * The EXPLANATION goes with it, and that is the same argument rather than an
 * exception to it. The sentence exists because a control that simply vanishes
 * reads as a broken product and a user cannot act on an absence - but on the
 * grace card the switch is not absent, so printing "no other provider is
 * available to switch to" beside a working Switch control would be that same
 * broken-product reading, pointed the other way.
 *
 * So the grace card answers all three at once and never consults the rungs: no
 * switch, no emphasis, nothing to explain.
 *
 * ## On the error card
 *
 * Retry re-runs the SAME account and model (`retry` is the same tuple by
 * definition). For a failure the provider will keep refusing until something
 * changes - a spent quota, an unpaid bill - that is very unlikely to do
 * anything, and the engine agrees: `rate_limit` and `billing` get no transient
 * retry either, only the outage-shaped failures do. So the switch leads and
 * Retry sits beside it as the secondary; offering them as equals made the
 * useless one the leftmost thing on the card.
 *
 * The explanation's subject is the FAILED tuple the host named, resolved
 * through the same module every other fallback surface names a tuple with.
 * Never the chat's current settings: this is bound to an attempt, and a chat
 * reconfigured since would be explained in terms of a model that never ran.
 */
function switchAffordanceFor(input: {
  readonly surface: "error_card" | "grace_card";
  readonly attempt: LastFailedAttempt;
  readonly modelLabelFor: FallbackModelLabelResolver;
}): {
  readonly offersSwitch: boolean;
  readonly switchLeads: boolean;
  readonly switchExplanation: string | null;
} {
  const { surface, attempt, modelLabelFor } = input;
  if (surface === "grace_card") {
    return { offersSwitch: false, switchLeads: false, switchExplanation: null };
  }
  const offersSwitch = attempt.eligibleRungs.includes("switch");
  const failedTuple = attempt.failedTuple;
  return {
    offersSwitch,
    switchLeads:
      offersSwitch &&
      (attempt.failure.reason === "rate_limit" ||
        attempt.failure.reason === "billing"),
    switchExplanation: describeSwitchDisposition(
      attempt.switchDisposition,
      failedTuple === null
        ? null
        : fallbackProviderModelLabel(failedTuple, modelLabelFor),
    ),
  };
}

function ManualRungAffordances({
  attempt,
  client,
  epicId,
  chatId,
  hostId,
  surface,
}: {
  readonly attempt: LastFailedAttempt;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  /**
   * Which surface these affordances are mounted on, and the ONE thing it
   * changes is whether the switch is offered here.
   *
   * `error_card` is durable transcript and owns the whole set. `grace_card` is
   * the countdown in the composer, which already has a destination menu of its
   * own - `<RoutingDestinationPicker>`, in its `menu` slot - and that one is not a
   * duplicate of this one: it takes a grace-hold LEASE that pauses the
   * countdown while the popover is open. Rendering both would put two
   * switch controls side by side, and the wrong one would be the leaseless one.
   *
   * A required prop rather than an optional flag, so a new call site has to say
   * which surface it is; a defaulted one would silently take the transcript's
   * answer.
   */
  readonly surface: "error_card" | "grace_card";
}) {
  const publishConfirmed = usePublishConfirmedManualFallbackAction({
    epicId,
    chatId,
    hostId,
  });
  const publishUnattended = usePublishUnattendedFallbackOutcome({
    epicId,
    chatId,
    hostId,
  });
  const canAct = useChatFallbackActionsCanAct({ epicId, chatId, hostId });
  // One tuple: the only model this card names is the FAILED one, in the
  // sentence explaining why there is no Switch… button. The destination menu
  // this card opens resolves its own rows - it names harnesses this card has no
  // way to know about until the listing answers.
  //
  // Gated on having a subject rather than on the sentence being on screen. A
  // durable failed tuple is the one thing this component always holds or does
  // not, and re-deriving `describeSwitchDisposition`'s branch here to decide
  // whether to read a catalogue would be a second copy of the copy module's
  // rule - the defect this whole module is organised against. The read itself
  // is the shared `listModels` slot the app-load prefetcher already fills, and
  // the hook's own availability gate keeps a harness the user has since
  // disabled from being asked about at all.
  const catalogueRead = manualRungCatalogueRead(attempt.failedTuple);
  const modelLabelFor = useFallbackModelLabels(
    client,
    catalogueRead.subjects,
    catalogueRead.enabled,
  );
  // The bare Retry / Wait buttons. The chooser owns its own instance of this
  // verb, so the two are joined below through the shared mutation key.
  const runManualRung = useFallbackRunManualRung(
    client,
    chatId,
    publishConfirmed,
    { inlineMenuOpen: false, publishUnattended },
  );
  const switchSeed = useChatPersistedSettings({ epicId, chatId, hostId });
  const seedTuple = attempt.failedTuple ?? switchSeed;
  // Any rung in flight for this chat - a bare button here or a pick in the
  // chooser - quiets every control, so one press cannot race another.
  const rungsInFlight =
    useIsMutating({
      mutationKey: chatFallbackMutationKeys.runManualRung(chatId),
    }) > 0;

  const run = useCallback(
    (rung: "retry" | "wait_once") => {
      // No per-call handler at all now. These two rungs are TOASTED, because
      // they are bare buttons: press Retry, the row does not change, and there
      // is nowhere on it to write "that isn't available any more". That toast
      // used to be passed here, which meant TanStack dropped it in the one case
      // it exists for - an answer arriving after this row went away. The hook
      // branches on `variables.rung` instead, and outlives us.
      runManualRung.mutate({
        epicId,
        chatId,
        rung,
        // Null for both rungs this arm sends. `retry` is the same tuple again
        // by definition, and `wait_once` parks on the tuple that failed -
        // which is what the wait is FOR. Only `switch` carries a target, and
        // that one comes from the destination menu below.
        target: null,
        userMessageId: attempt.userMessageId,
        turnId: attempt.turnId,
      });
    },
    [attempt, chatId, epicId, runManualRung],
  );

  // The shared minute clock, for one decision only: whether a wait or reset
  // time is far enough out to need its weekday (`formatWaitTime`).
  const now = useSampledNow();
  const rungs = attempt.eligibleRungs;
  const waitUntil = waitUntilLabel(attempt, now);
  // `!canAct` folded in, not checked separately, so every control this
  // component draws is gated by construction rather than one at a time - the
  // bare Retry / Wait buttons, their duplicates inside the empty menu, and the
  // Switch… trigger all already read this one value. See
  // {@link useChatFallbackActionsCanAct}: without it a viewer, or an owner on
  // a dropped chat stream, dispatched a manual rung straight from transcript.
  //
  // DISABLED rather than hidden, which is the choice the composer's cards
  // already made (`triggerDisabled={!canAct}`): the affordances are what the
  // host said this failure admits, and that is still true - what is missing is
  // this reader's standing to use them.
  const busy = runManualRung.isPending || rungsInFlight || !canAct;
  // Why there is no wait button, in the host's own terms. Never inferred from
  // the failure payload: `resetsAt` is PRESENT for a boundary past the user's
  // cap and ABSENT for one nobody verified, so the two states a user can act
  // on were indistinguishable from here, and the state where a wait is
  // impossible looked like the state where it is merely far away.
  const waitExplanation = describeWaitDisposition(
    attempt.waitDisposition,
    attempt.failure.resetsAt === undefined
      ? null
      : formatWaitTime(attempt.failure.resetsAt, now),
  );
  // All three switch decisions in one call - see the helper for why they are
  // one decision and not three.
  const { offersSwitch, switchLeads, switchExplanation } = switchAffordanceFor({
    surface,
    attempt,
    modelLabelFor,
  });

  // Whether the RETRY is the request in flight, as opposed to a switch or a
  // wait sent from the same hook. Without this the card answered a press with
  // nothing at all: `runManualRung.isPending` only ever reached `disabled`, so
  // a user pressed Retry, the button greyed for a moment, the affordances then
  // vanished when the host stopped naming this attempt, and the next thing on
  // screen was an identical error card. Every one of those steps is correct and
  // the sequence still reads as a dead button - which is exactly the report.
  // `variables` is only meaningful while a request is in flight, and the `&&`
  // is what makes reading it safe - no optional chain, which the type says is
  // unnecessary anyway.
  const retryInFlight =
    runManualRung.isPending && runManualRung.variables.rung === "retry";
  const retryButton = rungs.includes("retry") ? (
    <ManualRetryButton
      disabled={busy}
      inFlight={retryInFlight}
      // The weaker of the two when the switch leads, so the row has ONE
      // emphasized control rather than two filled boxes competing.
      variant={switchLeads ? "ghost" : "secondary"}
      onRetry={() => {
        run("retry");
      }}
    />
  ) : null;
  return (
    // A COLUMN, not one wrapping row. Everything below used to live in a single
    // `flex flex-wrap items-center gap-2` - the buttons, the settings link and
    // both explanation sentences together - with the sentences carrying `w-full`
    // so flex-wrap would break the line for them. That is what made the card
    // look ragged: prose and controls were peers in one row, the line breaks
    // were an artefact of a width hack rather than structure, and the vertical
    // rhythm changed depending on which sentences happened to be present.
    //
    // Two bands instead, each with one job: what the host wants to tell you,
    // then what you can do about it.
    <div className="mt-3 flex flex-col gap-2.5">
      <ManualRungExplanations
        switchExplanation={switchExplanation}
        waitExplanation={waitExplanation}
      />
      <div className="flex flex-wrap items-center gap-2">
        {switchLeads ? null : retryButton}
        {offersSwitch && seedTuple !== null ? (
          <RoutingDestinationPicker
            // The ATTEMPT, not a traversal: this row renders where no
            // dispatch-holding traversal exists, which is why the switch is
            // `runManualRung` bound to the failed attempt.
            entry={{ kind: "failed-turn", attempt, seedTuple }}
            triggerLabel={SWITCH_LABEL}
            // Emphasized where switching is the thing that helps.
            triggerVariant={switchLeads ? "secondary" : "ghost"}
            triggerDisabled={runManualRung.isPending || rungsInFlight}
            canAct={canAct}
            epicId={epicId}
            chatId={chatId}
            hostId={hostId}
          />
        ) : null}
        {switchLeads ? retryButton : null}
        {waitUntil === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              run("wait_once");
            }}
          >
            {waitUntil}
          </Button>
        )}
        {/*
         * ALWAYS, not only when there is nothing else. Hiding it beside buttons
         * made the escape available in exactly the state where the user had
         * least need of it and unavailable in the state where a destination
         * turned out to be unusable and the policy was the thing to go and look
         * at. "No buttons is a real state, and the host said so" is still true -
         * the difference is that the link is not the consolation prize for it.
         *
         * `ml-auto` puts it at the FAR end of the row, away from the actions.
         * It sat inline among them before, which made a link that navigates to
         * Settings read as a fourth thing you could do to this turn - and on a
         * row where it was the only control left, it read as the primary one.
         * Actions act on the message; this one leaves for a different screen,
         * and the gap is what says so.
         */}
        <div className="ml-auto flex items-center">
          <FallbackNoticeSettingsLink />
        </div>
      </div>
    </div>
  );
}

/**
 * The host's reasons a control is missing, as one muted block above the row.
 *
 * Its own component for the reason the two sentences are grouped at all: they
 * are the same KIND of thing - a fact about this failure that the reader cannot
 * act on directly - and they belong together, above the controls that remain,
 * rather than trailing underneath them as two separately-`w-full` orphans.
 *
 * Order is unchanged and still deliberate. The switch sentence names the chat
 * and is what the settings link is the remedy for; the wait sentence is about a
 * provider's reset boundary. A reader with both wants the actionable one first.
 *
 * `null` when there is nothing to say, so the column above contributes no gap
 * for an empty block - which is the other half of why the old version's rhythm
 * changed depending on which sentences were present.
 */
function ManualRungExplanations({
  switchExplanation,
  waitExplanation,
}: {
  readonly switchExplanation: string | null;
  readonly waitExplanation: string | null;
}) {
  if (switchExplanation === null && waitExplanation === null) return null;
  return (
    <div className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
      {switchExplanation === null ? null : <span>{switchExplanation}</span>}
      {waitExplanation === null ? null : <span>{waitExplanation}</span>}
    </div>
  );
}

/**
 * Retry, with the one thing it was missing: an answer to the press.
 *
 * The convention this follows is the app's own for a pending mutation -
 * `disabled` plus an UNCHANGED label plus inline `AgentSpinningDots`, never a
 * swapped "Retrying…" caption. It matters more here than in most places: a
 * manual retry has no other feedback anywhere. The engine's own transient
 * retries get `FallbackRetryRow` at the turn tail, but that row is driven by
 * `pending.state === "retrying"` and a manual rung never enters that state, so
 * between the click and the next frame the card said nothing whatsoever - and
 * when the retry then failed on the same still-limited account, the whole
 * episode read as a button that does nothing.
 */
function ManualRetryButton({
  disabled,
  inFlight,
  variant,
  onRetry,
}: {
  readonly disabled: boolean;
  readonly inFlight: boolean;
  /**
   * `secondary` when retrying is the best thing on offer, `ghost` when a switch
   * is. The row carries exactly one filled control either way - two of them is
   * what made the old card read as a pile of equally-weighted boxes.
   */
  readonly variant: "secondary" | "ghost";
  readonly onRetry: () => void;
}) {
  return (
    <Button size="sm" variant={variant} disabled={disabled} onClick={onRetry}>
      Retry
      {inFlight ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </Button>
  );
}

/**
 * "Wait until 3:00 PM" ("Wait until Sat 3:00 PM" past a day), or `null`.
 *
 * Two gates, and they are not redundant. `wait_once` in `eligibleRungs` is the
 * HOST's answer - it is present iff the failure carries a verified boundary
 * within the policy cap. The `resetsAt` check that follows is not a second
 * eligibility rule; it is this component refusing to name a time it does not
 * have, since the field is optional on the failure payload and a button reading
 * "Wait until undefined" is worse than no button.
 *
 * The host now keeps the two in step - it restates the boundary its verdict
 * was decided against onto `failure` - and this second gate is where they were
 * seen apart: a Codex usage limit is stamped before its post-limit probe
 * answers, so it arrived `eligible` with no time and drew no button at all.
 */
function waitUntilLabel(
  attempt: LastFailedAttempt,
  now: number,
): string | null {
  if (!attempt.eligibleRungs.includes("wait_once")) return null;
  const resetsAt = attempt.failure.resetsAt;
  if (resetsAt === undefined) return null;
  return `Wait until ${formatWaitTime(resetsAt, now)}`;
}
