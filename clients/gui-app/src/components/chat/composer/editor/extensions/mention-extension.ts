import { mergeAttributes, type Editor } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";

import {
  mentionAttrsFromAttachment,
  mentionPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";
import type { MentionAttachment } from "@/lib/composer/types";

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
      allowSpaces: false,
      allowedPrefixes: null,
      decorationTag: "span",
      decorationClass: "",
      items: () => [],
      render: createComposerSuggestionRender({
        pickerStore: deps.pickerStore,
        kind: "mention",
        slashTrigger: null,
        slashScopeForProps: null,
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
        commitMentionInsertion(editor, range, action.mention);
      },
    },
  });

  return ChatMention;
}

function commitMentionInsertion(
  editor: Editor,
  range: { from: number; to: number },
  mention: MentionAttachment,
): void {
  const overrideSpace =
    editor.state.doc.textBetween(range.to, range.to + 1) === " ";
  editor
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
