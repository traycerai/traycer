import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Layers } from "lucide-react";
import { NamedBotAvatar, PersonAvatar } from "@/components/bots/bot-avatars";
import {
  useBotIdentity,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BotMentionsContext,
  type BotMentionDirectory,
  type BotMentionTarget,
} from "@/components/bots/bot-mentions-context";
import {
  activeMentionQuery,
  matchMentionCandidates,
  mentionsToDisplay,
  mentionsToWire,
  shiftMentionPicks,
  spliceMentionPicks,
  type BotMentionCandidate,
  type BotMentionEdit,
  type BotMentionKind,
  type BotMentionTextRange,
  type BotMentionPick,
} from "@/lib/bots/bot-mentions";
import { useAuthStore } from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";

const MATCHES_MAX = 8;
const NO_CANDIDATES: ReadonlyArray<BotMentionCandidate> = [];

/** What a message box needs to complete `@` with what the environment can name. */
export interface BotMentionCompletion {
  /** The list under an `@` being typed; `null` while none shows. */
  readonly list: ReactNode;
  readonly listOpen: boolean;
  /** The id of the option the list has highlighted; `null` while none shows. */
  readonly activeOptionId: string | null;
  /** Handles a key the list takes (moving, picking, closing); `true` when it did. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The caret moved: what follows it decides the list. */
  readonly onCaret: (caret: number) => void;
  /**
   * The person edited the box, whether or not what it holds changed;
   * `input` is the box after it.
   */
  readonly onInput: (input: HTMLTextAreaElement) => void;
  /** The text as sent: each completed name as its token. */
  readonly toWire: (text: string) => string;
  /** A sent text as the box shows it: each token the box can name as its name. */
  readonly toDisplay: (text: string) => string;
}

/**
 * `@` completion for a bot channel's box (decisions 137, 177), one list of
 * what the bot's own environment can name: the current members of a team's
 * environment other than the viewer, by name and picture, as the team's
 * member directory lists them; the environment's other bots, by their
 * picture; and its tasks (`BotMentionsContext`). A personal environment's bot
 * has no one else to name, and a member with no name cannot be named.
 * Picking one writes `@Name` in the box, which the send turns into its
 * token, even where another has the same name.
 */
export function useBotMentionCompletion(args: {
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly listId: string;
}): BotMentionCompletion {
  const { text, setText, inputRef, listId } = args;
  const identity = useBotIdentity();
  const directory = useContext(BotMentionsContext);
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  const everyone = useMemo(
    () => mentionCandidatesOf(identity, directory),
    [directory, identity],
  );
  const candidates = useMemo(
    () => offeredCandidates(everyone, identity, viewerUserId),
    [everyone, identity, viewerUserId],
  );
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // An `@` the person closed the list on with Escape, by where it starts.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  // Where the caret goes once a pick is in the box.
  const placeCaret = useRef<number | null>(null);
  // What was picked into the box, by where each `@Name` sits in the text it
  // was read against: a name two share is sent as the one picked
  // (`mentionsToWire`). Each change of the text moves them with it,
  // and drops the ones it touched.
  const [anchored, setAnchored] = useState<{
    readonly text: string;
    readonly picks: ReadonlyArray<BotMentionPick>;
  }>({ text, picks: [] });
  if (anchored.text !== text) {
    setAnchored({
      text,
      picks: shiftMentionPicks(anchored.text, text, anchored.picks, null),
    });
  }
  // The edit under way, as the box announces it: its kind, and the box's
  // selection as it began, which says what a typed edit replaced
  // (`shiftMentionPicks`). Spent by the edit.
  const editing = useRef<{
    readonly inputType: string;
    readonly before: BotMentionTextRange;
  } | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const record = (event: InputEvent): void => {
      editing.current = {
        inputType: event.inputType,
        before: { start: input.selectionStart, end: input.selectionEnd },
      };
    };
    input.addEventListener("beforeinput", record);
    return () => input.removeEventListener("beforeinput", record);
  }, [inputRef]);
  const mention = activeMentionQuery(text, Math.min(caret, text.length));
  const matches =
    mention === null || candidates.length === 0
      ? NO_CANDIDATES
      : matchMentionCandidates(candidates, mention.query).slice(0, MATCHES_MAX);
  // A dismissal holds only while its `@` is the one being typed.
  if (dismissedAt !== null && mention?.start !== dismissedAt) {
    setDismissedAt(null);
  }
  const open =
    mention !== null && matches.length > 0 && dismissedAt !== mention.start;
  const active = Math.min(highlight, Math.max(matches.length - 1, 0));

  useEffect(() => {
    const next = placeCaret.current;
    if (next === null) return;
    placeCaret.current = null;
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(next, next);
  }, [inputRef, text]);

  const pick = (candidate: BotMentionCandidate): void => {
    if (mention === null) return;
    const end = Math.min(caret, text.length);
    const before = text.slice(0, mention.start);
    const after = text.slice(end);
    const inserted = `@${candidate.name} `;
    const written = before + inserted + after;
    setAnchored({
      text: written,
      picks: [
        ...spliceMentionPicks(
          shiftMentionPicks(anchored.text, text, anchored.picks, null),
          mention.start,
          end,
          inserted.length,
        ),
        {
          start: mention.start,
          end: mention.start + 1 + candidate.name.length,
          kind: candidate.kind,
          id: candidate.id,
        },
      ],
    });
    setText(written);
    const next = before.length + inserted.length;
    setCaret(next);
    setHighlight(0);
    placeCaret.current = next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    switch (event.key) {
      case "ArrowDown":
        setHighlight((active + 1) % matches.length);
        break;
      case "ArrowUp":
        setHighlight((active - 1 + matches.length) % matches.length);
        break;
      case "Enter":
      case "Tab":
        pick(matches[active]);
        break;
      case "Escape":
        setDismissedAt(mention.start);
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  };

  const list = open ? (
    <ul
      id={listId}
      role="listbox"
      aria-label="Mentions"
      data-testid="bot-mention-list"
      className="absolute inset-x-2 bottom-full z-20 mb-1 flex max-w-xs flex-col gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {matches.map((candidate, index) => (
        <li
          key={`${candidate.kind}:${candidate.id}`}
          id={optionId(listId, index)}
          role="option"
          aria-selected={index === active}
          data-testid="bot-mention-option"
          data-kind={candidate.kind}
          data-id={candidate.id}
          // Picked on press, before the box loses focus.
          onMouseDown={(event) => {
            event.preventDefault();
            pick(candidate);
          }}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-ui-sm text-foreground",
            index === active && "bg-foreground/8",
          )}
        >
          {mentionGlyph(candidate)}
          <span className="truncate">{candidate.name}</span>
        </li>
      ))}
    </ul>
  ) : null;

  const nameOf = (kind: BotMentionKind, id: string): string | null =>
    everyone.find((candidate) => candidate.kind === kind && candidate.id === id)
      ?.name ?? null;

  return {
    list,
    listOpen: open,
    activeOptionId: open ? optionId(listId, active) : null,
    onKeyDown,
    onCaret: (next) => {
      setCaret(next);
      setHighlight(0);
    },
    onInput: (input) => {
      const next = input.value;
      const announced = editing.current;
      editing.current = null;
      const edit: BotMentionEdit | null =
        announced === null
          ? null
          : {
              ...announced,
              after: { start: input.selectionStart, end: input.selectionEnd },
            };
      setAnchored((current) => ({
        text: next,
        picks: shiftMentionPicks(current.text, next, current.picks, edit),
      }));
      setCaret(input.selectionStart);
      setHighlight(0);
    },
    // The text sent is the box's trimmed, which starts where the box's
    // leading space ends.
    toWire: (sent) => {
      const offset = anchored.text.indexOf(sent);
      const picks =
        offset === -1
          ? shiftMentionPicks(anchored.text, sent, anchored.picks, null)
          : spliceMentionPicks(anchored.picks, 0, offset, 0);
      return mentionsToWire(sent, everyone, picks);
    },
    // A sent text's tokens are its picks again, so an edit sends each
    // mention to what it named.
    toDisplay: (sent) => {
      const display = mentionsToDisplay(sent, nameOf);
      setAnchored(display);
      return display.text;
    },
  };
}

/**
 * Everything the box can name, in the list's order: the members with a
 * name, then the bots, then the tasks.
 */
function mentionCandidatesOf(
  identity: BotIdentity | null,
  directory: BotMentionDirectory | null,
): ReadonlyArray<BotMentionCandidate> {
  const owner = identity?.owner ?? null;
  const members = owner?.kind === "team" ? owner.members : null;
  const people: BotMentionCandidate[] = (members ?? []).flatMap((member) =>
    member.displayName === null
      ? []
      : [
          {
            kind: "person" as const,
            id: member.userId,
            name: member.displayName,
            avatarUrl: member.avatarUrl,
          },
        ],
  );
  const named = (
    kind: BotMentionKind,
    targets: ReadonlyArray<BotMentionTarget>,
  ): BotMentionCandidate[] =>
    targets.map((target) => ({ kind, ...target, avatarUrl: null }));
  const all = [
    ...people,
    ...named("bot", directory?.bots ?? []),
    ...named("task", directory?.tasks ?? []),
  ];
  return all.length === 0 ? NO_CANDIDATES : all;
}

/** What the list offers: not the viewer, nor the bot whose box this is. */
function offeredCandidates(
  everyone: ReadonlyArray<BotMentionCandidate>,
  identity: BotIdentity | null,
  viewerUserId: string | null,
): ReadonlyArray<BotMentionCandidate> {
  const ownBotId = identity?.botId ?? null;
  return everyone.filter(
    (candidate) =>
      !(candidate.kind === "person" && candidate.id === viewerUserId) &&
      !(candidate.kind === "bot" && candidate.id === ownBotId),
  );
}

/** A row's kind at a glance: the person's picture, the bot's, or the task icon. */
function mentionGlyph(candidate: BotMentionCandidate): ReactNode {
  switch (candidate.kind) {
    case "person":
      return (
        <PersonAvatar
          userId={candidate.id}
          name={candidate.name}
          avatarUrl={candidate.avatarUrl}
          size="xs"
        />
      );
    case "bot":
      return <NamedBotAvatar botId={candidate.id} size="xs" />;
    case "task":
      return (
        <Layers
          aria-hidden="true"
          data-testid="bot-mention-task-glyph"
          className="size-4 shrink-0 text-muted-foreground"
        />
      );
  }
}

function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}
