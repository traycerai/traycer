import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  containsImageAtoms,
  hashOnlyImageHashes,
} from "@/lib/composer/image-atoms";
import { base64ToBytes, bytesToBase64Async } from "@/lib/composer/image-base64";
import {
  registerExtraImageRootSource,
  showLandingImageBudgetExceededToast,
  tryReserveLandingImageResidency,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import {
  getImageBytes,
  landingImagePartition,
  onLandingImagesDeleted,
  putImage,
  sha256Hex,
} from "@/lib/composer/landing-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { isJsonContent, isRecord } from "@/lib/editor/prosemirror-json";
import { appLogger } from "@/lib/logger";
import { persistKey, STORE_KEYS } from "@/lib/persist/keys";

/** What a bot's message box holds unsent, as the drafts store keeps it. */
export interface StoredBoxDraft {
  readonly text: string;
  readonly content: JsonContent | null;
  readonly seedId: number;
}

/** By bot, then by the box's conversation key. */
export type StoredBoxDrafts = Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, StoredBoxDraft>>>>>
>;

/** The slice of the drafts store kept on this device. */
export interface PersistedBotBoxDrafts {
  readonly threadBoxes: StoredBoxDrafts;
}

/**
 * Where every account's drafts were kept before each account's were kept
 * apart (T186, `botBoxDraftsKey`). Nobody owns what is stored there, so it is
 * never read: the drafts store removes it once an account signs in.
 */
export const LEGACY_BOT_BOX_DRAFTS_KEY = persistKey(STORE_KEYS.botBoxDrafts);

/** Each account's stored drafts are kept under a key that starts with this. */
const ACCOUNT_DRAFTS_PREFIX = `${LEGACY_BOT_BOX_DRAFTS_KEY}:`;

/** How long typing must pause before the boxes are written. */
export const BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS = 300;

/**
 * Where the bot message boxes' drafts are kept on this device (Tracy Bots
 * T158), as the agent composer keeps its drafts: the documents in
 * `localStorage`, each image's bytes in the composer image store under their
 * hash, the document naming the hash and the window that stored them. A
 * read puts the bytes back inline, which is how the box holds and sends an
 * image.
 *
 * A window never writes an image out of the drafts by failing to read it.
 * The image store is the window's own, so an image another window stored,
 * or one whose bytes cannot be read back here, is left out of this window's
 * box but kept in what is stored, a write of that box included
 * ({@link botBoxDraftCleared}). Only an image this window stored and its
 * image store no longer holds is dropped.
 *
 * Nor does a window write another's boxes away: every window's drafts share
 * one stored document, and a write puts only the boxes this window changed
 * since it last read or wrote them (its clears and forgotten bots included)
 * onto the document as it stands, leaving every other box as stored.
 *
 * Writes wait for typing to pause, and a page that is going away writes at
 * once, without the images not yet stored. Each image is admitted against
 * the composer image store's budget before it is stored; one the budget
 * refuses is written without, the person told once, and tried again on the
 * next write. Only a change to the boxes' drafts is written. Nothing is
 * written until the drafts store says the stored drafts are read and merged
 * ({@link botBoxDraftsRead}), so a change made while they are still being
 * read cannot replace them. A read that storage refuses fails, never reads as
 * nothing stored, so nothing is written for that account until a read does
 * succeed; a write that cannot read what is stored waits.
 */
export function createBotBoxDraftStorage(): PersistStorage<PersistedBotBoxDrafts> {
  return {
    getItem: async (name) => {
      if (writer.stopped) return null;
      const read = writer.readGeneration;
      const stored = readStoredValue(name);
      if (stored === null) return null;
      const state = await inlineStoredImages(stored.state, read);
      // The stored drafts were wiped while their images were read, or the
      // account whose drafts they are retired and another's are read now.
      if (wiped() || read !== writer.readGeneration) return null;
      writer.baseline = state.threadBoxes;
      return { ...stored, state };
    },
    setItem: (name, value) => {
      if (writer.stopped || !writer.read) return;
      const { threadBoxes } = value.state;
      if (threadBoxes === writer.lastThreadBoxes) return;
      writer.lastThreadBoxes = threadBoxes;
      schedule({ name, value });
    },
    removeItem: (name) => {
      dropWrites();
      writer.lastThreadBoxes = null;
      writer.baseline = {};
      localStorage.removeItem(name);
    },
  };
}

/**
 * The drafts store reads the stored drafts again: nothing is written until it
 * has. Returns the read's number, for {@link isCurrentBotBoxDraftsRead}.
 */
export function botBoxDraftsReading(): number {
  writer.read = false;
  writer.readGeneration += 1;
  writer.baseline = {};
  writer.unresolved = new Map();
  writer.gone = new Map();
  writer.droppedDuringRead.keys.clear();
  writer.droppedDuringRead.bots.clear();
  return writer.readGeneration;
}

/**
 * Whether the read numbered `read` is still the store's: one that an
 * account's retirement or a newer read overtook comes to nothing.
 */
export function isCurrentBotBoxDraftsRead(read: number): boolean {
  return read === writer.readGeneration;
}

/**
 * The account whose drafts the store holds is retiring (signed out, or
 * another signed in): what is waiting to be written lands now, under that
 * account's own key, as on a page hide. From then on nothing is written, and
 * a read still in flight is not taken, until the next account's drafts are
 * read.
 *
 * `midRead` is what the store holds when that account's own stored drafts
 * were still being read: what this window changed meanwhile, which has not
 * been written, and the boxes whose moves went below their stored draft
 * ({@link storedBotBoxDrafts}), land on them as they are stored, every other
 * box left as stored. `null` once they were read, or when their read failed:
 * unreadable drafts are never written over, nor are drafts storage cannot
 * read now (`land`).
 */
export function retireBotBoxDraftWrites(midRead: PendingWrite | null): void {
  if (midRead !== null && !writer.stopped && !writer.read) {
    takePending();
    // What the read found, if it got that far, is not this window's yet.
    writer.baseline = {};
    const { hashByInline } = writer;
    land(midRead, (b64content) => hashByInline.get(b64content));
  } else {
    flushPendingBotBoxDraftWrite();
  }
  dropWrites();
  writer.read = false;
  writer.readGeneration += 1;
  writer.lastThreadBoxes = null;
  writer.baseline = {};
  writer.hashByInline = new Map();
}

/**
 * The drafts stored under `name` as storage holds them now, each image named
 * by its hash, which a write keeps as it is: what an account retiring while
 * its drafts are still being read puts its moves below.
 */
export function storedBotBoxDrafts(name: string): StoredBoxDrafts {
  try {
    return readStoredValue(name)?.state.threadBoxes ?? {};
  } catch {
    // The write that follows cannot read them either, so it lands nothing.
    return {};
  }
}

/**
 * Removes the drafts every account shared before each account's were kept
 * apart, unread: whoever signs in first must not get another's.
 */
export function retireLegacyBotBoxDrafts(): void {
  try {
    localStorage.removeItem(LEGACY_BOT_BOX_DRAFTS_KEY);
  } catch {
    // Storage that cannot be reached holds nothing this window could read.
  }
}

/**
 * The person cleared or sent that box: the images it kept that this window
 * could not show go with it.
 */
export function botBoxDraftCleared(botId: string, key: string): void {
  const box = boxKeyOf(botId, key);
  if (!writer.read) writer.droppedDuringRead.keys.add(box);
  writer.unresolved.delete(box);
  writer.cleared.set(box, { botId, key });
}

/**
 * The bot is gone: the next write drops all its boxes, another window's
 * included, and the images its boxes kept that this window could not show.
 * Called before the drafts store's change that forgets it, which is then
 * written even where this window held none of the bot's boxes.
 */
export function botBoxDraftsForgotten(botId: string): void {
  if (!writer.read) writer.droppedDuringRead.bots.add(botId);
  writer.forgotten.add(botId);
  writer.lastThreadBoxes = null;
  for (const [box, unresolved] of writer.unresolved) {
    if (unresolved.botId === botId) writer.unresolved.delete(box);
  }
}

/**
 * The drafts store has read and merged the stored drafts: from here on its
 * changes are written. `changedDuringRead` writes the merged drafts at once,
 * for a change made while they were read reached no write.
 */
export function botBoxDraftsRead(input: {
  readonly name: string;
  readonly version: number;
  readonly threadBoxes: StoredBoxDrafts;
  readonly changedDuringRead: boolean;
}): void {
  if (writer.stopped) return;
  writer.read = true;
  writer.lastThreadBoxes = input.threadBoxes;
  if (!input.changedDuringRead) return;
  schedule({
    name: input.name,
    value: {
      state: { threadBoxes: input.threadBoxes },
      version: input.version,
    },
  });
}

/**
 * The stored drafts are being wiped: drops a write that has not landed and
 * writes nothing more from this window, nor takes a read that answers late,
 * where a write after the wipe, the reload's own included, would put them
 * back.
 */
export function stopBotBoxDraftWrites(): void {
  dropWrites();
  writer.stopped = true;
  writer.read = false;
}

/**
 * Writes now what is waiting, else what is being written, keeping only the
 * images already stored, whose hashes it keeps for the writes after it, the
 * next page hide's included. Written from what was being written, that write
 * still lands after it, with all its images, where the page is still there;
 * written from what was waiting, the older write being stored never lands.
 */
function flushPendingBotBoxDraftWrite(): void {
  if (writer.stopped) return;
  const { hashByInline, inFlightHashByInline } = writer;
  const pending = takePending();
  const write = pending ?? writer.inFlight;
  if (write === null) return;
  if (pending !== null) {
    // The write being stored is older than the one written now: it never lands.
    writer.inFlight = null;
    writer.inFlightHashByInline = new Map();
  }
  land(
    write,
    (b64content) =>
      hashByInline.get(b64content) ?? inFlightHashByInline.get(b64content),
  );
}

/** A write of the boxes' drafts: under which key, and what. */
export interface PendingWrite {
  readonly name: string;
  readonly value: StorageValue<PersistedBotBoxDrafts>;
}

/** One writer per window: the store it serves is a module singleton. */
const writer: {
  /** Whether the drafts store has read and merged the stored drafts. */
  read: boolean;
  /** Bumped by each read and each account's retirement; a read that sees it move is stale. */
  readGeneration: number;
  /** Set for good by a wipe. */
  stopped: boolean;
  /** The drafts last written or read, to tell a change to them from none. */
  lastThreadBoxes: StoredBoxDrafts | null;
  pending: PendingWrite | null;
  timer: number | null;
  /** The write whose images are being stored; `null` for none. */
  inFlight: PendingWrite | null;
  /** Bumped by each newer write and each wipe; a write that sees it move is stale. */
  generation: number;
  /**
   * The hash each inline image of this window's boxes is stored under, as of
   * the last write that landed, or as read back from storage.
   */
  hashByInline: ReadonlyMap<string, string>;
  /**
   * The images the write being stored has stored so far, kept from the image
   * store's sweeps until that write lands or a newer write or a wipe
   * overtakes it: an image only an overtaken write held is not kept.
   */
  inFlightHashByInline: Map<string, string>;
  /**
   * By box (`boxKeyOf`): the stored images the last read could not
   * put back in that box, kept in each write of it until the person clears
   * or sends the box or its bot is gone.
   */
  unresolved: Map<string, UnresolvedBox>;
  /**
   * By box (`boxKeyOf`): the images this window stored that the last read
   * found gone, until a write takes them out of what is stored.
   */
  gone: Map<string, GoneImages>;
  /** The boxes cleared and the bots forgotten while the stored drafts are read. */
  droppedDuringRead: { readonly keys: Set<string>; readonly bots: Set<string> };
  /**
   * This window's drafts as it last read or wrote them: a write puts only the
   * boxes that differ from them onto what is stored.
   */
  baseline: StoredBoxDrafts;
  /** The bots forgotten since the last write that landed: it drops all their boxes. */
  forgotten: Set<string>;
  /**
   * The boxes (`boxKeyOf`) the person cleared or sent since the last write
   * that landed: it writes each as this window holds it, whatever the
   * baseline says, for a box the read left nothing of in this window (one
   * holding only another window's images) differs from it in nothing.
   */
  cleared: Map<string, BoxAt>;
  /**
   * By box (`boxKeyOf`): the boxes the last write left an image out of, as
   * it wrote them. Written again while what is stored for the box is still
   * that, and left to whoever wrote it since otherwise.
   */
  incomplete: Map<string, IncompleteBox>;
  /** The hashes of the images the image budget refused: the person is told once for each. */
  refused: Set<string>;
} = {
  read: false,
  readGeneration: 0,
  stopped: false,
  lastThreadBoxes: null,
  pending: null,
  timer: null,
  inFlight: null,
  generation: 0,
  hashByInline: new Map(),
  inFlightHashByInline: new Map(),
  unresolved: new Map(),
  gone: new Map(),
  droppedDuringRead: { keys: new Set(), bots: new Set() },
  baseline: {},
  forgotten: new Set(),
  cleared: new Map(),
  incomplete: new Map(),
  refused: new Set(),
};

/** A box's stored images this window could not put back in it. */
interface UnresolvedBox {
  readonly botId: string;
  /** As stored: named by hash, with the window that stored them. */
  readonly images: ReadonlyArray<JsonContent>;
}

/** A box, by its bot and its key. */
interface BoxAt {
  readonly botId: string;
  readonly key: string;
}

/** A box's images this window stored whose bytes its image store no longer holds. */
interface GoneImages extends BoxAt {
  readonly hashes: ReadonlySet<string>;
}

/** A box a write left an image out of, and the draft it wrote for it. */
interface IncompleteBox extends BoxAt {
  readonly written: StoredBoxDraft;
}

function boxKeyOf(botId: string, key: string): string {
  return JSON.stringify([botId, key]);
}

/** Read through a call: an await between two reads can see a wipe land. */
function wiped(): boolean {
  return writer.stopped;
}

function schedule(write: PendingWrite): void {
  writer.pending = write;
  if (writer.timer !== null) window.clearTimeout(writer.timer);
  writer.timer = window.setTimeout(() => {
    writer.timer = null;
    void writePending();
  }, BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS);
}

/** The write waiting for typing to pause, taken: it is newer than any before it. */
function takePending(): PendingWrite | null {
  if (writer.timer !== null) window.clearTimeout(writer.timer);
  writer.timer = null;
  const pending = writer.pending;
  writer.pending = null;
  if (pending !== null) writer.generation += 1;
  return pending;
}

/** No write waiting or being written lands, nor carries what the stored drafts held. */
function dropWrites(): void {
  takePending();
  writer.inFlight = null;
  writer.inFlightHashByInline = new Map();
  writer.unresolved = new Map();
  writer.gone = new Map();
  writer.forgotten.clear();
  writer.cleared.clear();
  writer.incomplete.clear();
  writer.generation += 1;
}

async function writePending(): Promise<void> {
  const pending = takePending();
  if (pending === null) return;
  const generation = writer.generation;
  const stored = new Map<string, string>();
  writer.inFlight = pending;
  writer.inFlightHashByInline = stored;
  // Held until this write has landed or is overtaken: by then what it stored
  // is charged as the roots that name it, or is no one's.
  const admitted: LandingImageBudgetReservation[] = [];
  // Every image still to store is tried again on each write, so these are the
  // hashes of all the images a box still holds unstored.
  const tried = new Set<string>();
  try {
    await Promise.all(
      [...draftImages(pending.value.state)]
        .filter(([b64content]) => !writer.hashByInline.has(b64content))
        .map(async ([b64content, box]) => {
          const hash = await storeImage(b64content, box, admitted, tried);
          if (hash !== null) stored.set(b64content, hash);
        }),
    );
    if (writer.inFlight === pending) writer.inFlight = null;
    if (writer.inFlightHashByInline === stored) {
      writer.inFlightHashByInline = new Map();
    }
    // A newer write, or a wipe, came while the images were stored: the images
    // this one stored are kept only by what still names them.
    if (generation !== writer.generation || wiped()) return;
    for (const hash of writer.refused) {
      if (!tried.has(hash)) writer.refused.delete(hash);
    }
    const { hashByInline } = writer;
    land(
      pending,
      (b64content) => hashByInline.get(b64content) ?? stored.get(b64content),
    );
  } finally {
    for (const reservation of admitted) reservation.release();
  }
}

/**
 * Writes the boxes `write` changed onto the drafts as they are stored now,
 * each inline image named by the hash `hashOf` has for it and left out where
 * it has none; every other box stays as stored, whichever window wrote it.
 * From here on, the hashes of the images `write` names are the ones this
 * window's boxes hold.
 */
function land(
  write: PendingWrite,
  hashOf: (b64content: string) => string | undefined,
): void {
  const next = write.value.state.threadBoxes;
  const hashByInline = new Map<string, string>();
  for (const b64content of draftImages(write.value.state).keys()) {
    const hash = hashOf(b64content);
    if (hash !== undefined) hashByInline.set(b64content, hash);
  }
  writer.hashByInline = hashByInline;
  const partition = landingImagePartition();
  let threadBoxes: Partial<
    Record<string, Partial<Record<string, StoredBoxDraft>>>
  >;
  try {
    threadBoxes = editableDrafts(
      readStoredValue(write.name)?.state.threadBoxes ?? {},
    );
  } catch (error) {
    // The boxes it did not change are unknown, so it cannot keep them.
    writeFailed(write, error);
    return;
  }
  for (const botId of writer.forgotten) delete threadBoxes[botId];
  // Before this write's own boxes, which replace a box it changed anyway.
  takeOutGoneImages(threadBoxes, partition);
  const incomplete = putChangedBoxes(threadBoxes, next, partition);
  try {
    localStorage.setItem(
      write.name,
      JSON.stringify({ ...write.value, state: { threadBoxes } }),
    );
  } catch (error) {
    writeFailed(write, error);
    return;
  }
  writer.baseline = next;
  writer.forgotten.clear();
  writer.cleared.clear();
  writer.gone = new Map();
  writer.incomplete = incomplete;
}

/**
 * Storage could not be read for `write`, or refused it (full, say): it waits
 * again, for the next change to replace or the page hiding to try once more.
 * The error's name only: a quota error's message names the key, and the key
 * holds the account's id.
 */
function writeFailed(write: PendingWrite, error: unknown): void {
  appLogger.warn("[bot-box-drafts] draft write failed", {
    errorName: error instanceof Error ? error.name : "unknown",
  });
  writer.pending ??= write;
}

/**
 * Takes this window's own images the last read found gone out of each box as
 * stored, which may be another window's newer draft of it.
 */
function takeOutGoneImages(
  threadBoxes: Partial<Record<string, Partial<Record<string, StoredBoxDraft>>>>,
  partition: string,
): void {
  for (const { botId, key, hashes } of writer.gone.values()) {
    const draft = threadBoxes[botId]?.[key];
    if (draft === undefined || draft.content === null) continue;
    const content = withoutImages(draft.content, hashes, partition);
    // A box stored without those images stays as it is: an empty one is
    // another window's draft written ahead of its images, which its retry needs.
    if (content === draft.content) continue;
    const empty =
      draft.text.length === 0 &&
      (content === null || !containsImageAtoms(content));
    putBox(threadBoxes, botId, key, empty ? null : { ...draft, content });
  }
}

/**
 * Puts each box this window changed (`changedBoxes`) as it holds it now, or
 * takes it out where it holds nothing; returns the boxes written without an
 * image they hold, as written.
 */
function putChangedBoxes(
  threadBoxes: Partial<Record<string, Partial<Record<string, StoredBoxDraft>>>>,
  next: StoredBoxDrafts,
  partition: string,
): Map<string, IncompleteBox> {
  const incomplete = new Map<string, IncompleteBox>();
  for (const { botId, key } of changedBoxes(next, threadBoxes)) {
    const draft = next[botId]?.[key];
    const box = boxKeyOf(botId, key);
    if (draft === undefined) {
      putBox(threadBoxes, botId, key, null);
      continue;
    }
    const leftOut: string[] = [];
    const written = storedDraft(
      draft,
      writer.unresolved.get(box),
      partition,
      (b64) => {
        const hash = writer.hashByInline.get(b64) ?? null;
        if (hash === null) leftOut.push(b64);
        return hash;
      },
    );
    if (leftOut.length === 0) {
      putBox(threadBoxes, botId, key, written);
      continue;
    }
    // A draft of nothing but images not stored yet is kept as an empty one,
    // which a read leaves out of the box: what is stored for it then tells
    // this window's retry apart from another window clearing the box.
    const kept = written ?? { ...draft, content: { type: "doc", content: [] } };
    incomplete.set(box, { botId, key, written: kept });
    putBox(threadBoxes, botId, key, kept);
  }
  return incomplete;
}

/** Sets that box to `draft`, or takes it out for `null`, with its bot where it holds nothing more. */
function putBox(
  threadBoxes: Partial<Record<string, Partial<Record<string, StoredBoxDraft>>>>,
  botId: string,
  key: string,
  draft: StoredBoxDraft | null,
): void {
  const byKey = { ...threadBoxes[botId] };
  if (draft === null) delete byKey[key];
  else byKey[key] = draft;
  if (Object.keys(byKey).length === 0) delete threadBoxes[botId];
  else threadBoxes[botId] = byKey;
}

/**
 * `node` without the images `hashes` names that this window stored
 * (`partition`), and without a block they alone filled; `null` where nothing
 * is left of it, and `node` itself where it holds none of them.
 */
function withoutImages(
  node: JsonContent,
  hashes: ReadonlySet<string>,
  partition: string,
): JsonContent | null {
  if (node.type === "imageAttachment") {
    const hash = stringValue(node.attrs?.hash);
    const ours = node.attrs?.partition === partition;
    return hash !== null && ours && hashes.has(hash) ? null : node;
  }
  const children = node.content;
  if (children === undefined) return node;
  const next: JsonContent[] = [];
  let removed = false;
  for (const child of children) {
    const kept = withoutImages(child, hashes, partition);
    if (kept !== child) removed = true;
    if (kept !== null) next.push(kept);
  }
  if (!removed) return node;
  if (next.length === 0) return null;
  return { ...node, content: next };
}

/** The drafts as stored, copied down to each bot's boxes so a write can change them. */
function editableDrafts(
  drafts: StoredBoxDrafts,
): Partial<Record<string, Partial<Record<string, StoredBoxDraft>>>> {
  const copy: Partial<Record<string, Partial<Record<string, StoredBoxDraft>>>> =
    {};
  for (const [botId, byKey] of Object.entries(drafts)) {
    if (byKey !== undefined) copy[botId] = { ...byKey };
  }
  return copy;
}

/**
 * The boxes this window changed: those whose draft in `next` differs from
 * this window's baseline, one it cleared included; those the person cleared
 * or sent since the last write that landed; and those the last write left an
 * image out of, while `stored` still holds for them what it wrote.
 */
function changedBoxes(
  next: StoredBoxDrafts,
  stored: StoredBoxDrafts,
): ReadonlyArray<BoxAt> {
  const { baseline } = writer;
  const candidates: BoxAt[] = [
    ...writer.cleared.values(),
    ...writer.incomplete.values(),
  ];
  for (const drafts of [baseline, next]) {
    for (const [botId, key] of eachBox(drafts)) {
      candidates.push({ botId, key });
    }
  }
  const changed = new Map<string, BoxAt>();
  for (const { botId, key } of candidates) {
    const box = boxKeyOf(botId, key);
    if (changed.has(box)) continue;
    const incomplete = writer.incomplete.get(box);
    if (
      writer.cleared.has(box) ||
      !sameDraft(baseline[botId]?.[key], next[botId]?.[key]) ||
      (incomplete !== undefined &&
        sameDraft(incomplete.written, stored[botId]?.[key]))
    ) {
      changed.set(box, { botId, key });
    }
  }
  return [...changed.values()];
}

/** Whether two drafts of one box hold the same, compared by value where they are not one object. */
function sameDraft(
  a: StoredBoxDraft | undefined,
  b: StoredBoxDraft | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.text === b.text &&
    a.seedId === b.seedId &&
    (a.content === b.content ||
      JSON.stringify(a.content) === JSON.stringify(b.content))
  );
}

/** The bytes of every inline image the drafts hold, each with the first box holding it. */
function draftImages(state: PersistedBotBoxDrafts): Map<string, string> {
  const images = new Map<string, string>();
  for (const [botId, key, draft] of eachBox(state.threadBoxes)) {
    if (draft.content === null) continue;
    for (const b64content of inlineImages(draft.content)) {
      if (!images.has(b64content)) {
        images.set(b64content, boxKeyOf(botId, key));
      }
    }
  }
  return images;
}

/**
 * The image's bytes stored under their hash, once the image budget has
 * admitted them (`admitted` takes the reservation, `tried` the hash); `null`
 * where they cannot be. A refusal tells the person once per image, as a
 * refused paste does.
 */
async function storeImage(
  b64content: string,
  box: string,
  admitted: LandingImageBudgetReservation[],
  tried: Set<string>,
): Promise<string | null> {
  const bytes = base64ToBytes(b64content);
  if (bytes === null) return null;
  const hash = await contentHash(bytes);
  if (hash !== null) tried.add(hash);
  // As bytes becoming resident: a hash another window's draft names is a root
  // whose bytes this window's image store does not hold, and storing them
  // here adds them; a hash this store holds still costs nothing more.
  const reservation = tryReserveLandingImageResidency([
    { hash, bytes: bytes.byteLength },
  ]);
  if (reservation === null) {
    if (hash === null || !writer.refused.has(hash)) {
      if (hash !== null) writer.refused.add(hash);
      showLandingImageBudgetExceededToast(box);
    }
    return null;
  }
  if (hash !== null) writer.refused.delete(hash);
  admitted.push(reservation);
  return putImage(bytes).catch(() => null);
}

/** The image's content hash, `null` where it cannot be taken: the budget then charges it in full. */
async function contentHash(bytes: ImageBytes): Promise<string | null> {
  return sha256Hex(bytes).catch(() => null);
}

function inlineImages(node: JsonContent): ReadonlyArray<string> {
  if (node.type === "imageAttachment") {
    const b64content = stringValue(node.attrs?.b64content);
    return b64content === null ? [] : [b64content];
  }
  return node.content?.flatMap(inlineImages) ?? [];
}

/**
 * The draft as it is stored: each inline image named by its hash and this
 * window's image store (`partition`) instead of carrying its bytes, and left
 * out where `hashOf` has none for it; then, in a paragraph of their own at
 * the end, the images the box held that this window could not put back in
 * it (`unresolved`). `null` for a draft left with nothing in it.
 */
function storedDraft(
  draft: StoredBoxDraft,
  unresolved: UnresolvedBox | undefined,
  partition: string,
  hashOf: (b64content: string) => string | null,
): StoredBoxDraft | null {
  const rewritten =
    draft.content === null
      ? null
      : rewriteNode(draft.content, hashOf, partition);
  let content =
    rewritten === null || (rewritten.content?.length ?? 0) === 0
      ? null
      : rewritten;
  if (unresolved !== undefined) {
    const doc = content ?? { type: "doc", content: [] };
    content = {
      ...doc,
      content: [
        ...(doc.content ?? []),
        { type: "paragraph", content: [...unresolved.images] },
      ],
    };
  }
  if (
    draft.text.length === 0 &&
    (content === null || !containsImageAtoms(content))
  ) {
    return null;
  }
  return { ...draft, content };
}

function rewriteNode(
  node: JsonContent,
  hashOf: (b64content: string) => string | null,
  partition: string,
): JsonContent | null {
  if (node.type === "imageAttachment") {
    const b64content = stringValue(node.attrs?.b64content);
    if (b64content === null) return node;
    const hash = hashOf(b64content);
    if (hash === null) return null;
    const { b64content: _bytes, ...attrs } = node.attrs ?? {};
    return { ...node, attrs: { ...attrs, hash, partition } };
  }
  const children = node.content;
  if (children === undefined) return node;
  const next: JsonContent[] = [];
  for (const child of children) {
    const rewritten = rewriteNode(child, hashOf, partition);
    if (rewritten !== null) next.push(rewritten);
  }
  return { ...node, content: next };
}

/** What a read found for a stored image's hash in this window's image store. */
type ReadBack =
  | { readonly kind: "bytes"; readonly b64content: string }
  | { readonly kind: "gone" }
  | { readonly kind: "unreadable" };

const GONE: ReadBack = { kind: "gone" };
const UNREADABLE: ReadBack = { kind: "unreadable" };

/** A failed read or encode is `unreadable`, never `gone`: it fails that image only. */
async function readBack(hash: string): Promise<ReadBack> {
  let bytes: ImageBytes | undefined;
  try {
    bytes = await getImageBytes(hash);
  } catch {
    return UNREADABLE;
  }
  if (bytes === undefined) return GONE;
  return bytesToBase64Async(bytes).then(
    (b64content): ReadBack => ({ kind: "bytes", b64content }),
    (): ReadBack => UNREADABLE,
  );
}

/**
 * Every stored draft with its images' bytes back inline; a draft left with
 * nothing in it is dropped. An image this window stored and its image store
 * no longer holds is dropped. Any other image it cannot read back is left
 * out of the box and kept for its writes (`writer.unresolved`). Each image
 * read back is remembered under its hash, so a write that cannot wait keeps
 * it.
 */
async function inlineStoredImages(
  state: PersistedBotBoxDrafts,
  read: number,
): Promise<PersistedBotBoxDrafts> {
  const hashes = new Set<string>();
  for (const draft of eachDraft(state.threadBoxes)) {
    if (draft.content === null) continue;
    for (const hash of hashOnlyImageHashes(draft.content)) hashes.add(hash);
  }
  const found = new Map<string, ReadBack>();
  await Promise.all(
    [...hashes].map(async (hash) => {
      found.set(hash, await readBack(hash));
    }),
  );
  const partition = landingImagePartition();
  const unresolved = new Map<string, UnresolvedBox>();
  const gone = new Map<string, GoneImages>();
  const threadBoxes = mapDrafts(state.threadBoxes, (draft, botId, key) => {
    if (draft.content === null) return draft;
    const out: RestoreOut = { left: [], gone: [] };
    const content = restoreNode(draft.content, found, partition, out) ?? {
      type: "doc",
      content: [],
    };
    if (out.left.length > 0) {
      unresolved.set(boxKeyOf(botId, key), { botId, images: out.left });
    }
    if (out.gone.length > 0) {
      gone.set(boxKeyOf(botId, key), {
        botId,
        key,
        hashes: new Set(out.gone),
      });
    }
    if (draft.text.length === 0 && !containsImageAtoms(content)) return null;
    return {
      ...draft,
      content: (content.content?.length ?? 0) === 0 ? null : content,
    };
  });
  // A read overtaken meanwhile leaves the writer to the read that overtook it.
  if (!wiped() && read === writer.readGeneration) {
    const restored = new Map<string, string>();
    for (const [hash, outcome] of found) {
      if (outcome.kind === "bytes") restored.set(outcome.b64content, hash);
    }
    writer.hashByInline = new Map([...writer.hashByInline, ...restored]);
    const { keys, bots } = writer.droppedDuringRead;
    writer.unresolved = new Map(
      [...unresolved].filter(
        ([box, { botId }]) => !keys.has(box) && !bots.has(botId),
      ),
    );
    writer.gone = gone;
  }
  return { threadBoxes };
}

/** What a read could not put back in a box's document. */
interface RestoreOut {
  /** The images it left out to keep: another window's, or unreadable here. */
  readonly left: JsonContent[];
  /** The hashes of the images this window stored whose bytes are gone. */
  readonly gone: string[];
}

/**
 * `node` with each stored image's bytes back inline. An image it cannot put
 * back is left out: to `out.gone` where this window stored it (`partition`)
 * and its image store no longer holds it, to `out.left` otherwise.
 */
function restoreNode(
  node: JsonContent,
  found: ReadonlyMap<string, ReadBack>,
  partition: string,
  out: RestoreOut,
): JsonContent | null {
  if (node.type === "imageAttachment") {
    const {
      hash: storedHash,
      partition: storedIn,
      ...attrs
    } = node.attrs ?? {};
    const hash = stringValue(storedHash);
    if (hash === null || stringValue(attrs.b64content) !== null) return node;
    const outcome = found.get(hash);
    if (outcome?.kind === "bytes") {
      return { ...node, attrs: { ...attrs, b64content: outcome.b64content } };
    }
    if (outcome?.kind === "gone" && storedIn === partition) out.gone.push(hash);
    else out.left.push(node);
    return null;
  }
  const children = node.content;
  if (children === undefined) return node;
  const next: JsonContent[] = [];
  for (const child of children) {
    const restored = restoreNode(child, found, partition, out);
    if (restored !== null) next.push(restored);
  }
  // A block that held nothing but images left out goes with them: the
  // paragraph a write carries them in is one, and keeping it would add an
  // empty line to the draft on every read and write here. An empty paragraph
  // the person wrote had nothing to leave out, and stays.
  if (node.type !== "doc" && children.length > 0 && next.length === 0) {
    return null;
  }
  return { ...node, content: next };
}

function mapDrafts(
  drafts: StoredBoxDrafts,
  map: (
    draft: StoredBoxDraft,
    botId: string,
    key: string,
  ) => StoredBoxDraft | null,
): StoredBoxDrafts {
  const byBot: Partial<
    Record<string, Partial<Record<string, StoredBoxDraft>>>
  > = {};
  for (const [botId, byKey] of Object.entries(drafts)) {
    if (byKey === undefined) continue;
    const next: Partial<Record<string, StoredBoxDraft>> = {};
    for (const [key, draft] of Object.entries(byKey)) {
      if (draft === undefined) continue;
      const mapped = map(draft, botId, key);
      if (mapped !== null) next[key] = mapped;
    }
    if (Object.keys(next).length > 0) byBot[botId] = next;
  }
  return byBot;
}

function* eachDraft(drafts: StoredBoxDrafts): Generator<StoredBoxDraft> {
  for (const [, , draft] of eachBox(drafts)) yield draft;
}

/** Each draft with the bot and the key of its box. */
function* eachBox(
  drafts: StoredBoxDrafts,
): Generator<readonly [string, string, StoredBoxDraft]> {
  for (const [botId, byKey] of Object.entries(drafts)) {
    if (byKey === undefined) continue;
    for (const [key, draft] of Object.entries(byKey)) {
      if (draft !== undefined) yield [botId, key, draft];
    }
  }
}

/**
 * The drafts a stored value holds, by bot and key, leaving out anything that
 * does not read as a draft.
 */
export function storedBoxDraftsOf(value: unknown): StoredBoxDrafts {
  if (!isRecord(value)) return {};
  const byBot: Partial<
    Record<string, Partial<Record<string, StoredBoxDraft>>>
  > = {};
  for (const [botId, byKey] of Object.entries(value)) {
    if (!isRecord(byKey)) continue;
    const drafts: Partial<Record<string, StoredBoxDraft>> = {};
    for (const [key, draft] of Object.entries(byKey)) {
      const stored = storedDraftOf(draft);
      if (stored !== null) drafts[key] = stored;
    }
    if (Object.keys(drafts).length > 0) byBot[botId] = drafts;
  }
  return byBot;
}

function storedDraftOf(value: unknown): StoredBoxDraft | null {
  if (!isRecord(value)) return null;
  const { text, content, seedId } = value;
  if (typeof text !== "string" || typeof seedId !== "number") return null;
  if (content !== null && !isJsonContent(content, 0)) return null;
  return { text, content, seedId };
}

/**
 * The drafts stored under `name`; `null` when nothing is, or what is cannot be
 * parsed as drafts by any build, so writing over it loses nothing readable.
 * Throws when storage cannot be read: what it holds is unknown, so a read
 * fails and a write waits rather than replacing it.
 */
function readStoredValue(
  name: string,
): StorageValue<PersistedBotBoxDrafts> | null {
  const raw = localStorage.getItem(name);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
  return {
    state: { threadBoxes: storedBoxDraftsOf(parsed.state.threadBoxes) },
    version: typeof parsed.version === "number" ? parsed.version : 0,
  };
}

/**
 * The image hashes the image store's sweeps must keep for the bot boxes: the
 * ones every account's stored drafts on this device name as storage holds them
 * now, whichever window wrote them, for an account signed out keeps its drafts
 * and their images; the ones this window's boxes held at the last write that
 * landed, or read back; and the ones the newest write has stored so far.
 */
function botBoxDraftImageRoots(): ReadonlyArray<string> {
  const roots = new Set([
    ...writer.hashByInline.values(),
    ...writer.inFlightHashByInline.values(),
  ]);
  for (const name of accountDraftKeys()) {
    let stored: StorageValue<PersistedBotBoxDrafts> | null;
    try {
      stored = readStoredValue(name);
    } catch {
      // As for the keys: storage that cannot be read names no image.
      continue;
    }
    if (stored === null) continue;
    for (const draft of eachDraft(stored.state.threadBoxes)) {
      if (draft.content === null) continue;
      for (const hash of hashOnlyImageHashes(draft.content)) roots.add(hash);
    }
  }
  return [...roots];
}

/** The keys every account's stored drafts on this device are kept under. */
function accountDraftKeys(): ReadonlyArray<string> {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(ACCOUNT_DRAFTS_PREFIX) === true) keys.push(key);
    }
  } catch {
    // Storage that cannot be reached names no image.
    return [];
  }
  return keys;
}

registerExtraImageRootSource({ hashes: botBoxDraftImageRoots });

// Another window's wipe deleted this window's image store: none of the images
// it stored are there any more, so each write from now on stores its boxes'
// images again, and a write storing its images there is written again, after
// any newer one waiting.
onLandingImagesDeleted(() => {
  if (writer.stopped) return;
  writer.hashByInline = new Map();
  const inFlight = writer.inFlight;
  writer.inFlight = null;
  writer.inFlightHashByInline = new Map();
  writer.generation += 1;
  if (inFlight !== null && writer.pending === null) schedule(inFlight);
});

// A window that goes away mid-pause still keeps what its boxes held.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingBotBoxDraftWrite);
}
