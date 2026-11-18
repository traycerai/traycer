import { describe, expect, it } from "vitest";

import { decideDraftImageRefusal } from "@/lib/drafts/draft-image-send-refusal";

const HASHES = ["a".repeat(64), "b".repeat(64)];

describe("decideDraftImageRefusal", () => {
  it("empty hashOnlyHashes always surfaces, whatever the cause", () => {
    for (const cause of [
      "not-on-host",
      "unsupported-format",
      "too-large",
      null,
    ] as const) {
      const decision = decideDraftImageRefusal({
        cause,
        hashOnlyHashes: [],
        alreadyRetried: false,
      });
      expect(decision).toEqual({ kind: "surface", unbridgeable: [] });
    }
  });

  it("unsupported-format surfaces and marks every hash-only hash unbridgeable", () => {
    const decision = decideDraftImageRefusal({
      cause: "unsupported-format",
      hashOnlyHashes: HASHES,
      alreadyRetried: false,
    });
    expect(decision).toEqual({ kind: "surface", unbridgeable: HASHES });
  });

  it("too-large surfaces with nothing marked unbridgeable", () => {
    const decision = decideDraftImageRefusal({
      cause: "too-large",
      hashOnlyHashes: HASHES,
      alreadyRetried: false,
    });
    expect(decision).toEqual({ kind: "surface", unbridgeable: [] });
  });

  it("not-on-host retries inline when this send has not already retried", () => {
    const decision = decideDraftImageRefusal({
      cause: "not-on-host",
      hashOnlyHashes: HASHES,
      alreadyRetried: false,
    });
    expect(decision).toEqual({ kind: "retry-inline", hashes: HASHES });
  });

  it("not-on-host surfaces once alreadyRetried turns it terminal", () => {
    const decision = decideDraftImageRefusal({
      cause: "not-on-host",
      hashOnlyHashes: HASHES,
      alreadyRetried: true,
    });
    expect(decision).toEqual({ kind: "surface", unbridgeable: [] });
  });

  it("an absent cause behaves as not-on-host: retries when fresh", () => {
    const decision = decideDraftImageRefusal({
      cause: null,
      hashOnlyHashes: HASHES,
      alreadyRetried: false,
    });
    expect(decision).toEqual({ kind: "retry-inline", hashes: HASHES });
  });

  it("an absent cause behaves as not-on-host: surfaces once already retried", () => {
    const decision = decideDraftImageRefusal({
      cause: null,
      hashOnlyHashes: HASHES,
      alreadyRetried: true,
    });
    expect(decision).toEqual({ kind: "surface", unbridgeable: [] });
  });
});
