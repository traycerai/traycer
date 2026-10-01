import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  LANDING_IMAGE_BUDGET_BYTES,
  resetLandingImageBudgetReservationsForTesting,
  tryReserveLandingImageBudget,
} from "@/lib/composer/landing-image-budget";
import {
  holdComposerContentImageRoots,
  releaseComposerContentImageRoots,
  __resetComposerContentImageRootsForTests,
} from "@/lib/composer/composer-content-image-roots";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
// Imported for its module-load side effect: this is the file that registers the
// composer-draft and modal-patch ROOT source and the SIZE source beside it.
// Without the import the two stores below hold documents nothing prices, which
// is the bug under test.
import "@/lib/drafts/draft-mirror-coordinator";

/**
 * W-6: EVERY HOLDER THAT ROOTS IMAGES ALSO PRICES THEM.
 *
 * `use-composer-hash-first-paste` reserves the prepared byte length, writes the
 * bytes, inserts the node and releases - handing off to "steady-state
 * accounting". That hand-off did not exist for any composer but the landing
 * one: usage summed the landing draft store and the draft runtime registry, and
 * the extra root sources contributed hashes only. So each paste into a chat or
 * new-conversation composer was admitted against a usage figure that had never
 * heard of the images already sitting beside it, and eighteen sequential
 * 3 MiB images fitted inside a 64 MiB window budget one at a time. Concurrent
 * reservations were charged correctly; only sequential ones leaked, which is why
 * the ledger's own tests never saw it.
 *
 * ## What this file covers, and what it deliberately does not
 *
 * `rootByteCost` answers in three steps, and only the SECOND is this file's
 * subject: what the content DECLARES. The first - what the store MEASURED when
 * it wrote or read the bytes - covers every root whose bytes this window has
 * held, which is the whole of the same-window paste case, and
 * `landing-image-budget.test.ts` pins it ("charges an extra root's MEASURED
 * bytes against the cap"). Nothing here writes to the store, so every root below
 * is unmeasured by construction and the declared size is what has to answer.
 *
 * That is not a contrived corner. It is a draft mirrored from the host, or
 * restored on a second machine: the document names digests whose bytes the
 * recovery legs have not fetched yet, and those legs write through paths with no
 * budget call of their own. Unmeasured, undeclared and absent from the
 * partition, such a root prices at ZERO - which is how a recovery lands bytes
 * into a store that was admitted as having room for them. The landing surface
 * never had this hole, because the budget walks landing drafts directly; the
 * chat composer and the new-conversation modal reach it only through the
 * coordinator's registration, and it is that registration these cases are about.
 *
 * ## Why an exact sum rather than a refusal
 *
 * A candidate sized to the last free byte must be admitted and one byte more
 * must be refused, so a holder that contributes the WRONG number fails as surely
 * as one that contributes nothing. A test that only asserted "the paste is
 * refused" would pass on a holder charging the per-image ceiling, which is what
 * an unpriced root already costs before hydration.
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
 * Every content holder a case registered, withdrawn before the next one
 * measures.
 *
 * Not left to the module's own lifetime: these holders are deduped BY HASH, so
 * one leaking from a previous case contributes the same sum its own case
 * asserted and the positive passes for the wrong reason. The release case is the
 * one that then fails, which is a confusing way to learn that the positives were
 * never isolated.
 */
const heldHolderIds: string[] = [];

function mountContentHolder(content: JsonContent): { release: () => void } {
  const holderId = `holder-${heldHolderIds.length}`;
  heldHolderIds.push(holderId);
  holdComposerContentImageRoots(holderId, content);
  return { release: () => releaseComposerContentImageRoots(holderId) };
}

function resetAll(): void {
  heldHolderIds.length = 0;
  __resetComposerContentImageRootsForTests();
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
  // The holder registry that replaced `useImageContentRoot`. It is a plain
  // module now rather than a hook, so these cases register and release directly
  // - which is also what the tile's effect cleanup and the submit preparation's
  // `finally` do. The tile's Escape/Cancel path - still mounted, content set to
  // null - needs the tile's own wiring and lives in `chat-tile.test.tsx`; these
  // cases stay green with the tile's hold deleted, so they cannot stand in
  // for it.
  it("images held only by the inline editor are charged", () => {
    mountContentHolder(imageDoc(pastedImages(2)));

    expectHeadroom(2 * IMAGE_BYTES);
  });

  it("releasing the holder returns its bytes", () => {
    const holder = mountContentHolder(imageDoc(pastedImages(2)));
    expectHeadroom(2 * IMAGE_BYTES);

    holder.release();

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
