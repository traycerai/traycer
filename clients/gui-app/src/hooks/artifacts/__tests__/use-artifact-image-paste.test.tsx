/**
 * Artifact paste/drop: prepare → insert at caret → finish commit, with
 * abort on failure/uninserted and size/type classification.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import { useArtifactImagePaste } from "@/hooks/artifacts/use-artifact-image-paste";

const prepareBytes = vi.hoisted(() =>
  vi.fn((_bytes: Uint8Array) =>
    Promise.resolve({
      ok: true as const,
      operationId: "op-1",
      attachmentHash: "hash-1",
      mediaType: "image/png" as const,
      src: "images/hash-1.png",
    }),
  ),
);
const finish = vi.hoisted(() =>
  vi.fn(
    (
      _artifactId: string,
      _operationId: string,
      _commit: boolean,
    ): Promise<boolean> => Promise.resolve(true),
  ),
);
const reportableErrorToast = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/artifacts/use-artifact-image-operations", () => ({
  useArtifactImageOperations: () => ({
    supported: true,
    prepareBytes,
    prepareRemote: vi.fn(),
    finish,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: string[]) => Promise.resolve([...paths]),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
  }),
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast,
}));

function makeEditor(): Editor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  const awareness = new Awareness(ydoc);
  const user = deriveCollabUser({ userName: "P", email: "p@x.io" });
  return new Editor({
    editable: true,
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
    content: {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
  });
}

function countImages(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") count += 1;
    return true;
  });
  return count;
}

function tinyPngFile(name: string): File {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  return new File([bytes], name, { type: "image/png" });
}

afterEach(() => {
  cleanup();
  prepareBytes.mockReset();
  prepareBytes.mockImplementation(() =>
    Promise.resolve({
      ok: true as const,
      operationId: "op-1",
      attachmentHash: "hash-1",
      mediaType: "image/png" as const,
      src: "images/hash-1.png",
    }),
  );
  finish.mockReset();
  finish.mockResolvedValue(true);
  reportableErrorToast.mockReset();
});

beforeEach(() => {
  prepareBytes.mockClear();
  finish.mockClear();
  reportableErrorToast.mockClear();
});

describe("useArtifactImagePaste", () => {
  it("ingests a pasteable image at the caret and finishes with commit", async () => {
    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });

    await waitFor(() => {
      expect(countImages(editor)).toBe(1);
    });
    await waitFor(() => {
      expect(finish).toHaveBeenCalledWith("artifact-1", "op-1", true);
    });
    expect(prepareBytes).toHaveBeenCalledTimes(1);
    const image = editor.state.doc.firstChild;
    expect(image?.type.name).toBe("image");
    expect(image?.attrs).toMatchObject({
      src: "images/hash-1.png",
      alt: "shot.png",
      attachmentHash: "hash-1",
    });
    editor.destroy();
  });

  it("aborts prepared operations that were not inserted", async () => {
    const editor = makeEditor();
    editor.setEditable(false);
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });

    await waitFor(() => {
      expect(finish).toHaveBeenCalledWith("artifact-1", "op-1", false);
    });
    expect(countImages(editor)).toBe(0);
    expect(finish).not.toHaveBeenCalledWith("artifact-1", "op-1", true);
    editor.destroy();
  });

  it("removes the inserted node and surfaces when finish commit fails", async () => {
    finish.mockResolvedValueOnce(false);
    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });

    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(countImages(editor)).toBe(0);
    });
    expect(finish).toHaveBeenCalledWith("artifact-1", "op-1", true);
    editor.destroy();
  });

  it("rejects oversized images before prepare and classifies non-images as skips", async () => {
    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    const oversized = new File(
      [new Uint8Array(MAX_ARTIFACT_IMAGE_BYTES + 1)],
      "huge.png",
      { type: "image/png" },
    );
    act(() => {
      result.current.paste.attachImageFiles([oversized]);
    });
    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalled();
    });
    expect(prepareBytes).not.toHaveBeenCalled();
    expect(countImages(editor)).toBe(0);

    reportableErrorToast.mockClear();
    const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    act(() => {
      result.current.paste.attachImageFiles([textFile]);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(prepareBytes).not.toHaveBeenCalled();
    expect(countImages(editor)).toBe(0);
    // Non-image files are filtered, not toasted as failures.
    expect(reportableErrorToast).not.toHaveBeenCalled();
    editor.destroy();
  });
});
