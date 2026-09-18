import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  LANDING_IMAGE_BUDGET_BYTES,
  resetLandingImageBudgetReservationsForTesting,
  tryReserveLandingImageBudget,
} from "@/lib/composer/landing-image-budget";
import { useImageContentRoot } from "@/hooks/composer/use-image-content-root";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
// Imported for its module-load side effect: this is the file that registers the
// composer-draft and modal-patch CONTENT source. Without the import the two
// stores below hold documents nothing prices, which is the bug under test.
import "@/lib/drafts/draft-mirror-coordinator";

/**
 * W-6: EVERY HOLDER THAT ROOTS IMAGES ALSO PRICES THEM.
 *
 * `use-composer-hash-first-paste` reserves the prepared byte length, writes the
 * bytes, inserts the node and releases - handing off to "steady-state
 * accounting". That hand-off did not exist for any composer but the landing
 * one: `referencedImageBytes` summed the landing draft store and the draft
 * runtime registry, and the extra root sources contributed hashes only. So each
 * paste into a chat or new-conversation composer was admitted against a usage
 * figure that had never heard of the images already sitting beside it, and
 * eighteen sequential 3.75 MiB images fitted inside a 64 MiB window budget one
 * at a time. Concurrent reservations were charged correctly; only sequential
 * ones leaked, which is why the ledger's own tests never saw it.
 *
 * These cases measure the sum EXACTLY rather than asserting a refusal: a
 * candidate sized to the last free byte must be admitted and one byte more must
 * be refused, so a holder that contributes the wrong number fails as surely as
 * one that contributes nothing.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  }),
}));

const IMAGE_BYTES = 3 * 1024 * 1024;

function imageDoc(
  images: ReadonlyArray<{ readonly hash: string; readonly size: number }>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: images.map((image) => ({
          type: "imageAttachment",
          attrs: {
            id: `node-${image.hash.slice(0, 8)}`,
            fileName: "shot.png",
            hash: image.hash,
            b64content: null,
            mimeType: "image/png",
            size: image.size,
            byHashEligible: true,
          },
        })),
      },
    ],
  };
}

function hashOf(index: number): string {
  return String(index).padStart(64, "0");
}

function pastedImages(
  count: number,
): ReadonlyArray<{ readonly hash: string; readonly size: number }> {
  const images: Array<{ readonly hash: string; readonly size: number }> = [];
  for (let index = 0; index < count; index += 1) {
    images.push({ hash: hashOf(index), size: IMAGE_BYTES });
  }
  return images;
}

/**
 * The exact free space the budget believes it has, read through the only
 * observable the module exposes: what it will and will not admit. Each probe
 * releases, so measuring never changes the thing measured.
 */
function measuredHeadroom(expected: number): {
  readonly admitsExactly: boolean;
  readonly refusesOneMore: boolean;
} {
  const exact = tryReserveLandingImageBudget([{ hash: null, bytes: expected }]);
  const admitsExactly = exact !== null;
  exact?.release();
  const overBy1 = tryReserveLandingImageBudget([
    { hash: null, bytes: expected + 1 },
  ]);
  const refusesOneMore = overBy1 === null;
  overBy1?.release();
  return { admitsExactly, refusesOneMore };
}

function expectHeadroom(usedBytes: number): void {
  const headroom = measuredHeadroom(LANDING_IMAGE_BUDGET_BYTES - usedBytes);
  expect(headroom.admitsExactly).toBe(true);
  expect(headroom.refusesOneMore).toBe(true);
}

/**
 * Every hook mounted by a case, unmounted before the next one measures.
 *
 * Not left to Testing Library's auto-cleanup: these holders are deduped BY
 * HASH, so a mount leaking from a previous case contributes the same sum its
 * own case asserted and the positive passes for the wrong reason. The release
 * case is the one that then fails, which is a confusing way to learn that the
 * positives were never isolated.
 */
const mountedHolders: Array<{ readonly unmount: () => void }> = [];

function mountContentHolder(content: JsonContent): { unmount: () => void } {
  const view = renderHook(() => useImageContentRoot(content));
  mountedHolders.push(view);
  return view;
}

function resetAll(): void {
  while (mountedHolders.length > 0) mountedHolders.pop()?.unmount();
  resetLandingImageBudgetReservationsForTesting();
  draftRuntimeRegistry.resetForTesting();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerDraftStore.setState({ drafts: {} });
  useNewConversationModalStore.getState().resetForTests();
}

beforeEach(resetAll);
afterEach(resetAll);

describe("image byte budget: the chat composer's own draft is priced", () => {
  it("baseline: with no holders the whole budget is free", () => {
    expectHeadroom(0);
  });

  it("N sequential pastes are charged as the sum of the N sizes", () => {
    // What the producer does on each paste: reserve, write, insert, release.
    // The node it inserted is the holder from then on.
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", imageDoc(pastedImages(4)), null);

    expectHeadroom(4 * IMAGE_BYTES);
  });

  it("the same bytes pasted twice are charged once", () => {
    // Content-addressed: two nodes, one hash, one copy in the store. Charging
    // per-node would block a composer that is holding one image.
    const duplicate = { hash: hashOf(0), size: IMAGE_BYTES };
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", imageDoc([duplicate, duplicate]), null);

    expectHeadroom(IMAGE_BYTES);
  });

  it("images in two different chats' drafts are both charged", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", imageDoc(pastedImages(2)), null);
    useComposerDraftStore
      .getState()
      .setSnapshot(
        "chat-2",
        imageDoc([{ hash: hashOf(9), size: IMAGE_BYTES }]),
        null,
      );

    expectHeadroom(3 * IMAGE_BYTES);
  });

  it("clearing the draft returns its bytes to the budget", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", imageDoc(pastedImages(4)), null);
    expectHeadroom(4 * IMAGE_BYTES);

    // The send is accepted and the draft is cleared. Its bytes are no longer
    // held by anything, and the next paste has the whole budget again.
    useComposerDraftStore.setState({ drafts: {} });

    expectHeadroom(0);
  });
});

describe("image byte budget: the new-conversation modal is priced", () => {
  it("a modal draft's images are charged", () => {
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", imageDoc(pastedImages(3)));

    expectHeadroom(3 * IMAGE_BYTES);
  });

  it("a modal draft and a chat draft holding the SAME hash are charged once", () => {
    const shared = [{ hash: hashOf(0), size: IMAGE_BYTES }];
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", imageDoc(shared), null);
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", imageDoc(shared));

    expectHeadroom(IMAGE_BYTES);
  });

  it("clearing the modal draft returns its bytes", () => {
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", imageDoc(pastedImages(3)));
    expectHeadroom(3 * IMAGE_BYTES);

    useNewConversationModalStore.getState().clearDraft("epic-1");

    expectHeadroom(0);
  });
});

describe("image byte budget: an open inline edit is priced", () => {
  it("images held only by the inline editor are charged", () => {
    mountContentHolder(imageDoc(pastedImages(2)));

    expectHeadroom(2 * IMAGE_BYTES);
  });

  // Unmount, i.e. the park. The Escape/Cancel path - still mounted, content to
  // null - needs the tile's own wiring and lives in `chat-tile.test.tsx`; these
  // cases stay green with the tile's hook call deleted, so they cannot stand in
  // for it.
  it("unmounting the holder returns its bytes", () => {
    const view = mountContentHolder(imageDoc(pastedImages(2)));
    expectHeadroom(2 * IMAGE_BYTES);

    view.unmount();

    expectHeadroom(0);
  });

  it("an inline edit and a chat draft holding the SAME hash are charged once", () => {
    const shared = [{ hash: hashOf(0), size: IMAGE_BYTES }];
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-1", imageDoc(shared), null);
    mountContentHolder(imageDoc(shared));

    expectHeadroom(IMAGE_BYTES);
  });
});
