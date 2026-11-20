/**
 * A legacy stash entry's conversion while the image roots cannot be read
 * (Tracy Bots T186): its images go through the importer, whose reservation
 * needs the roots. It rejects, so its caller leaves the source where it is;
 * nothing is installed or written, and no reservation is left.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  LANDING_IMAGE_BUDGET_BYTES,
  registerExtraImageRootSource,
  resetLandingImageBudgetReservationsForTesting,
  reserveLandingImageBudget,
} from "@/lib/composer/landing-image-budget";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { imageHashKeys, sha256Hex } from "@/lib/composer/landing-image-store";
import {
  convertStashEntry,
  resetStashMigrationForTests,
  stashEntryIsConverted,
} from "@/lib/drafts/stash-migration";
import { IMAGE_B64 } from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

/** Set while the image roots cannot be read, as the bot drafts' are when storage fails. */
const unreadableRoots = { on: false };
registerExtraImageRootSource({
  hashes: () => {
    if (unreadableRoots.on) throw new Error("the image roots cannot be read");
    return [];
  },
});

beforeEach(() => {
  installFreshIndexedDb();
  window.localStorage.clear();
  resetStashMigrationForTests();
  resetLandingImageBudgetReservationsForTesting();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  unreadableRoots.on = false;
  resetLandingImageBudgetReservationsForTesting();
});

describe("a legacy stash entry's conversion", () => {
  it("rejects, installs and writes nothing and leaves no reservation, when the image roots cannot be read", async () => {
    const bytes = base64ToBytes(IMAGE_B64);
    if (bytes === null) throw new Error("the fixture image decodes");
    const hash = await sha256Hex(bytes);
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hi" },
            {
              type: "imageAttachment",
              attrs: {
                id: "node-1",
                fileName: "shot.png",
                hash,
                b64content: null,
                mimeType: "image/png",
                size: bytes.byteLength,
              },
            },
          ],
        },
      ],
    };
    unreadableRoots.on = true;

    await expect(
      convertStashEntry({
        stashId: "stash-1",
        content,
        blobHashes: [hash],
        lastTouchedAt: 1,
        readBlob: () => Promise.resolve({ bytes, mimeType: "image/png" }),
        stillCurrent: () => true,
      }),
    ).rejects.toThrow();

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(stashEntryIsConverted("stash-1")).toBe(false);
    expect(await imageHashKeys()).toEqual([]);
    // No reservation was left: the whole budget is still there to take.
    unreadableRoots.on = false;
    const whole = reserveLandingImageBudget(null, [
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(whole).not.toBeNull();
    whole?.release();
  });
});
