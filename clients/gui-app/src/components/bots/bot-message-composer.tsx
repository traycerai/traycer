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
import { useBotMentionCompletion } from "@/components/bots/bot-mention-completion";

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
 * one (`supersedes`), which stays where it is. A `seed` puts its text in the
 * box as a draft of a new message, unsent: the answer a member had for a
 * question someone else settled first, taken to its discussion. A box whose
 * draft is kept outside it (`keptDraft`) reports what it holds, so the draft
 * outlives the box, and spends that draft once it is sent - even when the
 * send lands after the box is gone.
 *
 * A send that lands clears the box only while the box still holds the
 * draft it sent: an edit or a seed loaded since is a newer draft, and stays.
 *
 * `@` completes a member of the team's environment (decision 137); the box
 * shows their name and the send writes their token, so the bot's host knows
 * who was mentioned.
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
   * A draft to put in the box, unsent; each new one (by its `id`) replaces
   * what the box holds. `null` for none; a draft kept outside the box that
   * goes away empties it, unless it is editing a failed message.
   */
  readonly seed: BotComposerSeed | null;
  /** Where the box's draft is kept outside it, while it is not editing a failed message; `null` where none is. */
  readonly keptDraft: BotKeptDraft | null;
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
    seed,
    keptDraft,
    onSent,
  } = props;
  const client = useTabHostClient();
  const send = useBotConversationSendMutation(client);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionListId = useId();
  const mentions = useBotMentionCompletion({
    text,
    setText,
    inputRef,
    listId: mentionListId,
  });
  // Which draft the box holds: each edit or seed loaded is a new one, and a
  // send owns the one it started with.
  const [generation, setGeneration] = useState(0);
  // A new edit replaces what the box holds with the message's text.
  const [loadedEdit, setLoadedEdit] = useState<BotComposerEdit | null>(null);
  if (edit !== loadedEdit) {
    setLoadedEdit(edit);
    if (edit !== null) {
      setText(mentions.toDisplay(edit.text));
      setGeneration((current) => current + 1);
    }
  }
  // As does a new seed. A kept draft that goes away was what the box showed,
  // as the box keeps what it holds there while it edits nothing: a send of
  // it spent it, from this box closed and opened again since, so the box
  // empties rather than offer it again.
  const seedId = seed?.id ?? null;
  const [loadedSeedId, setLoadedSeedId] = useState<number | null>(null);
  if (seedId !== loadedSeedId) {
    setLoadedSeedId(seedId);
    if (seed !== null) {
      setText(seed.text);
      setGeneration((current) => current + 1);
    } else if (edit === null) {
      setText("");
    }
  }
  // The draft the box holds now, for a send that lands after the person
  // moved on to another; and whether the box is still there to say anything.
  const generationRef = useRef(generation);
  const mountedRef = useRef(false);
  useEffect(() => {
    generationRef.current = generation;
  }, [generation]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (edit !== null) inputRef.current?.focus();
  }, [edit]);
  useEffect(() => {
    if (seedId !== null) inputRef.current?.focus();
  }, [seedId]);
  useEffect(() => {
    if (edit === null) keptDraft?.keep(text);
  }, [edit, keptDraft, text]);
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
    const started = generation;
    const held = keptDraft?.revision() ?? null;
    // Settled through the promise, not `mutate`'s callbacks, which do not
    // run once the box is gone: a kept draft that was sent is spent whether
    // or not the box is still there.
    send
      .mutateAsync({
        botId,
        conversationId,
        text: mentions.toWire(trimmed),
        threadId,
        announcementId,
        redeliver: null,
        supersedes,
        answer: null,
      })
      .then(
        (response) => {
          // The box is cleared, the edit ended, the send's delivery said and
          // the send reported, only while it still holds the draft it sent:
          // an edit or a seed loaded since keeps its draft, with nothing said
          // under it.
          if (generationRef.current !== started) return;
          if (supersedes === null && held !== null) keptDraft?.spend(held);
          if (!mountedRef.current) return;
          setText("");
          if (supersedes !== null) onEditEnd();
          const deliverySaid = onSent(response, trimmed);
          setLastDelivery(deliverySaid ? null : response.delivery);
        },
        () => failure.fail(),
      );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentions.onKeyDown(event)) return;
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
      <div className="relative flex flex-col rounded-lg border border-border bg-background transition-colors focus-within:border-ring">
        {mentions.list}
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
          aria-autocomplete="list"
          aria-expanded={mentions.listOpen}
          aria-controls={mentions.listOpen ? mentionListId : undefined}
          aria-activedescendant={mentions.activeOptionId ?? undefined}
          onSelect={(event) =>
            mentions.onCaret(event.currentTarget.selectionStart)
          }
          // Every edit, as `input` reports it: one that leaves the text as
          // it was (a paste of the same text over it) reaches no `onChange`,
          // and still replaced the picks it covered.
          onInput={(event) => mentions.onInput(event.currentTarget)}
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

/**
 * The message box of a channel that cannot take a message yet (Tracy Bots
 * T67, a team's main bot before the team has a host): drawn as the box is,
 * with nothing to type into and nothing to send, and `reason` under it. No
 * message is kept for later.
 */
export function BotMessageComposerUnavailable(props: {
  readonly placeholder: string;
  /** The accessible name of the box. */
  readonly label: string;
  /** Why nothing can be sent, said under the box. */
  readonly reason: string;
  readonly testId: string;
}): ReactNode {
  const { testId } = props;
  const inputId = useId();
  const reasonId = useId();
  return (
    <div
      className="flex shrink-0 flex-col gap-1 px-4 pt-1 pb-3"
      data-testid={testId}
    >
      <div className="flex flex-col rounded-lg border border-border bg-background">
        <label htmlFor={inputId} className="sr-only">
          {props.label}
        </label>
        <Textarea
          id={inputId}
          value=""
          variant="bare"
          size="sm"
          rows={1}
          placeholder={props.placeholder}
          disabled
          readOnly
          aria-describedby={reasonId}
          className="max-h-60 min-h-10"
          data-testid={`${testId}-input`}
        />
        <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
          <Button
            type="button"
            size="icon-sm"
            disabled
            aria-label="Send"
            data-testid={`${testId}-send`}
          >
            <SendHorizontal aria-hidden="true" />
          </Button>
        </div>
      </div>
      <p
        id={reasonId}
        className="px-1 text-ui-xs text-muted-foreground"
        data-testid={`${testId}-reason`}
      >
        {props.reason}
      </p>
    </div>
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

/** A draft put in the box to be sent as a new message, once the person sends it. */
export type BotComposerSeed = {
  /** Which draft it is: the box loads each id once. */
  readonly id: number;
  readonly text: string;
};

/** Where a box's unsent draft is kept, outside the box. */
export type BotKeptDraft = {
  /** What the box holds now, as the person types it; empty keeps nothing. */
  readonly keep: (text: string) => void;
  /** Which revision of the draft is kept now; `null` while none is. */
  readonly revision: () => number | null;
  /** The draft at `revision` was sent: spent, unless a newer draft took its place. */
  readonly spend: (revision: number) => void;
};

/** A failed message loaded into the box to be edited and sent again. */
export type BotComposerEdit = {
  /** The failed message's request, which the edit replaces. */
  readonly requestId: string;
  readonly text: string;
};
