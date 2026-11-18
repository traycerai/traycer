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
const listeners = new Set<() => void>();
/** Bumped by a clear, so a read that outlives one stores nothing. */
let generation = 0;

const PICTURE_MEDIA_TYPES: ReadonlySet<unknown> = new Set([
  "image/webp",
  "image/png",
]);

/** What `bot.readPicture` answers, unparsed at an equal method version. */
export interface BotPictureBytes {
  readonly mediaType: unknown;
  readonly bytesBase64: unknown;
}

function changed(): void {
  for (const listener of listeners) listener();
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
 * answer withdraws it.
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
    if (held.drawn === 0) wanted.delete(sha256);
  };
}

/** The first wanted picture that is not held and `skip` does not refuse. */
export function nextWantedBotPicture(
  skip: (sha256: string) => boolean,
): { readonly sha256: string; readonly botId: string } | null {
  for (const [sha256, entry] of wanted) {
    if (!links.has(sha256) && !skip(sha256)) {
      return { sha256, botId: entry.botId };
    }
  }
  return null;
}

/**
 * Holds the picture a read answered. `false` for an answer that is no
 * picture, and for one that arrives after the pictures were cleared.
 */
export function holdBotPicture(
  sha256: string,
  picture: BotPictureBytes,
  readIn: number,
): boolean {
  if (readIn !== generation) return false;
  if (
    typeof picture.mediaType !== "string" ||
    !PICTURE_MEDIA_TYPES.has(picture.mediaType) ||
    typeof picture.bytesBase64 !== "string"
  ) {
    return false;
  }
  const bytes = base64ToBytes(picture.bytesBase64);
  if (bytes === null) return false;
  const blob = new Blob([bytes], { type: picture.mediaType });
  links.set(sha256, URL.createObjectURL(blob));
  changed();
  return true;
}

/** What a read passes back to {@link holdBotPicture}. */
export function botPictureGeneration(): number {
  return generation;
}

/**
 * Drops the pictures no listed bot wears and nothing drawn wants: a replaced
 * picture's link does not outlive the bot's change.
 */
export function keepBotPictures(worn: ReadonlySet<string>): void {
  let dropped = false;
  for (const [sha256, link] of links) {
    if (worn.has(sha256) || wanted.has(sha256)) continue;
    URL.revokeObjectURL(link);
    links.delete(sha256);
    dropped = true;
  }
  if (dropped) changed();
}

/** Drops every picture and revokes its link: the signed-in identity changed. */
export function clearBotPictures(): void {
  generation += 1;
  for (const link of links.values()) URL.revokeObjectURL(link);
  links.clear();
  changed();
}
