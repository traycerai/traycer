import { useCallback, type ReactNode } from "react";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { sandboxRefusalCopyFor } from "@/components/chat/segments/sandbox-refusal-copy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * A send that never reached the conversation: the message is still the
 * person's, back in the box, and sending again is a plain send.
 */
export function BotSendFailedNotice(props: {
  readonly testId: string;
}): ReactNode {
  return (
    <p
      role="alert"
      data-testid={props.testId}
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive"
    >
      Couldn't send. Edit and try again.
    </p>
  );
}

/**
 * The bot's answer to a message the conversation already holds failed or is
 * held, said under the last row: what went wrong, in the words the agent
 * chat's error row uses for it, the sign-in that fixes it when that is the
 * fix, and the way to the session's transcript. Drawn only while the
 * session answering it is parked (a delivery it could not start) or failed,
 * read from its state alone; the typing line is drawn only while it
 * replies, so the two never show together. The message itself offers Retry
 * and Edit.
 */
export function BotUnansweredNotice(props: {
  readonly botTitle: string;
  /** The host the bot's tab is bound to, the one whose session failed. */
  readonly hostId: string;
  readonly activity: BotSessionActivity | null;
  /** Opens the transcript of the session that failed; `null` where there is none to open. */
  readonly onOpenUnderTheHood: (() => void) | null;
  readonly testId: string;
}): ReactNode {
  const { activity, onOpenUnderTheHood } = props;
  if (
    activity === null ||
    (activity.state !== "parked" && activity.state !== "failed")
  ) {
    return null;
  }
  const reason = activity.reason;
  // A sandbox's refusal in the words the error row gives it, from the same
  // code and text.
  const summary =
    reason === null
      ? null
      : (sandboxRefusalCopyFor(reason.code, reason.summary)?.description ??
        reason.summary);
  // Held is degraded, failed is an error; they read the same way.
  return (
    <div
      role="status"
      data-testid={props.testId}
      data-state={activity.state}
      className={cn(
        "mx-5 mt-1 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-ui-xs",
        activity.state === "parked"
          ? "border-warning/30 bg-warning/10 text-warning-foreground"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <p className="whitespace-pre-wrap break-words">
        {summary === null
          ? `${props.botTitle} couldn't answer.`
          : `${props.botTitle} couldn't answer: ${summary}`}
      </p>
      {reason?.action !== "sign-in" && onOpenUnderTheHood === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {reason?.action === "sign-in" ? (
            <SignInAction harnessId={reason.harnessId} hostId={props.hostId} />
          ) : null}
          {onOpenUnderTheHood === null ? null : (
            <Button
              type="button"
              variant="link"
              size="xs"
              data-testid={`${props.testId}-under-the-hood`}
              onClick={onOpenUnderTheHood}
            >
              Under the hood
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Settings ▸ Providers on the bot's host, at the harness that signed the
 * person out, where the agent chat sends them for the same error; the
 * section root when the harness is not one this client knows.
 */
function SignInAction(props: {
  readonly harnessId: string;
  readonly hostId: string;
}): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  const { harnessId, hostId } = props;
  const onClick = useCallback(() => {
    const harness = guiHarnessIdSchema.safeParse(harnessId);
    const focus = useProvidersFocusStore.getState();
    if (harness.success) {
      focus.setHostHarnessFocus({ harnessId: harness.data, hostId });
    } else {
      // No earlier action's focus may move Providers off this host.
      focus.clearFocusHarnessId();
    }
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId,
    });
  }, [openSettings, harnessId, hostId]);
  return (
    <Button
      type="button"
      size="xs"
      variant="secondary"
      data-testid="bot-unanswered-sign-in"
      onClick={onClick}
    >
      Sign in
    </Button>
  );
}
