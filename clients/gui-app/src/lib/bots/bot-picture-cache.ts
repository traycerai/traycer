import { base64ToBytes } from "@/lib/composer/image-base64";

/**
 * The pictures bots wear, as `blob:` links by the hash of their bytes.
 *
 * A link is shared by every bot and account that names its hash. That is
 * safe only because the cloud writes a picture mark for a bot after proving
 * the object is stored under that bot's own key, so a hash a look names is
 * one its reader may see. The links are still dropped when the signed-in
 * identity changes.
 *
 * A drawn picture is asked for here and read elsewhere: a bot's picture is
 * drawn in places with no host to ask, so the one loader that has a host
 * reads what is wanted. A read that fails leaves nothing behind.
 */
const links = new Map<string, string>();
/** The bot each wanted hash is read through, and how many pictures want it. */
const wanted = new Map<string, { botId: string; drawn: number }>();
/** The hashes the loader has read once, held or not, since its last reset. */
const tried = new Set<string>();
/**
 * Which host the loader asks, counted: every read belongs to one round, and
 * a new round reads afresh and takes nothing from the one before.
 */
let round = 0;
/** The hashes the listed bots wear, as the loader last said. */
let worn: ReadonlySet<string> = new Set();
/** The last answer of {@link nextWantedBotPicture}, kept so it is stable. */
let next: BotPictureRead | null = null;
const listeners = new Set<() => void>();

const PICTURE_MEDIA_TYPES: ReadonlySet<unknown> = new Set([
  "image/webp",
  "image/png",
]);

/** What `bot.readPicture` answers, unparsed at an equal method version. */
export interface BotPictureBytes {
  readonly mediaType: unknown;
  readonly bytesBase64: unknown;
}

/** One picture to read, as the bot that wears it, in one round of reads. */
export interface BotPictureRead {
  readonly sha256: string;
  readonly botId: string;
  readonly round: number;
}

function changed(): void {
  for (const listener of listeners) listener();
}

/**
 * Drops every link no listed bot wears and nothing drawn wants. A dropped
 * picture may be read again when something draws it: it was read, not
 * refused.
 */
function prune(): boolean {
  let dropped = false;
  for (const [sha256, link] of links) {
    if (worn.has(sha256) || wanted.has(sha256)) continue;
    URL.revokeObjectURL(link);
    links.delete(sha256);
    tried.delete(sha256);
    dropped = true;
  }
  return dropped;
}

/** Told of every change: a link held or dropped, a picture wanted or not. */
export function subscribeBotPictures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The link of the picture `sha256` names, or `null` while none is held. */
export function botPictureLink(sha256: string): string | null {
  return links.get(sha256) ?? null;
}

/**
 * Says a drawn picture wants `sha256`, read as `botId`'s picture. The
 * answer withdraws it; the last withdrawal drops a link no listed bot wears.
 */
export function wantBotPicture(sha256: string, botId: string): () => void {
  const entry = wanted.get(sha256);
  if (entry === undefined) {
    wanted.set(sha256, { botId, drawn: 1 });
    changed();
  } else {
    entry.drawn += 1;
  }
  return () => {
    const held = wanted.get(sha256);
    if (held === undefined) return;
    held.drawn -= 1;
    if (held.drawn > 0) return;
    wanted.delete(sha256);
    prune();
    changed();
  };
}

/**
 * The first wanted picture that is not held and has not been tried, or
 * `null`. The same object for the same answer, so it can be subscribed to.
 */
export function nextWantedBotPicture(): BotPictureRead | null {
  for (const [sha256, entry] of wanted) {
    if (links.has(sha256) || tried.has(sha256)) continue;
    if (
      next?.sha256 !== sha256 ||
      next.botId !== entry.botId ||
      next.round !== round
    ) {
      next = { sha256, botId: entry.botId, round };
    }
    return next;
  }
  next = null;
  return null;
}

/**
 * Holds the picture a read answered and marks its hash tried, whatever the
 * answer was: `null` for a read that failed or found no picture. A picture
 * nothing wants and no listed bot wears by now is not kept, and an answer
 * to a read of an earlier round is dropped.
 */
export function settleBotPictureRead(
  read: BotPictureRead,
  picture: BotPictureBytes | null,
): void {
  if (read.round !== round) return;
  const { sha256 } = read;
  tried.add(sha256);
  const link = picture === null ? null : linkOf(picture);
  if (link !== null) {
    const before = links.get(sha256);
    if (before !== undefined) URL.revokeObjectURL(before);
    links.set(sha256, link);
    prune();
  }
  changed();
}

function linkOf(picture: BotPictureBytes): string | null {
  if (
    typeof picture.mediaType !== "string" ||
    !PICTURE_MEDIA_TYPES.has(picture.mediaType) ||
    typeof picture.bytesBase64 !== "string"
  ) {
    return null;
  }
  const bytes = base64ToBytes(picture.bytesBase64);
  if (bytes === null) return null;
  return URL.createObjectURL(new Blob([bytes], { type: picture.mediaType }));
}

/**
 * Starts a new round: the loader has a new host to ask, so every picture
 * not held may be read again and no read of the round before counts.
 */
export function retryBotPictures(): void {
  round += 1;
  tried.clear();
  changed();
}

/**
 * Says which pictures the listed bots wear, and drops the links none of
 * them wears and nothing drawn wants: a replaced picture's link does not
 * outlive the bot's change.
 */
export function keepBotPictures(wornNow: ReadonlySet<string>): void {
  worn = wornNow;
  if (prune()) changed();
}

/** Drops every picture and revokes its link: the signed-in identity changed. */
export function clearBotPictures(): void {
  for (const link of links.values()) URL.revokeObjectURL(link);
  links.clear();
  tried.clear();
  worn = new Set();
  changed();
}
