/**
 * T5's send gate (`submitHostHeldImageHashes`, consumed through
 * `useChatComposerSubmit`) applies to an ORDINARY chat send only. The initial
 * create paths - the landing composer's `epic.create` and the in-epic
 * new-conversation modal's `epic.createChat` - never go through
 * `useChatComposerSubmit`, so the gate structurally cannot reach them.
 *
 * ## The rationale this file used to give, and why it no longer holds
 *
 * It said the create paths' prompt "always travels inline, regardless of
 * `draftBlobBridgeSupported`, because there is no negotiated `chat.subscribe`
 * session yet to have decided that flag from". The premise is still true and
 * the conclusion no longer follows: `epic.create` / `epic.createChat` are UNARY
 * methods that negotiate their own `{major, minor}`, so `@1.2` gives a create
 * path a capability answer without any stream at all. The absence of a stream
 * rules out the STREAM's gate; it never ruled out a gate.
 *
 * So the claim is now narrower and conditional: a create path never reaches the
 * SEND gate, and its inlining pass is unconditional BELOW `epic.create@1.2`.
 * Above it, the modal subtracts what the host has confirmed holding - see
 * `new-conversation-modal-attachments-by-hash.test.tsx` for the behaviour.
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

/**
 * The comment stripper `readSource` runs before any assertion sees a file.
 * `withoutComments` at the bottom is the entry point; the `stepIn*` arms above
 * it are one rule each.
 *
 * WHY THIS FILE STRIPS BEFORE IT SCANS. Every assertion below is a lexical
 * proxy for a semantic claim - "this surface never consults the STREAM's
 * gate" - and the proxy diverges from the claim in exactly one place: when
 * someone writes ABOUT the symbol instead of calling it. A comment explaining
 * why the modal must not ask `draftBlobBridgeSupported()` is evidence FOR the
 * claim, and matching it reds the pin for saying the right thing. That is not
 * a hypothetical - it is what happened, and rewording the prose would only
 * move the trap one edit further out.
 *
 * Strings are deliberately KEPT: a symbol reached through a string is still
 * a use (`import()`, a lookup by name), and one assertion below is about a
 * user-facing message that lives in one.
 *
 * LIMITS, stated because a stripper that ate too much would silently weaken
 * every absence assertion here rather than fail. It tracks line comments,
 * block comments and the three string forms; it does NOT track regex
 * literals, so a regex containing `//` would read as a line comment and
 * swallow the rest of that line. None of the three scanned files contains a
 * regex literal today, and the presence assertions below are the guard: they
 * run against this same stripped text, so over-stripping reds them.
 */
type StringMode = "single" | "double" | "template";
type ScanMode = "code" | "line" | "block" | StringMode;

/**
 * Where the scan is after one character: the mode it is now in, the index to
 * read next, and the text to keep. One arm per mode, so each stays small
 * enough to read as a rule rather than as control flow.
 */
interface ScanStep {
  readonly mode: ScanMode;
  readonly index: number;
  readonly emit: string;
}

const OPENING_QUOTES = new Map<string, StringMode>([
  ["'", "single"],
  ['"', "double"],
  ["`", "template"],
]);

const CLOSING_QUOTE: Record<StringMode, string> = {
  single: "'",
  double: '"',
  template: "`",
};

function stepInCode(ch: string, next: string, index: number): ScanStep {
  if (ch === "/" && next === "/") {
    return { mode: "line", index: index + 2, emit: "" };
  }
  if (ch === "/" && next === "*") {
    return { mode: "block", index: index + 2, emit: "" };
  }
  return {
    mode: OPENING_QUOTES.get(ch) ?? "code",
    index: index + 1,
    emit: ch,
  };
}

function stepInLineComment(ch: string, index: number): ScanStep {
  // The newline is kept so line numbers still line up with the file a failure
  // message points at.
  if (ch === "\n") return { mode: "code", index: index + 1, emit: ch };
  return { mode: "line", index: index + 1, emit: "" };
}

function stepInBlockComment(ch: string, next: string, index: number): ScanStep {
  if (ch === "*" && next === "/") {
    return { mode: "code", index: index + 2, emit: "" };
  }
  // Newlines only, for the same line-number reason.
  return { mode: "block", index: index + 1, emit: ch === "\n" ? ch : "" };
}

function stepInString(
  mode: StringMode,
  ch: string,
  next: string,
  index: number,
): ScanStep {
  // An escape consumes its next character, so a `\"` cannot be mistaken for
  // the closing quote.
  if (ch === "\\") return { mode, index: index + 2, emit: ch + next };
  if (ch === CLOSING_QUOTE[mode]) {
    return { mode: "code", index: index + 1, emit: ch };
  }
  return { mode, index: index + 1, emit: ch };
}

/**
 * The mode dispatch, in its own function rather than inline in the loop, and
 * for two reasons that are both load-bearing.
 *
 * Its DECLARED return type is what keeps the caller's `step` out of a type
 * cycle: resolving the last arm needs `mode` narrowed to `StringMode`,
 * narrowing is control-flow analysis, the caller's control flow includes
 * `mode = step.mode`, and typing that assignment needs `step`. Inferred
 * inline, `step` therefore depends on itself and TypeScript answers `any`
 * (TS7022), which the linter then reports five more times over. Annotating
 * the caller's `mode` does not help - it is already `let mode: ScanMode`, and
 * it is the narrowed type that is circular, not the declared one.
 *
 * And early returns rather than a ternary chain, because a four-way chain is
 * a nested ternary however it is formatted.
 */
function stepFor(
  mode: ScanMode,
  ch: string,
  next: string,
  index: number,
): ScanStep {
  if (mode === "code") return stepInCode(ch, next, index);
  if (mode === "line") return stepInLineComment(ch, index);
  if (mode === "block") return stepInBlockComment(ch, next, index);
  return stepInString(mode, ch, next, index);
}

/** `source` with its comments removed, string and template literals intact. */
function withoutComments(source: string): string {
  let mode: ScanMode = "code";
  let out = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const step = stepFor(mode, ch, next, index);
    out += step.emit;
    index = step.index;
    mode = step.mode;
  }
  return out;
}

function readSource(relativePath: string): string {
  return withoutComments(
    readFileSync(join(GUI_APP_ROOT, relativePath), "utf8"),
  );
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

  it("the new-conversation modal's inlining pass is unconditional BELOW epic.create@1.2, and what widens it is the UNARY capability - never the stream's", () => {
    const source = readSource(
      "src/components/epic-canvas/sidebar/new-conversation-modal.tsx",
    );
    // Counted, not merely present. The previous version of this case asserted
    // `NO_HOST_HELD_HASHES` appeared somewhere and that SOME
    // `draftImageInliningNeeded(x, NO_HOST_HELD_HASHES)` call existed - both of
    // which stayed true after the surface grew a by-hash path, because the
    // pre-flight seed still reads exactly that way. It passed while asserting
    // something false. A count cannot do that: the constant may appear in the
    // ONE pre-flight seed and nowhere else, so a change in either direction -
    // a second unconditional call, or the seed becoming conditional - reds.
    const unconditional = source.match(
      /draftImageInliningNeeded\(\s*\w+,\s*NO_HOST_HELD_HASHES\s*\)/g,
    );
    expect(unconditional).toHaveLength(1);
    // Every OTHER consultation goes through the live host-held set, which is
    // empty until the host confirms and is retracted when the destination
    // moves. That is what "conditional above @1.2" means operationally.
    const live = source.match(
      /draftImageInliningNeeded\([^)]*liveHostHeld\(\)/g,
    );
    expect(live?.length ?? 0).toBeGreaterThan(0);
    // And the condition is the UNARY capability. If this surface ever consults
    // the stream's flag it has acquired a dependency on a session it does not
    // have, which is the confusion the docblock above exists to prevent.
    expect(source).toContain("createAttachmentsByHashSupported");
    expect(source).not.toContain("draftBlobBridgeSupported");
  });

  it("the landing composer's inlining pass is unconditional BELOW epic.create@1.2, and what widens it is the UNARY capability - never the stream's", () => {
    const source = readSource(
      "src/components/home/hooks/use-landing-composer-actions.ts",
    );
    // The landing twin of the modal case above, and it needs the same
    // treatment for the same reason: an assertion that the by-hash arm merely
    // EXISTS stays true whichever gate opens it, so it would keep passing if
    // this surface ever started reading the stream's flag. What is pinned here
    // is which gate, and that the unconditional path is still reachable.
    //
    // Both byte paths are counted rather than asserted present. This surface
    // has exactly two - the synchronous session read and the async resolve -
    // and every one of them ends in the SHARED rewrite. A third appearing, or
    // one of these being replaced by a private rewrite, is exactly the drift
    // that put three copies of this logic in this file before.
    const rewrites = source.match(/inlineHashOnlyImageBytes\(/g);
    expect(rewrites).toHaveLength(3);
    const byteResolvers = source.match(
      /(sessionBase64ByHash|resolveBase64ByHash)\(/g,
    );
    expect(byteResolvers?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The gate is the UNARY one, named for `epic.create` specifically. A
    // surface that consulted the stream's flag would have acquired a
    // dependency on a session it does not have - the confusion the docblock
    // above exists to prevent.
    expect(source).toContain(
      'createAttachmentsByHashSupported(hostId, "epic.create")',
    );
    expect(source).not.toContain("draftBlobBridgeSupported");
    expect(source).not.toContain("sendAttachmentsByHashSupported");
    // And the landing surface keeps its own refusal: a hash with no bytes
    // names nothing here, because no epic exists yet for the host to resolve
    // it against. Every other surface leaves such a node hash-only.
    expect(source).toContain("Couldn't attach an image.");
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
