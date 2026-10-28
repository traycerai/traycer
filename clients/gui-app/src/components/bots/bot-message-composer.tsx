import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { SendHorizontal } from "lucide-react";
import type {
  BotConversationSendDelivery,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import {
  BotQueuedNotice,
  BotSendFailedNotice,
} from "@/components/bots/bot-channel-notices";

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
 *
 * Edit on a message the bot failed to answer (`edit`) puts its text in the
 * box; what the person sends then is a new message that replaces the failed
 * one (`supersedes`), which stays where it is.
 */
export function BotMessageComposer(props: {
  readonly botId: string;
  readonly conversationId: string;
  /** The thread the reply goes into; `null` posts at the channel's top level. */
  readonly threadId: string | null;
  /** The question or proposal the reply answers, opening its thread; `null` otherwise. */
  readonly announcementId: string | null;
  /**
   * Whether the box may send: `false` while what it holds would go where the
   * bot's host takes nothing now, the draft kept until it does.
   */
  readonly sendable: boolean;
  /** "Message name" on a channel, "Reply…" in a thread, as Slack labels them. */
  readonly placeholder: string;
  /** The accessible name of the box. */
  readonly label: string;
  readonly testId: string;
  readonly failure: BotSendFailure;
  /** The failed message being edited; `null` for a plain send. */
  readonly edit: BotComposerEdit | null;
  /** The edit was sent or cancelled. */
  readonly onEditEnd: () => void;
  /**
   * The host accepted `text`, what the box held, and the box was cleared.
   * Answers whether the owner says the send's delivery itself, where the
   * person now looks; the box says it only when it does not.
   */
  readonly onSent: (
    response: BotConversationSendResponse,
    text: string,
  ) => boolean;
}): ReactNode {
  const {
    botId,
    conversationId,
    threadId,
    announcementId,
    sendable,
    placeholder,
    label,
    testId,
    failure,
    edit,
    onEditEnd,
    onSent,
  } = props;
  const client = useTabHostClient();
  const send = useBotConversationSendMutation(client);
  const [text, setText] = useState("");
  // A new edit replaces what the box holds with the message's text.
  const [loadedEdit, setLoadedEdit] = useState<BotComposerEdit | null>(null);
  if (edit !== loadedEdit) {
    setLoadedEdit(edit);
    if (edit !== null) setText(edit.text);
  }
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The edit the box holds now, for a send that lands after the person moved
  // on to another.
  const currentEditRef = useRef<BotComposerEdit | null>(edit);
  useEffect(() => {
    currentEditRef.current = edit;
    if (edit !== null) inputRef.current?.focus();
  }, [edit]);
  const [lastDelivery, setLastDelivery] =
    useState<BotConversationSendDelivery | null>(null);
  const inputId = useId();
  const trimmed = text.trim();
  const canSend =
    sendable &&
    trimmed.length > 0 &&
    trimmed.length <= MESSAGE_MAX &&
    !send.isPending;

  const submit = (): void => {
    if (!canSend) return;
    failure.clear();
    const supersedes = edit?.requestId ?? null;
    send.mutate(
      {
        botId,
        conversationId,
        text: trimmed,
        threadId,
        announcementId,
        redeliver: null,
        supersedes,
      },
      {
        onSuccess: (response) => {
          // The box is cleared, the edit ended, the send's delivery said and
          // the send reported, only while it still holds what was sent: an
          // edit the person opened since keeps its draft, with nothing said
          // under it.
          if ((currentEditRef.current?.requestId ?? null) !== supersedes) {
            return;
          }
          setText("");
          if (supersedes !== null) onEditEnd();
          const deliverySaid = onSent(response, trimmed);
          setLastDelivery(deliverySaid ? null : response.delivery);
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
        {edit === null ? null : (
          <div
            className="flex items-center gap-2 px-3 pt-2 text-ui-xs text-muted-foreground"
            data-testid={`${testId}-editing`}
          >
            <span className="min-w-0 flex-1">
              Sending replaces your message that failed.
            </span>
            <Button
              type="button"
              variant="link"
              size="xs"
              data-testid={`${testId}-edit-cancel`}
              onClick={() => {
                setText("");
                onEditEnd();
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        <Textarea
          ref={inputRef}
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
  return <BotQueuedNotice testId={`${props.testId}-queued`} />;
}

/** A failed message loaded into the box to be edited and sent again. */
export type BotComposerEdit = {
  /** The failed message's request, which the edit replaces. */
  readonly requestId: string;
  readonly text: string;
};
