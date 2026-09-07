import type { JsonContent } from "./registry";
import {
  mentionAttachmentFromAttrs,
  stringValue,
} from "./composer-mention-attrs";

/**
 * Plain-text projection of composer content (human-readable). Do not conflate with `jsonContentToMarkdown`, which is what an agent reads.
 */

export function extractPlainTextFromComposerJSONContent(
  content: JsonContent,
): string {
  return extractPlainTextFromComposerNodes(content.content ?? []);
}

/** The same projection over a bare node LIST rather than a document. */
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

export function quotePrefixLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * What a mention chip projects to: `@` plus the path its attributes RESOLVE to.
 * A node whose attributes cannot be decoded into a reference at all projects to nothing, so a broken chip contributes no text instead of a broken one.
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

/** What the chip reads on screen, which is not always what it serializes to. */
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
