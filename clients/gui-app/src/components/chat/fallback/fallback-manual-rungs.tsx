import { useCallback, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Info } from "lucide-react";
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
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { formatWaitTime, useSampledNow } from "@/lib/relative-time";
import { chatFallbackMutationKeys } from "@/lib/query-keys";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  RECONNECTING_LABEL,
  SWITCH_LABEL,
  describeManualRungRefusal,
  describeSwitchDisposition,
  describeWaitDisposition,
  type RefusalNoteCopy,
} from "./fallback-copy";
import {
  fallbackProviderModelLabel,
  useFallbackModelLabels,
  type FallbackModelLabelResolver,
} from "./fallback-identity";
import { useFallbackRunManualRung } from "./use-fallback-actions";
import {
  useChatFallbackTraversalIsLive,
  useChatLastFailedAttempt,
} from "./use-last-failed-attempt";
import { usePublishConfirmedManualFallbackAction } from "./use-confirmed-manual-action";
import { usePublishUnattendedFallbackOutcome } from "./use-unattended-fallback-outcome";
import { RoutingDestinationPicker } from "./routing-destination-picker";

/**
 * The failed-turn card's actions: Retry, Switch to…, and "Wait until <time>".
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
 * host named, and let `chat.fallback.runManualRung` answer with a refusal the
 * card then states for the rest.
 *
 * That list used to carry a fourth item - "no traversal holds dispatch" - and
 * this component genuinely needed no gating of its own while it held. It does
 * not hold any more: the host defines the field during a `hold` too, so
 * `ManualRungActions` below carries the one gate that costs us, and its comment
 * says why the row cannot simply share the field.
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
  const standing = useChatFallbackActionStanding({ epicId, chatId, hostId });

  if (attempt === undefined) return null;
  // While the composer draws a routing card, THAT card owns the routing
  // conversation, and this row must not offer a second copy of it.
  //
  // The host defines `lastFailedAttempt` during a `hold` as well - the field
  // no longer means "no traversal holds dispatch" - so without this gate the
  // row came back on beside the countdown: a filled `Switch to…` here, above a
  // countdown offering its own. And this one is the leaseless one. The
  // countdown's picker takes the choice lease that freezes the window; a pick
  // made here does not, so the user opens the picker, the window expires under
  // the popover, routing commits, and the pick is refused. That race is
  // precisely what the choice lease exists to prevent.
  //
  // Nothing has to be remembered: the composer's card leaving is the same
  // frame that ends the traversal (or, for a countdown with nothing to try, the
  // frame the composer declines to draw one), so this row returns exactly when
  // it becomes the only surface again.
  //
  // One case DOES lose an affordance, and it is the right trade rather than an
  // oversight: a user who HIDES the card. Hiding is not an answer to the card's
  // question - the traversal runs on, untouched and still holding dispatch - so
  // this row stands down and that chat has no rungs anywhere until routing
  // ends. Restoring them here would restore them LEASELESS, into the race
  // above, which hiding did nothing to end. If that gap is ever worth closing,
  // it closes by giving this row the lease, not by ungating it.
  if (traversalIsLive) return null;
  // The row must be the one the host is describing. A transcript holding three
  // failed attempts offers these once, not three times - and a legacy record
  // (no turn identity, so no `turnId` prop) never reaches this component at
  // all, which is the correct answer rather than a missing one.
  if (attempt.turnId !== turnId) return null;
  // A sign-out is NOT gated here (spec Flow 4): the host's `eligibleRungs`
  // governs, and Retry leads as it does for any cause other than a rate limit
  // or billing stop. Signing in does not rewrite this attempt's recorded
  // cause, so a gate on it would leave the turn with no way to be retried once
  // the account works again - and a switch to an account that works is exactly
  // the recovery a sign-out calls for.
  //
  // A viewer of someone else's chat has no standing to steer it, now or after
  // a reconnect, so the actions are not drawn at all (spec Flow 4) - greying
  // them with "Reconnecting…" would promise something that is not coming.
  if (standing === "viewer") return null;

  return (
    <ManualRungAffordances
      attempt={attempt}
      client={client}
      epicId={epicId}
      chatId={chatId}
      hostId={hostId}
      reconnecting={standing === "reconnecting"}
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
 * This reader's standing to steer the chat right now.
 *
 * - `act`: an owner on an open stream.
 * - `reconnecting`: the stream is not open, or the host has not said who this
 *   reader is yet. The actions stay on screen, greyed, with "Reconnecting…".
 * - `viewer`: the host said this reader may not act. Settled for the session,
 *   so the actions are not drawn.
 */
type FallbackActionStanding = "act" | "reconnecting" | "viewer";

/**
 * Whether this chat would accept a fallback action right now - the ACT
 * CAPABILITY, read off the chat's own session.
 *
 * The card's affordances dispatch `chat.fallback.runManualRung`, a plain unary
 * RPC, and nothing on the client refused it: the buttons were gated on
 * `runManualRung.isPending` and on nothing else, so a VIEWER of someone else's
 * chat - or its owner while the chat stream is down - could fire a retry, a
 * wait, or a whole provider switch straight out of durable transcript.
 *
 * `ErrorSegment` is durable transcript rendered from a message list, so nothing
 * upstream of it knows the chat's access at all - which is exactly why the
 * three ids this component already resolves are the right source: the SESSION
 * knows. This reproduces `canSendAction`'s own rule (`chat-session-store.ts`)
 * rather than a paraphrase of it, so the card refuses precisely what the
 * stream-side lease refuses - and splits the refusal by WHY, since a reader
 * who will never act and one waiting on a reconnect are told different things.
 *
 * Deliberately NOT the composer's third term (`profile !== null`, the signed-in
 * account): that is the tile's own send precondition and has no bearing on
 * whether this chat's routing may be steered. Nor `sendBlocked`'s widenings -
 * a disabled profile or a signed-out provider is what a routing action is the
 * ESCAPE from, and gating on it would strand a chat on a destination it is no
 * longer allowed to leave.
 */
function useChatFallbackActionStanding(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}): FallbackActionStanding {
  const { epicId, chatId, hostId } = input;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const store = handle === null ? noSessionActSlice : handle.store;
  return useStore(store, (state) => {
    if (state.access !== null && !state.access.canAct) return "viewer";
    if (state.connectionStatus === "open" && state.access !== null) {
      return "act";
    }
    return "reconnecting";
  });
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
 * Whether the switch leads, and what to say when it is missing.
 *
 * Retry re-runs the SAME account and model (`retry` is the same tuple by
 * definition). For a failure the provider will keep refusing until something
 * changes - a spent quota, an unpaid bill - that is very unlikely to do
 * anything, and the engine agrees: `rate_limit` and `billing` get no transient
 * retry either, only the outage-shaped failures do. So after those two the
 * switch leads and the wait is its alternative (spec Flow 4); after anything
 * else Retry leads.
 *
 * The explanation's subject is the FAILED tuple the host named, resolved
 * through the same module every other routing surface names a tuple with.
 * Never the chat's current settings: this is bound to an attempt, and a chat
 * reconfigured since would be explained in terms of a model that never ran.
 */
function switchAffordanceFor(input: {
  readonly attempt: LastFailedAttempt;
  readonly modelLabelFor: FallbackModelLabelResolver;
}): {
  readonly offersSwitch: boolean;
  readonly switchLeads: boolean;
  readonly switchExplanation: string | null;
} {
  const { attempt, modelLabelFor } = input;
  const offersSwitch = attempt.eligibleRungs.includes("switch");
  const failedTuple = attempt.failedTuple;
  return {
    offersSwitch,
    switchLeads:
      attempt.failure.reason === "rate_limit" ||
      attempt.failure.reason === "billing",
    switchExplanation: describeSwitchDisposition(
      attempt.switchDisposition,
      failedTuple === null
        ? null
        : fallbackProviderModelLabel(failedTuple, modelLabelFor),
    ),
  };
}

type ManualAction = "retry" | "switch" | "wait";

/**
 * The actions this card draws, in order, the first one filled.
 *
 * ONE filled button, always the first: the order is the cause's order of
 * usefulness, and an action the host did not admit (or a refusal took away)
 * drops out so the next one leads rather than leaving a row with no primary.
 */
function orderedManualActions(input: {
  readonly switchLeads: boolean;
  readonly offers: Readonly<Record<ManualAction, boolean>>;
}): ReadonlyArray<ManualAction> {
  const order: ReadonlyArray<ManualAction> = input.switchLeads
    ? ["switch", "wait", "retry"]
    : ["retry", "switch", "wait"];
  return order.filter((action) => input.offers[action]);
}

/**
 * Which actions a refusal leaves standing (the spec's "Buttons left" column).
 * No refusal yet leaves all of them.
 */
function refusalLeaves(
  refusal: RefusalNoteCopy | null,
): Readonly<Record<ManualAction, boolean>> {
  const remaining = refusal === null ? "all" : refusal.remaining;
  switch (remaining) {
    case "all":
      return { retry: true, switch: true, wait: true };
    case "retry_and_switch":
      return { retry: true, switch: true, wait: false };
    case "switch":
      return { retry: false, switch: true, wait: false };
    case "none":
      return { retry: false, switch: false, wait: false };
  }
}

/**
 * The affordances themselves, the in-flight state, and the refusal note.
 *
 * ## Why this is a THIRD component
 *
 * The same reason the file already gives for the first split, applied to the
 * gates above: *"gating with an early `return null` inside one component would
 * not do"*. That doc was written about the host hooks; it is just as true of
 * the reporting state and the refusal note, and this component exists because
 * the second gate was originally the early return it warns against.
 *
 * The error row is NOT a stable surface for a delayed answer. `ErrorSegment`
 * renders `FallbackManualRungActions` for any row carrying a `turnId`, and
 * nothing about that changes when the attempt does - so a gate above turning
 * `false` used to leave this component **mounted and rendering nothing**, with
 * the per-render layout effect in `useFallbackOutcomeReporting` still
 * republishing "an inline surface answers" on every null render. A refusal then
 * arriving after the frame that removed the row (which is what
 * `attempt_not_latest` MEANS) deferred to an inline note that was no longer
 * rendering, and was delivered **nowhere**.
 *
 * Splitting is what fixes it, rather than a cleverer predicate: unmounting runs
 * the reporting hook's cleanup, and destroys the refusal note with it, so a
 * returning attempt cannot reappear under a stale refusal either. Losing the
 * in-flight mutation costs nothing - the Mutation lives in the query cache and
 * its hook-level `onSuccess` hands the refusal to the chat's announcer whether
 * or not this subtree is still here.
 */
function ManualRungAffordances({
  attempt,
  client,
  epicId,
  chatId,
  hostId,
  reconnecting,
}: {
  readonly attempt: LastFailedAttempt;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  /** The stream is down: draw the actions greyed and say "Reconnecting…". */
  readonly reconnecting: boolean;
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
  // The tab host record's name, for the refusal that names a machine ("…no
  // longer exists on Surya's MacBook"). Never from the host's detail: the host
  // writes a fixed sentence and the client says where.
  const hostLabel = useHostDirectoryEntry(hostId)?.label ?? null;
  // One tuple: the only model this card names is the FAILED one, in the
  // sentence explaining why there is no Switch… button. The picker this card
  // opens resolves its own rows.
  const catalogueRead = manualRungCatalogueRead(attempt.failedTuple);
  const modelLabelFor = useFallbackModelLabels(
    client,
    catalogueRead.subjects,
    catalogueRead.enabled,
  );
  // The bare Retry / Wait buttons. The picker owns its own instance of this
  // verb, so the two are joined below through the shared mutation key.
  //
  // This card answers inline while it is on screen - the refusal note below -
  // so the hook-level report stands down until it unmounts, then speaks
  // through the announcer. Never a toast (spec Flow 4).
  const runManualRung = useFallbackRunManualRung(
    client,
    chatId,
    publishConfirmed,
    { inlineMenuOpen: true, publishUnattended },
  );
  const [refusal, setRefusal] = useState<RefusalNoteCopy | null>(null);
  const switchSeed = useChatPersistedSettings({ epicId, chatId, hostId });
  const seedTuple = attempt.failedTuple ?? switchSeed;
  // Any rung in flight for this chat - a bare button here or a pick in the
  // picker - quiets every control, so one press cannot race another.
  const rungsInFlight =
    useIsMutating({
      mutationKey: chatFallbackMutationKeys.runManualRung(chatId),
    }) > 0;

  const run = useCallback(
    (rung: "retry" | "wait_once") => {
      setRefusal(null);
      runManualRung.mutate(
        {
          epicId,
          chatId,
          rung,
          // Null for both rungs this arm sends. `retry` is the same tuple
          // again by definition, and `wait_once` parks on the tuple that
          // failed - which is what the wait is FOR. Only `switch` carries a
          // target, and that one comes from the picker below.
          target: null,
          userMessageId: attempt.userMessageId,
          turnId: attempt.turnId,
        },
        {
          // Per-call, so it dies with this card: once the card is gone the
          // hook-level handler speaks the same sentence instead.
          onSuccess: (response) => {
            setRefusal(
              describeManualRungRefusal({
                outcome: response.outcome,
                detail: response.detail,
                rung,
                hostLabel,
              }),
            );
          },
        },
      );
    },
    [attempt, chatId, epicId, hostLabel, runManualRung],
  );

  // The shared minute clock, for one decision only: whether a wait or reset
  // time is far enough out to need its weekday (`formatWaitTime`).
  const now = useSampledNow();
  const waitUntil = waitUntilLabel(attempt, now);
  // DISABLED rather than hidden while reconnecting: the affordances are what
  // the host said this failure admits, and that is still true - what is
  // missing is a connection to send them on.
  const busy = runManualRung.isPending || rungsInFlight || reconnecting;
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
  const { offersSwitch, switchLeads, switchExplanation } = switchAffordanceFor({
    attempt,
    modelLabelFor,
  });
  const leaves = refusalLeaves(refusal);
  const actions = orderedManualActions({
    switchLeads,
    offers: {
      retry: attempt.eligibleRungs.includes("retry") && leaves.retry,
      switch: offersSwitch && seedTuple !== null && leaves.switch,
      wait: waitUntil !== null && leaves.wait,
    },
  });
  // Whether the RETRY is the request in flight, as opposed to a wait sent
  // from the same hook. Without it a press got no answer at all: the button
  // greyed for a moment, the affordances then vanished when the host stopped
  // naming this attempt, and the next thing on screen was an identical error
  // card - a sequence of correct steps that reads as a dead button.
  const inFlightRung = runManualRung.isPending
    ? runManualRung.variables.rung
    : null;

  const drawAction = (action: ManualAction, index: number) => {
    const variant = index === 0 ? "default" : "outline";
    switch (action) {
      case "retry":
        return (
          <Button
            key="retry"
            size="sm"
            variant={variant}
            disabled={busy}
            onClick={() => {
              run("retry");
            }}
          >
            Retry
            {inFlightRung === "retry" ? <PendingDots /> : null}
          </Button>
        );
      case "wait":
        return (
          <Button
            key="wait"
            size="sm"
            variant={variant}
            disabled={busy}
            onClick={() => {
              run("wait_once");
            }}
          >
            {waitUntil}
            {inFlightRung === "wait_once" ? <PendingDots /> : null}
          </Button>
        );
      case "switch":
        // `seedTuple` is non-null here: the switch is offered only with one.
        return seedTuple === null ? null : (
          <RoutingDestinationPicker
            key="switch"
            // The ATTEMPT, not a traversal: this card renders where no
            // dispatch-holding traversal exists, which is why the switch is
            // `runManualRung` bound to the failed attempt.
            entry={{ kind: "failed-turn", attempt, seedTuple }}
            triggerLabel={SWITCH_LABEL}
            triggerAriaLabel={null}
            triggerVariant={variant}
            triggerDisabled={runManualRung.isPending || rungsInFlight}
            canAct={!reconnecting}
            epicId={epicId}
            chatId={chatId}
            hostId={hostId}
          />
        );
    }
  };

  return (
    // A COLUMN: what the host wants to tell you, then what you can do about
    // it, then - after a refusal - why that did not work and what to do next,
    // where the buttons are.
    <div className="mt-3 flex flex-col gap-2.5">
      <ManualRungExplanations
        switchExplanation={switchExplanation}
        waitExplanation={waitExplanation}
      />
      {actions.length === 0 ? null : (
        <div
          data-testid="failed-turn-actions"
          className="flex flex-wrap items-center gap-2"
        >
          {actions.map(drawAction)}
          {reconnecting ? (
            <span className="text-ui-xs text-muted-foreground">
              {RECONNECTING_LABEL}
            </span>
          ) : null}
        </div>
      )}
      {refusal === null || refusal.text === null ? null : (
        <RefusalNote text={refusal.text} />
      )}
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
 * Order is deliberate. The switch sentence names the chat; the wait sentence
 * is about a provider's reset boundary. A reader with both wants the one about
 * this chat first.
 *
 * `null` when there is nothing to say, so the column above contributes no gap
 * for an empty block.
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
 * Why the last press did not run, and what to do next - where the buttons are
 * (spec Flow 4: "a toast never carries a refusal").
 *
 * A live region, because the sentence REPLACES what the press was expected to
 * do: a screen-reader user who pressed Retry hears the answer to that press.
 * Info-toned, not destructive: nothing broke, the host declined a request and
 * said why.
 */
function RefusalNote({ text }: { readonly text: string }) {
  return (
    <div
      role="status"
      data-testid="failed-turn-refusal"
      className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-2.5 py-2 text-ui-xs text-foreground"
    >
      <Info
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-info-foreground"
      />
      <span className="min-w-0">{text}</span>
    </div>
  );
}

function PendingDots() {
  return (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
    />
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
