/**
 * R5F1: `buildUnrecordedPromptHandoff` through the REAL landing draft store
 * and the REAL landing image partition (fake-indexeddb), not a mocked write.
 *
 * A mocked destination cannot see the defect this round fixed: the old handoff
 * handed its destination real `blobHashes` alongside an EMPTY image map, and
 * the write threw for any hash it could not find - so the fire-and-forget
 * `.catch` swallowed the rejection and NOTHING was ever written, the text
 * included. Only an install that actually runs against the store observes it.
 *
 * The destination is now a closed start-page draft (D01/D03), so what these
 * assert is a row in `useLandingDraftStore` whose content carries the words,
 * the qualification, and - when the bytes were resolvable - a LANDING hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import {
  buildUnrecordedPromptHandoff,
  HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS,
  type HandoffImageResolver,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  LANDING_IMAGE_BUDGET_BYTES,
  resetLandingImageBudgetReservationsForTesting,
  tryReserveLandingImageResidency,
} from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { pngBytesOfSize } from "@/lib/composer/__tests__/image-fixtures";
import {
  stripBase64ImageNodes,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

/**
 * A sha256-shaped hash. `blobHashesFromContent` filters anything that is not
 * 64 hex characters, so a readable placeholder like `"source-hash"` would make
 * the content carry an image the import never even asks about.
 */
function sourceHash(seed: string): string {
  return seed
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");
}

function hashOnlyDoc(hash: string, text: string, size: number): JsonContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              hash,
              b64content: null,
              mimeType: "image/png",
              size,
            },
          },
        ],
      },
    ],
  };
}

function inlineImageDoc(
  text: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): JsonContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
      {
        type: "imageAttachment",
        attrs: {
          id: "img-inline",
          fileName: "pasted.png",
          hash: null,
          b64content: bytesToBase64(bytes),
          mimeType,
          // Deliberately WRONG, as a real paste's attr can be: the
          // materialization must re-measure from the decoded bytes, or the
          // import rejects the node as corrupt.
          size: 1,
        },
      },
    ],
  };
}

function textOnlyDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function annotationRecord(imageHash: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "ann-handoff",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/checkout",
    pageTitle: "Checkout",
    capturedAt: 1_700_000_000_000,
    comment: "the button is misaligned",
    counts: { elements: 1, regions: 0, strokes: 2 },
    elements: [],
    imageFileName: "crop.png",
    imageHash,
    droppedElementCount: 0,
  };
}

function installed(draftId: string | null): LandingDraftTab {
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((row) => row.id === draftId);
  if (draft === undefined) throw new Error(`expected a draft for ${draftId}`);
  return draft;
}

function contentText(content: JsonContent): string {
  return JSON.stringify(content);
}

function findImageAttrs(
  node: JsonContent,
): Record<string, unknown> | undefined {
  if (node.type === "imageAttachment") return node.attrs;
  for (const child of node.content ?? []) {
    const found = findImageAttrs(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

const REASON = "The chat closed before the host confirmed this message.";

beforeEach(() => {
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  resetLandingImageBudgetReservationsForTesting();
  vi.useRealTimers();
});

describe("unrecorded prompt handoff - landing install round trip (R5F1)", () => {
  it("a hash-only prompt whose bytes ARE resolvable locally installs a draft with text and image both", async () => {
    const bytes = pngBytesOfSize(32);
    const hash = sourceHash("source");
    const text = "keep this text safe";
    const readHashImage: HandoffImageResolver = (candidate) =>
      Promise.resolve(candidate === hash ? bytes : null);

    const { draftId } = await buildUnrecordedPromptHandoff({
      content: hashOnlyDoc(hash, text, bytes.byteLength),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    const draft = installed(draftId);
    const rendered = contentText(draft.content);
    expect(rendered).toContain(text);
    expect(rendered).toContain("Unsent");
    expect(rendered).not.toContain("not saved with it");
    // Rewritten to a LANDING hash, and the bytes really are in the partition -
    // a row naming a digest the partition does not hold renders unavailable.
    const imageNode = findImageAttrs(draft.content);
    const landingHash = imageNode?.hash;
    expect(typeof landingHash).toBe("string");
    expect(landingHash).not.toBe(hash);
    if (typeof landingHash !== "string") throw new Error("expected a hash");
    expect(await getImageBytes(landingHash)).toEqual(bytes);
  });

  it("a hash-only prompt whose bytes are NOT resolvable installs text only, with a qualification saying the image was dropped", async () => {
    const hash = sourceHash("gone");
    const text = "the words must survive";
    const readHashImage: HandoffImageResolver = () => Promise.resolve(null);

    const { draftId } = await buildUnrecordedPromptHandoff({
      content: hashOnlyDoc(hash, text, 32),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    const rendered = contentText(installed(draftId).content);
    // The image node was dropped entirely - nothing left to render.
    expect(rendered).not.toContain("imageAttachment");
    expect(rendered).toContain(text);
    expect(rendered).toContain("not saved with it");
    expect(rendered).toContain("the bytes are no longer on this device");
  });

  it("says the annotation sidecar was dropped, rather than installing a partial capture as a complete one (DRIVE RED)", async () => {
    // A disposal's handoff is the LAST copy of the prompt. The sidecar does
    // not travel inside the document - the records name crops stored under
    // their own hashes - and a landing draft has nowhere to put them (M02). So
    // the draft has to SAY so: otherwise the comment, the page it was taken on
    // and which elements were marked are gone, and what is left LOOKS like a
    // complete capture of the prompt.
    const text = "the annotated prompt";
    const readHashImage: HandoffImageResolver = () => Promise.resolve(null);

    const { draftId } = await buildUnrecordedPromptHandoff({
      content: textOnlyDoc(text),
      browserAnnotations: [annotationRecord(sourceHash("crop"))],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    const rendered = contentText(installed(draftId).content);
    expect(rendered).toContain(text);
    expect(rendered).toContain("A browser annotation was not saved with it.");
    // And it states NO cause: records are dropped here structurally, not
    // because these particular bytes failed. Naming one would be a guess
    // printed as a fact.
    expect(rendered).not.toContain("could not be read");
  });

  it("a hanging image resolver is bounded by HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS and still installs the text", async () => {
    vi.useFakeTimers();
    const text = "text must outlive a stalled image read";
    const readHashImage: HandoffImageResolver = () =>
      new Promise<Uint8Array<ArrayBuffer> | null>(() => {
        // never settles
      });

    const pending = buildUnrecordedPromptHandoff({
      content: hashOnlyDoc(sourceHash("stalled"), text, 32),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    await vi.advanceTimersByTimeAsync(HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 50);
    const { draftId } = await pending;
    vi.useRealTimers();

    const rendered = contentText(installed(draftId).content);
    expect(rendered).toContain(text);
    expect(rendered).toContain("not saved with it");
    expect(rendered).toContain("the bytes could not be read in time");
  });

  it("an INLINE image survives the persistence seam as a hashed node with bytes resident (DRIVE RED)", async () => {
    // The defect this covers: an inline node was installed unchanged and
    // counted as no loss, but BOTH landing persistence seams - the
    // localStorage `partialize` and the desktop per-window projection - route
    // through `stripBase64ImageNodes`, and a closed handoff draft has no
    // mounted editor to finish the rewrite they are waiting for. The picture
    // was there until the next reload and then silently gone.
    const bytes = pngBytesOfSize(64);
    const text = "a pasted screenshot that must outlive a reload";
    const readHashImage: HandoffImageResolver = () => Promise.resolve(null);

    const { draftId } = await buildUnrecordedPromptHandoff({
      content: inlineImageDoc(text, bytes, "image/png"),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    const draft = installed(draftId);
    // What the seams would write. Asserted through the shared helper rather
    // than by driving zustand's persist: both seams call exactly this, and it
    // is what erases an inline node.
    const persisted = stripBase64ImageNodes(draft.content);
    const rendered = contentText(persisted);
    expect(rendered).toContain(text);
    expect(rendered).toContain("imageAttachment");
    expect(rendered).not.toContain('b64content":"');
    // Nothing was lost, so the draft must not claim otherwise.
    expect(rendered).not.toContain("not saved with it");

    const attrs = findImageAttrs(persisted);
    const hash = attrs?.hash;
    if (typeof hash !== "string") throw new Error("expected a landing hash");
    expect(await getImageBytes(hash)).toEqual(bytes);
    // Re-measured from the decoded bytes, not carried from the node's attr.
    expect(attrs?.size).toBe(bytes.byteLength);
  });

  it("drops an inline image whose format the host cannot store, and says so (DRIVE RED)", async () => {
    // BMP is outside `host-storable-image-formats`. Hashing it would mint a
    // content address for bytes this client may never store, so the node goes
    // and the qualification names the reason - rather than installing a
    // picture that the persistence seam erases without a word.
    const text = "the words outlive an unstorable picture";
    const readHashImage: HandoffImageResolver = () => Promise.resolve(null);

    const { draftId } = await buildUnrecordedPromptHandoff({
      content: inlineImageDoc(text, pngBytesOfSize(48), "image/bmp"),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    const rendered = contentText(installed(draftId).content);
    expect(rendered).toContain(text);
    expect(rendered).not.toContain("imageAttachment");
    expect(rendered).toContain("its format cannot be kept in a draft");
  });

  it("releases a timed-out import's reservation when it finishes late, and installs no second draft (DRIVE RED)", async () => {
    // `Promise.race` BOUNDS the import; it does not cancel it. A resolver that
    // never settles cannot expose this - the import never gets far enough to
    // hold a reservation. This one answers AFTER the deadline, which is the
    // case that charged this window's image budget for the rest of the session
    // against bytes nothing references.
    vi.useFakeTimers();
    const bytes = pngBytesOfSize(96);
    const hash = sourceHash("late");
    const text = "words that beat a slow image read";
    const releaseReadRef: { current: (() => void) | null } = {
      current: null,
    };
    const readHashImage: HandoffImageResolver = () =>
      new Promise<Uint8Array<ArrayBuffer> | null>((resolve) => {
        releaseReadRef.current = () => resolve(bytes);
      });

    const pending = buildUnrecordedPromptHandoff({
      content: hashOnlyDoc(hash, text, bytes.byteLength),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => true,
    });

    await vi.advanceTimersByTimeAsync(HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 50);
    const { draftId, readsSettled } = await pending;
    const rendered = contentText(installed(draftId).content);
    expect(rendered).toContain(text);
    expect(rendered).toContain("the bytes could not be read in time");

    // REAL timers before letting the read answer: the abandoned import goes on
    // to `putImage`, and fake-indexeddb's own request queue never drains while
    // the clock is frozen - `readsSettled` would simply never settle.
    vi.useRealTimers();
    // The abandoned import now completes and takes a real reservation.
    const resolveRead: () => void =
      releaseReadRef.current ??
      ((): void => expect.unreachable("resolver never ran"));
    resolveRead();
    await readsSettled;

    // A DIFFERENT hash, for the whole budget. Same-hash would prove nothing:
    // `reserve` charges a candidate already in flight zero, and skips the
    // projection entirely when nothing new is charged - so a leak would read
    // as headroom. Charged at the cap, any outstanding byte tips `projected`
    // over it.
    const probe = tryReserveLandingImageResidency([
      { hash: sourceHash("probe"), bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(probe).not.toBeNull();
    probe?.release();
    // And exactly one draft: the late import must not install a second row.
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("installs NOTHING when the identity fence moved during the image read (DRIVE RED)", async () => {
    // The fence is re-asked SYNCHRONOUSLY right before the install, so a
    // sign-out that lands while the bytes are being read is caught even though
    // it was invisible to any check made before the call.
    const bytes = pngBytesOfSize(32);
    const hash = sourceHash("switched");
    let current = true;
    const readHashImage: HandoffImageResolver = (candidate) => {
      current = false;
      return Promise.resolve(candidate === hash ? bytes : null);
    };

    const { draftId } = await buildUnrecordedPromptHandoff({
      content: hashOnlyDoc(hash, "another account's words", bytes.byteLength),
      browserAnnotations: [],
      reason: REASON,
      readHashImage,
      stillCurrent: () => current,
    });

    expect(draftId).toBeNull();
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });
});
