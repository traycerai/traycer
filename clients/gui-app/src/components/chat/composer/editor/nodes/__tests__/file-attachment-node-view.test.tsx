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
  type FileInsertion,
  type FileNodeSettle,
  type PutFileBlob,
} from "@/lib/composer/file-attachment-upload";
import {
  okPut,
  targetFor,
} from "@/lib/composer/__tests__/file-attachment-fixtures";
import {
  containsPendingFileAttachment,
  type ComposerFileAttachmentAttrs,
} from "@/lib/composer/file-attachments";

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: vi.fn(),
}));

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

const insertNode: FileInsertion = (attrs) => {
  const results: boolean[] = [];
  act(() => {
    results.push(mounted().commands.insertFileAttachment(attrs));
  });
  return results.at(0) === true ? "inserted" : "dropped";
};

const settleInEditor: FileNodeSettle = (id, settlement) => {
  act(() => {
    mounted().commands.settleFileAttachmentById(id, settlement);
  });
};

function attachTo(input: {
  readonly put: PutFileBlob;
  readonly insert: FileInsertion;
}): Promise<unknown> {
  return attachFileAttachment({
    file: new File([crypto.randomUUID()], "clip.mov", {
      type: "video/quicktime",
    }),
    target: targetFor("host-1"),
    put: input.put,
    insert: input.insert,
    settle: settleInEditor,
  });
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
    const put = vi.fn<PutFileBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const inserted: ComposerFileAttachmentAttrs[] = [];
    const { container } = render(<Harness content={[]} />);
    await attachTo({
      put,
      insert: (next) => {
        inserted.push(next);
        return insertNode(next);
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
    const put = okPut();
    const { container } = render(<Harness content={[]} />);

    await attachTo({ put, insert: insertNode });

    await waitFor(() => expect(chipState(container)).toBe("stored"));
    expect(docHasPending()).toBe(false);
    expect(screen.getByText("clip.mov")).not.toBeNull();
  });

  it("removes the node when the upload fails", async () => {
    const put = vi
      .fn<PutFileBlob>()
      .mockRejectedValue(new Error("socket closed"));
    const { container } = render(<Harness content={[]} />);
    await attachTo({ put, insert: insertNode });

    expect(fileNodeCount()).toBe(1);
    await waitFor(() => expect(fileNodeCount()).toBe(0));
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-composer-chip="file-attachment"]'),
    ).toBeNull();
  });
});
