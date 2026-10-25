import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { SendHorizontal } from "lucide-react";
import type { BotConversationSendDelivery } from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { BotSendFailedNotice } from "@/components/bots/bot-channel-notices";

const MESSAGE_MAX = 100_000;

/**
 * Slack's message box, for a bot's channel and its threads (Tracy Bots): a
 * post at the channel's top level (`threadId: null`), a reply in a thread,
 * or a reply under an announcement or direct post (`announcementId`), which
 * opens the thread hung off it. Enter sends, Shift+Enter breaks the line.
 *
 * A send is a request to the bot, not a turn: there is no model to choose,
 * nothing to approve and nothing to attach, and the bot may be paused - the
 * host then accepts the message as `queued` and the bot reads it once it can
 * be reached. The box says so, once, for the send that was queued.
 *
 * A send that fails before the host takes it leaves the text in the box and
 * says so above it (`failure`, which an option the person clicks reports to
 * as well), until they edit or send again.
 */
export function BotMessageComposer(props: {
  readonly botId: string;
  readonly conversationId: string;
  /** The thread the reply goes into; `null` posts at the channel's top level. */
  readonly threadId: string | null;
  /** The question or proposal the reply answers, opening its thread; `null` otherwise. */
  readonly announcementId: string | null;
  /** "Message #name" on a channel, "Reply…" in a thread, as Slack labels them. */
  readonly placeholder: string;
  /** The accessible name of the box. */
  readonly label: string;
  readonly testId: string;
  readonly failure: BotSendFailure;
}): ReactNode {
  const {
    botId,
    conversationId,
    threadId,
    announcementId,
    placeholder,
    label,
    testId,
    failure,
  } = props;
  const client = useTabHostClient();
  const send = useBotConversationSendMutation(client);
  const [text, setText] = useState("");
  const [lastDelivery, setLastDelivery] =
    useState<BotConversationSendDelivery | null>(null);
  const inputId = useId();
  const trimmed = text.trim();
  const canSend =
    trimmed.length > 0 && trimmed.length <= MESSAGE_MAX && !send.isPending;

  const submit = (): void => {
    if (!canSend) return;
    failure.clear();
    send.mutate(
      { botId, conversationId, text: trimmed, threadId, announcementId },
      {
        onSuccess: (response) => {
          setText("");
          setLastDelivery(response.delivery);
        },
        onError: failure.fail,
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-1 px-4 pt-1 pb-3"
      data-testid={testId}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col rounded-lg border border-border bg-background transition-colors focus-within:border-ring">
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <Textarea
          id={inputId}
          value={text}
          variant="bare"
          size="sm"
          rows={1}
          placeholder={placeholder}
          disabled={send.isPending}
          maxLength={MESSAGE_MAX}
          className="max-h-60 min-h-10"
          data-testid={`${testId}-input`}
          onChange={(event) => {
            setText(event.target.value);
            if (lastDelivery !== null) setLastDelivery(null);
            failure.clear();
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
          <Button
            type="submit"
            size="icon-sm"
            disabled={!canSend}
            aria-label="Send"
            data-testid={`${testId}-send`}
          >
            {send.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : (
              <SendHorizontal aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      <ComposerStatus
        failed={failure.failed}
        queued={lastDelivery === "queued"}
        testId={testId}
      />
    </form>
  );
}

function ComposerStatus(props: {
  readonly failed: boolean;
  readonly queued: boolean;
  readonly testId: string;
}): ReactNode {
  if (props.failed) {
    return <BotSendFailedNotice testId={`${props.testId}-send-failed`} />;
  }
  if (!props.queued) return null;
  return (
    <p
      role="status"
      className="text-ui-xs text-muted-foreground"
      data-testid={`${props.testId}-queued`}
    >
      Saved. The bot will read it.
    </p>
  );
}
