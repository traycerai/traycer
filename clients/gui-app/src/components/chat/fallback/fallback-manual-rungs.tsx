import { useCallback, useState } from "react";
import type {
  ChatRunSettings,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { Button } from "@/components/ui/button";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { formatClockTime } from "@/lib/relative-time";
import {
  SWITCH_LABEL,
  describeFallbackOutcome,
  describeWaitDisposition,
  switchConsequencesText,
} from "./fallback-copy";
import { FallbackDestinationMenu } from "./fallback-destination-menu";
import { FallbackNoticeSettingsLink } from "./fallback-notice-attribution";
import {
  toastFallbackOutcome,
  useFallbackRunManualRung,
} from "./use-fallback-actions";
import { useChatLastFailedAttempt } from "./use-last-failed-attempt";
import { usePublishConfirmedManualFallbackAction } from "./use-confirmed-manual-action";

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
 * Not this component, and deliberately. `lastFailedAttempt` is defined by the
 * HOST iff its own manual-rung guard chain would admit something - the latest
 * attempt is a terminal failure, nothing is running, no traversal holds
 * dispatch, and any terminal traversal record settled as a failure. Three of
 * those four cannot be checked in a renderer without racing, and a second copy
 * disagrees on exactly the frames that matter. So the rule here is short:
 * render what the host named, on the row the host named, and let
 * `chat.fallback.runManualRung` answer `rung_unavailable` for the rest.
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
  const publishConfirmed = usePublishConfirmedManualFallbackAction({
    epicId,
    chatId,
    hostId,
  });
  const runManualRung = useFallbackRunManualRung(
    client,
    chatId,
    publishConfirmed,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const run = useCallback(
    (rung: "retry" | "wait_once") => {
      if (attempt === undefined) return;
      runManualRung.mutate(
        {
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
        },
        {
          // TOAST, because these two are bare buttons: press Retry, the row
          // does not change, and there is nowhere on it to write "that isn't
          // available any more". The verb reports at the call site rather than
          // in the hook precisely so the menu below can choose differently -
          // see `toastFallbackOutcome`.
          onSuccess: toastFallbackOutcome,
        },
      );
    },
    [attempt, chatId, epicId, runManualRung],
  );

  const onMenuOpenChange = useCallback((next: boolean) => {
    setMenuOpen(next);
    setRefusal(null);
  }, []);

  const onPickTarget = useCallback(
    (target: ChatRunSettings) => {
      if (attempt === undefined) return;
      runManualRung.mutate(
        {
          epicId,
          chatId,
          rung: "switch",
          target,
          // BOTH ids, and from the DTO rather than from anything this row could
          // reconstruct: the reuse path re-sends the same persisted user message
          // across retries, so `userMessageId` alone cannot tell an attempt from
          // its retry and a successful replay would look like this one.
          userMessageId: attempt.userMessageId,
          turnId: attempt.turnId,
        },
        {
          // INLINE and deliberately NOT a toast, unlike the two rungs above.
          // The menu is still open and is the surface the click came from, so
          // it is the honest place to answer - and a toast beside it would
          // report one refusal twice.
          onSuccess: (response) => {
            const message = describeFallbackOutcome(response.outcome);
            if (message === null) {
              setMenuOpen(false);
              return;
            }
            // `rung_unavailable` is the one that actually lands here, and it is
            // a NORMAL outcome: `eligibleRungs` was an upper bound computed at
            // frame time and already stale when this click arrived.
            setRefusal(message);
          },
        },
      );
    },
    [attempt, chatId, epicId, runManualRung],
  );

  if (attempt === undefined) return null;
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

  const rungs = attempt.eligibleRungs;
  const waitUntil = waitUntilLabel(attempt);
  const busy = runManualRung.isPending;
  // Why there is no wait button, in the host's own terms. Never inferred from
  // the failure payload: `resetsAt` is PRESENT for a boundary past the user's
  // cap and ABSENT for one nobody verified, so the two states a user can act
  // on were indistinguishable from here, and the state where a wait is
  // impossible looked like the state where it is merely far away.
  const waitExplanation = describeWaitDisposition(
    attempt.waitDisposition,
    attempt.failure.resetsAt === undefined
      ? null
      : formatClockTime(attempt.failure.resetsAt),
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {rungs.includes("retry") ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            run("retry");
          }}
        >
          Retry
        </Button>
      ) : null}
      {rungs.includes("switch") ? (
        <FallbackDestinationMenu
          triggerLabel={SWITCH_LABEL}
          triggerDisabled={busy}
          // `null` for the count, and that is the honest answer rather than a
          // gap: this card acts on a failed ATTEMPT, and `lastFailedAttempt`
          // carries no queue figure - the traversal that would have counted
          // one is over. The copy says the queue moves without naming a
          // number it does not have.
          header={switchConsequencesText(null)}
          // The ATTEMPT selector, not a traversal one. This card renders where
          // there is no dispatch-holding traversal to name - a terminal failure,
          // an exhausted ladder, a `completed_awaiting_return` left over from an
          // earlier success - which is the whole reason `runManualRung` is bound
          // to the failed attempt instead.
          selector={{
            kind: "attempt",
            userMessageId: attempt.userMessageId,
            turnId: attempt.turnId,
          }}
          epicId={epicId}
          chatId={chatId}
          client={client}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          onPick={onPickTarget}
          picking={runManualRung.isPending}
          // No hold to take: there is no countdown here to freeze.
          preparing={false}
          refusal={refusal}
          // The one entry point that HAS the rungs to repeat, so it does. The
          // two card menus pass `null` because their equivalents are already on
          // the card the popover is anchored to.
          emptyStateActions={
            <div className="flex w-full flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {rungs.includes("retry") ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      run("retry");
                    }}
                  >
                    Retry
                  </Button>
                ) : null}
                {waitUntil === null ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      run("wait_once");
                    }}
                  >
                    {waitUntil}
                  </Button>
                )}
              </div>
              {/*
               * The SAME disposition the card renders, repeated here because
               * this is where its absence is confusing. The empty menu offers
               * Retry and (sometimes) a wait button; when the wait button is
               * missing, the reader is looking at the one surface that could
               * explain why and previously said nothing - the sentence lived
               * only on the card BEHIND the popover. F6 promised both halves
               * and shipped one.
               *
               * Same string, one source (`describeWaitDisposition`), so the
               * two surfaces cannot drift into two explanations of one fact.
               */}
              {waitExplanation === null ? null : (
                <div className="text-ui-xs text-muted-foreground">
                  {waitExplanation}
                </div>
              )}
            </div>
          }
        />
      ) : null}
      {waitUntil === null ? null : (
        <Button
          size="sm"
          variant="secondary"
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
       */}
      <FallbackNoticeSettingsLink />
      {waitExplanation === null ? null : (
        // Full-width below the buttons rather than inline beside them: it is a
        // sentence, not a control, and `beyond_cap`'s version names a time the
        // Settings link next to it is the remedy for.
        <div className="w-full text-ui-xs text-muted-foreground">
          {waitExplanation}
        </div>
      )}
    </div>
  );
}

/**
 * "Wait until 3:00 PM", or `null`.
 *
 * Two gates, and they are not redundant. `wait_once` in `eligibleRungs` is the
 * HOST's answer - it is present iff the failure carries a verified boundary
 * within the policy cap. The `resetsAt` check that follows is not a second
 * eligibility rule; it is this component refusing to name a time it does not
 * have, since the field is optional on the failure payload and a button reading
 * "Wait until undefined" is worse than no button.
 */
function waitUntilLabel(attempt: LastFailedAttempt): string | null {
  if (!attempt.eligibleRungs.includes("wait_once")) return null;
  const resetsAt = attempt.failure.resetsAt;
  if (resetsAt === undefined) return null;
  return `Wait until ${formatClockTime(resetsAt)}`;
}
