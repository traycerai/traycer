import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";

import { bumpComposerDraftGeneration } from "@/lib/composer/composer-draft-generation";
import type { BrowserTabPreviewImage } from "@/lib/composer/mentions/browser-tab-preview";

import { buildComposerExtensions } from "../editor/editor-config";
import { commitBrowserTabPreviewInsertion } from "../editor/extensions/mention-extension";
import { createComposerPickerStore } from "../picker/composer-picker-store";

/** Resolvers for the captures the mocked fetch left in flight. */
const pending = vi.hoisted(
  () => [] as Array<(image: BrowserTabPreviewImage | null) => void>,
);

vi.mock("@/lib/composer/mentions/browser-tab-preview", async (original) => {
  const actual =
    await original<
      typeof import("@/lib/composer/mentions/browser-tab-preview")
    >();
  return {
    ...actual,
    fetchBrowserTabPreviewImage: () =>
      new Promise<BrowserTabPreviewImage | null>((resolve) => {
        pending.push(resolve);
      }),
  };
});

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

afterEach(() => {
  pending.splice(0);
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

const REQUEST = {
  coordinatorKey: "coordinator-remote",
  tabId: "tab-1",
  hostName: "Studio",
  title: "Docs",
  url: "https://example.com/docs",
};

const IMAGE: BrowserTabPreviewImage = {
  id: "img-preview",
  fileName: "Studio-tab.jpg",
  mimeType: "image/jpeg",
  size: null,
  b64content: "aGk=",
};

describe("cross-host browser tab preview insertion", () => {
  it("writes the text line immediately and the screenshot when it arrives", async () => {
    const editor = makeEditor();
    const range = { from: 1, to: 1 };

    commitBrowserTabPreviewInsertion(editor, range, REQUEST);

    expect(editor.state.doc.textContent).toBe(
      "browser tab on Studio: Docs - https://example.com/docs ",
    );
    expect(imageIds(editor)).toEqual([]);

    await settlePreview(IMAGE);

    expect(imageIds(editor)).toEqual(["img-preview"]);
  });

  // The regression this guard exists for: the editor SURVIVES a send, so
  // `isDestroyed` is false and a capture still in flight at submit time used
  // to drop its screenshot into the next, empty draft.
  it("drops a screenshot that arrives after the draft was sent", async () => {
    const editor = makeEditor();

    commitBrowserTabPreviewInsertion(editor, { from: 1, to: 1 }, REQUEST);

    // What submit does: bump the generation, then clear the draft.
    bumpComposerDraftGeneration(editor);
    editor.commands.clearContent();

    await settlePreview(IMAGE);

    expect(imageIds(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("");
  });

  it("inserts nothing when the host has no screenshot to give", async () => {
    const editor = makeEditor();

    commitBrowserTabPreviewInsertion(editor, { from: 1, to: 1 }, REQUEST);
    await settlePreview(null);

    expect(imageIds(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe(
      "browser tab on Studio: Docs - https://example.com/docs ",
    );
  });
});

async function settlePreview(
  image: BrowserTabPreviewImage | null,
): Promise<void> {
  const resolve = pending.shift();
  if (resolve === undefined) throw new Error("no preview capture in flight");
  resolve(image);
  await Promise.resolve();
  await Promise.resolve();
}

function imageIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "imageAttachment") {
      const id: unknown = node.attrs.id;
      if (typeof id === "string") ids.push(id);
    }
    return true;
  });
  return ids;
}

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      getPlaceholder: () => "test",
      onSubmit: { current: () => undefined },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}
