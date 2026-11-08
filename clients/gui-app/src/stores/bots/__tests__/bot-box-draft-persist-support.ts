import { vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import type * as DraftStorage from "@/lib/bots/bot-box-draft-storage";
import type { StoredBoxDrafts } from "@/lib/bots/bot-box-draft-storage";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { BOT_TOKEN_CONTEXT_TYPE } from "@/lib/composer/tiptap-json-content";
import type { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";

/**
 * What the suites of the bot boxes' kept drafts share (Tracy Bots T158): an
 * app that really starts - fresh modules over the same `localStorage` and
 * IndexedDB, as a restart leaves them - with the real drafts store, the
 * stored value as written, and documents with a mention and an inline image.
 * Nothing here imports the storage or the store statically: each start loads
 * its own.
 */

/** Hand-written: the key the boxes' drafts are stored under. */
export const BOX_DRAFTS_KEY = "traycer-gui-app:bot-box-drafts";
export const OWNER_LABEL = "Message Tracy";
export const CHANNEL = "conversation-channel";
export const THREAD = "post-1";
export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const IMAGE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** One run of the app: the modules it loaded, and how it ends. */
export interface App {
  readonly storage: typeof DraftStorage;
  readonly drafts: typeof useBotDraftsStore;
  /** The image hashes the image store's sweeps must keep, as this run reads them. */
  readonly imageRoots: () => ReadonlySet<string>;
  /** The window goes away: this run writes nothing more. */
  readonly close: () => void;
}

let running: App | null = null;

/**
 * The app starts over what is stored, with modules of its own; the previous
 * run, if any, has ended. Returns once the modules are loaded: the stored
 * drafts may still be being read (`hydrated`).
 */
export async function startApp(): Promise<App> {
  running?.close();
  const app = await loadApp();
  running = app;
  return app;
}

/**
 * A second window of the app, started beside the running one over the same
 * storage, with modules of its own; the caller closes it. Returns once the
 * modules are loaded, as {@link startApp} does.
 */
export async function startWindowBeside(): Promise<App> {
  return loadApp();
}

async function loadApp(): Promise<App> {
  vi.resetModules();
  const storage = await import("@/lib/bots/bot-box-draft-storage");
  const { useBotDraftsStore: drafts } =
    await import("@/stores/bots/bot-drafts-store");
  const budget = await import("@/lib/composer/landing-image-budget");
  return {
    storage,
    drafts,
    imageRoots: budget.landingLiveImageRootHashes,
    close: storage.stopBotBoxDraftWrites,
  };
}

/** The app's drafts store has read and merged what was stored. */
export async function hydrated(app: App): Promise<App> {
  if (app.drafts.persist.hasHydrated()) return app;
  await new Promise<void>((resolve) => {
    const stop = app.drafts.persist.onFinishHydration(() => {
      stop();
      resolve();
    });
  });
  return app;
}

/** The first start of the app on a device holding nothing. */
export async function startFresh(): Promise<App> {
  running?.close();
  localStorage.clear();
  installFreshIndexedDb();
  return hydrated(await startApp());
}

/** The app is started again over what is stored, and has read it. */
export async function restart(): Promise<App> {
  return hydrated(await startApp());
}

/** The bytes of `IMAGE_B64` stored in the image store as a draft's write leaves them; their hash. */
export async function storeImageBytes(): Promise<string> {
  const { putImage } = await import("@/lib/composer/landing-image-store");
  const { base64ToBytes } = await import("@/lib/composer/image-base64");
  const bytes = base64ToBytes(IMAGE_B64);
  if (bytes === null) throw new Error("the fixture image decodes");
  return putImage(bytes);
}

/** A paragraph of `text`, then `extras`. */
export function boxDoc(
  text: string,
  extras: ReadonlyArray<JsonContent>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }, ...extras],
      },
    ],
  };
}

export const MENTION: JsonContent = {
  type: "mention",
  attrs: {
    contextType: BOT_TOKEN_CONTEXT_TYPE,
    id: "<@user-1>",
    label: "Ada",
  },
};

/** An image carrying its bytes, as the box holds it. */
export const INLINE_IMAGE: JsonContent = {
  type: "imageAttachment",
  attrs: {
    id: "image-1",
    fileName: "shot.png",
    mimeType: "image/png",
    b64content: IMAGE_B64,
  },
};

/**
 * An image named by its hash, as the drafts are stored by this window: one
 * with no desktop window id keeps its images under `"default"`.
 */
export function hashedImage(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: "image-1",
      fileName: "shot.png",
      mimeType: "image/png",
      hash,
      partition: "default",
    },
  };
}

/** Writes `drafts` where a run of the app - this window's or another's - leaves them. */
export function storeDraftsAsLeft(drafts: StoredBoxDrafts): void {
  localStorage.setItem(
    BOX_DRAFTS_KEY,
    JSON.stringify({ state: { threadBoxes: drafts }, version: 1 }),
  );
}

/** The drafts as `localStorage` holds them; `null` while nothing was written. */
export function storedDrafts(app: App): StoredBoxDrafts | null {
  const raw = localStorage.getItem(BOX_DRAFTS_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
  return app.storage.storedBoxDraftsOf(parsed.state.threadBoxes);
}

/**
 * Lets typing pause past the debounce, and waits until `landed` holds of what
 * is stored. Needs `vi.useFakeTimers({ toFake: ["setTimeout",
 * "clearTimeout"] })`: the write waits on the debounce, and the fake
 * IndexedDB runs on the real clock.
 */
export async function waitForStore(
  app: App,
  landed: (drafts: StoredBoxDrafts | null) => boolean,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(
    app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS,
  );
  await vi.waitFor(() => {
    if (!landed(storedDrafts(app)))
      throw new Error("the drafts are not stored");
  });
}

/** Lets typing pause well past the debounce: whatever was going to land has. */
export async function pastTheDebounce(app: App): Promise<void> {
  await vi.advanceTimersByTimeAsync(
    app.storage.BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS * 3,
  );
}
