/**
 * Mentions in a bot channel's messages (decisions 137, 177): a member is
 * named in a message's text as `<@userId>`, which is what the bot's host
 * reads the mentions from; another bot of the environment as `<#botId>` (a
 * bot is a channel); a task as `<~epicId>`. The box shows `@Name` while the
 * person types; the send writes the token.
 */

/** What a mention names. */
export type BotMentionKind = "person" | "bot" | "task";

/** A member, bot or task the box can name. */
export interface BotMentionCandidate {
  readonly kind: BotMentionKind;
  /** The member's user id, the bot's id or the task's epic id. */
  readonly id: string;
  readonly name: string;
  /** A member's picture; `null` for a bot or a task. */
  readonly avatarUrl: string | null;
}

/**
 * Any mention in a message's text: `<@userId>`, `<#botId>` or `<~epicId>`,
 * a bot and a task id in their exact shapes, so text that only looks like
 * one (`<#include>`) stays as written. Read with {@link mentionOfToken}.
 */
export const BOT_MENTION_TOKEN =
  /<(?:@([^\s<>@]{1,64})|#(bot_[0-7][0-9A-HJKMNP-TV-Z]{25})|~([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))>/g;

/** What a {@link BOT_MENTION_TOKEN} match's `token` names, by its head. */
export function mentionOfToken(token: string): {
  readonly kind: BotMentionKind;
  readonly id: string;
} {
  const id = token.slice(2, -1);
  switch (token.charAt(1)) {
    case "@":
      return { kind: "person", id };
    case "#":
      return { kind: "bot", id };
    default:
      return { kind: "task", id };
  }
}

function botMentionToken(kind: BotMentionKind, id: string): string {
  switch (kind) {
    case "person":
      return `<@${id}>`;
    case "bot":
      return `<#${id}>`;
    case "task":
      return `<~${id}>`;
  }
}

/** One key per thing named, whatever its kind. */
function mentionKey(kind: BotMentionKind, id: string): string {
  return `${kind}:${id}`;
}

/** Characters a name may not run into for `@Name` to be that name. */
const NAME_BOUNDARY = /[\s.,;:!?()[\]{}'"]/;

/**
 * A member, bot or task picked from the list, by where the `@Name` the pick
 * wrote sits in the box: `[start, end)`, the `@` and the name.
 */
export interface BotMentionPick {
  readonly start: number;
  readonly end: number;
  readonly kind: BotMentionKind;
  readonly id: string;
}

/**
 * `picks` once `[start, end)` of the text is replaced by `insertedLength`
 * characters: a pick the edit touches is gone, and one after it moves with
 * the text.
 */
export function spliceMentionPicks(
  picks: ReadonlyArray<BotMentionPick>,
  start: number,
  end: number,
  insertedLength: number,
): ReadonlyArray<BotMentionPick> {
  const delta = insertedLength - (end - start);
  return picks.flatMap((pick) => {
    if (pick.end <= start) return [pick];
    if (pick.start >= end) {
      return [{ ...pick, start: pick.start + delta, end: pick.end + delta }];
    }
    return [];
  });
}

/** A range of the box's text, `[start, end)`; a caret where they meet. */
export interface BotMentionTextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * An edit the person made in the box: its kind (an input event's
 * `inputType`), and the box's selection as it began and once it was made.
 */
export interface BotMentionEdit {
  readonly inputType: string;
  readonly before: BotMentionTextRange;
  readonly after: BotMentionTextRange;
}

interface EditedSpan {
  readonly start: number;
  readonly end: number;
  readonly insertedLength: number;
}

/**
 * The span a typed or deleted edit changed, by the selection it began at:
 * a selected range is what it replaced, whatever the texts share inside it;
 * at a caret, text is inserted there, or deleted behind it for a backward
 * deletion and ahead of it otherwise.
 */
function editAtSelection(
  { start, end }: BotMentionTextRange,
  inputType: string,
  delta: number,
): EditedSpan {
  if (start < end) return { start, end, insertedLength: delta + end - start };
  if (delta >= 0) return { start, end: start, insertedLength: delta };
  if (inputType.endsWith("Backward")) {
    return { start: start + delta, end: start, insertedLength: 0 };
  }
  return { start, end: start - delta, insertedLength: 0 };
}

/**
 * The span an undo or redo changed, by the selection it leaves: the text it
 * restored is selected, and where it took text away the caret is where it
 * was. `null` where the selection says neither.
 */
function editAtRestoredSelection(
  { start, end }: BotMentionTextRange,
  delta: number,
): EditedSpan | null {
  if (start < end) {
    return { start, end: end - delta, insertedLength: end - start };
  }
  if (delta < 0) return { start, end: start - delta, insertedLength: 0 };
  return null;
}

/** `span` where it turns `previous` into `next`, else `null`. */
function agreeing(
  previous: string,
  next: string,
  span: EditedSpan | null,
): EditedSpan | null {
  if (span === null) return null;
  const agrees =
    span.start >= 0 &&
    span.end >= span.start &&
    span.end <= previous.length &&
    span.insertedLength >= 0 &&
    previous.slice(0, span.start) === next.slice(0, span.start) &&
    previous.slice(span.end) === next.slice(span.start + span.insertedLength);
  return agrees ? span : null;
}

/** How long a start and an end `previous` and `next` share, each alone. */
function commonEnds(
  previous: string,
  next: string,
): {
  readonly prefix: number;
  readonly suffix: number;
  readonly shorter: number;
} {
  const shorter = Math.min(previous.length, next.length);
  let suffix = 0;
  while (
    suffix < shorter &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  let prefix = 0;
  while (prefix < shorter && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  return { prefix, suffix, shorter };
}

/**
 * The one span between `previous` and `next`'s common start and end, the
 * common end taken first, so typing just before a pick moves it rather than
 * touching it.
 */
function diffEdit(previous: string, next: string): EditedSpan {
  const { prefix, suffix, shorter } = commonEnds(previous, next);
  const start = Math.min(prefix, shorter - suffix);
  return {
    start,
    end: previous.length - suffix,
    insertedLength: next.length - suffix - start,
  };
}

/**
 * Every span that could have turned `previous` into `next`, as one: where
 * repeated text leaves several, from the earliest start to the latest end,
 * so no pick is kept on a guess between two of the same text.
 */
function everyDiffEdit(previous: string, next: string): EditedSpan {
  const { prefix, suffix, shorter } = commonEnds(previous, next);
  const start = Math.min(prefix, shorter - suffix);
  const kept = Math.min(suffix, shorter - prefix);
  return {
    start,
    end: previous.length - kept,
    insertedLength: next.length - kept - start,
  };
}

/** Whether the edit is typed or deleted at the selection, unlike an undo. */
function editsAtSelection(inputType: string): boolean {
  return inputType.startsWith("insert") || inputType.startsWith("delete");
}

/**
 * `picks` across the change from `previous` to `next`. A typed or deleted
 * edit changed the span its selection says: a selected range, all of it,
 * or the text at a caret. An undo or redo changed the span the selection it
 * leaves says; where that does not hold, every span the texts allow counts
 * as changed. A change with no edit known (a text the app set) is read from
 * the texts alone.
 */
export function shiftMentionPicks(
  previous: string,
  next: string,
  picks: ReadonlyArray<BotMentionPick>,
  edit: BotMentionEdit | null,
): ReadonlyArray<BotMentionPick> {
  if (picks.length === 0) return picks;
  // A selected range a typed edit replaced is gone even where the new text
  // reads the same; any other edit that leaves the text as it was moved
  // nothing.
  const replacesRange =
    edit !== null &&
    editsAtSelection(edit.inputType) &&
    edit.before.start < edit.before.end;
  if (previous === next && !replacesRange) return picks;
  const delta = next.length - previous.length;
  let span: EditedSpan;
  if (edit === null) {
    span = diffEdit(previous, next);
  } else if (editsAtSelection(edit.inputType)) {
    span =
      agreeing(
        previous,
        next,
        editAtSelection(edit.before, edit.inputType, delta),
      ) ?? diffEdit(previous, next);
  } else {
    span =
      agreeing(previous, next, editAtRestoredSelection(edit.after, delta)) ??
      everyDiffEdit(previous, next);
  }
  return spliceMentionPicks(picks, span.start, span.end, span.insertedLength);
}

function endsNameAt(text: string, at: number): boolean {
  const after = text.charAt(at);
  return after === "" || NAME_BOUNDARY.test(after);
}

/** Whether `pick`'s range of `text` still reads `@Name` of what it picked. */
function pickHolds(
  text: string,
  pick: BotMentionPick,
  name: string | undefined,
): boolean {
  if (name === undefined || name.trim().length === 0) return false;
  return (
    text.slice(pick.start, pick.end) === `@${name}` &&
    endsNameAt(text, pick.end)
  );
}

/**
 * The text as sent: a pick whose range still reads `@Name` of what it picked
 * becomes its token, and any other `@Name` becomes a token only where
 * nothing else the box can name - member, bot or task - has that name; a
 * name two share and that no pick holds stays as typed. Longer names are
 * matched first, so "@Ann Lee" is not read as "@Ann".
 */
export function mentionsToWire(
  text: string,
  candidates: ReadonlyArray<BotMentionCandidate>,
  picks: ReadonlyArray<BotMentionPick>,
): string {
  const nameOf = new Map(
    candidates.map((candidate) => [
      mentionKey(candidate.kind, candidate.id),
      candidate.name,
    ]),
  );
  const byName = new Map<string, BotMentionCandidate[]>();
  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (name.length === 0) continue;
    byName.set(name, [...(byName.get(name) ?? []), candidate]);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const pickAt = new Map(picks.map((pick) => [pick.start, pick]));
  let out = "";
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at === -1) break;
    out += text.slice(index, at);
    const before = at === 0 ? "" : text[at - 1];
    if (before !== "" && !NAME_BOUNDARY.test(before)) {
      out += "@";
      index = at + 1;
      continue;
    }
    const pick = pickAt.get(at);
    if (
      pick !== undefined &&
      pickHolds(text, pick, nameOf.get(mentionKey(pick.kind, pick.id)))
    ) {
      out += botMentionToken(pick.kind, pick.id);
      index = pick.end;
      continue;
    }
    const name = names.find(
      (candidate) =>
        text.startsWith(candidate, at + 1) &&
        endsNameAt(text, at + 1 + candidate.length),
    );
    if (name === undefined) {
      out += "@";
      index = at + 1;
      continue;
    }
    // A name two share is neither of them unless picked, nor a shorter name
    // that starts it.
    const named = byName.get(name) ?? [];
    out +=
      named.length === 1
        ? botMentionToken(named[0].kind, named[0].id)
        : `@${name}`;
    index = at + 1 + name.length;
  }
  return out + text.slice(index);
}

/**
 * The text as the box shows it: each token the box can name as `@Name`,
 * held as a pick of what it names, so it is sent as that again; any other
 * token stays as it is.
 */
export function mentionsToDisplay(
  text: string,
  nameOf: (kind: BotMentionKind, id: string) => string | null,
): { readonly text: string; readonly picks: ReadonlyArray<BotMentionPick> } {
  const picks: BotMentionPick[] = [];
  let out = "";
  let index = 0;
  for (const match of text.matchAll(BOT_MENTION_TOKEN)) {
    const { kind, id } = mentionOfToken(match[0]);
    const name = nameOf(kind, id);
    out += text.slice(index, match.index);
    index = match.index + match[0].length;
    if (name === null) {
      out += match[0];
      continue;
    }
    const shown = `@${name}`;
    picks.push({
      start: out.length,
      end: out.length + shown.length,
      kind,
      id,
    });
    out += shown;
  }
  return { text: out + text.slice(index), picks };
}

/**
 * The `@` being typed at `caret`: where it starts and what follows it on its
 * line, or `null` when the caret is not in one. As in the agent composer, an
 * `@` starts a mention at the start of a line or after a space, and what
 * follows it runs on through spaces, to the next such `@`.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  const head = text.slice(0, caret);
  const match = /(?:^|\s)@((?:(?!\s@)[^\n])*)$/.exec(head);
  if (match === null) return null;
  const query = match[1];
  return { start: caret - query.length - 1, query };
}
