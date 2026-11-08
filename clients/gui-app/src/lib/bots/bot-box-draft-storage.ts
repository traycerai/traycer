import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  containsImageAtoms,
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
  omitImageAtomsByHash,
} from "@/lib/composer/image-atoms";
import { base64ToBytes, bytesToBase64Async } from "@/lib/composer/image-base64";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { getImageBytes, putImage } from "@/lib/composer/landing-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { isJsonContent, isRecord } from "@/lib/editor/prosemirror-json";
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

export const BOT_BOX_DRAFTS_PERSIST_KEY = persistKey(STORE_KEYS.botBoxDrafts);

/** How long typing must pause before the boxes are written. */
export const BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS = 300;

/**
 * Where the bot message boxes' drafts are kept on this device (Tracy Bots
 * T158), as the agent composer keeps its drafts: the documents in
 * `localStorage`, each image's bytes in the composer image store under their
 * hash, the document naming the hash. A read puts the bytes back inline,
 * which is how the box holds and sends an image, and leaves out an image
 * whose bytes are gone.
 *
 * Writes wait for typing to pause, and a page that is going away writes at
 * once, without the images not yet stored. Only a change to the boxes'
 * drafts is written. Nothing is written until the drafts store says the
 * stored drafts are read and merged ({@link botBoxDraftsRead}), so a change
 * made while they are still being read cannot replace them.
 */
export function createBotBoxDraftStorage(): PersistStorage<PersistedBotBoxDrafts> {
  return {
    getItem: async (name) => {
      if (writer.stopped) return null;
      const stored = readStoredValue(name);
      if (stored === null) return null;
      const state = await inlineStoredImages(stored.state);
      // The stored drafts were wiped while their images were read.
      if (wiped()) return null;
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
      localStorage.removeItem(name);
    },
  };
}

/** The drafts store reads the stored drafts again: nothing is written until it has. */
export function botBoxDraftsReading(): void {
  writer.read = false;
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
export function flushPendingBotBoxDraftWrite(): void {
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

interface PendingWrite {
  readonly name: string;
  readonly value: StorageValue<PersistedBotBoxDrafts>;
}

/** One writer per window: the store it serves is a module singleton. */
const writer: {
  /** Whether the drafts store has read and merged the stored drafts. */
  read: boolean;
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
} = {
  read: false,
  stopped: false,
  lastThreadBoxes: null,
  pending: null,
  timer: null,
  inFlight: null,
  generation: 0,
  hashByInline: new Map(),
  inFlightHashByInline: new Map(),
};

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

/** No write waiting or being written lands. */
function dropWrites(): void {
  takePending();
  writer.inFlight = null;
  writer.inFlightHashByInline = new Map();
  writer.generation += 1;
}

async function writePending(): Promise<void> {
  const pending = takePending();
  if (pending === null) return;
  const generation = writer.generation;
  const stored = new Map<string, string>();
  writer.inFlight = pending;
  writer.inFlightHashByInline = stored;
  await Promise.all(
    [...draftImages(pending.value.state)]
      .filter((b64content) => !writer.hashByInline.has(b64content))
      .map(async (b64content) => {
        const hash = await storeImage(b64content);
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
  const { hashByInline } = writer;
  land(
    pending,
    (b64content) => hashByInline.get(b64content) ?? stored.get(b64content),
  );
}

/**
 * Writes `write`, each inline image named by the hash `hashOf` has for it and
 * left out where it has none; from here on, the hashes of the images it
 * names are the ones this window's boxes hold.
 */
function land(
  write: PendingWrite,
  hashOf: (b64content: string) => string | undefined,
): void {
  const hashByInline = new Map<string, string>();
  for (const b64content of draftImages(write.value.state)) {
    const hash = hashOf(b64content);
    if (hash !== undefined) hashByInline.set(b64content, hash);
  }
  writer.hashByInline = hashByInline;
  const value: StorageValue<PersistedBotBoxDrafts> = {
    ...write.value,
    state: storedState(
      write.value.state,
      (b64content) => hashByInline.get(b64content) ?? null,
    ),
  };
  localStorage.setItem(write.name, JSON.stringify(value));
}

/** The bytes of every inline image the drafts hold. */
function draftImages(state: PersistedBotBoxDrafts): Set<string> {
  const images = new Set<string>();
  for (const draft of eachDraft(state.threadBoxes)) {
    if (draft.content === null) continue;
    for (const b64content of inlineImages(draft.content))
      images.add(b64content);
  }
  return images;
}

/** The image's bytes stored under their hash; `null` where they cannot be. */
async function storeImage(b64content: string): Promise<string | null> {
  const bytes = base64ToBytes(b64content);
  if (bytes === null) return null;
  return putImage(bytes).catch(() => null);
}

function inlineImages(node: JsonContent): ReadonlyArray<string> {
  if (node.type === "imageAttachment") {
    const b64content = stringValue(node.attrs?.b64content);
    return b64content === null ? [] : [b64content];
  }
  return node.content?.flatMap(inlineImages) ?? [];
}

/**
 * The drafts as they are stored: each inline image named by its hash instead
 * of carrying its bytes, and left out where `hashOf` has none for it. A
 * draft left with nothing in it is dropped.
 */
function storedState(
  state: PersistedBotBoxDrafts,
  hashOf: (b64content: string) => string | null,
): PersistedBotBoxDrafts {
  return {
    threadBoxes: mapDrafts(state.threadBoxes, (draft) => {
      if (draft.content === null) return draft;
      const rewritten = rewriteNode(draft.content, hashOf);
      const content =
        rewritten === null || (rewritten.content?.length ?? 0) === 0
          ? null
          : rewritten;
      if (
        draft.text.length === 0 &&
        (content === null || !containsImageAtoms(content))
      ) {
        return null;
      }
      return { ...draft, content };
    }),
  };
}

function rewriteNode(
  node: JsonContent,
  hashOf: (b64content: string) => string | null,
): JsonContent | null {
  if (node.type === "imageAttachment") {
    const b64content = stringValue(node.attrs?.b64content);
    if (b64content === null) return node;
    const hash = hashOf(b64content);
    if (hash === null) return null;
    const { b64content: _bytes, ...attrs } = node.attrs ?? {};
    return { ...node, attrs: { ...attrs, hash } };
  }
  const children = node.content;
  if (children === undefined) return node;
  const next: JsonContent[] = [];
  for (const child of children) {
    const rewritten = rewriteNode(child, hashOf);
    if (rewritten !== null) next.push(rewritten);
  }
  return { ...node, content: next };
}

/**
 * Every stored draft with its images' bytes back inline, and without the
 * images whose bytes are gone or cannot be read back, so one such image
 * never fails the whole read; a draft left with nothing in it is dropped.
 * Each image read back is remembered under its hash, so a write that cannot
 * wait keeps it.
 */
async function inlineStoredImages(
  state: PersistedBotBoxDrafts,
): Promise<PersistedBotBoxDrafts> {
  const hashes = new Set<string>();
  for (const draft of eachDraft(state.threadBoxes)) {
    if (draft.content === null) continue;
    for (const hash of hashOnlyImageHashes(draft.content)) hashes.add(hash);
  }
  const bytesByHash = new Map<string, string>();
  const missing = new Set<string>();
  const restored = new Map<string, string>();
  await Promise.all(
    [...hashes].map(async (hash) => {
      const bytes = await getImageBytes(hash).catch(() => undefined);
      const b64content =
        bytes === undefined
          ? null
          : await bytesToBase64Async(bytes).catch(() => null);
      if (b64content === null) {
        missing.add(hash);
        return;
      }
      bytesByHash.set(hash, b64content);
      restored.set(b64content, hash);
    }),
  );
  if (!wiped()) {
    writer.hashByInline = new Map([...writer.hashByInline, ...restored]);
  }
  return {
    threadBoxes: mapDrafts(state.threadBoxes, (draft) => {
      if (draft.content === null) return draft;
      const content = omitImageAtomsByHash(
        inlineHashOnlyImageBytes(draft.content, bytesByHash),
        missing,
      );
      if (draft.text.length === 0 && !containsImageAtoms(content)) return null;
      return {
        ...draft,
        content: (content.content?.length ?? 0) === 0 ? null : content,
      };
    }),
  };
}

function mapDrafts(
  drafts: StoredBoxDrafts,
  map: (draft: StoredBoxDraft) => StoredBoxDraft | null,
): StoredBoxDrafts {
  const byBot: Partial<
    Record<string, Partial<Record<string, StoredBoxDraft>>>
  > = {};
  for (const [botId, byKey] of Object.entries(drafts)) {
    if (byKey === undefined) continue;
    const next: Partial<Record<string, StoredBoxDraft>> = {};
    for (const [key, draft] of Object.entries(byKey)) {
      if (draft === undefined) continue;
      const mapped = map(draft);
      if (mapped !== null) next[key] = mapped;
    }
    if (Object.keys(next).length > 0) byBot[botId] = next;
  }
  return byBot;
}

function* eachDraft(drafts: StoredBoxDrafts): Generator<StoredBoxDraft> {
  for (const byKey of Object.values(drafts)) {
    if (byKey === undefined) continue;
    for (const draft of Object.values(byKey)) {
      if (draft !== undefined) yield draft;
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

function readStoredValue(
  name: string,
): StorageValue<PersistedBotBoxDrafts> | null {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(name);
    if (raw === null) return null;
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
 * ones the stored drafts name as storage holds them now, whichever window
 * wrote them; the ones this window's boxes held at the last write that
 * landed, or read back; and the ones the newest write has stored so far.
 */
function botBoxDraftImageRoots(): ReadonlyArray<string> {
  const roots = new Set([
    ...writer.hashByInline.values(),
    ...writer.inFlightHashByInline.values(),
  ]);
  const stored = readStoredValue(BOT_BOX_DRAFTS_PERSIST_KEY);
  if (stored !== null) {
    for (const draft of eachDraft(stored.state.threadBoxes)) {
      if (draft.content === null) continue;
      for (const hash of hashOnlyImageHashes(draft.content)) roots.add(hash);
    }
  }
  return [...roots];
}

registerExtraImageRootSource({ hashes: botBoxDraftImageRoots });

// A window that goes away mid-pause still keeps what its boxes held.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingBotBoxDraftWrite);
}
