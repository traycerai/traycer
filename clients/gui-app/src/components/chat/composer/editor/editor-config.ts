import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Blockquote from "@tiptap/extension-blockquote";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extensions/placeholder";
import Link from "@tiptap/extension-link";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import type { ComposerPickerStore } from "../picker/composer-picker-store";

import { createMentionExtension } from "./extensions/mention-extension";
import {
  ChatSlashCommandNode,
  createSlashSuggestionExtension,
} from "./extensions/slash-command-extension";
import { AttachmentGroupNode } from "./extensions/attachment-group-extension";
import { ImageAttachmentNode } from "./extensions/image-attachment-extension";
import { ChatListKeymap } from "./extensions/chat-list-keymap";
import { createChatPasteHandler } from "./extensions/chat-paste-handler";
import { ChatCopySerializer } from "./extensions/chat-copy-serializer";

export interface BuildComposerExtensionsArgs {
  readonly pickerStore: ComposerPickerStore;
  readonly placeholder: string;
  readonly onSubmit: { readonly current: () => void };
  readonly slashProviderId: GuiHarnessId;
  readonly getHasPastedImageBytes: () => ((hash: string) => boolean) | null;
}

// Blockquote is button-only (T5): the composer schema stays blockquote-valid
// (so quoted drafts and edited sent messages round-trip) but grants none of
// the extension's default authoring affordances - no `> ` wrapping input rule,
// no Cmd-Shift-B toggle. `addCommands` (setBlockquote/toggleBlockquote/
// unsetBlockquote) is left untouched; `unsetBlockquote` backs the composer's
// own narrow Backspace-unwrap keymap.
const ComposerBlockquote = Blockquote.extend({
  addInputRules() {
    return [];
  },
  addKeyboardShortcuts() {
    return {};
  },
});

export function buildComposerExtensions(
  args: BuildComposerExtensionsArgs,
): Extensions {
  return [
    StarterKit.configure({
      heading: false,
      horizontalRule: false,
      blockquote: false,
      link: false,
      dropcursor: false,
      gapcursor: false,
    }),
    ComposerBlockquote,
    Markdown,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
    }),
    Placeholder.configure({
      placeholder: args.placeholder,
      includeChildren: false,
      emptyEditorClass: "is-editor-empty",
    }),
    createMentionExtension({ pickerStore: args.pickerStore }),
    ChatSlashCommandNode,
    createSlashSuggestionExtension({ pickerStore: args.pickerStore }),
    AttachmentGroupNode,
    ImageAttachmentNode,
    ChatListKeymap.configure({
      onSubmit: args.onSubmit,
      pickerStore: args.pickerStore,
    }),
    createChatPasteHandler({
      pickerStore: args.pickerStore,
      getHasPastedImageBytes: args.getHasPastedImageBytes,
    }),
    // Cmd+C / Cmd+X -> structured plain text (list markers, mentions, slash
    // commands) instead of ProseMirror's default blank-line-joined textContent.
    ChatCopySerializer,
  ];
}
