import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileAttachmentNode } from "@/components/chat/composer/editor/extensions/file-attachment-extension";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  attachFileAttachment,
  readFileAttachmentUploadStatus,
  type FileAttachmentUploadClient,
} from "@/lib/composer/file-attachment-upload";
import {
  containsPendingFileAttachment,
  type ComposerFileAttachmentAttrs,
} from "@/lib/composer/file-attachments";

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: vi.fn(),
}));

type PutBlob = FileAttachmentUploadClient["requestWithOptions"];

let editor: Editor | null = null;

function Harness(props: {
  readonly content: ReadonlyArray<ComposerFileAttachmentAttrs>;
}) {
  const instance = useEditor({
    extensions: [StarterKit, FileAttachmentNode],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: props.content.map((attrs) => ({
            type: "fileAttachment",
            attrs,
          })),
        },
      ],
    },
    immediatelyRender: true,
  });
  useEffect(() => {
    editor = instance;
  }, [instance]);
  return (
    <TooltipProvider delayDuration={0}>
      <EditorContent editor={instance} />
    </TooltipProvider>
  );
}

function pendingAttrs(id: string): ComposerFileAttachmentAttrs {
  return {
    id,
    hash: "c".repeat(64),
    fileName: "clip.mov",
    mediaType: "video/quicktime",
    size: 4096,
    uploadState: "pending",
  };
}

function mounted(): Editor {
  if (editor === null) throw new Error("editor not mounted");
  return editor;
}

function docHasPending(): boolean {
  return containsPendingFileAttachment(mounted().getJSON());
}

function insertNode(attrs: ComposerFileAttachmentAttrs): boolean {
  let inserted = false;
  act(() => {
    inserted = mounted().commands.insertFileAttachment(attrs);
  });
  return inserted;
}

function fileNodeCount(): number {
  const paragraph = mounted().getJSON().content.at(0);
  return paragraph?.content?.length ?? 0;
}

function chipState(container: HTMLElement): string | null {
  return (
    container
      .querySelector('[data-composer-chip="file-attachment"]')
      ?.getAttribute("data-file-attachment-state") ?? null
  );
}

beforeEach(() => {
  editor = null;
});

afterEach(() => {
  cleanup();
});

describe("fileAttachment node view", () => {
  it("shows a pending node nobody here is uploading as unconfirmed, and still pending", async () => {
    const { container } = render(
      <Harness content={[pendingAttrs("restored-node")]} />,
    );

    await waitFor(() => expect(chipState(container)).toBe("unconfirmed"));
    expect(docHasPending()).toBe(true);
    expect(screen.getByText("clip.mov")).not.toBeNull();
  });

  it("removing a node cancels its upload and deletes it", async () => {
    let release: () => void = () => undefined;
    const put = vi.fn<PutBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const inserted: ComposerFileAttachmentAttrs[] = [];
    const { container } = render(<Harness content={[]} />);
    await attachFileAttachment({
      file: new File(["abc"], "clip.mov", { type: "video/quicktime" }),
      target: { hostId: "host-1", client: { requestWithOptions: put } },
      insert: (next) => {
        inserted.push(next);
        act(() => {
          mounted().commands.insertFileAttachment(next);
        });
        return true;
      },
    });
    const id = inserted.at(0)?.id;
    if (id === undefined) throw new Error("expected an inserted node");
    await waitFor(() => expect(chipState(container)).toBe("uploading"));

    fireEvent.click(screen.getByRole("button", { name: "Remove clip.mov" }));

    expect(readFileAttachmentUploadStatus(id)).toBe("cancelled");
    expect(
      container.querySelector('[data-composer-chip="file-attachment"]'),
    ).toBeNull();
    expect(docHasPending()).toBe(false);
    release();
  });

  it("clears the pending state when the upload is stored", async () => {
    const put = vi.fn<PutBlob>().mockResolvedValue({ ok: true });
    const { container } = render(<Harness content={[]} />);

    await attachFileAttachment({
      file: new File(["abc"], "clip.mov", { type: "video/quicktime" }),
      target: { hostId: "host-1", client: { requestWithOptions: put } },
      insert: insertNode,
    });

    await waitFor(() => expect(chipState(container)).toBe("stored"));
    expect(docHasPending()).toBe(false);
    expect(screen.getByText("clip.mov")).not.toBeNull();
  });

  it("removes the node when the upload fails", async () => {
    const put = vi.fn<PutBlob>().mockRejectedValue(new Error("socket closed"));
    const { container } = render(<Harness content={[]} />);
    await attachFileAttachment({
      file: new File(["abc"], "clip.mov", { type: "video/quicktime" }),
      target: { hostId: "host-1", client: { requestWithOptions: put } },
      insert: insertNode,
    });

    expect(fileNodeCount()).toBe(1);
    await waitFor(() => expect(fileNodeCount()).toBe(0));
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-composer-chip="file-attachment"]'),
    ).toBeNull();
  });
});
