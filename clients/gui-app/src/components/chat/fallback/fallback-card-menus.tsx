import { useCallback, useEffect, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ChatRunSettings,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";
import { formatWaitTime, useSampledNow } from "@/lib/relative-time";
import {
  CHOOSE_DIFFERENTLY_LABEL,
  COUNTDOWN_NOT_PAUSED_LABEL,
  HOST_UNREACHABLE_LABEL,
  SWITCH_INSTEAD_LABEL,
  describeFallbackOutcome,
  switchConsequencesText,
} from "./fallback-copy";
import { FallbackDestinationMenu } from "./fallback-destination-menu";
import { useFallbackChooseTarget } from "./use-fallback-actions";
import { useFallbackChoiceLease } from "./use-fallback-choice-lease";
import { usePublishUnattendedFallbackOutcome } from "./use-unattended-fallback-outcome";

/**
 * "Choose differently…" — the grace card's menu, which FREEZES the window.
 *
 * The whole reason this differs from its waiting-card sibling is the lease. A
 * countdown is a budget being spent, so opening a menu over one has to stop the
 * clock or the window expires while the user reads their options; a wait runs to
 * a provider reset boundary, which is a fact rather than a budget, and nothing
 * needs freezing there.
 *
 * The freeze is a STREAM action rather than a unary RPC because a lease has to
 * bind to the subscription that owns it — a unary call has no `connectionId` on
 * the wire, so two windows opening this menu would be indistinguishable. Sent on
 * the stream, the binding is free, and subscriber detach resumes the frozen
 * remainder with no extra message.
 *
 * Three things it will not do:
 *
 * **It does not claim the pause.** Rows appear only once the ack has minted a
 * token AND the DTO itself reports `choosing`. Until then the menu says it is
 * pausing, in the present progressive, because the countdown really is still
 * running. The card's own headline follows the same rule.
 *
 * **It does not list under a refused hold.** A `refused` lease means the host
 * declined the hold, so the menu says so and lists nothing, rather than
 * offering destinations for a window nobody holds. It stays OPEN while it says
 * it - the popover's `open` is the user's, and yanking it shut would take the
 * sentence away at the moment it appeared. Closing is the user's next move, or
 * the card's when the traversal ends.
 *
 * A refusal also does NOT mean the traversal advanced: an accepted ack that
 * mints no token refuses too, and reopening from `choosing` has been a normal
 * path since B1. The menu reports that it has nothing to list, never a cause it
 * did not learn.
 *
 * **It does not decide when a token is handed back.** Close is a plain
 * `release()`; the STREAM STORE owns the rest, because menu visibility and
 * lease lifetime are different facts. A close that beats the ack leaves the
 * store holding the obligation, and the token is released when it arrives -
 * after this component has stopped caring. Detach, chat close and host restart
 * still resume the remainder host-side, which is why the host can never treat
 * the release frame as the only way a hold ends; the frame is what keeps a
 * still-connected subscriber from sitting on a frozen window.
 *
 * The unmount release below is the same courtesy for the one close this
 * component never hears about: a released chat session stays warm for ten
 * minutes, so closing the tile over an open menu leaves the stream connected
 * and the host holding a window with no UI anywhere to give it back.
 */
export function FallbackGraceMenu({
  pending,
  client,
  epicId,
  chatId,
  hostId,
  canAct,
}: {
  readonly pending: PendingFallback;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly canAct: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { lease, hold, release } = useFallbackChoiceLease({
    epicId,
    chatId,
    hostId,
  });
  // The menu's inline line is the channel while the popover is open; once it
  // closes - or once the card goes with the traversal's next transition - the
  // answer is owed to the chat's persistent announcer instead (MF11).
  const publishUnattended = usePublishUnattendedFallbackOutcome({
    epicId,
    chatId,
    hostId,
  });
  const [refusal, setRefusal] = useState<string | null>(null);
  const chooseTarget = useFallbackChooseTarget(client, chatId, {
    inlineMenuOpen: open,
    publishUnattended,
  });

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      setRefusal(null);
      if (next) {
        hold(pending.traversalId);
        return;
      }
      release();
    },
    [hold, pending.traversalId, release],
  );

  // REACQUIRE when an authoritative frame retires the lease under an OPEN menu.
  //
  // B1 made a reconnect retire the old-epoch lease, which is correct - a token
  // minted on a dead connection cannot be presented on the new one. What it
  // left behind is this: the only `hold(...)` call used to be in
  // `onOpenChange(true)`, so nothing re-asked. A user with the menu open
  // through a detach came back to `preparing` forever - "Pausing the
  // countdown…" printed over a countdown the host had resumed and was actively
  // spending - until the traversal advanced or they closed and reopened it. The
  // card stays mounted across `hold` and `choosing`, so nothing remounted this
  // component to re-run the open path either.
  //
  // Stream sync, not derived state: the trigger is an authoritative frame
  // arriving, which is exactly the external-source case effects are for.
  //
  // Asks ONCE per retirement, with no guard flag, and the two branches of
  // `fallbackHoldForChoice` are why - they are worth stating separately,
  // because only one of them is the "it wrote the slot" story.
  //
  // When the send SUCCEEDS the slot is written synchronously, so `lease` is
  // non-null on the very next render and stays non-null while the request is in
  // flight (`pending`), once it is `held`, and if the host refuses it
  // (`refused` is non-null too - the refusal surfaces as neutral feedback
  // below, which is the "or close it" half of this recovery). Nothing re-asks.
  //
  // When the send FAILS the slot is NOT written, and `lease === null` is still
  // true. `sendAction` returns null whenever `canSendAction` is false, which is
  // FOUR distinct conditions, not one: the session is disposed, there is no
  // stream client, `connectionStatus !== "open"`, or `access.canAct !== true`.
  // Two of those are not connectivity at all - a disposed session and a viewer
  // without permission to act are settled facts, not gaps to wait out - so this
  // deliberately does NOT diagnose which one occurred or assert that it will
  // clear.
  //
  // It does not need to. The recovery is stated as a rule about frames rather
  // than about causes: `pending` is a dependency as the whole object rather
  // than as its two fields, the DTO is replaced per authoritative frame, so
  // every frame re-evaluates the guards above. Where the condition has cleared
  // the hold goes out; where it has not, `canSendAction` refuses again and
  // nothing is sent. That is the whole contract, and it is deliberately stated
  // without a claim about how often frames arrive in any of the four cases -
  // the retry is correct whether they arrive or not. It cannot spin: between
  // frames nothing in the dependency list moves.
  //
  // `hold` only - never `release` - because a retired lease has no token to
  // hand back: the store dropped it with the connection it was minted on.
  useEffect(() => {
    if (!open) return;
    if (lease !== null) return;
    // Only a live grace window can be frozen, and `hold` is the only state
    // that has one running.
    //
    // The distinction this guard turns on is NOT whether the lease was retired
    // - a reconnect retires it in `choosing` exactly as in `hold`, and the
    // integration suite's control does precisely that. It is whether there is
    // a countdown left to stop. `choosing` means the host already froze the
    // window and is running no timer against it, so re-asking would request a
    // freeze of something that is not being spent; anything terminal has no
    // window at all. In `hold` the clock is running, and a client that cannot
    // re-ask watches it run out behind a menu that says it is paused.
    if (pending.state !== "hold") return;
    hold(pending.traversalId);
  }, [open, lease, pending, hold]);

  // Latest-value refs rather than effect dependencies, so the cleanup below
  // runs on UNMOUNT and on nothing else. Depending on `open`/`release`
  // directly would fire a release every time the popover toggled or the
  // session handle changed - which is the ordinary close, already handled
  // above, reported twice.
  const openRef = useRef(open);
  const releaseRef = useRef(release);
  useEffect(() => {
    openRef.current = open;
    releaseRef.current = release;
  });
  useEffect(
    () => () => {
      if (openRef.current) releaseRef.current();
    },
    [],
  );

  const onPick = useCallback(
    (target: ChatRunSettings) => {
      chooseTarget.mutate(
        {
          epicId,
          chatId,
          traversalId: pending.traversalId,
          revision: pending.revision,
          target,
          // The token this menu's own hold minted. `null` would be legal on the
          // wire — the waiting card's menu sends exactly that — but sending it
          // from HERE would present no proof for a hold we did take, and the
          // host validates a presented lease either way.
          leaseToken: lease?.token ?? null,
        },
        {
          onSuccess: (response) => {
            const message = describeFallbackOutcome(response.outcome);
            if (message === null) {
              // Applied. The frame that follows is the feedback; the menu just
              // gets out of the way. No release: the traversal has advanced, so
              // there is no frozen remainder left to resume.
              setOpen(false);
              return;
            }
            setRefusal(message);
          },
          // The one answer this menu had NO line for. Every `outcome` above
          // arrives in a successful response; a request that got no response at
          // all left `refusal` unset, `picking` fell back to false, the rows
          // re-enabled, and the surface the click came from said nothing at all
          // about a click that failed.
          //
          // Beside, not instead of, `useHostScopedMutationForClient`'s toast.
          // The two are complementary rather than duplicated, because a per-call
          // handler is the OBSERVER's: TanStack runs this one only while this
          // popover is still mounted, which is exactly when the inline line is
          // the right channel, and the toast is what remains when the traversal
          // has already taken this surface away. The cost is that both speak
          // while the menu IS open - accepted, because a silent popover in front
          // of the user is the worse half of that trade.
          //
          // `HOST_UNREACHABLE_LABEL` rather than a second wording: this menu
          // already prints exactly this sentence when the LISTING cannot reach
          // the host, and one unreachable host is one fact.
          onError: () => {
            setRefusal(HOST_UNREACHABLE_LABEL);
          },
        },
      );
    },
    [
      chatId,
      chooseTarget,
      epicId,
      lease,
      pending.revision,
      pending.traversalId,
    ],
  );

  const refusedHold = lease !== null && lease.status === "refused";
  return (
    <FallbackDestinationMenu
      triggerLabel={CHOOSE_DIFFERENTLY_LABEL}
      // `switching` has committed: there is no window left to freeze and no
      // choice left to make.
      triggerDisabled={!canAct || pending.state === "switching"}
      header={null}
      selector={{
        kind: "traversal",
        traversalId: pending.traversalId,
        revision: pending.revision,
      }}
      epicId={epicId}
      chatId={chatId}
      client={client}
      open={open}
      onOpenChange={onOpenChange}
      onPick={onPick}
      picking={chooseTarget.isPending}
      // Both halves of the ticket's rule: the host minted a token AND the DTO
      // agrees the window is frozen. Either alone would let the rows appear over
      // a countdown that is still being spent.
      //
      // A REFUSED hold satisfies this too, and deliberately - `refused` is not
      // `held`, so it reads as "not entitled to list", which is exactly what it
      // is. An earlier version excluded it (`!refusedHold && …`) and thereby
      // fetched and listed destinations for a window this client had just been
      // told it does not hold.
      //
      // What the refusal does NOT establish is why. It is not evidence the
      // traversal advanced - the doc above enumerates the refusals that carry
      // no such claim - so the rows are withheld because listing them would
      // offer picks this client cannot back with a token, not because their
      // destinations are known to be stale.
      preparing={lease?.status !== "held" || pending.state !== "choosing"}
      refusal={refusedHold ? COUNTDOWN_NOT_PAUSED_LABEL : refusal}
      emptyStateActions={null}
    />
  );
}

/**
 * "Switch instead…" — the waiting card's menu, which freezes NOTHING.
 *
 * No lease, and `leaseToken: null` on the pick. A reset boundary is a fact, not
 * a budget: there is no countdown to pause, so there is nothing for a hold to
 * protect. `chooseTarget` cancels the wait atomically as part of applying the
 * pick, which is why this needs no separate "stop waiting" step.
 *
 * Its header says what happens if the user picks nothing, because unlike the
 * grace card there is no visible number ticking down to make that obvious.
 */
export function FallbackWaitingMenu({
  pending,
  client,
  epicId,
  chatId,
  hostId,
  canAct,
}: {
  readonly pending: PendingFallback;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  /**
   * Not for a lease - this menu freezes nothing - but for the announcer: the
   * chat session this refusal has to reach is keyed by the whole triple.
   */
  readonly hostId: string;
  readonly canAct: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The shared minute clock, for the header's resume time alone: whether it is
  // far enough out to need its weekday (`formatWaitTime`).
  const now = useSampledNow();
  // The transition this menu is MOST likely to lose its surface to is its own
  // card's: `waiting -> switching` replaces the waiting subtree wholesale, so a
  // losing pick answered a beat later finds no menu, no inline line and no live
  // region. That is the MF11 case, and this is where its answer goes.
  const publishUnattended = usePublishUnattendedFallbackOutcome({
    epicId,
    chatId,
    hostId,
  });
  const chooseTarget = useFallbackChooseTarget(client, chatId, {
    inlineMenuOpen: open,
    publishUnattended,
  });

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    setRefusal(null);
  }, []);

  const onPick = useCallback(
    (target: ChatRunSettings) => {
      chooseTarget.mutate(
        {
          epicId,
          chatId,
          traversalId: pending.traversalId,
          revision: pending.revision,
          target,
          leaseToken: null,
        },
        {
          onSuccess: (response) => {
            const message = describeFallbackOutcome(response.outcome);
            if (message === null) {
              setOpen(false);
              return;
            }
            setRefusal(message);
          },
          // The transport half, on the same terms as the grace menu's - see the
          // note there. Same defect, same channel: an unanswered pick used to
          // leave this popover looking exactly as it did before the click.
          onError: () => {
            setRefusal(HOST_UNREACHABLE_LABEL);
          },
        },
      );
    },
    [chatId, chooseTarget, epicId, pending.revision, pending.traversalId],
  );

  return (
    <FallbackDestinationMenu
      triggerLabel={SWITCH_INSTEAD_LABEL}
      triggerDisabled={!canAct}
      header={waitingMenuHeader(
        pending.deadline,
        pending.queuedItemsMoving,
        now,
      )}
      selector={{
        kind: "traversal",
        traversalId: pending.traversalId,
        revision: pending.revision,
      }}
      epicId={epicId}
      chatId={chatId}
      client={client}
      open={open}
      onOpenChange={onOpenChange}
      onPick={onPick}
      picking={chooseTarget.isPending}
      preparing={false}
      refusal={refusal}
      emptyStateActions={null}
    />
  );
}

/**
 * "Resumes at 3:00 PM unless you pick something. <consequences>", or the
 * consequences alone.
 *
 * NEVER `null`, and the doc used to say otherwise. A missing deadline drops the
 * RESET FRAGMENT rather than the whole header: the consequences of picking a
 * destination - the message replays, the queue moves, a fresh session starts -
 * are true whether or not a reset time is in hand, and F10 is the finding that
 * they must be stated before the countdown spends them. Returning `null` there
 * hid them on exactly the wait whose end nobody can name.
 *
 * The waiting card above still reads "Resuming shortly…" in that state, so the
 * time itself is not repeated here - only the part this menu owns.
 */
function waitingMenuHeader(
  deadline: number | null,
  queuedItemsMoving: number,
  now: number,
): string {
  const consequences = switchConsequencesText(queuedItemsMoving);
  if (deadline === null) return consequences;
  return `Resumes at ${formatWaitTime(deadline, now)} unless you pick something. ${consequences}`;
}
