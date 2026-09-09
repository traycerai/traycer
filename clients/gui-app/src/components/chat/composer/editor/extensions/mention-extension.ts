import { mergeAttributes, type Editor } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";

import {
  mentionAttrsFromAttachment,
  mentionPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";
import type {
  BrowserTabMentionEntry,
  MentionAttachment,
} from "@/lib/composer/types";
import { composerDraftGeneration } from "@/lib/composer/composer-draft-generation";
import {
  browserTabPreviewText,
  fetchBrowserTabPreviewImage,
} from "@/lib/composer/mentions/browser-tab-preview";

import { MentionNodeView } from "../nodes/mention-node-view";
import { createComposerSuggestionRender } from "../../picker/suggestion-render";
import type {
  ComposerPickerItem,
  ComposerPickerStore,
} from "../../picker/composer-picker-store";
import { dataAttributeMap, MENTION_ATTRIBUTE_NAMES } from "./attribute-helpers";

export interface MentionExtensionDeps {
  readonly pickerStore: ComposerPickerStore;
}

/**
 * Stable key for the `@` mention suggestion plugin. Exported (and pinned via the
 * suggestion config below, overriding extension-mention's auto-generated key) so
 * code outside the editor can imperatively exit an open suggestion by
 * dispatching `setMeta(mentionSuggestionPluginKey, { exit: true })` - see the
 * editor's `dismissActiveSuggestion` handle.
 */
export const mentionSuggestionPluginKey = new PluginKey(
  "composer-mention-suggestion",
);

export function createMentionExtension(deps: MentionExtensionDeps) {
  const ChatMention = Mention.extend({
    name: "mention",
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      const parentAttributes = this.parent?.() ?? {};
      return {
        ...parentAttributes,
        ...dataAttributeMap(MENTION_ATTRIBUTE_NAMES),
      };
    },

    parseHTML() {
      return [{ tag: "span[data-composer-mention]" }];
    },

    renderText({ node }) {
      return mentionPlainTextFromAttrs(node.attrs);
    },

    renderHTML({ node, HTMLAttributes }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-composer-mention": "" }),
        mentionPlainTextFromAttrs(node.attrs),
      ];
    },

    addNodeView() {
      return ReactNodeViewRenderer(MentionNodeView);
    },
  }).configure({
    deleteTriggerWithBackspace: true,
    HTMLAttributes: { "data-composer-mention": "" },
    suggestion: {
      pluginKey: mentionSuggestionPluginKey,
      char: "@",
      allowSpaces: true,
      // Word-boundary trigger only: `@` opens the menu at the start of a
      // block or after a space, never mid-word - typing an email
      // (`user@host.com`) must not pop the menu at `@host`. (`null` here
      // means "trigger anywhere".)
      allowedPrefixes: [" "],
      decorationTag: "span",
      decorationClass: "",
      items: () => [],
      render: createComposerSuggestionRender({
        pickerStore: deps.pickerStore,
        kind: "mention",
        slashTrigger: null,
        slashScopeForProps: null,
        suggestionPluginKey: mentionSuggestionPluginKey,
      }),
      command: ({ editor, range, props }) => {
        const item = props as ComposerPickerItem;
        if (item.kind !== "mention") return;
        const action = item.entry.action;
        if (action.kind === "back") {
          deps.pickerStore.getState().setStep({ kind: "root" });
          return;
        }
        if (action.kind === "navigate") {
          deps.pickerStore.getState().setStep(action.step);
          return;
        }
        if (action.kind === "attach-tab-preview") {
          commitBrowserTabPreviewInsertion(editor, range, action.entry);
          return;
        }
        commitMentionInsertion(editor, range, action.mention);
      },
    },
  });

  return ChatMention;
}

/**
 * A cross-host tab commits its text line synchronously - the pick must feel
 * immediate, and the line is the part that always exists - then appends the
 * screenshot when the owning host answers. A capture that fails or is refused
 * (a dormant tab is never woken for a preview) simply appends nothing.
 */
export function commitBrowserTabPreviewInsertion(
  editor: Editor,
  range: { from: number; to: number },
  entry: BrowserTabMentionEntry,
): void {
  const overrideSpace =
    editor.state.doc.textBetween(range.to, range.to + 1) === " ";
  editor
    .chain()
    .focus()
    .insertContentAt(
      { from: range.from, to: overrideSpace ? range.to + 1 : range.to },
      [{ type: "text", text: `${browserTabPreviewText(entry)} ` }],
    )
    .run();
  const draftGeneration = composerDraftGeneration(editor);
  void fetchBrowserTabPreviewImage(entry).then((image) => {
    if (image === null || editor.isDestroyed) return;
    // The draft this pick belonged to is gone (the user sent it, or it was
    // replaced): the editor is still alive, so without this the screenshot
    // would land in the NEXT message. No `.focus()` either - a late insert
    // must not steal the caret from whatever the user is doing now.
    if (composerDraftGeneration(editor) !== draftGeneration) return;
    editor.chain().insertImageAttachment(image).run();
  });
}

function commitMentionInsertion(
  editor: Editor,
  range: { from: number; to: number },
  mention: MentionAttachment,
): boolean {
  const overrideSpace =
    editor.state.doc.textBetween(range.to, range.to + 1) === " ";
  return editor
    .chain()
    .focus()
    .insertContentAt(
      { from: range.from, to: overrideSpace ? range.to + 1 : range.to },
      [
        { type: "mention", attrs: mentionAttrsFromAttachment(mention) },
        { type: "text", text: " " },
      ],
    )
    .run();
}

export function insertMentionAttachmentCommand(
  editor: Editor,
  mention: MentionAttachment,
): boolean {
  const { from, to } = editor.state.selection;
  return commitMentionInsertion(editor, { from, to }, mention);
}
