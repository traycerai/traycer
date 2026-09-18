/**
 * Canonical suite for `landing-image-budget.ts`: live-root skip, hash-aware
 * in-flight ledger, anonymous (hash-null) paste slots, opaque reservation
 * release, and measured-byte capacity math. Real draft store + runtime registry;
 * only sonner is mocked for toast side effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  LANDING_IMAGE_BUDGET_BYTES,
  LANDING_IMAGE_MAX_BYTES_PER_IMAGE,
  registerExtraImageRootSource,
  reserveLandingImageBudget,
  tryReserveLandingImageResidency,
  resetLandingImageBudgetReservationsForTesting,
} from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import {
  awaitLandingImageSizes,
  imageHashKeys,
  imageStore,
  putImage,
  setLandingImageSizesHydratedForTests,
} from "@/lib/composer/landing-image-store";
import { set as idbSet } from "idb-keyval";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: toastError,
    warning: vi.fn(),
    success: vi.fn(),
  }),
}));

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function imageDoc(hash: string, size: number): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `node-${hash.slice(0, 8)}`,
              fileName: "live.png",
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

function makeDraft(input: {
  readonly id: string;
  readonly content: JsonContent;
  readonly lastTouchedAt: number;
}): import("@/stores/home/landing-draft-store").LandingDraftTab {
  return {
    id: input.id,
    content: input.content,
    selection: null,
    lastTouchedAt: input.lastTouchedAt,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
  };
}

describe("reserveLandingImageBudget", () => {
  beforeEach(() => {
    resetLandingImageBudgetReservationsForTesting();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    toastError.mockClear();
  });

  afterEach(() => {
    resetLandingImageBudgetReservationsForTesting();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  // One source, installed once: `registerExtraImageRootSource` has no
  // withdrawal, so the tests below drive it by emptying the array instead.
  const extraRoots: string[] = [];
  registerExtraImageRootSource({ hashes: () => extraRoots });

  it("charges an extra root's MEASURED bytes against the cap (DRIVE RED)", async () => {
    // Extra roots are hash-only by construction - an annotation crop, a
    // composer or new-chat row, a stash entry - so nothing about them declares
    // a size, and they were counted as zero while the sweep dutifully protected
    // their bytes. The roots and the usage sum have to be the same set.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const bytes = new Uint8Array(512).fill(7);
    extraRoots.push(await putImage(bytes));

    // Exactly the cap once those 512 bytes are counted.
    const exact = reserveLandingImageBudget(null, [
      { hash: "d".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 512 },
    ]);
    expect(exact).not.toBeNull();
    exact?.release();

    // One byte past it.
    expect(
      reserveLandingImageBudget(null, [
        { hash: "e".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 511 },
      ]),
    ).toBeNull();
    extraRoots.length = 0;
  });

  it("charges a resident root it has not MEASURED at the per-image ceiling", async () => {
    // Bytes written by a build before the size table existed. Unknown must not
    // mean free while the partition is holding them; the store measures them at
    // the next start, and until then the ceiling is the honest bound.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const roots = 13;
    expect(roots * LANDING_IMAGE_MAX_BYTES_PER_IMAGE).toBeGreaterThan(
      LANDING_IMAGE_BUDGET_BYTES,
    );
    for (let index = 0; index < roots; index += 1) {
      const hash = `${index}`.padStart(64, "b");
      await idbSet(hash, new Uint8Array(8).fill(index), imageStore());
      extraRoots.push(hash);
    }
    // Enumerating the partition is what makes them "resident" to the store.
    await imageHashKeys();

    expect(
      reserveLandingImageBudget(null, [{ hash: "c".repeat(64), bytes: 1 }]),
    ).toBeNull();
    extraRoots.length = 0;
  });

  it("charges a root at the ceiling until the partition has been measured (DRIVE RED)", async () => {
    // Cold start: the presence set is seeded by the same startup pass that
    // measures sizes, so before it finishes "no bytes here" is what it says
    // about every restored image. Reading that as free admitted a paste on top
    // of a full partition.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const roots = 13;
    for (let index = 0; index < roots; index += 1) {
      extraRoots.push(`${index}`.padStart(64, "c"));
    }
    // The partition has never been measured, and nothing here declares a size.
    setLandingImageSizesHydratedForTests(false);

    expect(
      reserveLandingImageBudget(null, [{ hash: "e".repeat(64), bytes: 1 }]),
    ).toBeNull();

    // Once the pass has run, the same roots are known to hold nothing.
    setLandingImageSizesHydratedForTests(true);
    const admitted = reserveLandingImageBudget(null, [
      { hash: "e".repeat(64), bytes: 1 },
    ]);
    expect(admitted).not.toBeNull();
    admitted?.release();
    extraRoots.length = 0;
  });

  it("does not charge a reservation the root sum is already charging (DRIVE RED)", async () => {
    // The bytes landed and something references them, so they are a root - and
    // a root is charged. Leaving the reservation charged too refuses work that
    // fits, for as long as the caller holds it.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const bytes = new Uint8Array(512).fill(3);
    const hash = await putImage(bytes);
    extraRoots.push(hash);

    // Reserving the SAME hash that is now rooted costs nothing new, and must
    // not make the next admission see 1024 bytes of usage for 512 real ones.
    const held = reserveLandingImageBudget(null, [
      { hash, bytes: bytes.byteLength },
    ]);
    expect(held).not.toBeNull();
    const exact = reserveLandingImageBudget(null, [
      { hash: "f".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 512 },
    ]);
    expect(exact).not.toBeNull();
    exact?.release();
    held?.release();
    extraRoots.length = 0;
  });

  it("hands an anonymous slot's charge to the hash once its bytes land (DRIVE RED)", async () => {
    // A batch reserves before it has hashed anything. The first item lands and
    // something roots it - so the root sum charges those bytes - while the slot
    // that stood for it is still held for a slower sibling. Charging both
    // refuses pastes that fit, for as long as the slow one takes.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const batch = reserveLandingImageBudget(null, [
      { hash: null, bytes: 512 },
      { hash: null, bytes: 512 },
    ]);
    expect(batch).not.toBeNull();

    const bytes = new Uint8Array(512).fill(9);
    const hash = await putImage(bytes);
    extraRoots.push(hash);
    batch?.settleStored(0, hash);

    // 512 rooted + 512 still outstanding = 1024, not 1536.
    const exact = reserveLandingImageBudget(null, [
      { hash: "a".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 1024 },
    ]);
    expect(exact).not.toBeNull();
    exact?.release();
    batch?.release();
    extraRoots.length = 0;
  });

  it("settles the slot of the item that landed, not the first unnamed one (DRIVE RED)", async () => {
    // A batch's writes run concurrently, so the fast item can settle while a
    // slower, LARGER sibling is still outstanding. Settling "the first unnamed
    // slot" moved the big slot's charge onto the small item's hash - and when
    // that hash was already rooted, the difference vanished from the ledger
    // entirely and the next admission saw capacity that does not exist.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const duplicate = new Uint8Array(1024).fill(4);
    const duplicateHash = await putImage(duplicate);
    extraRoots.push(duplicateHash);

    const batch = reserveLandingImageBudget(null, [
      { hash: null, bytes: 4096 },
      { hash: null, bytes: 1024 },
    ]);
    expect(batch).not.toBeNull();
    // The SECOND candidate is the one that landed, and its bytes are already a
    // root - so settling it frees 1024 of outstanding charge, not 4096.
    batch?.settleStored(1, duplicateHash);

    // 1024 rooted + 4096 still outstanding. One byte more than the remainder
    // must not fit.
    expect(
      reserveLandingImageBudget(null, [
        {
          hash: "a".repeat(64),
          bytes: LANDING_IMAGE_BUDGET_BYTES - 1024 - 4096 + 1,
        },
      ]),
    ).toBeNull();
    batch?.release();
    extraRoots.length = 0;
  });

  it("keeps charging a reservation whose root is charging ZERO for it (DRIVE RED)", async () => {
    // A root whose bytes this partition does not hold costs nothing - that is
    // what makes a dangling reference free. Dropping its reservation on the
    // grounds that "a root exists" therefore made those bytes free twice over,
    // which is how a stash restoring a missing crop could be admitted on top of
    // a full partition.
    installFreshIndexedDb();
    await awaitLandingImageSizes();
    const missingHash = "c".repeat(64);
    extraRoots.push(missingHash);
    // Rooted, absent: charged zero by the root sum.
    const restoring = tryReserveLandingImageResidency([
      { hash: missingHash, bytes: 4096 },
    ]);
    expect(restoring).not.toBeNull();

    expect(
      reserveLandingImageBudget(null, [
        { hash: "d".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 4096 + 1 },
      ]),
    ).toBeNull();
    const fits = reserveLandingImageBudget(null, [
      { hash: "d".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 4096 },
    ]);
    expect(fits).not.toBeNull();
    fits?.release();
    restoring?.release();
    extraRoots.length = 0;
  });

  it("charges nothing for a DANGLING root with no bytes anywhere", () => {
    // An annotation record whose crop was reclaimed still names its hash. The
    // ceiling would be a permanent tax for bytes nobody holds, and no later
    // measurement could ever retire it.
    for (let index = 0; index < 13; index += 1) {
      extraRoots.push(`${index}`.padStart(64, "f"));
    }

    const admitted = reserveLandingImageBudget(null, [
      { hash: "c".repeat(64), bytes: 1 },
    ]);
    expect(admitted).not.toBeNull();
    admitted?.release();
    extraRoots.length = 0;
  });

  it("charges zero for a candidate hash that is already a live root", () => {
    const liveHash = "a".repeat(64);
    const huge = LANDING_IMAGE_BUDGET_BYTES;
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "draft-live",
          content: imageDoc(liveHash, huge),
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "draft-live",
    });

    // Live root already occupies the full cap; same-hash re-reserve must still
    // succeed (charges 0). A different hash of 1 byte must fail.
    const owned = requireDefined(
      reserveLandingImageBudget("draft-live", [
        { hash: liveHash, bytes: huge },
      ]),
      "owned for live root",
    );
    owned.release();

    expect(
      reserveLandingImageBudget("draft-live", [
        { hash: "b".repeat(64), bytes: 1 },
      ]),
    ).toBeNull();
  });

  it("dedupes overlapping in-flight reservations for the same new hash", () => {
    const shared = "b".repeat(64);
    // Charge almost the full budget once; a second same-hash share still fits
    // because it is not double-charged.
    const almostAll = LANDING_IMAGE_BUDGET_BYTES - 100;

    const first = requireDefined(
      reserveLandingImageBudget("d1", [{ hash: shared, bytes: almostAll }]),
      "first reservation",
    );
    const second = requireDefined(
      reserveLandingImageBudget("d2", [{ hash: shared, bytes: almostAll }]),
      "second overlapping reservation",
    );

    // A different hash of 101 bytes would tip over (almostAll + 101 > cap).
    expect(
      reserveLandingImageBudget("d3", [{ hash: "c".repeat(64), bytes: 101 }]),
    ).toBeNull();
    // 100 bytes of a different hash still fits against the single charge.
    const residual = requireDefined(
      reserveLandingImageBudget("d3", [{ hash: "c".repeat(64), bytes: 100 }]),
      "residual different-hash",
    );
    residual.release();

    first.release();
    second.release();

    const afterBothReleased = requireDefined(
      reserveLandingImageBudget("d4", [{ hash: shared, bytes: almostAll }]),
      "after both released",
    );
    afterBothReleased.release();
  });

  it("two different hashes that only fit when counted once both reserve", () => {
    const h1 = "d".repeat(64);
    const h2 = "e".repeat(64);
    const each = Math.floor(LANDING_IMAGE_BUDGET_BYTES * 0.4);

    const a = requireDefined(
      reserveLandingImageBudget("d1", [
        { hash: h1, bytes: each },
        { hash: h2, bytes: each },
      ]),
      "two-hash reservation",
    );
    // 0.8 of cap held; another 0.4 different hash must fail.
    expect(
      reserveLandingImageBudget("d2", [{ hash: "f".repeat(64), bytes: each }]),
    ).toBeNull();
    a.release();
  });

  it("rejects a second reservation that would tip the combined in-flight total over the cap", () => {
    const h1 = "f".repeat(64);
    const h2 = "0".repeat(64);
    const almostAll = LANDING_IMAGE_BUDGET_BYTES - 100;

    const held = requireDefined(
      reserveLandingImageBudget("d1", [{ hash: h1, bytes: almostAll }]),
      "held near-cap reservation",
    );

    const rejected = reserveLandingImageBudget("d2", [
      { hash: h2, bytes: 200 },
    ]);
    expect(rejected).toBeNull();
    expect(toastError).toHaveBeenCalled();

    held.release();
    const afterRelease = requireDefined(
      reserveLandingImageBudget("d2", [{ hash: h2, bytes: 200 }]),
      "after release",
    );
    afterRelease.release();
  });

  it("release is all-or-nothing free: full cycle allows re-reserve of same total", () => {
    const h = "1".repeat(64);
    const bytes = 50_000;

    const first = requireDefined(
      reserveLandingImageBudget("d1", [{ hash: h, bytes }]),
      "first",
    );
    first.release();

    const second = requireDefined(
      reserveLandingImageBudget("d1", [{ hash: h, bytes }]),
      "second",
    );
    // Still charged after re-reserve: near-cap sibling of remaining room fails
    // only if first was not released - here second holds bytes alone so a
    // different near-cap hash of budget - bytes + 1 must fail if charged.
    const leftover = LANDING_IMAGE_BUDGET_BYTES - bytes;
    expect(
      reserveLandingImageBudget("d2", [
        { hash: "2".repeat(64), bytes: leftover + 1 },
      ]),
    ).toBeNull();
    const fits = requireDefined(
      reserveLandingImageBudget("d2", [
        { hash: "2".repeat(64), bytes: leftover },
      ]),
      "exact leftover",
    );
    second.release();
    fits.release();
  });

  it("empty candidates always succeed and release is a harmless no-op", () => {
    const empty = requireDefined(
      reserveLandingImageBudget("d1", []),
      "empty candidates",
    );
    expect(() => empty.release()).not.toThrow();
    expect(() => empty.release()).not.toThrow();
  });

  it("uses candidate.bytes (measured), not any external size metadata", () => {
    const h = "2".repeat(64);
    const hold = requireDefined(
      reserveLandingImageBudget("d1", [
        { hash: "3".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 10 },
      ]),
      "hold",
    );

    const ok = requireDefined(
      reserveLandingImageBudget("d2", [{ hash: h, bytes: 5 }]),
      "measured 5 bytes",
    );
    const tooBig = reserveLandingImageBudget("d3", [
      { hash: "4".repeat(64), bytes: 1_000_000 },
    ]);
    expect(tooBig).toBeNull();

    hold.release();
    ok.release();
  });

  it("admits exact boundary at LANDING_IMAGE_BUDGET_BYTES and rejects one byte over", () => {
    const hExact = "5".repeat(64);
    const hOver = "6".repeat(64);

    const exact = requireDefined(
      reserveLandingImageBudget("d1", [
        { hash: hExact, bytes: LANDING_IMAGE_BUDGET_BYTES },
      ]),
      "exact cap",
    );
    exact.release();

    expect(
      reserveLandingImageBudget("d1", [
        { hash: hOver, bytes: LANDING_IMAGE_BUDGET_BYTES + 1 },
      ]),
    ).toBeNull();

    // referenced + in-flight + new === cap admitted; one more byte rejected.
    const hold = requireDefined(
      reserveLandingImageBudget("d1", [
        { hash: "7".repeat(64), bytes: LANDING_IMAGE_BUDGET_BYTES - 50 },
      ]),
      "hold near cap",
    );
    const exactRemaining = requireDefined(
      reserveLandingImageBudget("d2", [{ hash: "8".repeat(64), bytes: 50 }]),
      "exact remaining",
    );
    expect(
      reserveLandingImageBudget("d3", [{ hash: "9".repeat(64), bytes: 1 }]),
    ).toBeNull();
    hold.release();
    exactRemaining.release();
  });

  it("hash-null candidates never dedupe against live roots or other reservations", () => {
    const liveHash = "a".repeat(64);
    const liveBytes = Math.floor(LANDING_IMAGE_BUDGET_BYTES * 0.6);
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "draft-live",
          content: imageDoc(liveHash, liveBytes),
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "draft-live",
    });

    // Same byte count as the live root, but hash null - must charge full bytes.
    const pasteLike = reserveLandingImageBudget("draft-live", [
      { hash: null, bytes: liveBytes },
    ]);
    // live (0.6) + paste (0.6) > 1.0 → reject.
    expect(pasteLike).toBeNull();

    // Two concurrent hash-null reservations with identical byte counts never
    // share a ledger slot: each half of remaining headroom succeeds once,
    // twice over-caps.
    const remaining = LANDING_IMAGE_BUDGET_BYTES - liveBytes;
    const halfRemaining = Math.floor(remaining / 2);
    const firstAnon = requireDefined(
      reserveLandingImageBudget("d1", [{ hash: null, bytes: halfRemaining }]),
      "first anon",
    );
    const secondAnon = requireDefined(
      reserveLandingImageBudget("d2", [{ hash: null, bytes: halfRemaining }]),
      "second anon same bytes",
    );
    // Third identical half would exceed remaining headroom after two charges.
    expect(
      reserveLandingImageBudget("d3", [{ hash: null, bytes: halfRemaining }]),
    ).toBeNull();
    firstAnon.release();
    secondAnon.release();
  });

  it("duplicate release is idempotent and does not free another overlapping share", () => {
    const shared = "b".repeat(64);
    // Leave only 10 bytes of headroom after both shares are still charged once.
    const charge = LANDING_IMAGE_BUDGET_BYTES - 10;

    const first = requireDefined(
      reserveLandingImageBudget("d1", [{ hash: shared, bytes: charge }]),
      "first share",
    );
    const second = requireDefined(
      reserveLandingImageBudget("d2", [{ hash: shared, bytes: charge }]),
      "second share (deduped)",
    );

    // With the shared hash still in-flight once, only 10 bytes remain free.
    expect(
      reserveLandingImageBudget("d3", [{ hash: "c".repeat(64), bytes: 11 }]),
    ).toBeNull();

    first.release();
    first.release(); // second call must be a no-op

    // second still holds the ledger entry - capacity not freed yet.
    expect(
      reserveLandingImageBudget("d3", [{ hash: "c".repeat(64), bytes: 11 }]),
    ).toBeNull();

    const stillFits = requireDefined(
      reserveLandingImageBudget("d3", [{ hash: "c".repeat(64), bytes: 10 }]),
      "exact remaining while second held",
    );
    stillFits.release();
    second.release();

    // After both shares released, a charge-sized reservation succeeds again.
    const after = requireDefined(
      reserveLandingImageBudget("d4", [{ hash: shared, bytes: charge }]),
      "after both released",
    );
    after.release();
  });

  it("budget rejection never closes an active or inactive draft", () => {
    const big = 40 * 1024 * 1024;
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "active",
          content: imageDoc("a".repeat(64), big),
          lastTouchedAt: 1,
        }),
        makeDraft({
          id: "inactive",
          content: imageDoc("b".repeat(64), big),
          lastTouchedAt: 2,
        }),
      ],
      activeDraftId: "active",
    });

    // 80 MB referenced + a tiny paste exceeds the 64 MB budget.
    const allowed = reserveLandingImageBudget(null, [
      { hash: null, bytes: 1024 },
    ]);
    expect(allowed).toBeNull();
    const draftIds = useLandingDraftStore.getState().drafts.map((d) => d.id);
    expect(draftIds).toEqual(["active", "inactive"]);
  });

  it("budget rejection preserves every durable draft", () => {
    const size = 30 * 1024 * 1024;
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "old",
          content: imageDoc("c".repeat(64), size),
          lastTouchedAt: 1,
        }),
        makeDraft({
          id: "mid",
          content: imageDoc("d".repeat(64), size),
          lastTouchedAt: 2,
        }),
        makeDraft({
          id: "active",
          content: imageDoc("e".repeat(64), size),
          lastTouchedAt: 3,
        }),
      ],
      activeDraftId: "active",
    });

    const allowed = reserveLandingImageBudget(null, [
      { hash: null, bytes: 1024 },
    ]);
    expect(allowed).toBeNull();
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "old",
      "mid",
      "active",
    ]);
  });

  it("budget counts a hash shared across drafts once (content-addressed dedupe)", () => {
    const size = 40 * 1024 * 1024;
    const shared = "f".repeat(64);
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "a",
          content: imageDoc(shared, size),
          lastTouchedAt: 1,
        }),
        makeDraft({
          id: "active",
          content: imageDoc(shared, size),
          lastTouchedAt: 2,
        }),
      ],
      activeDraftId: "active",
    });

    // Deduped referenced bytes = 40 MB; +10 MB = 50 MB ≤ 64 MB → allowed.
    const allowed = requireDefined(
      reserveLandingImageBudget(null, [
        { hash: null, bytes: 10 * 1024 * 1024 },
      ]),
      "deduped referenced admits 10 MB paste",
    );
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "a",
      "active",
    ]);
    allowed.release();
  });

  it("blocks the paste when only the active draft remains and it still exceeds budget", () => {
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "active",
          content: imageDoc("0".repeat(64), 60 * 1024 * 1024),
          lastTouchedAt: 1,
        }),
      ],
      activeDraftId: "active",
    });

    const allowed = reserveLandingImageBudget(null, [
      { hash: null, bytes: 10 * 1024 * 1024 },
    ]);
    expect(allowed).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("blocks the paste rather than evicting other drafts when there is no active draft", () => {
    const big = 40 * 1024 * 1024;
    useLandingDraftStore.setState({
      drafts: [
        makeDraft({
          id: "a",
          content: imageDoc("1".repeat(64), big),
          lastTouchedAt: 1,
        }),
        makeDraft({
          id: "b",
          content: imageDoc("2".repeat(64), big),
          lastTouchedAt: 2,
        }),
      ],
      activeDraftId: null,
    });

    const allowed = reserveLandingImageBudget(null, [
      { hash: null, bytes: 1024 },
    ]);
    expect(allowed).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useLandingDraftStore.getState().drafts.map((d) => d.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("duplicate hashes within one call are only charged once", () => {
    const h = "3".repeat(64);
    const each = Math.floor(LANDING_IMAGE_BUDGET_BYTES * 0.6);
    // Two entries same hash in one call: if double-charged would reject (1.2x).
    const owned = requireDefined(
      reserveLandingImageBudget("d1", [
        { hash: h, bytes: each },
        { hash: h, bytes: each },
      ]),
      "same-hash twice in one call",
    );
    // Remaining headroom is 0.4 of cap.
    expect(
      reserveLandingImageBudget("d2", [
        {
          hash: "4".repeat(64),
          bytes: Math.floor(LANDING_IMAGE_BUDGET_BYTES * 0.5),
        },
      ]),
    ).toBeNull();
    owned.release();
  });
});

/**
 * Isolation: importing ONLY `landing-image-budget.ts` (never the draft store
 * or GC) must be safe. No root source is registered, so draft-derived reads
 * are empty/zero; admission still works against that zero baseline. Intentionally
 * does NOT mock `idb-keyval` - if this import starts needing that mock, budget
 * has re-acquired a transitive GC/storage dependency.
 */
describe("landing-image-budget module isolation", () => {
  it("imports alone: empty roots, zero-baseline reserve, no store/GC side effects", async () => {
    vi.resetModules();

    // Fresh module registry: only the budget graph, not draft store or GC.
    const budget = await import("@/lib/composer/landing-image-budget");

    expect(budget.landingLiveImageRootHashes()).toEqual(new Set());

    const underCap = requireDefined(
      budget.reserveLandingImageBudget("isolated-draft", [
        { hash: "i".repeat(64), bytes: 1024 },
      ]),
      "under-cap isolation reserve",
    );
    underCap.release();

    expect(
      budget.reserveLandingImageBudget("isolated-draft", [
        {
          hash: "j".repeat(64),
          bytes: budget.LANDING_IMAGE_BUDGET_BYTES + 1,
        },
      ]),
    ).toBeNull();

    // Sanity: re-importing the store is still possible after isolation; this
    // does not assert registration timing (covered in import-cycle suite).
    budget.resetLandingImageBudgetReservationsForTesting();
  });
});

/**
 * §3.1: an unmeasured root is charged the PREPARED ceiling, not the old 5 MiB
 * paste refusal.
 *
 * Preparation resizes and re-encodes rather than refusing, so the largest thing
 * that can BE in the store is `PREPARED_IMAGE_MAX_BYTES` (3.75 MiB). Charging
 * the old 5 MiB over-charges every unmeasured root by 33%, and charging the
 * SOURCE ceiling would over-charge by 13× - both refuse pastes that fit, and
 * only on a cold start, which is the hardest window to reproduce by hand.
 *
 * Measured at the last free byte rather than asserted as a refusal: a wrong
 * constant fails as surely as a missing one.
 */
describe("image byte budget: an unmeasured root on a cold start", () => {
  it("is charged the prepared ceiling, and one byte more is refused", async () => {
    const budget = await import("@/lib/composer/landing-image-budget");
    const store = await import("@/lib/composer/landing-image-store");
    const { PREPARED_IMAGE_MAX_BYTES } =
      await import("@/lib/composer/prompt-stash-image-preparation");

    // Bytes present, size not yet measured, hydration pass not finished: the
    // "unknown because we have not looked yet" case.
    const hash = await store.putImage(new Uint8Array([1, 2, 3]));
    store.setLandingImageSizesHydratedForTests(false);
    store.__resetMeasuredLandingImageSizesForTests();
    registerExtraImageRootSource({ hashes: () => [hash] });

    const free = budget.LANDING_IMAGE_BUDGET_BYTES - PREPARED_IMAGE_MAX_BYTES;
    const exact = budget.tryReserveLandingImageBudget([
      { hash: null, bytes: free },
    ]);
    expect(exact).not.toBeNull();
    exact?.release();
    const overBy1 = budget.tryReserveLandingImageBudget([
      { hash: null, bytes: free + 1 },
    ]);
    expect(overBy1).toBeNull();
    overBy1?.release();
  });

  it("is charged ZERO once hydrated and the bytes are demonstrably absent", async () => {
    // The second arm, and the reason the first cannot stand alone: with the
    // hydration gate deleted, a cold store and an absent hash look identical
    // from the outside, so the pin above would still pass. Here the partition
    // has looked and found nothing, and an absent root must cost nothing -
    // charging the ceiling for bytes nobody holds is a tax no measurement can
    // ever retire.
    const budget = await import("@/lib/composer/landing-image-budget");
    const store = await import("@/lib/composer/landing-image-store");

    store.setLandingImageSizesHydratedForTests(true);
    registerExtraImageRootSource({ hashes: () => ["f".repeat(64)] });

    const whole = budget.tryReserveLandingImageBudget([
      { hash: null, bytes: budget.LANDING_IMAGE_BUDGET_BYTES },
    ]);
    expect(whole).not.toBeNull();
    whole?.release();
  });
});
