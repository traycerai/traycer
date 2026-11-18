import { afterEach, describe, expect, it } from "vitest";

import {
  __resetPendingIngestImageRootsForTests,
  holdPendingIngestImageHash,
  pendingIngestImageHashRoots,
  releasePendingIngestImageHashes,
} from "@/lib/composer/pending-ingest-image-roots";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

afterEach(() => {
  __resetPendingIngestImageRootsForTests();
});

describe("pending-ingest-image-roots", () => {
  it("a held hash appears in the live root set, and disappears once released", () => {
    holdPendingIngestImageHash("holder-1", HASH_A);

    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(true);
    expect(pendingIngestImageHashRoots()).toContain(HASH_A);

    releasePendingIngestImageHashes("holder-1");

    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(false);
    expect(pendingIngestImageHashRoots()).not.toContain(HASH_A);
  });

  it("holds each hash under a holder independently - an early finisher stays rooted while a slower sibling under the SAME holder is still pending", () => {
    // This is F1's shape: `holdPendingIngestImageHash` is called per hash as
    // each completes, not once for the whole batch - so the fast file's hash
    // must be rooted the instant it exists, before the slow sibling's call
    // arrives at all.
    holdPendingIngestImageHash("batch-1", HASH_A);
    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(true);

    holdPendingIngestImageHash("batch-1", HASH_B);
    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(true);
    expect(landingLiveImageRootHashes().has(HASH_B)).toBe(true);
  });

  it("releasing a holder id releases every hash it accumulated, in one call", () => {
    holdPendingIngestImageHash("batch-1", HASH_A);
    holdPendingIngestImageHash("batch-1", HASH_B);

    releasePendingIngestImageHashes("batch-1");

    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(false);
    expect(landingLiveImageRootHashes().has(HASH_B)).toBe(false);
  });

  it("releasing a holder id that never registered is a no-op", () => {
    expect(() =>
      releasePendingIngestImageHashes("unknown-holder"),
    ).not.toThrow();
  });

  it("releasing one holder does not affect another holder's held hashes", () => {
    holdPendingIngestImageHash("holder-1", HASH_A);
    holdPendingIngestImageHash("holder-2", HASH_B);

    releasePendingIngestImageHashes("holder-1");

    expect(landingLiveImageRootHashes().has(HASH_A)).toBe(false);
    expect(landingLiveImageRootHashes().has(HASH_B)).toBe(true);
  });
});
