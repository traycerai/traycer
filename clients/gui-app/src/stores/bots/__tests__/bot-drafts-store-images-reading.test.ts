/**
 * The bot boxes' drafts while the images they name are still being read
 * (Tracy Bots T186), through the REAL drafts store and storage over
 * `localStorage`: the account's stored text is read at once, so the tab opens,
 * and only a box whose stored draft names images still being read waits, by its
 * stored text, until they settle or the person discards it. The image store's
 * read is held by the case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { botBoxDraftsKey } from "@/lib/persist";
import {
  BOT_ID,
  BOX_DRAFTS_KEY,
  IMAGE_B64,
  boxDoc,
  hashedImage,
  startFresh,
  startSignedOutApp,
  TEST_USER_ID,
  storeDraftsAsLeft,
  storedDrafts,
  waitForStore,
  type App,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

const HASH = "cd".repeat(32);

const reads = vi.hoisted(() => ({
  /** What the image read answers, once the case lets it. */
  gate: Promise.withResolvers<ImageBytes | undefined>(),
}));

// The image database's read answers when the case says.
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/composer/landing-image-store")
  >()),
  getImageBytes: () => reads.gate.promise,
}));

let app: App;

beforeEach(async () => {
  reads.gate = Promise.withResolvers<ImageBytes | undefined>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  app = await startFresh();
});

afterEach(() => {
  app.close();
  vi.useRealTimers();
});

async function imageBytes(): Promise<ImageBytes> {
  const { base64ToBytes } = await import("@/lib/composer/image-base64");
  const bytes = base64ToBytes(IMAGE_B64);
  if (bytes === null) throw new Error("the fixture image decodes");
  return bytes;
}

/** Two boxes stored for the account, a text-only one and one naming an image by its hash, and the app started over them. */
async function startOverTextAndImageBoxes(): Promise<App> {
  storeDraftsAsLeft({
    [BOT_ID]: {
      plain: {
        text: "plain text",
        content: boxDoc("plain text", []),
        seedId: 1,
      },
      pic: {
        text: "pic text",
        content: boxDoc("pic text", [hashedImage(HASH)]),
        seedId: 1,
      },
    },
  });
  const started = await startSignedOutApp();
  app = started;
  // What signing in does (`BotDraftsPersistLifecycleBridge`): the account takes
  // the store, which holds none of its drafts until they are read.
  started.drafts
    .getState()
    .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
      userId: TEST_USER_ID,
    });
  expect(started.drafts.getState().ownDraftsRead).toBe(false);
  started.drafts.persist.setOptions({ name: botBoxDraftsKey(TEST_USER_ID) });
  void started.drafts.persist.rehydrate();
  await vi.waitFor(() =>
    expect(started.drafts.getState().ownDraftsRead).toBe(true),
  );
  return started;
}

describe("the boxes' drafts while an image they name is being read", () => {
  it("is admitted before the image settles, with the text-only box in place and the image box waiting by its stored text", async () => {
    const started = await startOverTextAndImageBoxes();

    const state = started.drafts.getState();
    expect(state.threadBoxes[BOT_ID]?.plain?.text).toBe("plain text");
    expect(state.threadBoxes[BOT_ID]?.pic).toBeUndefined();
    expect(state.boxesReading).toEqual({
      [BOT_ID]: { pic: { text: "pic text" } },
    });
  });

  it("brings the waiting box in with its image inline once the image settles", async () => {
    const started = await startOverTextAndImageBoxes();

    reads.gate.resolve(await imageBytes());

    await vi.waitFor(() =>
      expect(started.drafts.getState().boxesReading).toEqual({}),
    );
    const pic = started.drafts.getState().threadBoxes[BOT_ID]?.pic;
    expect(pic?.text).toBe("pic text");
    expect(JSON.stringify(pic?.content)).toContain(IMAGE_B64);
    expect(started.drafts.getState().threadBoxes[BOT_ID]?.plain?.text).toBe(
      "plain text",
    );
  });

  it("brings the waiting box in with its text and without the image when the image read fails", async () => {
    const started = await startOverTextAndImageBoxes();

    reads.gate.reject(new Error("the image database failed"));

    await vi.waitFor(() =>
      expect(started.drafts.getState().boxesReading).toEqual({}),
    );
    const pic = started.drafts.getState().threadBoxes[BOT_ID]?.pic;
    expect(pic?.text).toBe("pic text");
    expect(JSON.stringify(pic?.content)).not.toContain(IMAGE_B64);
  });

  it("stays admitted for good, the image box still waiting, while an image never settles, and the text-only box holds what is typed", async () => {
    const started = await startOverTextAndImageBoxes();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(started.drafts.getState().ownDraftsRead).toBe(true);
    expect(started.drafts.getState().boxesReading).toEqual({
      [BOT_ID]: { pic: { text: "pic text" } },
    });
    started.drafts.getState().typeThreadBox(BOT_ID, "plain", {
      text: "plain text, edited",
      content: boxDoc("plain text, edited", []),
      held: [],
    });
    // While an image read never settles nothing is written: the stored
    // drafts stay as they are, so the edit is the store's alone until it does.
    expect(started.drafts.getState().threadBoxes[BOT_ID]?.plain?.text).toBe(
      "plain text, edited",
    );
    expect(started.drafts.getState().boxesReading).toEqual({
      [BOT_ID]: { pic: { text: "pic text" } },
    });
  });

  it("drops the waiting mark on a discard, leaves the box empty when its image settles, and removes its stored draft with the next write", async () => {
    const started = await startOverTextAndImageBoxes();

    started.drafts.getState().discardReadingBox(BOT_ID, "pic");

    expect(started.drafts.getState().boxesReading).toEqual({});
    reads.gate.resolve(await imageBytes());
    await vi.advanceTimersByTimeAsync(0);
    expect(started.drafts.getState().threadBoxes[BOT_ID]?.pic).toBeUndefined();
    started.drafts.getState().typeThreadBox(BOT_ID, "plain", {
      text: "plain text, edited",
      content: boxDoc("plain text, edited", []),
      held: [],
    });
    await waitForStore(
      started,
      (stored) => stored?.[BOT_ID]?.plain?.text === "plain text, edited",
    );
    expect(storedDrafts(started)?.[BOT_ID]?.pic).toBeUndefined();
    expect(started.drafts.getState().threadBoxes[BOT_ID]?.pic).toBeUndefined();
  });

  it("drops the waiting mark through the actions a component gets", async () => {
    const started = await startOverTextAndImageBoxes();
    const { useBotDraftActions } =
      await import("@/stores/bots/bot-drafts-store");
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => useBotDraftActions());

    result.current.discardReadingBox(BOT_ID, "pic");

    expect(started.drafts.getState().boxesReading).toEqual({});
  });

  it("leaves the waiting box's stored draft under the retiring account's key, its image still named by hash, when the account retires mid-wait", async () => {
    const started = await startOverTextAndImageBoxes();

    started.drafts
      .getState()
      .retire((kept) => kept ?? { text: "", content: null, seedId: 0 }, {
        userId: "user-next",
      });
    reads.gate.resolve(await imageBytes());
    await vi.advanceTimersByTimeAsync(0);

    expect(started.drafts.getState().boxesReading).toEqual({});
    expect(started.drafts.getState().threadBoxes).toEqual({});
    const raw = localStorage.getItem(BOX_DRAFTS_KEY) ?? "";
    expect(raw).toContain(`"hash":"${HASH}"`);
    expect(raw).not.toContain("b64content");
    expect(raw).toContain("pic text");
    expect(raw).toContain("plain text");
  });
});
