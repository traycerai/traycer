import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
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
import {
  KEYBOARD_FOCUS_OWNER_PROPS,
  useKeyboardFocusLayoutWithin,
} from "@/hooks/ui/use-keyboard-focus-layout";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import type {
  BotSendFailure,
  BotUnsentMessage,
} from "@/hooks/bots/use-bot-send-failure";
import {
  BotQueuedNotice,
  BotSendFailedNotice,
} from "@/components/bots/bot-channel-notices";
import { useBotMentionCompletion } from "@/components/bots/bot-mention-completion";
import {
  appendQuoteMarkdown,
  type QuoteTextSnapshot,
} from "@/components/chat/quote/append-quote-to-draft";
import { cn } from "@/lib/utils";

const MESSAGE_MAX = 100_000;

const BOX_FULL = {
  name: "full",
  form: "px-4 pt-1 pb-3",
  frame: "flex flex-col",
  input: "max-h-60",
  send: "pb-1.5",
};

/** 44 tall: the field's 40, its frame's border and the form's padding. */
const BOX_ONE_ROW = {
  name: "one-row",
  form: "px-2 py-px",
  frame: "grid grid-cols-[minmax(0,1fr)_auto] items-center",
  input: "max-h-10",
  send: "",
};

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
 * The box empties the moment it sends, and takes the next message while the
 * last one is on its way; it sends one at a time. A send that fails before
 * the host takes it puts the text back in the box, and the edit it was
 * sending with it, while the box is still empty, and says so under it
 * (`failure`, which an option the person clicks reports to as well), until
 * they edit or send again. Where they began a newer draft meanwhile, the
 * draft stays and the failure line offers what failed back (Restore), until
 * they take it or send again.
 *
 * Edit on a message the bot failed to answer (`edit`) puts its text in the
 * box; what the person sends then is a new message that replaces the failed
 * one (`supersedes`), which stays where it is. A `seed` puts its text in the
 * box as a draft of a new message, unsent: the answer a member had for a
 * question someone else settled first, taken to its discussion. A box whose
 * draft is kept outside it (`keptDraft`) reports what it holds, so the draft
 * outlives the box, and so holds nothing once the box sends it; a send that
 * fails after the box is gone keeps it there again, or offers it back where
 * a newer one is.
 *
 * A send that lands is reported, and says it was queued only while the box
 * is still empty.
 *
 * A quote of a selection in the conversation (`quote`) is added after what
 * the box shows, as markdown quote lines - an edit in progress included,
 * which stays an edit - and the box takes the focus with the caret after it.
 *
 * `@` completes a member of the team's environment (decision 137); the box
 * shows their name and the send writes their token, so the bot's host knows
 * who was mentioned.
 *
 * With the keyboard up on a short viewport the box is one row, the field beside
 * Send, and a longer draft scrolls inside the field. The same elements restyle,
 * so the field keeps its focus.
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
  /** The edit's send failed: the box edits that message again, with `edit.text` as sent. */
  readonly onEditResume: (edit: BotComposerEdit) => void;
  /**
   * A draft to put in the box, unsent; each new one (by its `id`) replaces
   * what the box holds. `null` for none; a draft kept outside the box that
   * goes away empties it, unless it is editing a failed message.
   */
  readonly seed: BotComposerSeed | null;
  /** Where the box's draft is kept outside it, while it is not editing a failed message; `null` where none is. */
  readonly keptDraft: BotKeptDraft | null;
  /** A quote to add to what the box shows; `null` for none. */
  readonly quote: BotComposerQuote | null;
  /**
   * The host accepted `text`, what the box sent.
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
    onEditResume,
    seed,
    keptDraft,
    quote,
    onSent,
  } = props;
  const client = useTabHostClient();
  const send = useBotConversationSendMutation(client);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const box = useKeyboardFocusLayoutWithin(form) ? BOX_ONE_ROW : BOX_FULL;
  const mentionListId = useId();
  const mentions = useBotMentionCompletion({
    text,
    setText,
    inputRef,
    listId: mentionListId,
  });
  // A new edit replaces what the box holds with the message's text.
  const [loadedEdit, setLoadedEdit] = useState<BotComposerEdit | null>(null);
  if (edit !== loadedEdit) {
    setLoadedEdit(edit);
    if (edit !== null) {
      setText(mentions.toDisplay(edit.text));
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
    } else if (edit === null) {
      setText("");
    }
  }
  useBoxQuote({ quote, setText, inputRef });
  const emptyRef = useBoxEmptyRef(text, edit);
  // Whether the box is still there to say anything.
  const mountedRef = useRef(false);
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

  // What failed goes back in the box, as it was sent: an edit's send edits
  // that message again, and a new message's text is the box's draft.
  const putBack = (unsent: BotUnsentMessage): void => {
    if (unsent.supersedes !== null) {
      onEditResume({ requestId: unsent.supersedes, text: unsent.wire });
      return;
    }
    if (edit !== null) onEditEnd();
    setText(mentions.toDisplay(unsent.wire));
  };
  const submit = (): void => {
    if (!canSend) return;
    failure.clear();
    const unsent: BotUnsentMessage = {
      text: trimmed,
      wire: mentions.toWire(trimmed),
      supersedes: edit?.requestId ?? null,
    };
    // The box empties as the send starts, which drops the draft kept outside
    // it, and the edit it held ends: the row the host writes reaches the
    // list before the host answers.
    setText("");
    setLastDelivery(null);
    if (unsent.supersedes !== null) onEditEnd();
    // Settled through the promise, not `mutate`'s callbacks, which do not
    // run once the box is gone.
    send
      .mutateAsync({
        botId,
        conversationId,
        text: unsent.wire,
        threadId,
        announcementId,
        redeliver: null,
        supersedes: unsent.supersedes,
        answer: null,
      })
      .then(
        (response) => {
          // The send went, so it is reported whatever the box did meanwhile;
          // the delivery is said under the box only while it is still empty.
          if (!mountedRef.current) return;
          const deliverySaid = onSent(response, trimmed);
          if (!emptyRef.current) return;
          setLastDelivery(deliverySaid ? null : response.delivery);
        },
        () => {
          // Back where the draft is, while nothing newer is there: the box,
          // or the draft kept outside a box that is gone. Else offered back.
          if (mountedRef.current && emptyRef.current) {
            putBack(unsent);
            failure.fail(null);
          } else if (
            !mountedRef.current &&
            unsent.supersedes === null &&
            keptDraft !== null &&
            keptDraft.revision() === null
          ) {
            keptDraft.keep(unsent.text);
            failure.fail(null);
          } else {
            failure.fail(unsent);
          }
        },
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
      ref={setForm}
      className={cn("flex shrink-0 flex-col gap-1", box.form)}
      data-testid={testId}
      data-box-form={box.name}
      {...KEYBOARD_FOCUS_OWNER_PROPS}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div
        className={cn(
          "relative rounded-lg border border-border bg-background transition-colors focus-within:border-ring",
          box.frame,
        )}
      >
        {mentions.list}
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        {edit === null ? null : (
          <div
            className="col-span-2 flex items-center gap-2 px-3 pt-2 text-ui-xs text-muted-foreground"
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
          maxLength={MESSAGE_MAX}
          className={cn("min-h-10", box.input)}
          data-testid={`${testId}-input`}
          aria-autocomplete="list"
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
            // A failed message offered back stays offered while they type.
            if (failure.unsent === null) failure.clear();
          }}
          onKeyDown={onKeyDown}
        />
        <div
          className={cn("flex items-center justify-end gap-2 px-2", box.send)}
        >
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
        failure={failure}
        queued={lastDelivery === "queued"}
        testId={testId}
        onRestore={(unsent) => {
          failure.clear();
          putBack(unsent);
          inputRef.current?.focus();
        }}
      />
    </form>
  );
}

/**
 * The message box of a channel that cannot take a message yet (
 * a team's main bot before the team has a host): drawn as the box is,
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

/**
 * Whether the box is empty now, for a send that settles after the person may
 * have begun another draft: a newer draft is any text, or an edit loaded.
 */
function useBoxEmptyRef(
  text: string,
  edit: BotComposerEdit | null,
): RefObject<boolean> {
  const empty = text.trim().length === 0 && edit === null;
  const emptyRef = useRef(empty);
  useEffect(() => {
    emptyRef.current = empty;
  }, [empty]);
  return emptyRef;
}

/**
 * Adds each quote once, by its id, to what the box shows then, and moves the
 * focus into the box with the caret after it.
 */
function useBoxQuote(args: {
  readonly quote: BotComposerQuote | null;
  readonly setText: Dispatch<SetStateAction<string>>;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
}): void {
  const { quote, setText, inputRef } = args;
  const [takenQuoteId, setTakenQuoteId] = useState<number | null>(null);
  if (quote !== null && quote.id !== takenQuoteId) {
    setTakenQuoteId(quote.id);
    setText((current) => quote.snapshots.reduce(appendQuoteMarkdown, current));
  }
  useEffect(() => {
    if (quote === null || quote.id !== takenQuoteId) return;
    const input = inputRef.current;
    if (input !== null) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    quote.taken();
  }, [inputRef, quote, takenQuoteId]);
}

function ComposerStatus(props: {
  readonly failure: BotSendFailure;
  readonly queued: boolean;
  readonly testId: string;
  readonly onRestore: (unsent: BotUnsentMessage) => void;
}): ReactNode {
  const { failure, onRestore } = props;
  if (failure.failed) {
    const { unsent } = failure;
    return (
      <BotSendFailedNotice
        testId={`${props.testId}-send-failed`}
        restore={
          unsent === null
            ? null
            : { text: unsent.text, onRestore: () => onRestore(unsent) }
        }
      />
    );
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
};

/** Quotes of selections, for the box to add to what it shows. */
export type BotComposerQuote = {
  /** Which quote it is: the box adds each id once. */
  readonly id: number;
  /** The selections, added in order. */
  readonly snapshots: ReadonlyArray<QuoteTextSnapshot>;
  /** The box added them: the owner stops offering them. */
  readonly taken: () => void;
};

/** A failed message loaded into the box to be edited and sent again. */
export type BotComposerEdit = {
  /** The failed message's request, which the edit replaces. */
  readonly requestId: string;
  readonly text: string;
};
