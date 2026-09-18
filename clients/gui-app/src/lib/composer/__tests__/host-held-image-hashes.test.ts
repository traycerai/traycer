import { beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import {
  __resetHostHeldImageHashesForTests,
  clearHostHeldImageHashes,
  hostHeldImageHashes,
  NO_HOST_HELD_HASHES,
  setHostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import { draftImageInliningNeeded } from "@/lib/drafts/draft-image-inlining";

const SURFACE = "chat-1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

beforeEach(() => {
  __resetHostHeldImageHashesForTests();
});

describe("host-held image hashes", () => {
  it("round-trips a set/read for the same incarnation", () => {
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, incarnation, [HASH_A, HASH_B]);

    expect(hostHeldImageHashes(SURFACE, incarnation)).toEqual(
      new Set([HASH_A, HASH_B]),
    );
  });

  it("reads empty for a different incarnation than the one stored", () => {
    const stored = createComposerEditorIncarnation();
    const other = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, stored, [HASH_A]);

    expect(hostHeldImageHashes(SURFACE, other)).toBe(NO_HOST_HELD_HASHES);
  });

  it("a null stored incarnation matches any incarnation", () => {
    setHostHeldImageHashes(SURFACE, null, [HASH_A]);
    const incarnation = createComposerEditorIncarnation();

    expect(hostHeldImageHashes(SURFACE, incarnation)).toEqual(
      new Set([HASH_A]),
    );
    expect(hostHeldImageHashes(SURFACE, null)).toEqual(new Set([HASH_A]));
  });

  it("a null incarnation passed at read time matches any stored entry", () => {
    const stored = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, stored, [HASH_A]);

    expect(hostHeldImageHashes(SURFACE, null)).toEqual(new Set([HASH_A]));
  });

  it("clear removes the surface's entry", () => {
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, incarnation, [HASH_A]);

    clearHostHeldImageHashes(SURFACE);

    expect(hostHeldImageHashes(SURFACE, incarnation)).toBe(NO_HOST_HELD_HASHES);
  });

  it("setting an empty hash list clears the entry rather than storing empty", () => {
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, incarnation, [HASH_A]);

    setHostHeldImageHashes(SURFACE, incarnation, []);

    expect(hostHeldImageHashes(SURFACE, incarnation)).toBe(NO_HOST_HELD_HASHES);
  });

  it("a surface with no entry at all reads empty", () => {
    const incarnation = createComposerEditorIncarnation();
    expect(hostHeldImageHashes("never-seeded", incarnation)).toBe(
      NO_HOST_HELD_HASHES,
    );
  });
});

describe("draftImageInliningNeeded against host-held hashes", () => {
  function docWithHashOnlyImages(
    ...hashes: ReadonlyArray<string>
  ): JsonContent {
    return {
      type: "doc",
      content: hashes.map((hash) => ({
        type: "imageAttachment",
        attrs: {
          id: `img-${hash.slice(0, 6)}`,
          fileName: "screenshot.png",
          mimeType: "image/png",
          size: 128,
          hash,
        },
      })),
    };
  }

  it("excludes a host-held hash and includes one that is not", () => {
    const content = docWithHashOnlyImages(HASH_A, HASH_B);
    const hostHeld = new Set([HASH_A]);

    expect(draftImageInliningNeeded(content, hostHeld)).toEqual([HASH_B]);
  });

  it("needs nothing when every hash-only node is host-held", () => {
    const content = docWithHashOnlyImages(HASH_A, HASH_B);
    const incarnation = createComposerEditorIncarnation();
    setHostHeldImageHashes(SURFACE, incarnation, [HASH_A, HASH_B]);

    expect(
      draftImageInliningNeeded(
        content,
        hostHeldImageHashes(SURFACE, incarnation),
      ),
    ).toEqual([]);
  });
});
