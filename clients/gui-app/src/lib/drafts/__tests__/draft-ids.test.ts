import { describe, expect, it } from "vitest";
import {
  LEGACY_COMPOSER_DRAFT_NAMESPACE,
  interviewDraftBindingKey,
  legacyComposerDraftId,
  migratedLegacyComposerDraftId,
  mintDraftId,
} from "../draft-ids";

/**
 * The derived id is published as a cloud chat id, and that column is 36
 * chars wide. It must also stay byte-identical across releases and across
 * the host's mirror of the derivation (which re-keys rows written under
 * the earlier `legacy-composer-<key>` form), so the vector below is pinned
 * rather than recomputed.
 */
describe("legacyComposerDraftId", () => {
  it("is the pinned uuid v5 of the composer key under the fixed namespace", () => {
    expect(LEGACY_COMPOSER_DRAFT_NAMESPACE).toBe(
      "848a7355-4280-4cfc-8bc6-f9d5aa3996cc",
    );
    expect(legacyComposerDraftId("7f1c1d2a-9b4e-4d8e-8f2a-3c5b6d7e8f90")).toBe(
      "de1163cc-8dfa-5d11-9ad0-a350cc095612",
    );
    expect(legacyComposerDraftId("legacy")).toBe(
      "390e0338-6a74-5629-adb7-073d3735e98d",
    );
  });

  it("fits the 36-char cloud chat id column and stays out of the minted v4 space", () => {
    const derived = legacyComposerDraftId("chat-1");
    expect(derived).toHaveLength(36);
    expect(derived).toBe(legacyComposerDraftId("chat-1"));
    expect(derived.charAt(14)).toBe("5");
    expect(mintDraftId().charAt(14)).toBe("4");
    expect(mintDraftId()).toHaveLength(36);
  });
});

describe("migratedLegacyComposerDraftId", () => {
  it("maps the retired prefixed form to the same derivation and leaves every other id alone", () => {
    expect(
      migratedLegacyComposerDraftId(
        "legacy-composer-7f1c1d2a-9b4e-4d8e-8f2a-3c5b6d7e8f90",
      ),
    ).toBe("de1163cc-8dfa-5d11-9ad0-a350cc095612");
    expect(migratedLegacyComposerDraftId("legacy-composer-legacy")).toBe(
      legacyComposerDraftId("legacy"),
    );
    expect(
      migratedLegacyComposerDraftId("de1163cc-8dfa-5d11-9ad0-a350cc095612"),
    ).toBe("de1163cc-8dfa-5d11-9ad0-a350cc095612");
    expect(migratedLegacyComposerDraftId("d-minted")).toBe("d-minted");
    // A bare prefix names no composer; it is not a legacy id.
    expect(migratedLegacyComposerDraftId("legacy-composer-")).toBe(
      "legacy-composer-",
    );
  });
});

/**
 * These pin the RUNTIME value produced by `interviewDraftBindingKey`, not how
 * the source spells its separator. The separator is U+0000: the source now
 * writes it as a Unicode escape, but it was once a literal NUL byte in the
 * template literal, which made grep/ripgrep classify the whole file as binary
 * and skip it in a directory walk. Either spelling compiles to the same
 * runtime string, so this describe block cannot tell them apart - it can only
 * confirm the persisted-key contract (chatId + NUL + blockId) still holds.
 * `no-raw-nul-byte-in-source.test.ts` is the guard that reads the source
 * bytes and catches a literal NUL if one is reintroduced.
 */
describe("interviewDraftBindingKey", () => {
  it("joins chatId and blockId with a literal U+0000 separator", () => {
    const key = interviewDraftBindingKey("chat-1", "block-1");

    expect(key).toBe("chat-1" + String.fromCharCode(0) + "block-1");
    expect(key).toHaveLength(14);
    expect(key.charCodeAt(6)).toBe(0);
  });

  it("does not collide across chatId/blockId boundaries the way plain concatenation would", () => {
    const keyA = interviewDraftBindingKey("a", "bc");
    const keyB = interviewDraftBindingKey("ab", "c");

    expect(keyA).not.toBe(keyB);
  });
});
