import { use, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { QueuedMessageStagesContext } from "@/components/chat/queued-message-stages";

/** One sentence for both the disabled Send's tooltip and the line beside it. */
export const CHAT_STREAM_RECONNECTING_COPY =
  "Reconnecting to the host — sending is paused";

/**
 * This chat's own delivery state, said beside the composer for as long as it
 * holds.
 *
 * Two facts, and never both. While the chat's stream is not open, sending is
 * paused and the line says so - the same sentence the disabled Send button
 * carries in its tooltip, which a person only finds by hovering a control that
 * has stopped working. While the stream IS open and a send has gone unanswered
 * past the display deadline, it says delivery is not confirmed and offers the
 * check. That second line is not a failure: the send keeps its ids and its
 * content, nothing is sent again, and it clears the moment the host answers.
 */
export function ChatComposerDeliveryStatus(): ReactNode {
  const stages = use(QueuedMessageStagesContext);
  if (stages.streamReconnecting) {
    return (
      <div
        role="status"
        data-testid="chat-composer-reconnecting"
        className="mb-2 flex items-center gap-2 rounded-md border border-canvas-border/70 bg-canvas px-3 py-2 text-ui-sm text-muted-foreground"
      >
        <AgentSpinningDots
          className={undefined}
          testId="chat-composer-reconnecting-spinner"
          variant={undefined}
        />
        <span className="min-w-0 flex-1">{CHAT_STREAM_RECONNECTING_COPY}</span>
      </div>
    );
  }
  if (stages.unconfirmedSendActionIds.size === 0) return null;
  return (
    <div
      role="status"
      data-testid="chat-composer-delivery-unconfirmed"
      className="mb-2 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
    >
      <span className="min-w-0 flex-1">
        Delivery not confirmed. The host has not acknowledged your message yet,
        and nothing was sent again.
      </span>
      {stages.onCheckDelivery === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={stages.onCheckDelivery}
        >
          Check delivery
        </Button>
      )}
    </div>
  );
}
