/**
 * T5's send gate (`submitHostHeldImageHashes`, consumed through
 * `useChatComposerSubmit`) applies to an ORDINARY chat send only. The initial
 * create paths - the landing composer's `epic.create` and the in-epic
 * new-conversation modal's `epic.createChat` - never go through
 * `useChatComposerSubmit`, so the gate structurally cannot reach them: their
 * prompt always travels inline, regardless of `draftBlobBridgeSupported`,
 * because there is no negotiated `chat.subscribe` session yet to have decided
 * that flag from.
 *
 * A source-level pin rather than a rendered one: both surfaces are large
 * components whose render harness would dwarf what this test needs to prove,
 * and the claim itself is about which FUNCTIONS a call site imports, which a
 * render cannot observe more directly than a static check can. If either
 * surface starts importing the gate, this goes red and the acceptance claim
 * (T5 item 8) needs re-examining, not silently waived.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GUI_APP_ROOT = join(import.meta.dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(GUI_APP_ROOT, relativePath), "utf8");
}

const CREATE_PATH_FILES = [
  "src/components/epic-canvas/sidebar/new-conversation-modal.tsx",
  "src/components/home/hooks/use-landing-composer-actions.ts",
] as const;

describe("the initial-create composer paths never reach T5's send gate", () => {
  for (const path of CREATE_PATH_FILES) {
    it(`${path} never imports useChatComposerSubmit or submitHostHeldImageHashes`, () => {
      const source = readSource(path);
      expect(source).not.toContain("useChatComposerSubmit");
      expect(source).not.toContain("submitHostHeldImageHashes");
    });
  }

  it("the new-conversation modal's own inlining pass is unconditional (NO_HOST_HELD_HASHES), not the gate's live host-held set", () => {
    const source = readSource(
      "src/components/epic-canvas/sidebar/new-conversation-modal.tsx",
    );
    // `draftImageInliningNeeded(captured, NO_HOST_HELD_HASHES)` is what makes
    // "always inline" true rather than merely asserted: it is the same
    // predicate the chat composer's gate would otherwise plug a live
    // confirmed/host-held set into, and this surface hands it the constant
    // empty one instead - nothing to subtract, so every hash-only node it
    // ever produces is treated as needing bytes.
    expect(source).toContain("NO_HOST_HELD_HASHES");
    expect(source).toMatch(
      /draftImageInliningNeeded\(\s*\w+,\s*NO_HOST_HELD_HASHES\s*\)/,
    );
  });

  it("the composer's `/btw` fork is a third create path, unpinnable by import-absence but pinned by its own re-inline call", () => {
    // `/btw` lives INSIDE `use-chat-composer-submit.ts` - the very file that
    // imports the gate for its ordinary send - so "never imports the gate"
    // cannot be the pin here. What CAN be pinned: `onSideChat` is a CREATE
    // (`epic.createChat`'s `initialMessage`), and its branch re-inlines via
    // `reinlineRefusedSendContent` rather than trusting whatever
    // `submitHostHeldImageHashes` decided for the ordinary send this
    // document would otherwise have taken. A host-held hash that the ordinary
    // gate would leave bare must still travel inline on this path -
    // see the runtime coverage in
    // `use-chat-composer-submit-draft-images.test.tsx`, which drives an
    // actual memo-confirmed hash through `onSideChat` and asserts it lands
    // inline; this pins the SOURCE shape that behaviour depends on.
    const source = readSource(
      "src/components/chat/composer/use-chat-composer-submit.ts",
    );
    const sideChatBranch = source.slice(
      source.indexOf("if (onSideChat !== null) {"),
    );
    expect(sideChatBranch).toContain("reinlineRefusedSendContent");
    // The re-inline is unconditional on hash-only content being PRESENT, not
    // on whether the gate would have called it host-held - it never reads
    // `submitHostHeldImageHashes` at all within this branch.
    expect(
      sideChatBranch.slice(0, sideChatBranch.indexOf("return;")),
    ).not.toContain("submitHostHeldImageHashes");
  });
});
