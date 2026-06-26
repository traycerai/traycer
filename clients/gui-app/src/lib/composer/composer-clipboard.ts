import type { Slice } from "@tiptap/pm/model";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  mentionPlainTextFromAttrs,
  numberValue,
  slashCommandPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";
import {
  isJsonContent,
  isRecord,
  sliceToDocJson,
} from "@/lib/editor/prosemirror-json";

const CLIPBOARD_SCHEMA = "traycer.composer-content";
const CLIPBOARD_VERSION = 1;
const COMPOSER_CONTENT_HTML_ATTR = "data-traycer-composer-content";

const COMPOSER_CLIPBOARD_MIME = "application/x-traycer-composer+json";
const WEB_COMPOSER_CLIPBOARD_MIME = `web ${COMPOSER_CLIPBOARD_MIME}`;

interface ComposerClipboardCopyArgs {
  readonly content: JsonContent;
  readonly plainText: string;
}

interface ComposerClipboardPayload {
  readonly schema: typeof CLIPBOARD_SCHEMA;
  readonly version: typeof CLIPBOARD_VERSION;
  readonly content: JsonContent;
}

interface ClipboardTextContext {
  readonly listDepth: number;
}

export async function copyComposerContentToClipboard(
  args: ComposerClipboardCopyArgs,
): Promise<void> {
  const html = buildComposerClipboardHtml(args.content, args.plainText);
  const clipboard = navigator.clipboard;
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof clipboard.write === "function"
  ) {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([args.plainText], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      await clipboard.writeText(args.plainText);
      return;
    }
  }
  await clipboard.writeText(args.plainText);
}

export function composerClipboardPlainText(content: JsonContent): string {
  return normalizeClipboardText(
    composerClipboardPlainTextFromNode(content, { listDepth: 0 }),
  );
}

/**
 * `clipboardTextSerializer` for the chat composer editor. ProseMirror's default
 * serializer emits node `textContent` joined by blank lines, which drops list
 * markers and double-spaces every block. Routing the copied slice through the
 * composer's structured plain-text serializer instead keeps `-` / `1.` markers,
 * mentions, and slash commands intact on Cmd+C / Cmd+X.
 */
export function composerClipboardTextSerializer(slice: Slice): string {
  const doc = sliceToDocJson(slice);
  if (doc === null) return "";
  return composerClipboardPlainText(doc);
}

export function buildComposerClipboardHtml(
  content: JsonContent,
  plainText: string,
): string {
  const payload = serializeComposerClipboardPayload(content);
  return [
    `<div ${COMPOSER_CONTENT_HTML_ATTR}="${escapeHtmlAttr(payload)}" style="display:none"></div>`,
    `<div>${plainTextToHtml(plainText)}</div>`,
  ].join("");
}

export function readComposerContentFromClipboardData(
  clipboardData: DataTransfer,
): JsonContent | null {
  const customPayload = getClipboardData(
    clipboardData,
    COMPOSER_CLIPBOARD_MIME,
  );
  const customContent = parseComposerClipboardPayload(customPayload);
  if (customContent !== null) return customContent;

  const webCustomPayload = getClipboardData(
    clipboardData,
    WEB_COMPOSER_CLIPBOARD_MIME,
  );
  const webCustomContent = parseComposerClipboardPayload(webCustomPayload);
  if (webCustomContent !== null) return webCustomContent;

  const html = getClipboardData(clipboardData, "text/html");
  if (html.length === 0) return null;
  return parseComposerClipboardHtml(html);
}

function parseComposerClipboardPayload(value: string): JsonContent | null {
  if (value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (parsed.schema !== CLIPBOARD_SCHEMA) return null;
    if (parsed.version !== CLIPBOARD_VERSION) return null;
    const content = parsed.content;
    return isJsonContent(content, 0) ? content : null;
  } catch {
    return null;
  }
}

function serializeComposerClipboardPayload(content: JsonContent): string {
  const payload: ComposerClipboardPayload = {
    schema: CLIPBOARD_SCHEMA,
    version: CLIPBOARD_VERSION,
    content,
  };
  return JSON.stringify(payload);
}

export function parseComposerClipboardHtml(html: string): JsonContent | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const holder = parsed.body.querySelector(`[${COMPOSER_CONTENT_HTML_ATTR}]`);
  const payload = holder?.getAttribute(COMPOSER_CONTENT_HTML_ATTR) ?? "";
  return parseComposerClipboardPayload(payload);
}

function getClipboardData(clipboardData: DataTransfer, type: string): string {
  try {
    return clipboardData.getData(type);
  } catch {
    return "";
  }
}

function composerClipboardPlainTextFromNodes(
  nodes: ReadonlyArray<JsonContent>,
  ctx: ClipboardTextContext,
  separator: string,
): string {
  return nodes
    .map((node) => composerClipboardPlainTextFromNode(node, ctx))
    .filter((text) => text.length > 0)
    .join(separator);
}

function composerClipboardPlainTextFromNode(
  node: JsonContent,
  ctx: ClipboardTextContext,
): string {
  const inlineText = composerClipboardInlinePlainText(node);
  if (inlineText !== null) return inlineText;
  const blockText = composerClipboardBlockPlainText(node, ctx);
  if (blockText !== null) return blockText;
  return composerClipboardPlainTextFromNodes(node.content ?? [], ctx, "");
}

function composerClipboardInlinePlainText(node: JsonContent): string | null {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return mentionPlainTextFromAttrs(node.attrs);
  if (node.type === "slashCommand") {
    return slashCommandPlainTextFromAttrs(node.attrs);
  }
  if (node.type === "imageAttachment" || node.type === "attachmentGroup") {
    return "";
  }
  return null;
}

function composerClipboardBlockPlainText(
  node: JsonContent,
  ctx: ClipboardTextContext,
): string | null {
  if (node.type === "doc") {
    return composerClipboardPlainTextFromNodes(node.content ?? [], ctx, "\n\n");
  }
  if (node.type === "paragraph") {
    return composerClipboardPlainTextFromNodes(node.content ?? [], ctx, "");
  }
  if (node.type === "bulletList") {
    return listPlainText(node.content ?? [], ctx, "bullet", null);
  }
  if (node.type === "orderedList") {
    return listPlainText(
      node.content ?? [],
      ctx,
      "ordered",
      numberValue(node.attrs?.start),
    );
  }
  if (node.type === "listItem") {
    return composerClipboardPlainTextFromNodes(node.content ?? [], ctx, "\n");
  }
  if (node.type === "codeBlock") {
    const code = composerClipboardPlainTextFromNodes(
      node.content ?? [],
      ctx,
      "",
    );
    return `\`\`\`\n${code}\n\`\`\``;
  }
  return null;
}

function listPlainText(
  children: ReadonlyArray<JsonContent>,
  ctx: ClipboardTextContext,
  kind: "bullet" | "ordered",
  start: number | null,
): string {
  const childCtx = { listDepth: ctx.listDepth + 1 };
  return children
    .flatMap((child, index) => {
      if (child.type !== "listItem") return [];
      const marker = kind === "bullet" ? "-" : `${(start ?? 1) + index}.`;
      return [listItemPlainText(child, childCtx, marker)];
    })
    .join("\n");
}

function listItemPlainText(
  node: JsonContent,
  ctx: ClipboardTextContext,
  marker: string,
): string {
  const indent = "  ".repeat(Math.max(0, ctx.listDepth - 1));
  const continuationIndent = " ".repeat(indent.length + marker.length + 1);
  const text = composerClipboardPlainTextFromNode(node, ctx);
  if (text.length === 0) return `${indent}${marker}`;
  const lines = text.split("\n");
  const first = lines[0];
  const rest = lines
    .slice(1)
    .map((line) => (line.length === 0 ? line : `${continuationIndent}${line}`));
  return [`${indent}${marker} ${first}`, ...rest].join("\n");
}

function normalizeClipboardText(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => escapeHtmlText(line))
    .join("<br>");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
