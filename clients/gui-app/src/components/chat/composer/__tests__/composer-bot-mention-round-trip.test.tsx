/**
 * A bot mention must cross the real editor intact. ProseMirror keeps only the
 * mention attrs its schema names, so a document built straight from
 * `mentionAttrsFromAttachment` cannot show a dropped `botId` or
 * `botTrunkChatId`.
 */
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { mentionAttachmentFromSuggestion } from "@/lib/composer/mentions/attachments";
import {
  collectMentionAttachmentsFromJSONContent,
  mentionAttrsFromAttachment,
} from "@/lib/composer/tiptap-json-content";
import type { BotMentionEntry, MentionAttachment } from "@/lib/composer/types";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

afterEach(() => {
  cleanup();
});

const ENTRY: BotMentionEntry = {
  kind: "bot",
  id: "bot:bot-1",
  botId: "bot-1",
  trunkChatId: "trunk-1",
  label: "Tracy · Acme",
  description: "Acme",
  keywords: ["Tracy", "Acme", "tracy", "bot"],
};

const PROJECTION = "@bot:Tracy · Acme (bot bot-1, trunk agent trunk-1)";

function pickedMention(): MentionAttachment {
  const mention = mentionAttachmentFromSuggestion(ENTRY);
  if (mention === null) throw new Error("a bot entry completes a mention");
  return mention;
}

function emptyDoc(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function toAgentText(json: JsonContent): string {
  return jsonContentToMarkdown(json, {
    mentionFormat: "llm",
    platform: "POSIX",
  }).trim();
}

interface HarnessProps {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly initialContent: JsonContent;
  readonly onEditorReady: () => void;
}

function Harness(props: HarnessProps) {
  const { handleRef, initialContent, onEditorReady } = props;
  const [pickerStore] = useState(() => createComposerPickerStore());
  return (
    <ComposerPromptEditor
      ref={(instance) => {
        handleRef.current = instance;
      }}
      initialContent={initialContent}
      initialSelection={null}
      pickerStore={pickerStore}
      placeholder="bot-mention"
      editorClassName={undefined}
      isActive={false}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      stabilizeImageAttachmentCaret={false}
      onDocumentChange={() => undefined}
      onSelectionChange={() => undefined}
      onSubmit={() => undefined}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onKeyDown={undefined}
      interceptKeyDown={null}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={onEditorReady}
    />
  );
}

async function mountEditor(
  initialContent: JsonContent,
): Promise<ComposerPromptEditorHandle> {
  const handleRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };
  // The editor is created asynchronously; its ready signal is what makes the
  // handle's methods stop no-oping.
  const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  render(
    <Harness
      handleRef={handleRef}
      initialContent={initialContent}
      onEditorReady={markReady}
    />,
  );
  await ready;
  const handle = handleRef.current;
  if (handle === null) throw new Error("editor handle missing");
  return handle;
}

describe("a bot mention through the composer editor", () => {
  it("a picked bot reaches the agent with its trunk agent id", async () => {
    const mention = pickedMention();
    const handle = await mountEditor(emptyDoc());

    let inserted = false;
    act(() => {
      inserted = handle.insertMentionAttachment(mention);
    });
    expect(inserted).toBe(true);

    const json = handle.getJSON();
    expect(toAgentText(json)).toBe(PROJECTION);
    expect(collectMentionAttachmentsFromJSONContent(json)).toEqual([mention]);
  });

  it("a saved bot mention keeps its trunk agent id on load", async () => {
    const saved: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: mentionAttrsFromAttachment(pickedMention()),
            },
          ],
        },
      ],
    };
    const handle = await mountEditor(saved);

    expect(toAgentText(handle.getJSON())).toBe(PROJECTION);
  });
});
