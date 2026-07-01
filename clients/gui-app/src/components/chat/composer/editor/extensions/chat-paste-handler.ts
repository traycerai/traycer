import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Slice,
  type Schema,
} from "@tiptap/pm/model";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { readComposerContentFromClipboardData } from "@/lib/composer/composer-clipboard";
import { normalizeComposerContent } from "@/lib/composer/composer-content-normalizer";
import { sanitizeMarkdownHtml } from "@/lib/composer/markdown-paste";
import { normalizeSliceSoftBreaks } from "@/lib/composer/normalize-soft-breaks";
import {
  parseLeadingSlashCommand,
  slashCommandParagraph,
} from "@/lib/composer/tiptap-json-content";

import {
  isLeadingRange,
  leadingTokenInDocument,
} from "./slash-command-extension";
import type { ComposerPickerStore } from "../../picker/composer-picker-store";

const chatPasteHandlerKey = new PluginKey("composer-chat-paste-handler");
const BOLD_MARK = { type: "bold" };

export interface ChatPasteHandlerDeps {
  readonly pickerStore: ComposerPickerStore;
}

export function createChatPasteHandler(deps: ChatPasteHandlerDeps) {
  return Extension.create({
    name: "chatPasteHandler",

    addProseMirrorPlugins() {
      const { editor } = this;
      return [
        new Plugin({
          key: chatPasteHandlerKey,
          props: {
            handlePaste(view, event) {
              const clipboardData = event.clipboardData;
              if (clipboardData === null) return false;

              if (clipboardData.files.length > 0) return false;

              const composerContent =
                readComposerContentFromClipboardData(clipboardData);
              if (composerContent !== null) {
                const slice = composerContentSlice(
                  view.state.schema,
                  composerContent,
                );
                if (slice === null) return false;
                const tr = view.state.tr.replaceSelection(
                  normalizeSliceSoftBreaks(slice, view.state.schema),
                );
                view.dispatch(tr.scrollIntoView());
                return true;
              }

              const html = clipboardData.getData("text/html");
              if (html.length > 0) {
                const sanitized = sanitizeMarkdownHtml(html);
                if (sanitized === null) return false;

                const parser = ProseMirrorDOMParser.fromSchema(
                  view.state.schema,
                );
                const slice = parser.parseSlice(sanitized, {
                  preserveWhitespace: false,
                });
                const tr = view.state.tr.replaceSelection(
                  normalizeSliceSoftBreaks(slice, view.state.schema),
                );
                view.dispatch(tr.scrollIntoView());
                return true;
              }

              const text = clipboardData.getData("text/plain");
              if (text.length === 0) return false;

              // A `/command …` pasted at the start of the composer (e.g. a copied
              // next-step prompt) becomes a slashCommand chip, mirroring the
              // submit-time normalization and the live suggestion popover. This
              // runs before the markdown branch so the command name and its
              // literal arguments are preserved verbatim.
              const slashSlice = leadingSlashCommandSlice(
                view.state,
                text,
                deps.pickerStore.getState().knownSlashCommands,
              );
              if (slashSlice !== null) {
                const tr = view.state.tr.replaceSelection(slashSlice);
                view.dispatch(tr.scrollIntoView());
                return true;
              }
              const existingSlashPaste = existingLeadingSlashCommandPaste(
                view.state,
                text,
                deps.pickerStore.getState().knownSlashCommands,
              );
              if (existingSlashPaste !== null) {
                const tr = view.state.tr.insertText(
                  existingSlashPaste.text,
                  existingSlashPaste.pos,
                );
                view.dispatch(tr.scrollIntoView());
                return true;
              }

              if (editor.markdown === undefined) return false;
              const slice = composerMarkdownContentSlice(
                view.state.schema,
                editor.markdown.parse(text),
              );
              if (slice === null) return false;
              const tr = view.state.tr.replaceSelection(
                normalizeSliceSoftBreaks(slice, view.state.schema),
              );
              view.dispatch(tr.scrollIntoView());
              return true;
            },
          },
        }),
      ];
    },
  });
}

function composerMarkdownContentSlice(
  schema: Schema,
  content: JsonContent,
): Slice | null {
  try {
    const node = schema.nodeFromJSON(normalizeComposerMarkdownContent(content));
    if (node.type.name !== "doc") return new Slice(Fragment.from(node), 0, 0);
    const firstChild = node.firstChild;
    if (
      node.childCount === 1 &&
      firstChild !== null &&
      firstChild.type.name === "paragraph"
    ) {
      return new Slice(firstChild.content, 0, 0);
    }
    return new Slice(node.content, 0, 0);
  } catch {
    return null;
  }
}

function normalizeComposerMarkdownContent(content: JsonContent): JsonContent {
  return normalizeComposerMarkdownNode(content);
}

function normalizeComposerMarkdownNode(node: JsonContent): JsonContent {
  if (node.type === "heading") return headingAsBoldParagraph(node);
  if (node.type === "horizontalRule") return horizontalRuleAsTextParagraph();
  if (node.type === "blockquote") {
    return {
      type: "doc",
      content: normalizeComposerMarkdownChildren(node.content ?? []),
    };
  }
  const children = node.content;
  if (children === undefined) return node;
  return {
    ...node,
    content: normalizeComposerMarkdownChildren(children),
  };
}

function normalizeComposerMarkdownChildren(
  children: ReadonlyArray<JsonContent>,
): JsonContent[] {
  return children.flatMap((child) => {
    const normalized = normalizeComposerMarkdownNode(child);
    if (normalized.type === "doc") return normalized.content ?? [];
    return [normalized];
  });
}

function headingAsBoldParagraph(node: JsonContent): JsonContent {
  return {
    type: "paragraph",
    content: addBoldMarkToInlineContent(node.content ?? []),
  };
}

function horizontalRuleAsTextParagraph(): JsonContent {
  return {
    type: "paragraph",
    content: [{ type: "text", text: "---" }],
  };
}

function addBoldMarkToInlineContent(
  children: ReadonlyArray<JsonContent>,
): JsonContent[] {
  return children.map((child) => {
    const normalizedChild =
      child.content === undefined
        ? child
        : {
            ...child,
            content: addBoldMarkToInlineContent(child.content),
          };
    if (normalizedChild.type !== "text") return normalizedChild;
    return {
      ...normalizedChild,
      marks: marksWithBold(normalizedChild.marks ?? []),
    };
  });
}

function marksWithBold(
  marks: ReadonlyArray<{ type: string; attrs?: Record<string, unknown> }>,
): { type: string; attrs?: Record<string, unknown> }[] {
  if (marks.some((mark) => mark.type === BOLD_MARK.type)) return [...marks];
  return [...marks, BOLD_MARK];
}

function composerContentSlice(
  schema: Schema,
  content: JsonContent,
): Slice | null {
  try {
    const node = schema.nodeFromJSON(normalizeComposerContent(content));
    if (node.type.name === "doc") {
      return new Slice(node.content, 0, 0);
    }
    return new Slice(Fragment.from(node), 0, 0);
  } catch {
    return null;
  }
}

function leadingSlashCommandSlice(
  state: EditorState,
  text: string,
  knownCommands: ReadonlyMap<string, string> | null,
): Slice | null {
  // Without a loaded catalog we cannot tell a real command from arbitrary text,
  // so leave the paste as plain text rather than risk a chip for a non-command.
  if (knownCommands === null) return null;
  if (!isLeadingSlashTarget(state)) return null;
  const parsed = parseLeadingSlashCommand(text);
  if (parsed === null) return null;
  // Match case-insensitively but build the chip from the catalog's canonical
  // name, so a pasted `/Plan` lands the same chip the popover would for `plan`.
  const canonicalName = knownCommands.get(parsed.name.toLowerCase());
  if (canonicalName === undefined) return null;
  const paragraph = slashCommandParagraph(
    canonicalName,
    text.slice(parsed.end),
  );
  try {
    const node = state.schema.nodeFromJSON(paragraph);
    return new Slice(node.content, 0, 0);
  } catch {
    return null;
  }
}

// True when a slashCommand inserted at the current selection would land at the
// document's leading position - the only place the leading-only schema guard
// keeps it. Reuses the suggestion plugin's `isLeadingRange` predicate so paste
// is exactly as permissive as typing, and bails when the first block already
// opens with a slashCommand chip (a second one would be stripped by the guard).
function isLeadingSlashTarget(state: EditorState): boolean {
  const { selection, doc } = state;
  if (!isLeadingRange(state, selection.from, selection.to)) return false;
  return leadingTokenInDocument(doc)?.node.type.name !== "slashCommand";
}

function existingLeadingSlashCommandPaste(
  state: EditorState,
  text: string,
  knownCommands: ReadonlyMap<string, string> | null,
): { readonly pos: number; readonly text: string } | null {
  if (knownCommands === null) return null;
  // This path inserts after the existing chip without replacing the selection,
  // so restrict it to a collapsed caret. A range selection falls through to the
  // markdown branch, which replaces the selected content as the user expects.
  if (!state.selection.empty) return null;
  if (!isLeadingRange(state, state.selection.from, state.selection.to)) {
    return null;
  }
  const parsed = parseLeadingSlashCommand(text);
  if (parsed === null) return null;
  if (!knownCommands.has(parsed.name.toLowerCase())) return null;
  const leadingToken = leadingTokenInDocument(state.doc);
  if (leadingToken?.node.type.name !== "slashCommand") return null;
  return {
    pos: leadingToken.pos + leadingToken.node.nodeSize,
    text: text.startsWith(" ") ? text : ` ${text}`,
  };
}
