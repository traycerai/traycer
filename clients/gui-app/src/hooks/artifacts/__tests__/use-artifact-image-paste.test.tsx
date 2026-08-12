/**
 * Artifact paste/drop: prepare → insert at caret → finish commit, with
 * abort on failure/uninserted and size/type classification.
 * Non-image path paste is disabled (`beginPathInsertion: () => null`).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactImageFinishResponseFixtures,
  MAX_ARTIFACT_IMAGE_BYTES,
} from "@traycer/protocol/host/epic/unary-schemas";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import type { ArtifactImagePreparation } from "@/hooks/artifacts/use-artifact-image-operations";
import { useArtifactImagePaste } from "@/hooks/artifacts/use-artifact-image-paste";

const prepareBytes = vi.hoisted(() =>
  vi.fn((_bytes: Uint8Array): Promise<ArtifactImagePreparation> =>
    Promise.resolve({
      ok: true as const,
      operationId: "op-1",
      attachmentHash: "hash-1",
      mediaType: "image/png" as const,
      src: "images/hash-1.png",
    }),
  ),
);
const commit = vi.hoisted(() => vi.fn());
const abort = vi.hoisted(() => vi.fn());
const reportableErrorToast = vi.hoisted(() => vi.fn());
const resolveDroppedFilePaths = vi.hoisted(() =>
  vi.fn((_files: ReadonlyArray<File>) => Promise.resolve([] as string[])),
);

vi.mock("@/hooks/artifacts/use-artifact-image-operations", () => ({
  useArtifactImageOperations: () => ({
    supported: true,
    prepareBytes,
    prepareRemote: vi.fn(),
    commit,
    abort,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths,
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

function imageAlts(editor: Editor): string[] {
  const alts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") {
      alts.push(String(node.attrs.alt ?? ""));
    }
    return true;
  });
  return alts;
}

function imageMediaTypes(editor: Editor): string[] {
  const mediaTypes: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") {
      mediaTypes.push(String(node.attrs.mediaType ?? ""));
    }
    return true;
  });
  return mediaTypes;
}

function countFragmentImages(fragment: Y.XmlFragment | Y.XmlElement): number {
  let count = 0;
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "image") count += 1;
    count += countFragmentImages(child);
  }
  return count;
}

function editorFragment(editor: Editor): Y.XmlFragment {
  const collaboration = editor.extensionManager.extensions.find(
    (extension) => extension.name === "collaboration",
  );
  const options: unknown = collaboration?.options;
  if (typeof options !== "object" || options === null) {
    throw new Error("expected collaboration options");
  }
  if (!("fragment" in options)) {
    throw new Error("expected collaboration fragment option");
  }
  const fragment: unknown = options.fragment;
  if (!(fragment instanceof Y.XmlFragment)) {
    throw new Error("expected collaboration fragment");
  }
  return fragment;
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

function makeFileTransfer(files: ReadonlyArray<File>): {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly type: string;
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
} {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

function editorHasAbsolutePathOrCode(editor: Editor, path: string): boolean {
  if (editor.getText().includes(path)) return true;
  if (editor.getHTML().includes(path)) return true;
  let hasCode = false;
  editor.state.doc.descendants((node) => {
    if (
      node.type.name === "code" ||
      node.marks.some((m) => m.type.name === "code")
    ) {
      hasCode = true;
      return false;
    }
    return true;
  });
  return hasCode;
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
  commit.mockReset();
  abort.mockReset();
  reportableErrorToast.mockReset();
  resolveDroppedFilePaths.mockReset();
  resolveDroppedFilePaths.mockResolvedValue([]);
});

beforeEach(() => {
  prepareBytes.mockClear();
  commit.mockResolvedValue(
    artifactImageFinishResponseFixtures.commit.committed,
  );
  abort.mockResolvedValue(artifactImageFinishResponseFixtures.abort.aborted);
  reportableErrorToast.mockClear();
  resolveDroppedFilePaths.mockClear();
});
describe("useArtifactImagePaste", () => {
  it("maps the paste selection while preparation is pending", async () => {
    let resolvePrepare = (_value: ArtifactImagePreparation): void => {
      throw new Error("prepare promise was not initialized");
    };
    prepareBytes.mockImplementationOnce(
      () =>
        new Promise<ArtifactImagePreparation>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph" }, { type: "paragraph" }],
    });
    editor.commands.setTextSelection(1);
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });
    await waitFor(() => expect(prepareBytes).toHaveBeenCalledTimes(1));

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent("typed after paste");
    resolvePrepare({
      ok: true,
      operationId: "op-1",
      attachmentHash: "hash-1",
      mediaType: "image/png",
      src: "images/hash-1.png",
    });

    await waitFor(() => expect(countImages(editor)).toBe(1));
    expect(editor.state.doc.firstChild?.type.name).toBe("image");
    expect(editor.getText()).toContain("typed after paste");
    expect(editor.state.selection.$from.parent.textContent).toBe(
      "typed after paste",
    );
    editor.destroy();
  });

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
      expect(commit).toHaveBeenCalledWith("artifact-1", "op-1");
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

  it("restores a text caret when undo removes a pasted image", async () => {
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

    act(() => {
      expect(editor.commands.undo()).toBe(true);
    });
    await waitFor(() => {
      expect(countImages(editor)).toBe(0);
    });
    expect({
      type: editor.state.selection.constructor.name,
      empty: editor.state.selection.empty,
      parentIsTextblock: editor.state.selection.$from.parent.isTextblock,
    }).toEqual({
      type: "TextSelection",
      empty: true,
      parentIsTextblock: true,
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
      expect(abort).toHaveBeenCalledWith("artifact-1", "op-1");
    });
    expect(countImages(editor)).toBe(0);
    expect(commit).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("removes the inserted node and surfaces when finish commit rejects", async () => {
    commit.mockRejectedValueOnce(
      new Error("The artifact image could not be committed."),
    );
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
    expect(commit).toHaveBeenCalledWith("artifact-1", "op-1");
    editor.destroy();
  });

  it("retries not-yet-converged and keeps the node after commit", async () => {
    commit.mockResolvedValueOnce(
      artifactImageFinishResponseFixtures.commit.notYetConverged,
    );
    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });

    await waitFor(() => {
      expect(commit).toHaveBeenCalledTimes(2);
    });
    expect(countImages(editor)).toBe(1);
    expect(reportableErrorToast).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("removes the inserted node and surfaces unknown-operation", async () => {
    commit.mockResolvedValueOnce(
      artifactImageFinishResponseFixtures.commit.unknownOperation,
    );
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
    expect(commit).toHaveBeenCalledTimes(1);
    expect(countImages(editor)).toBe(0);
    expect(abort).toHaveBeenCalledWith("artifact-1", "op-1");
    editor.destroy();
  });

  it("removes the inserted node after bounded not-yet-converged retries", async () => {
    commit.mockResolvedValue(
      artifactImageFinishResponseFixtures.commit.notYetConverged,
    );
    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });

    await waitFor(
      () => {
        expect(reportableErrorToast).toHaveBeenCalled();
      },
      { timeout: 3_000 },
    );
    expect(commit).toHaveBeenCalledTimes(7);
    expect(countImages(editor)).toBe(0);
    editor.destroy();
  });

  it("settles multi-image paste: removes only failed nodes and retains successful commits", async () => {
    let prepareCount = 0;
    prepareBytes.mockImplementation(() => {
      prepareCount += 1;
      const n = prepareCount;
      return Promise.resolve({
        ok: true as const,
        operationId: `op-${n}`,
        attachmentHash: `hash-${n}`,
        mediaType: "image/png" as const,
        src: `images/hash-${n}.png`,
      });
    });
    commit.mockImplementation((_artifactId: string, operationId: string) => {
      if (operationId === "op-1") {
        return Promise.resolve(
          artifactImageFinishResponseFixtures.commit.unknownOperation,
        );
      }
      return Promise.resolve(
        artifactImageFinishResponseFixtures.commit.committed,
      );
    });

    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([
        tinyPngFile("one.png"),
        tinyPngFile("two.png"),
        tinyPngFile("three.png"),
      ]);
    });

    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith("artifact-1", "op-1");
      expect(commit).toHaveBeenCalledWith("artifact-1", "op-2");
      expect(commit).toHaveBeenCalledWith("artifact-1", "op-3");
    });
    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(countImages(editor)).toBe(2);
    });
    expect(imageAlts(editor).sort()).toEqual(["three.png", "two.png"]);
    expect(abort).not.toHaveBeenCalledWith("artifact-1", "op-2");
    expect(abort).not.toHaveBeenCalledWith("artifact-1", "op-3");
    editor.destroy();
  });

  it("tracks rollback by inserted node instead of matching image attributes", async () => {
    let prepareCount = 0;
    prepareBytes.mockImplementation(() => {
      prepareCount += 1;
      return Promise.resolve({
        ok: true as const,
        operationId: `op-${prepareCount}`,
        attachmentHash: "same-hash",
        mediaType:
          prepareCount === 1 ? ("image/png" as const) : ("image/jpeg" as const),
        src: "images/same.png",
      });
    });
    commit.mockImplementation((_artifactId: string, operationId: string) =>
      operationId === "op-1"
        ? Promise.resolve(
            artifactImageFinishResponseFixtures.commit.unknownOperation,
          )
        : Promise.resolve(artifactImageFinishResponseFixtures.commit.committed),
    );

    const editor = makeEditor();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([
        tinyPngFile("same.png"),
        tinyPngFile("same.png"),
      ]);
    });

    await waitFor(() => {
      expect(reportableErrorToast).toHaveBeenCalled();
      expect(countImages(editor)).toBe(1);
    });
    expect(imageMediaTypes(editor)).toEqual(["image/jpeg"]);
    editor.destroy();
  });

  it("rolls back through Yjs after the editor view is destroyed", async () => {
    let rejectCommit: (reason: unknown) => void = () => {};
    commit.mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCommit = reject;
        }),
    );
    const editor = makeEditor();
    const fragment = editorFragment(editor);
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    act(() => {
      result.current.paste.attachImageFiles([tinyPngFile("shot.png")]);
    });
    await waitFor(() => expect(countImages(editor)).toBe(1));
    editor.destroy();
    rejectCommit(new Error("commit failed"));

    await waitFor(
      () => {
        expect(countFragmentImages(fragment)).toBe(0);
      },
      { timeout: 3_000 },
    );
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

  it("does not insert absolute machine paths or inline-code for non-image paste", async () => {
    const absolutePath = "/Users/me/projects/secret/notes.txt";
    resolveDroppedFilePaths.mockResolvedValue([absolutePath]);
    const editor = makeEditor();
    const initialText = editor.getText();
    const { result } = renderHook(() =>
      useArtifactImagePaste(editor, "epic-1", "artifact-1"),
    );

    render(
      <div
        data-testid="artifact-paste-zone"
        onPaste={result.current.paste.onPaste}
        onDrop={result.current.paste.onDrop}
      />,
    );

    const textFile = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByTestId("artifact-paste-zone"), {
      clipboardData: makeFileTransfer([textFile]),
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // beginPathInsertion is disabled: no resolve, no absolute path, no code span.
    expect(resolveDroppedFilePaths).not.toHaveBeenCalled();
    expect(result.current.paste.isResolvingFilePaths).toBe(false);
    expect(editor.getText()).toBe(initialText);
    expect(editorHasAbsolutePathOrCode(editor, absolutePath)).toBe(false);
    expect(prepareBytes).not.toHaveBeenCalled();
    expect(countImages(editor)).toBe(0);
    editor.destroy();
  });
});
