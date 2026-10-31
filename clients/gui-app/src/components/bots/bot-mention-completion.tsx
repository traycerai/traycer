import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { MemberAvatar } from "@/components/bots/bot-avatars";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import {
  activeMentionQuery,
  matchMentionCandidates,
  mentionsToDisplay,
  mentionsToWire,
  shiftMentionPicks,
  spliceMentionPicks,
  type BotMentionCandidate,
  type BotMentionPick,
} from "@/lib/bots/bot-mentions";
import { useAuthStore } from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";

const MATCHES_MAX = 8;
const NO_CANDIDATES: ReadonlyArray<BotMentionCandidate> = [];

/** What a message box needs to complete `@` with the environment's members. */
export interface BotMentionCompletion {
  /** The list under an `@` being typed; `null` while none shows. */
  readonly list: ReactNode;
  readonly listOpen: boolean;
  /** Handles a key the list takes (moving, picking, closing); `true` when it did. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The caret moved: what follows it decides the list. */
  readonly onCaret: (caret: number) => void;
  /** The text as sent: each completed name as its member's token. */
  readonly toWire: (text: string) => string;
  /** A sent text as the box shows it: each member's token as their name. */
  readonly toDisplay: (text: string) => string;
}

/**
 * `@` completion for a bot channel's box (decision 137): the current members
 * of a team's environment other than the viewer, by name and picture, as the
 * team's member directory lists them. A personal environment's bot has no
 * one else to name, and a member with no name cannot be named. Picking one
 * writes `@Name` in the box, which the send turns into that member's token,
 * even where another member has the same name.
 */
export function useBotMentionCompletion(args: {
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly listId: string;
}): BotMentionCompletion {
  const { text, setText, inputRef, listId } = args;
  const owner = useBotIdentity()?.owner ?? null;
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  const members = owner?.kind === "team" ? owner.members : null;
  const everyone = useMemo((): ReadonlyArray<BotMentionCandidate> => {
    if (members === null) return NO_CANDIDATES;
    return members.flatMap((member) =>
      member.displayName === null
        ? []
        : [
            {
              userId: member.userId,
              name: member.displayName,
              avatarUrl: member.avatarUrl,
            },
          ],
    );
  }, [members]);
  const candidates = useMemo(
    () => everyone.filter((member) => member.userId !== viewerUserId),
    [everyone, viewerUserId],
  );
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // An `@` the person closed the list on with Escape, by where it starts.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  // Where the caret goes once a pick is in the box.
  const placeCaret = useRef<number | null>(null);
  // The members picked into the box, by where each `@Name` sits in the text
  // they were read against: a name two members share is sent as the one
  // picked (`mentionsToWire`). Each change of the text moves them with it,
  // and drops the ones it touched.
  const [anchored, setAnchored] = useState<{
    readonly text: string;
    readonly picks: ReadonlyArray<BotMentionPick>;
  }>({ text, picks: [] });
  if (anchored.text !== text) {
    setAnchored({
      text,
      picks: shiftMentionPicks(anchored.text, text, anchored.picks),
    });
  }
  const mention = activeMentionQuery(text, Math.min(caret, text.length));
  const matches =
    mention === null || candidates.length === 0
      ? NO_CANDIDATES
      : matchMentionCandidates(candidates, mention.query).slice(0, MATCHES_MAX);
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
          shiftMentionPicks(anchored.text, text, anchored.picks),
          mention.start,
          end,
          inserted.length,
        ),
        {
          start: mention.start,
          end: mention.start + 1 + candidate.name.length,
          userId: candidate.userId,
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
      aria-label="Members"
      data-testid="bot-mention-list"
      className="absolute inset-x-2 bottom-full z-20 mb-1 flex max-w-xs flex-col gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {matches.map((candidate, index) => (
        <li
          key={candidate.userId}
          role="option"
          aria-selected={index === active}
          data-testid="bot-mention-option"
          data-user-id={candidate.userId}
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
          <MemberAvatar
            userId={candidate.userId}
            name={candidate.name}
            avatarUrl={candidate.avatarUrl}
            size="xs"
          />
          <span className="truncate">{candidate.name}</span>
        </li>
      ))}
    </ul>
  ) : null;

  const nameOf = (userId: string): string | null =>
    everyone.find((member) => member.userId === userId)?.name ?? null;

  return {
    list,
    listOpen: open,
    onKeyDown,
    onCaret: (next) => {
      setCaret(next);
      setHighlight(0);
    },
    // The text sent is the box's trimmed, which starts where the box's
    // leading space ends.
    toWire: (sent) => {
      const offset = anchored.text.indexOf(sent);
      const picks =
        offset === -1
          ? shiftMentionPicks(anchored.text, sent, anchored.picks)
          : spliceMentionPicks(anchored.picks, 0, offset, 0);
      return mentionsToWire(sent, everyone, picks);
    },
    // A sent text's tokens are its picks again, so an edit sends each
    // mention to the member it named.
    toDisplay: (sent) => {
      const display = mentionsToDisplay(sent, nameOf);
      setAnchored(display);
      return display.text;
    },
  };
}
