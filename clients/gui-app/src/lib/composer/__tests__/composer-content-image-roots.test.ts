import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  __resetComposerContentImageRootsForTests,
  holdComposerContentImageRoots,
  releaseComposerContentImageRoots,
  withHeldComposerContentImageRoots,
} from "@/lib/composer/composer-content-image-roots";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";

const HASH = "a".repeat(64);

function docWithHashOnlyImage(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "img-1",
          fileName: "screenshot.png",
          mimeType: "image/png",
          size: 128,
          hash,
        },
      },
    ],
  };
}

afterEach(() => {
  __resetComposerContentImageRootsForTests();
});

describe("composer content image roots", () => {
  it("a held hash appears in the live root set, and disappears once released", () => {
    holdComposerContentImageRoots("holder-1", docWithHashOnlyImage(HASH));

    expect(landingLiveImageRootHashes().has(HASH)).toBe(true);

    releaseComposerContentImageRoots("holder-1");

    expect(landingLiveImageRootHashes().has(HASH)).toBe(false);
  });

  it("releasing a holder id that never registered is a no-op", () => {
    expect(() =>
      releaseComposerContentImageRoots("unknown-holder"),
    ).not.toThrow();
  });

  it("re-registering the same holder id replaces its entry rather than accumulating", () => {
    const otherHash = "b".repeat(64);
    holdComposerContentImageRoots("holder-1", docWithHashOnlyImage(HASH));
    holdComposerContentImageRoots("holder-1", docWithHashOnlyImage(otherHash));

    const roots = landingLiveImageRootHashes();
    expect(roots.has(otherHash)).toBe(true);
    expect(roots.has(HASH)).toBe(false);
  });
});

/**
 * The `try`/`finally` these three submit surfaces share lives in this helper
 * rather than in their hook bodies, because the React Compiler cannot lower a
 * `try` with no `catch` and the whole hook would lose its memoization. Moving
 * it made one module responsible for an invariant three call sites depend on,
 * so it needs its own coverage - the happy path above never exercises the leg
 * that actually matters.
 */
describe("withHeldComposerContentImageRoots", () => {
  it("holds for the duration of the run and releases after it resolves", async () => {
    let heldDuringRun = false;
    await withHeldComposerContentImageRoots(
      "holder-run",
      docWithHashOnlyImage(HASH),
      async () => {
        heldDuringRun = landingLiveImageRootHashes().has(HASH);
        await Promise.resolve();
      },
      () => undefined,
    );

    expect(heldDuringRun).toBe(true);
    expect(landingLiveImageRootHashes().has(HASH)).toBe(false);
  });

  it("releases the hold and settles even when the run REJECTS, and still propagates", async () => {
    let settled = false;
    const boom = new Error("resolution blew up");

    await expect(
      withHeldComposerContentImageRoots(
        "holder-throw",
        docWithHashOnlyImage(HASH),
        () => Promise.reject(boom),
        () => {
          settled = true;
        },
      ),
    ).rejects.toBe(boom);

    // Without the `finally` the hash would be pinned for the life of the
    // renderer and the surface would stay stuck in its preparing state.
    expect(landingLiveImageRootHashes().has(HASH)).toBe(false);
    expect(settled).toBe(true);
  });

  it("runs the settle callback exactly once", async () => {
    let settleCount = 0;
    await withHeldComposerContentImageRoots(
      "holder-once",
      docWithHashOnlyImage(HASH),
      () => Promise.resolve(),
      () => {
        settleCount += 1;
      },
    );

    expect(settleCount).toBe(1);
  });
  it("two overlapping holds under one label do not release each other (DRIVE RED)", async () => {
    // The lifetime of a scoped hold is one async call, and two can legitimately
    // overlap under one surface identity: a composer remounted under the same
    // `taskId` while the previous preparation is still awaiting, or two canvas
    // tiles showing one chat. Keyed by the label, the second `hold` overwrote
    // the first's entry and the FIRST `finally` deleted the second's - so the
    // bytes the still-running preparation needs were reaped mid-flight.
    const HASH_A = "aa".repeat(32);
    const HASH_B = "bb".repeat(32);
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: () => void = () => undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = withHeldComposerContentImageRoots(
      "overlapping-label",
      docWithHashOnlyImage(HASH_A),
      () => firstGate,
      () => undefined,
    );
    const second = withHeldComposerContentImageRoots(
      "overlapping-label",
      docWithHashOnlyImage(HASH_B),
      () => secondGate,
      () => undefined,
    );

    // Both are in flight, so both documents are rooted.
    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(true);
    expect(landingLiveImageRootHashes().has(HASH_B)).toBe(true);

    // The FIRST settles while the second is still preparing.
    releaseFirst();
    await first;

    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(false);
    // The second still needs its bytes - this is the assertion that goes red
    // when the key is the label rather than the acquisition.
    expect(landingLiveImageRootHashes().has(HASH_B)).toBe(true);

    releaseSecond();
    await second;
    expect(landingLiveImageRootHashes().has(HASH_B)).toBe(false);
  });
});
