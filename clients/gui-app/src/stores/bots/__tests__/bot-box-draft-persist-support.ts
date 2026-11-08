import { vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS,
  stopBotBoxDraftWrites,
  storedBoxDraftsOf,
  type StoredBoxDrafts,
} from "@/lib/bots/bot-box-draft-storage";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { BOT_TOKEN_CONTEXT_TYPE } from "@/lib/composer/tiptap-json-content";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";

/**
 * What the suites of the bot boxes' kept drafts share (Tracy Bots T158): the
 * real drafts store over the real `localStorage` and a fake IndexedDB for the
 * image bytes, the stored value as written, and documents with a mention and
 * an inline image.
 */

/** Hand-written: the key the boxes' drafts are stored under. */
export const BOX_DRAFTS_KEY = "traycer-gui-app:bot-box-drafts";
export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const IMAGE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

/** An image named by its hash, as the drafts are stored. */
export function hashedImage(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: { id: "image-1", fileName: "shot.png", mimeType: "image/png", hash },
  };
}

/** Writes `drafts` where a previous run of the app left them. */
export function storeDraftsAsLeft(drafts: StoredBoxDrafts): void {
  localStorage.setItem(
    BOX_DRAFTS_KEY,
    JSON.stringify({ state: { threadBoxes: drafts }, version: 1 }),
  );
}

/** The drafts as `localStorage` holds them; `null` while nothing was written. */
export function storedDrafts(): StoredBoxDrafts | null {
  const raw = localStorage.getItem(BOX_DRAFTS_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
  return storedBoxDraftsOf(parsed.state.threadBoxes);
}

/**
 * Every test starts as a fresh start of the app: nothing stored, no bytes,
 * and the store having read that. Needs `vi.useFakeTimers({ toFake:
 * ["setTimeout", "clearTimeout"] })`: the write waits on the debounce, and
 * the fake IndexedDB runs on the real clock.
 */
export async function startFresh(): Promise<void> {
  stopBotBoxDraftWrites();
  localStorage.clear();
  installFreshIndexedDb();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {}, unsentBoxes: {} });
  await useBotDraftsStore.persist.rehydrate();
}

/** The app starts again over what is stored: memory empty, the store reading it. */
export async function restartApp(): Promise<void> {
  stopBotBoxDraftWrites();
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {}, unsentBoxes: {} });
  await useBotDraftsStore.persist.rehydrate();
}

/** Lets typing pause past the debounce, and waits until `landed` holds of what is stored. */
export async function waitForStore(
  landed: (drafts: StoredBoxDrafts | null) => boolean,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS);
  await vi.waitFor(() => {
    if (!landed(storedDrafts())) throw new Error("the drafts are not stored");
  });
}

/** Lets typing pause well past the debounce: whatever was going to land has. */
export async function pastTheDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS * 3);
}
