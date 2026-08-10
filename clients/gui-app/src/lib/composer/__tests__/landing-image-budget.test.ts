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
  reserveLandingImageBudget,
  resetLandingImageBudgetReservationsForTesting,
} from "@/lib/composer/landing-image-budget";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import {
  emptyLandingDraftWorkspaceSnapshot,
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
