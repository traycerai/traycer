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
 * `picks` across the change from `previous` to `next`, read as the one span
 * between their common start and end. The common end is taken first, so
 * typing just before a pick moves it rather than touching it.
 */
export function shiftMentionPicks(
  previous: string,
  next: string,
  picks: ReadonlyArray<BotMentionPick>,
): ReadonlyArray<BotMentionPick> {
  if (previous === next || picks.length === 0) return picks;
  const shorter = Math.min(previous.length, next.length);
  let suffix = 0;
  while (
    suffix < shorter &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  let prefix = 0;
  while (prefix < shorter - suffix && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  return spliceMentionPicks(
    picks,
    prefix,
    previous.length - suffix,
    next.length - suffix - prefix,
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
  const unique = [...byName]
    .flatMap(([name, userIds]) =>
      userIds.length === 1 ? [{ name, userId: userIds[0] }] : [],
    )
    .sort((a, b) => b.name.length - a.name.length);
  const pickAt = new Map(picks.map((pick) => [pick.start, pick]));
  const endsName = (at: number): boolean => {
    const after = text.charAt(at);
    return after === "" || NAME_BOUNDARY.test(after);
  };
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
    const picked = pick === undefined ? undefined : nameOf.get(pick.userId);
    if (
      pick !== undefined &&
      picked !== undefined &&
      picked.trim().length > 0 &&
      text.slice(at, pick.end) === `@${picked}` &&
      endsName(pick.end)
    ) {
      out += botMentionToken(pick.userId);
      index = pick.end;
      continue;
    }
    const named = unique.find(
      ({ name }) =>
        text.startsWith(name, at + 1) && endsName(at + 1 + name.length),
    );
    if (named === undefined) {
      out += "@";
      index = at + 1;
      continue;
    }
    out += botMentionToken(named.userId);
    index = at + 1 + named.name.length;
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
