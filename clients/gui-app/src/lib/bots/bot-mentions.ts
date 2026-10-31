/**
 * Mentions in a bot channel's messages (decision 137): a member is named in
 * a message's text as `<@userId>`, which is what the bot's host reads the
 * mentions from. The box shows `@Name` while the person types; the send
 * writes the token.
 */

/** A member the box can name. */
export interface BotMentionCandidate {
  readonly userId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

/** `<@userId>` in a message's text. */
export const BOT_MENTION_TOKEN = /<@([^\s<>@]{1,64})>/g;

export function botMentionToken(userId: string): string {
  return `<@${userId}>`;
}

/** Characters a name may not run into for `@Name` to be that name. */
const NAME_BOUNDARY = /[\s.,;:!?()[\]{}'"]/;

/**
 * A member picked from the list, by where the `@Name` the pick wrote sits in
 * the box: `[start, end)`, the `@` and the name.
 */
export interface BotMentionPick {
  readonly start: number;
  readonly end: number;
  readonly userId: string;
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

/**
 * The box's selection as an edit was about to change it, `[start, end)`,
 * and the edit's kind (an input event's `inputType`).
 */
export interface BotMentionEditSelection {
  readonly start: number;
  readonly end: number;
  readonly inputType: string;
}

interface EditedSpan {
  readonly start: number;
  readonly end: number;
  readonly insertedLength: number;
}

/**
 * The edit a selection makes that changes the text's length by `delta`: a
 * selected range is replaced; at a caret, text is inserted there, or
 * deleted behind it for a backward deletion and ahead of it otherwise.
 */
function editAtSelection(
  selection: BotMentionEditSelection,
  delta: number,
): EditedSpan {
  const { start, end, inputType } = selection;
  if (start < end) return { start, end, insertedLength: delta + end - start };
  if (delta >= 0) return { start, end: start, insertedLength: delta };
  if (inputType.endsWith("Backward")) {
    return { start: start + delta, end: start, insertedLength: 0 };
  }
  return { start, end: start - delta, insertedLength: 0 };
}

/**
 * The edit from `previous` to `next` that the selection made; `null` when
 * the texts do not agree with it, so the selection did not make it.
 */
function selectionEdit(
  previous: string,
  next: string,
  selection: BotMentionEditSelection,
): EditedSpan | null {
  const span = editAtSelection(selection, next.length - previous.length);
  const agrees =
    span.start >= 0 &&
    span.end <= previous.length &&
    span.insertedLength >= 0 &&
    previous.slice(0, span.start) === next.slice(0, span.start) &&
    previous.slice(span.end) === next.slice(span.start + span.insertedLength);
  return agrees ? span : null;
}

/**
 * The one span between `previous` and `next`'s common start and end. The
 * common end is taken first, so typing just before a pick moves it rather
 * than touching it. `ambiguous` when the two overlap, so repeated text lets
 * more than one span make the change.
 */
function diffEdit(
  previous: string,
  next: string,
): EditedSpan & { readonly ambiguous: boolean } {
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
  const start = Math.min(prefix, shorter - suffix);
  return {
    start,
    end: previous.length - suffix,
    insertedLength: next.length - suffix - start,
    ambiguous: prefix > start,
  };
}

/**
 * `picks` across the change from `previous` to `next`. The texts decide the
 * edit where they leave one span to make it. Where repeated text leaves
 * several, the selection the edit replaced decides among them, which tells
 * two of the same `@Name` apart; an undo or redo, which does not edit at the
 * selection, or an edit with no selection known (a text the app set) keeps
 * the span that leaves an untouched pick on its text.
 */
export function shiftMentionPicks(
  previous: string,
  next: string,
  picks: ReadonlyArray<BotMentionPick>,
  selection: BotMentionEditSelection | null,
): ReadonlyArray<BotMentionPick> {
  if (previous === next || picks.length === 0) return picks;
  const diff = diffEdit(previous, next);
  const atSelection =
    diff.ambiguous && selection !== null && editsAtSelection(selection)
      ? selectionEdit(previous, next, selection)
      : null;
  const span = atSelection ?? diff;
  return spliceMentionPicks(picks, span.start, span.end, span.insertedLength);
}

/** Whether the edit is typed or deleted at the selection, unlike an undo. */
function editsAtSelection(selection: BotMentionEditSelection): boolean {
  return (
    selection.inputType.startsWith("insert") ||
    selection.inputType.startsWith("delete")
  );
}

function endsNameAt(text: string, at: number): boolean {
  const after = text.charAt(at);
  return after === "" || NAME_BOUNDARY.test(after);
}

/** Whether `pick`'s range of `text` still reads `@Name` of the member it picked. */
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
 * The text as sent: a pick whose range still reads `@Name` of the member it
 * picked becomes that member's token, and any other `@Name` becomes its
 * member's token only where no other member has that name; a name two
 * members share and that no pick holds stays as typed. Longer names are
 * matched first, so "@Ann Lee" is not read as "@Ann".
 */
export function mentionsToWire(
  text: string,
  members: ReadonlyArray<BotMentionCandidate>,
  picks: ReadonlyArray<BotMentionPick>,
): string {
  const nameOf = new Map(members.map((member) => [member.userId, member.name]));
  const byName = new Map<string, string[]>();
  for (const member of members) {
    const name = member.name.trim();
    if (name.length === 0) continue;
    byName.set(name, [...(byName.get(name) ?? []), member.userId]);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const pickAt = new Map(picks.map((pick) => [pick.start, pick]));
  const endsName = (at: number): boolean => endsNameAt(text, at);
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
    if (pick !== undefined && pickHolds(text, pick, nameOf.get(pick.userId))) {
      out += botMentionToken(pick.userId);
      index = pick.end;
      continue;
    }
    const name = names.find(
      (candidate) =>
        text.startsWith(candidate, at + 1) &&
        endsName(at + 1 + candidate.length),
    );
    if (name === undefined) {
      out += "@";
      index = at + 1;
      continue;
    }
    // A name two members share is neither of them unless picked, nor a
    // shorter name that starts it.
    const userIds = byName.get(name) ?? [];
    out += userIds.length === 1 ? botMentionToken(userIds[0]) : `@${name}`;
    index = at + 1 + name.length;
  }
  return out + text.slice(index);
}

/**
 * The text as the box shows it: each member's token as `@Name`, held as a
 * pick of that member, so it is sent as them again; a token of anyone else
 * stays as it is.
 */
export function mentionsToDisplay(
  text: string,
  nameOf: (userId: string) => string | null,
): { readonly text: string; readonly picks: ReadonlyArray<BotMentionPick> } {
  const picks: BotMentionPick[] = [];
  let out = "";
  let index = 0;
  for (const match of text.matchAll(BOT_MENTION_TOKEN)) {
    const userId = match[1];
    const name = nameOf(userId);
    out += text.slice(index, match.index);
    index = match.index + match[0].length;
    if (name === null) {
      out += match[0];
      continue;
    }
    const shown = `@${name}`;
    picks.push({ start: out.length, end: out.length + shown.length, userId });
    out += shown;
  }
  return { text: out + text.slice(index), picks };
}

/**
 * The `@` being typed at `caret`: where it starts and what follows it, or
 * `null` when the caret is not in one. An `@` starts a mention at the start
 * of the text or after a space.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  const head = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(head);
  if (match === null) return null;
  const query = match[1];
  return { start: caret - query.length - 1, query };
}

/** The candidates whose name starts a word with `query`, case-insensitively. */
export function matchMentionCandidates(
  candidates: ReadonlyArray<BotMentionCandidate>,
  query: string,
): ReadonlyArray<BotMentionCandidate> {
  const needle = query.toLowerCase();
  return candidates.filter((candidate) => {
    const words = candidate.name.toLowerCase().split(/\s+/);
    return words.some((_, index) =>
      words.slice(index).join(" ").startsWith(needle),
    );
  });
}
