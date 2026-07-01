import "../../../../../__tests__/test-browser-apis";
import { Profiler, useState, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { composerInlineChipClassNames } from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

afterEach(() => {
  cleanup();
});

interface HarnessProps {
  readonly profileRender: ProfilerOnRenderCallback;
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly initialContent: JsonContent;
  readonly initialSelection: {
    readonly from: number;
    readonly to: number;
  } | null;
}

function Harness({
  profileRender,
  handleRef,
  initialContent,
  initialSelection,
}: HarnessProps) {
  const [pickerStore] = useState<ComposerPickerStore>(() =>
    createComposerPickerStore(),
  );
  const setHandle = (instance: ComposerPromptEditorHandle | null): void => {
    handleRef.current = instance;
  };
  return (
    <Profiler id="composer-editor" onRender={profileRender}>
      <ComposerPromptEditor
        ref={setHandle}
        initialContent={initialContent}
        initialSelection={initialSelection}
        pickerStore={pickerStore}
        placeholder="test"
        editorClassName={undefined}
        isActive={false}
        disabled={false}
        slashProviderId="claude"
        onSnapshot={() => undefined}
        onSubmit={() => undefined}
        onPaste={() => undefined}
        onDragOver={() => undefined}
        onDrop={() => undefined}
        onKeyDown={undefined}
        onFocus={() => undefined}
        onBlur={() => undefined}
      />
    </Profiler>
  );
}

describe("ComposerPromptEditor render isolation", () => {
  it("does not re-render the editor wrapper on focus / typing", async () => {
    const phases: string[] = [];
    const profileRender: ProfilerOnRenderCallback = (_id, phase) => {
      phases.push(phase);
    };
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    render(
      <Harness
        profileRender={profileRender}
        handleRef={handleRef}
        initialContent={emptyContent()}
        initialSelection={null}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const updatesAfterMount = phases.filter((p) => p === "update").length;

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");
    act(() => {
      handle.focus();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const finalUpdates = phases.filter((p) => p === "update").length;
    expect(finalUpdates - updatesAfterMount).toBeLessThanOrEqual(1);
  });

  it("maps a legacy attachmentGroup selection before applying it", async () => {
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    render(
      <Harness
        profileRender={NOOP_PROFILE}
        handleRef={handleRef}
        initialContent={legacyImageContent("abcdef")}
        initialSelection={{ from: 7, to: 7 }}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");
    act(() => {
      handle.insertImageAttachments([imageAttrs("img-new")]);
    });

    expect(inlineSequence(handle.getJSON())).toEqual([
      "image:img-legacy",
      "text:abc",
      "image:img-new",
      "text:def",
    ]);
  });

  it("renders inserted images as visible inline atom chips", async () => {
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    render(
      <Harness
        profileRender={NOOP_PROFILE}
        handleRef={handleRef}
        initialContent={emptyContent()}
        initialSelection={null}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");
    act(() => {
      handle.insertImageAttachments([imageAttrs("img-1")]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chip = document.querySelector<HTMLElement>(
      "[data-composer-image-atom]",
    );
    expect(chip).not.toBeNull();
    if (chip === null) throw new Error("expected image atom chip");
    expect(chip.textContent).toContain("Image#1");
    expect(chip.getAttribute("aria-label")).toBe("Attached Image#1: img-1.png");
    expect(chip.getAttribute("style") ?? "").not.toContain(
      "visibility: hidden",
    );
  });

  it("renumbers visible image atom chips from document order", async () => {
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    render(
      <Harness
        profileRender={NOOP_PROFILE}
        handleRef={handleRef}
        initialContent={duplicateImageContent()}
        initialSelection={null}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-composer-image-atom]"),
      ).map((chip) => chip.textContent),
    ).toEqual(["Image#1", "Image#2"]);
  });

  it("updates existing image atom labels when a new image is inserted before them", async () => {
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    render(
      <Harness
        profileRender={NOOP_PROFILE}
        handleRef={handleRef}
        initialContent={singleImageContent()}
        initialSelection={{ from: 1, to: 1 }}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(imageChipLabels()).toEqual(["Image#1"]);
    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");
    act(() => {
      handle.insertImageAttachments([imageAttrs("img-new")]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(imageChipLabels()).toEqual(["Image#1", "Image#2"]);
    expect(imageChipIds()).toEqual(["img-new", "img-old"]);
  });

  it("uses shared sizing classes for slash, image, and mention chips", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Harness
          profileRender={NOOP_PROFILE}
          handleRef={{ current: null }}
          initialContent={mixedChipContent()}
          initialSelection={null}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chips = Array.from(
      document.querySelectorAll<HTMLElement>("[data-composer-chip]"),
    );
    const chipsByKind = new Map(
      chips.map((chip) => [chip.dataset.composerChip, chip]),
    );
    expect(Array.from(chipsByKind.keys()).sort()).toEqual([
      "image-attachment",
      "mention",
      "slash-command",
    ]);

    const sharedClasses = composerInlineChipClassNames("regular")
      .root.split(" ")
      .filter((className) => !className.startsWith("text-"));
    for (const chip of chips) {
      expect(chip.className.split(" ")).toEqual(
        expect.arrayContaining(sharedClasses),
      );
    }
  });
});

const NOOP_PROFILE: ProfilerOnRenderCallback = () => undefined;

function emptyContent(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function legacyImageContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "attachmentGroup",
        content: [imageNode("img-legacy")],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function duplicateImageContent(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          imageNodeWithFileName("img-1", "image.png"),
          { type: "text", text: " and " },
          imageNodeWithFileName("img-2", "image.png"),
        ],
      },
    ],
  };
}

function singleImageContent(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [imageNodeWithFileName("img-old", "image.png")],
      },
    ],
  };
}

function mixedChipContent(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "slashCommand", attrs: { commandName: "plan" } },
          { type: "text", text: " " },
          imageNode("img-1"),
          { type: "text", text: " " },
          {
            type: "mention",
            attrs: {
              contextType: "file",
              id: "src/sentry.ts",
              path: "src/sentry.ts",
              pathKind: "file",
              relPath: "src/sentry.ts",
              absolutePath: "/abs/src/sentry.ts",
              workspacePath: "/abs",
              label: "src/sentry.ts",
              description: "/abs/src/sentry.ts",
            },
          },
        ],
      },
    ],
  };
}

function imageNode(id: string): JsonContent {
  return imageNodeWithFileName(id, `${id}.png`);
}

function imageNodeWithFileName(id: string, fileName: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName,
      b64content: id,
      mimeType: "image/png",
      size: id.length,
    },
  };
}

function imageAttrs(id: string): ImageAttachmentAttrs {
  return {
    id,
    fileName: `${id}.png`,
    b64content: id,
    mimeType: "image/png",
    size: id.length,
  };
}

function inlineSequence(content: JsonContent): string[] {
  const paragraph = content.content?.[0];
  return (paragraph?.content ?? []).flatMap((node) => {
    if (node.type === "imageAttachment") {
      const id = node.attrs?.id;
      return typeof id === "string" ? [`image:${id}`] : [];
    }
    if (node.type === "text") return [`text:${node.text ?? ""}`];
    return [];
  });
}

function imageChipLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-composer-image-atom]"),
  ).map((chip) => chip.textContent);
}

function imageChipIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-composer-image-atom]"),
  ).flatMap((chip) => {
    const id = chip.dataset.composerImageId;
    return id === undefined ? [] : [id];
  });
}
