import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftDecisionState,
  useChatFeedbackDraftSupported,
  useRetireFeedbackDraftDecision,
} from "@/hooks/chats/use-chat-feedback-draft";
import { newFeedbackDraftClientActionId } from "@/lib/chats/feedback-draft-client-action-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * Send for a feedback draft, on its notification row. It sends the draft as
 * written and never attaches diagnostic data: the row shows neither the
 * draft's text nor the diagnostics box, so the logs go only from the draft's
 * card in the chat, where both can be read first.
 *
 * `resolved` is the row's own state (the draft was sent or skipped, here or
 * on its card): Send is then withdrawn. The row's resolve can trail the
 * decision, so a decision made in this window - here or on the card - counts
 * as soon as it is answered: sent or skipped withdraws Send, failed keeps it
 * with the reason. A host that cannot send draws nothing, and the row still
 * opens the draft's card.
 */
export function FeedbackDraftSendControl(props: {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
  readonly resolved: boolean;
}): ReactNode {
  const supported = useChatFeedbackDraftSupported(props.hostId);
  const client = useHostClientForHostId(props.hostId);
  const draft = {
    hostId: props.hostId,
    epicId: props.epicId,
    chatId: props.chatId,
    blockId: props.blockId,
  };
  const decide = useChatFeedbackDraftDecideMutation(client, draft);
  const decision = useChatFeedbackDraftDecisionState(client, draft);
  useRetireFeedbackDraftDecision(client, draft, props.resolved);
  const settled = decision.settled;
  if (settled !== null && settled.state === "sent") {
    return (
      <p
        data-testid="notification-feedback-draft-sent"
        className="text-ui-xs text-muted-foreground"
      >
        Sent to the Traycer team.
      </p>
    );
  }
  if (
    props.resolved ||
    supported === false ||
    (settled !== null && settled.state === "skipped")
  ) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 text-ui-xs">
      {settled !== null && settled.state === "failed" ? (
        <p
          data-testid="notification-feedback-draft-failed"
          className="text-destructive"
        >
          Not sent
          {settled.failureReason === null ? "" : `: ${settled.failureReason}`}.
          You can try again.
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={decision.isPending || client === null}
        data-testid="notification-feedback-draft-send"
        onClick={() => {
          decide.mutate({
            epicId: props.epicId,
            chatId: props.chatId,
            blockId: props.blockId,
            decision: "send",
            includeDiagnostics: false,
            clientActionId: newFeedbackDraftClientActionId(),
          });
        }}
      >
        Send
        {decision.isPending ? (
          <AgentSpinningDots
            className="size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}
