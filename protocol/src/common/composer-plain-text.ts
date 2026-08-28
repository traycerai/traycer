import type { JsonContent } from "./registry";
import {
  mentionAttachmentFromAttrs,
  stringValue,
} from "./composer-mention-attrs";

/**
 * The plain-text projection of composer content - what a document READS as once
 * its atoms are spelled out: `@mentions` as their resolved paths, `/commands`
 * as their canonical names, quotes prefixed the way markdown quotes them, and
 * attachments as nothing at all.
 *
 * This is the projection behind a sent message's `contentText`, a draft tab's
 * label, and the chat minimap's preview - so it is also the projection the
 * host's transcript row skeleton has to run
 * ({@link ../persistence/chat-transcript/build-skeleton}'s
 * `TranscriptPreviewProjection`). It lives in `common/` for that reason: it is
 * a projection OF `JsonContent`, sitting beside `json-content-serializer.ts`,
 * which is the other one - and deliberately not under
 * `persistence/chat-transcript/`, since a draft tab's label is not a transcript
 * concern and most of its callers never touch a transcript at all.
 *
 * It is the same code the GUI has always run, not a second implementation of
 * it. `clients/gui-app/src/lib/composer/tiptap-json-content.ts` re-exports
 * everything here under its original names, so every GUI import path is
 * unchanged and there is nothing for a host copy to drift from. The two
 * projections differ in what they are FOR and must not be conflated:
 * `jsonContentToMarkdown` produces the markdown an agent reads, with validation
 * markers and `@agent:` reference forms; this produces the text a human reads
 * back.
 */

export function extractPlainTextFromComposerJSONContent(
  content: JsonContent,
): string {
  return extractPlainTextFromComposerNodes(content.content ?? []);
}

/**
 * The same projection over a bare node LIST rather than a document.
 *
 * Exported for the composer's leading-token scan, which asks whether the
 * siblings AFTER a candidate `/command` leave its token terminated. That
 * question is decided by what the remainder projects to, and answering it per
 * node type kept getting it wrong in a new way each time - so the scan
 * delegates to this rather than to a hand-written mirror of it.
 */
export function extractPlainTextFromComposerNodes(
  content: ReadonlyArray<JsonContent>,
): string {
  return content
    .flatMap((node) => {
      const text = plainTextFromNode(node);
      return text.length > 0 ? [text] : [];
    })
    .join("\n");
}

function plainTextFromNode(node: JsonContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return mentionPlainTextFromAttrs(node.attrs);
  if (node.type === "slashCommand") {
    return slashCommandPlainTextFromAttrs(node.attrs);
  }
  if (node.type === "imageAttachment") return "";
  if (node.type === "attachmentGroup") return "";
  // A sourced quote projects to text exactly like a blockquote - the source it
  // remembers travels in its attrs, not in the prose.
  if (node.type === "blockquote" || node.type === "sourcedQuote") {
    return blockquotePlainText(node);
  }
  return (node.content ?? []).map((child) => plainTextFromNode(child)).join("");
}

function blockquotePlainText(node: JsonContent): string {
  const text = (node.content ?? [])
    .map((child) => plainTextFromNode(child))
    .join("\n");
  return quotePrefixLines(text);
}

/**
 * The single markdown-quote prefix rule for every plain-text projection of a
 * blockquote (submit `contentText` here, composer copy in the GUI's
 * `composer-clipboard.ts`). Blank lines become a bare `>` so the quote stays
 * one contiguous block. Child serialization legitimately differs per caller;
 * only this prefixing rule is shared.
 */
export function quotePrefixLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * What a mention chip projects to: `@` plus the path its attributes RESOLVE to.
 *
 * Goes through the full attribute decode rather than reading `attrs.path`,
 * because the two are not the same string - see `composer-mention-attrs.ts`.
 * A node whose attributes cannot be decoded into a reference at all projects to
 * nothing, so a broken chip contributes no text instead of a broken one.
 */
export function mentionPlainTextFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  if (attrs === undefined) return "";

  const mention = mentionAttachmentFromAttrs(attrs);
  if (mention === null) return "";
  return `@${mention.path}`;
}

export function slashCommandPlainTextFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  const name = slashCommandNameFromAttrs(attrs);
  if (name === null) return "";
  return `/${name}`;
}

/**
 * What the chip reads on screen, which is not always what it serializes to.
 *
 * A chip written with `$` - picked from the popover, pasted, or spliced out of a
 * next-step prompt - keeps that character in its label so both the live composer
 * and the sent message show back what was written, while
 * {@link slashCommandPlainTextFromAttrs} still emits the canonical `/name` the
 * provider and the round-trip parser expect. Skills reach the host through
 * `skillInvocations`, keyed off the node's `kind` rather than this text, so the
 * trigger stays a purely local affordance.
 *
 * Travels with its plain-text sibling rather than staying beside the node view
 * that draws it: both read the name off the same attributes with the same
 * `commandName` / `name` / `id` fallback, and splitting them would leave that
 * fallback restated in two places.
 */
export function slashCommandLabelFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  const name = slashCommandNameFromAttrs(attrs);
  if (name === null) return "";
  return `${stringValue(attrs?.trigger) === "$" ? "$" : "/"}${name}`;
}

function slashCommandNameFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string | null {
  const name =
    stringValue(attrs?.commandName) ??
    stringValue(attrs?.name) ??
    stringValue(attrs?.id);
  if (name === null) return null;
  return name.replace(/^[/$]+/, "");
}
