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
 * The text as sent: each `@Name` of a member becomes that member's token.
 * A name two members share is the one the person picked: `picks` are the
 * members picked from the list, in the order they were, and each such
 * `@Name` takes the next pick that names one of them; with none left it
 * stays as typed. Longer names are matched first, so "@Ann Lee" is not
 * read as "@Ann".
 */
export function mentionsToWire(
  text: string,
  members: ReadonlyArray<BotMentionCandidate>,
  picks: ReadonlyArray<string>,
): string {
  const byName = new Map<string, string[]>();
  for (const member of members) {
    const name = member.name.trim();
    if (name.length === 0) continue;
    byName.set(name, [...(byName.get(name) ?? []), member.userId]);
  }
  const unspent = [...picks];
  const userIdOf = (name: string): string | null => {
    const userIds = byName.get(name) ?? [];
    if (userIds.length === 1) return userIds[0];
    const index = unspent.findIndex((userId) => userIds.includes(userId));
    if (index === -1) return null;
    const [picked] = unspent.splice(index, 1);
    return picked;
  };
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  let out = "";
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at === -1) break;
    out += text.slice(index, at);
    const before = at === 0 ? "" : text[at - 1];
    const name =
      before === "" || NAME_BOUNDARY.test(before)
        ? names.find((candidate) => {
            if (!text.startsWith(candidate, at + 1)) return false;
            const after = text.charAt(at + 1 + candidate.length);
            return after === "" || NAME_BOUNDARY.test(after);
          })
        : undefined;
    const userId = name === undefined ? null : userIdOf(name);
    if (name === undefined || userId === null) {
      out += "@";
      index = at + 1;
      continue;
    }
    out += botMentionToken(userId);
    index = at + 1 + name.length;
  }
  return out + text.slice(index);
}

/**
 * The text as the box shows it: each member's token as `@Name`; a token of
 * anyone else stays as it is.
 */
export function mentionsToDisplay(
  text: string,
  nameOf: (userId: string) => string | null,
): string {
  return text.replace(BOT_MENTION_TOKEN, (token, userId: string) => {
    const name = nameOf(userId);
    return name === null ? token : `@${name}`;
  });
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
