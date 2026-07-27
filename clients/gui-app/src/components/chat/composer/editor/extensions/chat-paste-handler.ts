import { Extension } from "@tiptap/core";
import { Plugin, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
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
  stringValue,
} from "@/lib/composer/tiptap-json-content";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { hasClaimableFileTransfer } from "@/lib/files/file-transfer-paths";

import {
  isLeadingRange,
  leadingTokenInDocument,
} from "./slash-command-extension";
import type { ComposerPickerStore } from "../../picker/composer-picker-store";

const BOLD_MARK = { type: "bold" };

export interface ChatPasteHandlerDeps {
  readonly pickerStore: ComposerPickerStore;
  readonly getHasPastedImageBytes: () => ((hash: string) => boolean) | null;
}

export function createChatPasteHandler(deps: ChatPasteHandlerDeps) {
  return Extension.create({
    name: "chatPasteHandler",

    addProseMirrorPlugins() {
      const { editor } = this;
      // The composer-content (JSON) clipboard flavor is a whole standalone
      // copied-message doc, so both the no-strip and strip cases rebuild
      // through `pasteComposerContent`'s closed 0/0 slice - there's no open
      // slice to preserve for this flavor. The HTML clipboard flavor uses
      // `pasteSliceWithValidatedImages` below instead, which strips directly
      // against the parsed `Slice`'s `Fragment` so an inline paste's open
      // boundaries survive a strip.
      const pasteWithValidatedImages = (
        view: EditorView,
        content: JsonContent,
      ): boolean => {
        const hashes = hashOnlyImageHashes(content);
        const hasPastedImageBytes = deps.getHasPastedImageBytes();
        if (hashes.length === 0 || hasPastedImageBytes === null) {
          return pasteComposerContent(view, content);
        }
        const availableHashes = new Set(
          hashes.filter((hash) => hasPastedImageBytes(hash)),
        );
        if (availableHashes.size === hashes.length) {
          return pasteComposerContent(view, content);
        }
        const filtered = filterUnavailablePastedImages(
          content,
          availableHashes,
        );
        const pasted = pasteComposerContent(view, filtered.content);
        if (filtered.removedCount > 0) {
          showUnavailablePastedImageToast(filtered.removedCount);
        }
        return pasted;
      };
      const pasteSliceWithValidatedImages = (
        view: EditorView,
        slice: Slice,
      ): boolean => {
        const dispatchSlice = (sliceToDispatch: Slice): boolean => {
          const tr = view.state.tr.replaceSelection(sliceToDispatch);
          view.dispatch(tr.scrollIntoView());
          return true;
        };
        const hashes = hashOnlyImageFragmentHashes(slice.content);
        const hasPastedImageBytes = deps.getHasPastedImageBytes();
        if (hashes.length === 0 || hasPastedImageBytes === null) {
          return dispatchSlice(slice);
        }
        const availableHashes = new Set(
          hashes.filter((hash) => hasPastedImageBytes(hash)),
        );
        if (availableHashes.size === hashes.length) {
          return dispatchSlice(slice);
        }
        const filtered = filterUnavailablePastedImageSlice(
          slice,
          availableHashes,
        );
        const pasted = dispatchSlice(filtered.slice);
        if (filtered.removedCount > 0) {
          showUnavailablePastedImageToast(filtered.removedCount);
        }
        return pasted;
      };
      return [
        new Plugin({
          props: {
            handlePaste(view, event) {
              const clipboardData = event.clipboardData;
              if (clipboardData === null) return false;

              // File-like clipboards (real `File`s, or a URI-only flavor that
              // actually parses to a `file://` path) are owned exclusively by
              // the React-level paste handler (`useComposerPasteEvents`),
              // which resolves them to real paths asynchronously. Claiming
              // the event here (returning `true` with no dispatch) stops
              // ProseMirror's own fallback text/html/markdown branches below
              // from also inserting the clipboard's textual representation -
              // a `text/uri-list` paste commonly carries a `text/plain`
              // sibling (e.g. VS Code), and without this early return that
              // sibling would insert as plain text alongside the async
              // path-span insertion. `hasClaimableFileTransfer` (unlike a
              // type-name-only check) parses the URI content first, so an
              // ordinary `https://` link paste - which also carries a
              // `text/uri-list` type - is correctly left unclaimed and falls
              // through to normal text/markdown paste below.
              if (hasClaimableFileTransfer(clipboardData)) return true;

              const composerContent =
                readComposerContentFromClipboardData(clipboardData);
              if (composerContent !== null) {
                return pasteWithValidatedImages(view, composerContent);
              }

              const html = clipboardData.getData("text/html");
              if (html.length > 0) {
                const sanitized = sanitizeMarkdownHtml(html);
                if (sanitized === null) return false;

                const parser = ProseMirrorDOMParser.fromSchema(
                  view.state.schema,
                );
                const slice = normalizeSliceSoftBreaks(
                  parser.parseSlice(sanitized, {
                    preserveWhitespace: false,
                  }),
                  view.state.schema,
                );
                return pasteSliceWithValidatedImages(view, slice);
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
            // Mirrors the `handlePaste` file-ownership guard above: a
            // file-like drop (real `File`s, or a URI entry that parses to a
            // `file://` path) is owned by the React-level drop handler.
            // Without this, ProseMirror's own default drop handling - which
            // runs whenever no plugin claims the drop - would insert whatever
            // text/html representation the drag also carries before React's
            // async path resolution lands.
            handleDrop(_view, event) {
              const dataTransfer = event.dataTransfer;
              if (dataTransfer === null) return false;
              return hasClaimableFileTransfer(dataTransfer);
            },
          },
        }),
      ];
    },
  });
}

function pasteComposerContent(view: EditorView, content: JsonContent): boolean {
  const slice = composerContentSlice(view.state.schema, content);
  if (slice === null) return false;
  const tr = view.state.tr.replaceSelection(
    normalizeSliceSoftBreaks(slice, view.state.schema),
  );
  view.dispatch(tr.scrollIntoView());
  return true;
}

function hashOnlyImageHashes(content: JsonContent): string[] {
  const hashes = new Set<string>();
  collectHashOnlyImageHashes(content, hashes);
  return Array.from(hashes);
}

function collectHashOnlyImageHashes(
  node: JsonContent,
  hashes: Set<string>,
): void {
  if (node.type === "imageAttachment") {
    const hash = stringValue(node.attrs?.hash);
    const b64content = stringValue(node.attrs?.b64content);
    if (hash !== null && b64content === null) hashes.add(hash);
    return;
  }
  node.content?.forEach((child) => collectHashOnlyImageHashes(child, hashes));
}

interface FilteredPastedImageContent {
  readonly content: JsonContent;
  readonly removedCount: number;
}

interface FilteredPastedImageNode {
  readonly node: JsonContent | null;
  readonly removedCount: number;
}

function filterUnavailablePastedImages(
  content: JsonContent,
  availableHashes: ReadonlySet<string>,
): FilteredPastedImageContent {
  const filtered = filterUnavailablePastedImageNode(content, availableHashes);
  return {
    content: filtered.node ?? { type: "doc", content: [] },
    removedCount: filtered.removedCount,
  };
}

function filterUnavailablePastedImageNode(
  node: JsonContent,
  availableHashes: ReadonlySet<string>,
): FilteredPastedImageNode {
  if (node.type === "imageAttachment") {
    const hash = stringValue(node.attrs?.hash);
    const b64content = stringValue(node.attrs?.b64content);
    if (hash !== null && b64content === null && !availableHashes.has(hash)) {
      return { node: null, removedCount: 1 };
    }
    return { node, removedCount: 0 };
  }
  if (node.content === undefined) return { node, removedCount: 0 };
  const filteredChildren = node.content.map((child) =>
    filterUnavailablePastedImageNode(child, availableHashes),
  );
  const children = filteredChildren.flatMap((child) =>
    child.node === null ? [] : [child.node],
  );
  const removedCount = filteredChildren.reduce(
    (count, child) => count + child.removedCount,
    0,
  );
  if (node.type === "attachmentGroup" && children.length === 0) {
    return { node: null, removedCount };
  }
  return { node: { ...node, content: children }, removedCount };
}

function hashOnlyImageFragmentHashes(fragment: Fragment): string[] {
  const hashes = new Set<string>();
  collectHashOnlyImageFragmentHashes(fragment, hashes);
  return Array.from(hashes);
}

function collectHashOnlyImageFragmentHashes(
  fragment: Fragment,
  hashes: Set<string>,
): void {
  fragment.forEach((node) => {
    if (node.type.name === "imageAttachment") {
      const hash = stringValue(node.attrs.hash);
      const b64content = stringValue(node.attrs.b64content);
      if (hash !== null && b64content === null) hashes.add(hash);
      return;
    }
    if (node.isLeaf) return;
    collectHashOnlyImageFragmentHashes(node.content, hashes);
  });
}

interface FilteredPastedImageSlice {
  readonly slice: Slice;
  readonly removedCount: number;
}

interface FilteredPastedImageFragment {
  readonly fragment: Fragment;
  readonly removedCount: number;
}

// Mirrors `filterUnavailablePastedImages`, but works on the ProseMirror
// `Slice`/`Fragment` directly instead of round-tripping through JSON, so the
// original slice's `openStart`/`openEnd` survive a strip. An inline atomic
// `imageAttachment` node's removal never changes block-nesting depth, so
// reusing the original open boundaries on the filtered fragment stays valid.
function filterUnavailablePastedImageSlice(
  slice: Slice,
  availableHashes: ReadonlySet<string>,
): FilteredPastedImageSlice {
  const filtered = filterUnavailablePastedImageFragment(
    slice.content,
    availableHashes,
  );
  return {
    slice: new Slice(filtered.fragment, slice.openStart, slice.openEnd),
    removedCount: filtered.removedCount,
  };
}

function filterUnavailablePastedImageFragment(
  fragment: Fragment,
  availableHashes: ReadonlySet<string>,
): FilteredPastedImageFragment {
  const children: ProseMirrorNode[] = [];
  let removedCount = 0;
  fragment.forEach((node) => {
    if (node.type.name === "imageAttachment") {
      const hash = stringValue(node.attrs.hash);
      const b64content = stringValue(node.attrs.b64content);
      if (hash !== null && b64content === null && !availableHashes.has(hash)) {
        removedCount += 1;
        return;
      }
      children.push(node);
      return;
    }
    if (node.isLeaf) {
      children.push(node);
      return;
    }
    const filteredChild = filterUnavailablePastedImageFragment(
      node.content,
      availableHashes,
    );
    removedCount += filteredChild.removedCount;
    if (
      node.type.name === "attachmentGroup" &&
      filteredChild.fragment.childCount === 0
    ) {
      return;
    }
    children.push(node.copy(filteredChild.fragment));
  });
  return { fragment: Fragment.fromArray(children), removedCount };
}

function showUnavailablePastedImageToast(removedCount: number): void {
  const plural = removedCount === 1 ? "image" : "images";
  const verb = removedCount === 1 ? "was" : "were";
  reportableErrorToast(
    removedCount === 1
      ? "Pasted image unavailable"
      : "Some pasted images are unavailable",
    {
      description: `${removedCount} ${plural} could not be found in this composer and ${verb} removed.`,
    },
    {
      title: "Pasted image unavailable",
      message: null,
      code: null,
      source: "Chat composer",
    },
  );
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
