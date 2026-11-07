import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { SendHorizontal } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  BOT_CONVERSATION_IMAGES_ONLY_TEXT,
  type BotConversationAttachment,
  type BotConversationSendDelivery,
  type BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  KEYBOARD_FOCUS_OWNER_PROPS,
  useKeyboardFocusLayoutWithin,
} from "@/hooks/ui/use-keyboard-focus-layout";
import {
  pastedImagesVerdict,
  useBotBoxImageIngest,
} from "@/hooks/bots/use-bot-box-images";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import type { BotImageReach } from "@/hooks/bots/use-bot-send-version";
import { isAttachmentIngestPending } from "@/hooks/composer/use-composer-paste";
import type { BotUnsentMessage } from "@/stores/bots/bot-drafts-store";
import {
  BotQueuedNotice,
  BotSendFailedNotice,
} from "@/components/bots/bot-channel-notices";
import { useBotMentionCompletion } from "@/components/bots/bot-mention-completion";
import {
  ComposerCallButton,
  ComposerCallCaptions,
  ComposerCallSwap,
} from "@/components/layout/voice/composer-call";
import { useComposerCall } from "@/components/layout/voice/use-composer-call";
import { ChatComposerAttachmentsStrip } from "@/components/chat/composer/chat-composer-attachments-strip";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import type { PastedComposerImage } from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import { ComposerDropOverlay } from "@/components/home/composer/composer-shell";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import {
  appendBlocks,
  buildQuoteBlockquote,
  type QuoteTextSnapshot,
} from "@/components/chat/quote/append-quote-to-draft";
import {
  botBoxAttachments,
  botBoxText,
  botBoxWire,
  EMPTY_BOT_BOX,
} from "@/lib/bots/bot-box-content";
import {
  collectImageAtoms,
  type ComposerImageAtom,
} from "@/lib/composer/image-atoms";
import { cn } from "@/lib/utils";

const MESSAGE_MAX = 100_000;

function sameImageAtoms(
  left: ReadonlyArray<ComposerImageAtom>,
  right: ReadonlyArray<ComposerImageAtom>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (atom, index) =>
        atom.b64content === right[index]?.b64content &&
        atom.fileName === right[index]?.fileName &&
        atom.mimeType === right[index]?.mimeType,
    )
  );
}

function useCachedBotBoxAttachments(
  content: JsonContent,
  atoms: ReadonlyArray<ComposerImageAtom>,
  imageReach: BotImageReach,
): ReadonlyArray<BotConversationAttachment> {
  const [cache, setCache] = useState<{
    atoms: ReadonlyArray<ComposerImageAtom>;
    attachments: ReadonlyArray<BotConversationAttachment>;
  }>({ atoms: [], attachments: [] });
  if (imageReach !== "delivered") return [];
  if (sameImageAtoms(cache.atoms, atoms)) return cache.attachments;
  const attachments = botBoxAttachments(content);
  setCache({ atoms, attachments });
  return attachments;
}

function noop(): void {}

/** An image pasted by hash has no bytes the box can send: only an inline one lands. */
function NO_PASTED_IMAGE_BYTES(): boolean {
  return false;
}

const BOX_FULL = {
  name: "full",
  form: "px-4 pt-1 pb-3",
  frame: "flex flex-col",
  input: "max-h-60",
  send: "pb-1.5",
};

/** The field and actions share one row while the keyboard is open. */
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
 * A send is a request to the bot, not a turn: there is no model to choose
 * and nothing to approve, and the bot may be paused - the host then accepts
 * the message as `queued` and the bot reads it once it can be reached. The box
 * says so, once, for the send that was queued.
 *
 * The box is the agent composer's editor, with neither its slash commands nor
 * its picker's sources: `@` lists what the bot's environment can name, and each
 * name is a chip that the send writes as its token. Images dropped on the box
 * or pasted into it sit in a strip above it, and go back with the rest of the
 * editor's document wherever a failed send does. The host serving the tab has
 * to take them: one below `bot.conversation.send@1.4` is
 * offered none. A bot whose host has not said it takes them keeps them in the
 * strip and says so: Send carries the text alone (`BotImageReach`).
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
 * outlives the box, and so holds nothing once the box sends it. A send that
 * fails after the box is gone keeps it there again; one that fails over a
 * newer draft, whether or not the box is still there, is offered back from
 * there beside it, so the offer outlives the box too.
 *
 * A send that lands is reported while the box is still there, and says it
 * was queued only while the box is still empty; one that lands after the box
 * is gone is not reported, so nothing opens for a box the person has left.
 *
 * A quote of a selection in the conversation (`quote`) is added after what
 * the box shows, as markdown quote lines - an edit in progress included,
 * which stays an edit - and the box takes the focus with the caret after it.
 *
 * `@` completes a member of the team's environment (decision 137), or a bot
 * or a task of the bot's environment (decision 177); the box shows the name
 * and the send writes its token, so the bot's host knows what was named.
 *
 * With the keyboard up on a short viewport the box is one row, the field beside
 * Send, and a longer draft scrolls inside the field. The same elements restyle,
 * so the field keeps its focus.
 *
 * Call sits beside Send on the channel's box and an opened thread's (Call
 * Tracy): a call from the channel opens a new thread with the first thing
 * said, one from a thread continues it. While the call placed from this box
 * runs, the box swaps its field for the call bar, with the captions above
 * it; the draft is kept and comes back with the field. The composer
 * microphone's chord starts and ends that call.
 */
export function BotMessageComposer(props: {
  readonly botId: string;
  /** The bot's name, as Call says it. */
  readonly botTitle: string;
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
  /** What the box does with images. */
  readonly imageReach: BotImageReach;
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
   * The host accepted `text`, what the box sent; not called once the box
   * is gone. Answers whether the owner says the send's delivery itself, where the
   * person now looks; the box says it only when it does not.
   */
  readonly onSent: (
    response: BotConversationSendResponse,
    text: string,
    content: JsonContent,
  ) => boolean;
}): ReactNode {
  const {
    botId,
    botTitle,
    conversationId,
    threadId,
    announcementId,
    sendable,
    imageReach,
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
  const call = useComposerCall(botId, threadId, announcementId);
  const send = useBotConversationSendMutation(client);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [focused, setFocused] = useState(false);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const box = useKeyboardFocusLayoutWithin(form) ? BOX_ONE_ROW : BOX_FULL;
  const frameRef = useRef<HTMLDivElement>(null);
  const mentions = useBotMentionCompletion({
    replyRow: box === BOX_ONE_ROW ? frameRef : null,
  });
  const { content, setContent, loadBox, onEditorReady, takenQuoteId } =
    useBotBoxDocument(editorRef, {
      edit,
      seed,
      quote,
      contentOf: mentions.contentOf,
    });
  const text = useMemo(() => botBoxText(content), [content]);
  const wire = useMemo(() => botBoxWire(content), [content]);
  const imageAtoms = useMemo(() => collectImageAtoms(content), [content]);
  const imageCount = imageAtoms.length;
  const takesImages = imageReach !== "none";
  const paste = useBotBoxImageIngest(editorRef);
  useEffect(() => {
    if (edit !== null) editorRef.current?.focusAtEnd("reveal-caret");
  }, [edit]);
  const seedId = seed?.id ?? null;
  useEffect(() => {
    if (seedId !== null) editorRef.current?.focusAtEnd("reveal-caret");
  }, [seedId]);
  useEffect(() => {
    if (quote === null || quote.id !== takenQuoteId) return;
    editorRef.current?.focusAtEnd("reveal-caret");
    quote.taken();
  }, [quote, takenQuoteId]);
  const emptyRef = useBoxEmptyRef(text, imageCount, edit);
  // Whether the box is still there to say anything.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (edit !== null) return;
    keptDraft?.keep(
      text,
      text.length === 0 && imageCount === 0 ? null : content,
    );
  }, [content, edit, imageCount, keptDraft, text]);
  const [lastDelivery, setLastDelivery] =
    useState<BotConversationSendDelivery | null>(null);
  // What goes with the text: a bot's host that takes no image gets none.
  // The editor emits a fresh document for every keystroke. The image atoms
  // usually have the same bytes, so keep their decoded wire metadata until an
  // image actually changes.
  const carried = useCachedBotBoxAttachments(content, imageAtoms, imageReach);
  const canSend = canSendBotBox({
    sendable,
    wireLength: wire.length,
    attachmentCount: carried.length,
    ingestPending: takesImages && isAttachmentIngestPending(paste),
    sendPending: send.isPending,
  });

  // What failed goes back in the box, as it was sent: an edit's send edits
  // that message again, and a new message's text is the box's draft.
  const putBack = (unsent: BotUnsentMessage): void => {
    if (unsent.supersedes !== null) {
      // The owner may immediately retire this edit if its request resumed
      // while the failed send was offered back. Restore the draft either way.
      loadBox(unsent.content);
      onEditResume({
        requestId: unsent.supersedes,
        text: unsent.wire,
        content: unsent.content,
        sessionThreadId: unsent.sessionThreadId,
      });
      return;
    }
    if (edit !== null) onEditEnd();
    loadBox(unsent.content);
  };
  const submit = (): void => {
    if (!canSend) return;
    failure.clear();
    keptDraft?.offer(null);
    const unsent: BotUnsentMessage = {
      text,
      wire,
      supersedes: edit?.requestId ?? null,
      content,
      sessionThreadId: edit?.sessionThreadId,
    };
    // The box empties as the send starts, which drops the draft kept outside
    // it, and the edit it held ends: the row the host writes reaches the
    // list before the host answers.
    loadBox(EMPTY_BOT_BOX);
    setLastDelivery(null);
    if (unsent.supersedes !== null) onEditEnd();
    // Settled through the promise, not `mutate`'s callbacks, which do not
    // run once the box is gone.
    send
      .mutateAsync({
        botId,
        conversationId,
        text: wire.length === 0 ? BOT_CONVERSATION_IMAGES_ONLY_TEXT : wire,
        threadId,
        announcementId,
        redeliver: null,
        supersedes: unsent.supersedes,
        answer: null,
        ...(carried.length === 0 ? {} : { attachments: [...carried] }),
      })
      .then(
        (response) => {
          // The send went, so it is reported whatever the box did meanwhile,
          // unless the box is gone; the delivery is said under the box only
          // while it is still empty.
          if (!mountedRef.current) return;
          const deliverySaid = onSent(response, text, unsent.content);
          if (!emptyRef.current) return;
          setLastDelivery(deliverySaid ? null : response.delivery);
        },
        () => {
          // Back where the draft is, while nothing newer is there: the box,
          // or the draft kept outside a box that is gone. Else offered back,
          // beside the draft kept outside the box where there is one. A box
          // that is gone leaves its owner's failure alone where its draft is
          // kept outside it: the owner may show another conversation's box
          // now, and the kept draft says it for this one.
          if (mountedRef.current && emptyRef.current) {
            putBack(unsent);
            failure.fail(null);
          } else if (keptDraft === null) {
            failure.fail(unsent);
          } else if (mountedRef.current) {
            keptDraft.offer(unsent);
            failure.fail(null);
          } else if (unsent.supersedes === null && !keptDraft.hasDraft()) {
            keptDraft.keep(unsent.text, unsent.content);
          } else {
            keptDraft.offer(unsent);
          }
        },
      );
  };
  // The box's drop target, for a host that takes images.
  const dropTarget = takesImages
    ? {
        onDragEnter: paste.onDragEnter,
        onDragLeave: paste.onDragLeave,
        onDragOver: paste.onDragOver,
        onDrop: paste.onDrop,
      }
    : undefined;
  const dropping = takesImages ? paste.dragOverlayVariant : null;
  const ingestPasted = useCallback(
    (images: ReadonlyArray<PastedComposerImage>) =>
      pastedImagesVerdict({
        takesImages,
        editor: editorRef.current,
        images,
      }),
    [takesImages],
  );
  const inputGroupRef = useRef<HTMLDivElement>(null);
  const { inputAria } = mentions;
  useEffect(() => {
    const input = inputGroupRef.current?.querySelector(
      "[data-composer-editor]",
    );
    if (input === null || input === undefined) return;
    for (const name of [
      "aria-autocomplete",
      "aria-controls",
      "aria-activedescendant",
    ] as const) {
      const value = inputAria[name];
      if (value === undefined) input.removeAttribute(name);
      else input.setAttribute(name, value);
    }
  });

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
      <ComposerCallCaptions shown={call.barShown} testId={testId} />
      <div
        ref={frameRef}
        className={cn(
          "relative rounded-lg border border-border bg-background transition-colors focus-within:border-ring",
          box.frame,
        )}
        {...dropTarget}
      >
        {dropping === null ? null : (
          <ComposerDropOverlay {...FILE_DROP_OVERLAY_CONTENT[dropping]} />
        )}
        <ComposerCallSwap shown={call.barShown} testId={testId}>
          {mentions.menu}
          {takesImages && imageCount > 0 ? (
            <div
              className="col-span-2 flex flex-col gap-1 px-3 pt-2"
              data-testid={`${testId}-images`}
            >
              <ChatComposerAttachmentsStrip
                taskId={null}
                content={content}
                editingQueueItemId={null}
                onCancelQueueEdit={null}
                onRemoveImage={(id) =>
                  editorRef.current?.removeImageAttachmentById(id)
                }
              />
              {imageReach === "delivered" ? null : (
                <p
                  className="text-ui-xs text-muted-foreground"
                  data-testid={`${testId}-images-not-delivered`}
                >
                  This bot&apos;s host can&apos;t take images yet, so only your
                  text will be sent.
                </p>
              )}
            </div>
          ) : null}
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
                  loadBox(EMPTY_BOT_BOX);
                  onEditEnd();
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          <div
            ref={inputGroupRef}
            role="group"
            aria-label={label}
            className="min-w-0"
            data-testid={`${testId}-input`}
          >
            <ComposerPromptEditor
              ref={editorRef}
              pickerStore={mentions.pickerStore}
              initialContent={content}
              initialSelection={null}
              placeholder={placeholder}
              editorClassName={cn("min-h-10 px-3 py-2", box.input)}
              stabilizeImageAttachmentCaret
              isActive={focused}
              disabled={false}
              slashProviderId={null}
              preserveMessagePaste
              hasPastedImageBytes={NO_PASTED_IMAGE_BYTES}
              ingestPastedComposerImages={ingestPasted}
              onDocumentChange={(next) => {
                setContent(next);
                if (lastDelivery !== null) setLastDelivery(null);
                // A failed message offered back stays offered while they type.
                if (failure.unsent === null) failure.clear();
              }}
              onSelectionChange={noop}
              onSubmit={submit}
              onPaste={takesImages ? paste.onPaste : noop}
              onDragOver={noop}
              onDrop={noop}
              onKeyDown={undefined}
              interceptKeyDown={null}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onEditorReady={onEditorReady}
            />
          </div>
          <div
            className={cn("flex items-center justify-end gap-2 px-2", box.send)}
          >
            <ComposerCallButton
              target={call.target}
              botTitle={botTitle}
              testId={testId}
            />
            <Button
              type="submit"
              size="icon-sm-touch"
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
        </ComposerCallSwap>
      </div>
      <ComposerStatus
        failure={failure}
        keptDraft={keptDraft}
        queued={lastDelivery === "queued"}
        testId={testId}
        onRestore={(unsent) => {
          failure.clear();
          keptDraft?.offer(null);
          putBack(unsent);
          editorRef.current?.focusAtEnd("reveal-caret");
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
            size="icon-sm-touch"
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

function canSendBotBox(args: {
  readonly sendable: boolean;
  readonly wireLength: number;
  readonly attachmentCount: number;
  readonly ingestPending: boolean;
  readonly sendPending: boolean;
}): boolean {
  return (
    args.sendable &&
    (args.wireLength > 0 || args.attachmentCount > 0) &&
    args.wireLength <= MESSAGE_MAX &&
    !args.ingestPending &&
    !args.sendPending
  );
}

/**
 * Whether the box is empty now, for a send that settles after the person may
 * have begun another draft: a newer draft is any text or image, or an edit
 * loaded.
 */
function useBoxEmptyRef(
  text: string,
  imageCount: number,
  edit: BotComposerEdit | null,
): RefObject<boolean> {
  const empty = text.length === 0 && imageCount === 0 && edit === null;
  const emptyRef = useRef(empty);
  useEffect(() => {
    emptyRef.current = empty;
  }, [empty]);
  return emptyRef;
}

/**
 * The editor's document as the box holds it. What the person does reaches it
 * through `setContent`; what the box puts there itself goes through `loadBox`,
 * which the editor then shows. A focused box keeps its caret at the end of it,
 * and only a gesture of the person's moves focus to it.
 */
function useBotBoxDocument(
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
  incoming: {
    readonly edit: BotComposerEdit | null;
    readonly seed: BotComposerSeed | null;
    readonly quote: BotComposerQuote | null;
    readonly contentOf: (text: string) => JsonContent;
  },
): {
  readonly content: JsonContent;
  readonly setContent: (content: JsonContent) => void;
  readonly loadBox: (content: JsonContent) => void;
  readonly onEditorReady: () => void;
  readonly takenQuoteId: number | null;
} {
  const { edit, seed, quote, contentOf } = incoming;
  const [content, setContent] = useState(EMPTY_BOT_BOX);
  const [loaded, setLoaded] = useState<JsonContent | null>(null);
  const [editContent, setEditContent] = useState<JsonContent | null>(null);
  const loadBox = (next: JsonContent): void => {
    // An explicit load replaces the row copy, even when its document matches.
    setEditContent(null);
    setContent(next);
    // Each load must trigger the editor sync, including repeated clears with
    // EMPTY_BOT_BOX after consecutive sends on one mounted composer.
    setLoaded({ ...next });
  };
  // An edit or seed replaces the box's content once. A quote appends after
  // whichever document it currently holds, including an edit.
  const [loadedEdit, setLoadedEdit] = useState<BotComposerEdit | null>(null);
  if (edit !== loadedEdit) {
    setLoadedEdit(edit);
    if (edit !== null) {
      const next = edit.content ?? contentOf(edit.text);
      // A refused replacement is unsent work, even before another keystroke.
      // Only a fresh row load can be an untouched duplicate of the request.
      setEditContent(edit.content === null ? next : null);
      setContent(next);
      setLoaded(next);
    } else {
      // A retry outside this box ends replacement mode. Drop the duplicate
      // only while it is still the document Edit loaded; a changed draft
      // becomes an ordinary new message, including its images and quotes.
      if (
        editContent !== null &&
        JSON.stringify(content) === JSON.stringify(editContent)
      ) {
        setContent(EMPTY_BOT_BOX);
        setLoaded(EMPTY_BOT_BOX);
      }
      setEditContent(null);
    }
  }
  const seedId = seed?.id ?? null;
  const [loadedSeedId, setLoadedSeedId] = useState<number | null>(null);
  if (seedId !== loadedSeedId) {
    setLoadedSeedId(seedId);
    let next: JsonContent | null = null;
    if (seed !== null) next = seed.content ?? contentOf(seed.text);
    else if (edit === null) next = EMPTY_BOT_BOX;
    if (next !== null) {
      setContent(next);
      setLoaded(next);
    }
  }
  const [takenQuoteId, setTakenQuoteId] = useState<number | null>(null);
  if (quote !== null && quote.id !== takenQuoteId) {
    setTakenQuoteId(quote.id);
    const next = appendBlocks(
      content,
      quote.snapshots.flatMap((snapshot) => [
        buildQuoteBlockquote(snapshot),
        { type: "paragraph" },
      ]),
    );
    setContent(next);
    setLoaded(next);
  }
  useEffect(() => {
    const editor = editorRef.current;
    if (loaded === null || editor === null) return;
    const hadFocus = editor.hasFocus();
    editor.syncContent(loaded, { from: 1, to: 1 });
    if (hadFocus) editor.focusAtEnd("reveal-caret");
  }, [editorRef, loaded]);
  const contentRef = useRef(content);
  useLayoutEffect(() => {
    contentRef.current = content;
  }, [content]);
  // Anything loaded before the editor could take it.
  const onEditorReady = useCallback(() => {
    if (contentRef.current === EMPTY_BOT_BOX) return;
    editorRef.current?.syncContent(contentRef.current, { from: 1, to: 1 });
  }, [editorRef]);
  return { content, setContent, loadBox, onEditorReady, takenQuoteId };
}

/**
 * What the box says under it: a failed send offered back (from the draft
 * kept outside the box, else from the failure), a failed send whose text is
 * in the box, or a queued send.
 */
function ComposerStatus(props: {
  readonly failure: BotSendFailure;
  readonly keptDraft: BotKeptDraft | null;
  readonly queued: boolean;
  readonly testId: string;
  readonly onRestore: (unsent: BotUnsentMessage) => void;
}): ReactNode {
  const { failure, onRestore } = props;
  const unsent = props.keptDraft?.unsent ?? failure.unsent;
  if (unsent !== null || failure.failed) {
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
  /** The box's own document; `null` for text put there from outside it. */
  readonly content: JsonContent | null;
};

/** Where a box's unsent draft is kept, outside the box. */
export type BotKeptDraft = {
  /** What the box holds now, as the person types it; empty keeps nothing. */
  readonly keep: (text: string, content: JsonContent | null) => void;
  /** Whether a draft is kept now, read when a send settles. */
  readonly hasDraft: () => boolean;
  /** A failed send of the box offered back beside the draft; `null` for none. */
  readonly unsent: BotUnsentMessage | null;
  /** Offers a failed send back; `null` takes the offer away. */
  readonly offer: (unsent: BotUnsentMessage | null) => void;
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
  /** Captured by the edit owner; null is trunk, absent means not observed. */
  readonly sessionThreadId?: string | null;
  /** The failed message's request, which the edit replaces. */
  readonly requestId: string;
  readonly text: string;
  /** The box's document as a failed send of the edit left it; `null` for a row's text alone. */
  readonly content: JsonContent | null;
};
