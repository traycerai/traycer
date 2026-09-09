import { useCallback, useEffect, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ChatRunSettings,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@/lib/host";
import { formatClockTime } from "@/lib/relative-time";
import {
  CHOOSE_DIFFERENTLY_LABEL,
  COUNTDOWN_NOT_PAUSED_LABEL,
  SWITCH_INSTEAD_LABEL,
  describeFallbackOutcome,
  switchConsequencesText,
} from "./fallback-copy";
import { FallbackDestinationMenu } from "./fallback-destination-menu";
import { useFallbackChooseTarget } from "./use-fallback-actions";
import { useFallbackChoiceLease } from "./use-fallback-choice-lease";

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
 * **It does not keep a refused hold open.** A `refused` lease means the host
 * declined the hold, so the menu says so and closes rather than listing
 * destinations for a window nobody holds. It does NOT mean the traversal
 * advanced: an accepted ack that mints no token refuses too, and reopening from
 * `choosing` has been a normal path since B1. The menu reports that it has
 * nothing to list, never a cause it did not learn.
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
  const chooseTarget = useFallbackChooseTarget(client, chatId);
  const [refusal, setRefusal] = useState<string | null>(null);

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
      // fetched and listed destinations for a traversal the host had just told
      // us had moved on: every row a pick that could only answer
      // `traversal_advanced`.
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
  canAct,
}: {
  readonly pending: PendingFallback;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly canAct: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const chooseTarget = useFallbackChooseTarget(client, chatId);

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
        },
      );
    },
    [chatId, chooseTarget, epicId, pending.revision, pending.traversalId],
  );

  return (
    <FallbackDestinationMenu
      triggerLabel={SWITCH_INSTEAD_LABEL}
      triggerDisabled={!canAct}
      header={waitingMenuHeader(pending.deadline, pending.queuedItemsMoving)}
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
 * "Resumes at 3:00 PM unless you pick something", or `null`.
 *
 * `null` for a wait with no deadline in hand rather than a sentence with a hole
 * in it. The waiting card above already reads "Resuming shortly…" in that state,
 * so the menu adds nothing by repeating a time it does not have.
 */
function waitingMenuHeader(
  deadline: number | null,
  queuedItemsMoving: number,
): string {
  const consequences = switchConsequencesText(queuedItemsMoving);
  if (deadline === null) return consequences;
  return `Resumes at ${formatClockTime(deadline)} unless you pick something. ${consequences}`;
}
