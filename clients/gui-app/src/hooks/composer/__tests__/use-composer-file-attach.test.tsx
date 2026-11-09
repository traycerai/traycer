import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { FILE_ATTACHMENT_MAX_BYTES } from "@traycer/protocol/host/drafts/schemas";

import {
  composerAttachmentsHoldSend,
  useComposerFileAttachArgs,
  useComposerHashPasteAdapter,
  type ComposerFileRoute,
  type ComposerFilePathIngestArgs,
  type ComposerPasteEditorHandle,
} from "@/hooks/composer/use-composer-paste";
import {
  readFileAttachmentUploadStatus,
  type PutFileBlob,
} from "@/lib/composer/file-attachment-upload";
import {
  fileAttachmentIdentities,
  settleFileNodeInContent,
  type ComposerFileAttachmentAttrs,
  type FileNodeSettlement,
} from "@/lib/composer/file-attachments";
import {
  createComposerEditorIncarnation,
  type ComposerEditorIncarnation,
} from "@/lib/composer/composer-editor-incarnation";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import {
  docOfFileNodes,
  fileNodeAttrs,
  freshHostId,
  okPut,
  targetFor,
  uniqueFile,
} from "@/lib/composer/__tests__/file-attachment-fixtures";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
}));

const resolveDroppedFilePaths =
  vi.fn<(files: ReadonlyArray<File>) => Promise<string[]>>();

function filePaths(): ComposerFilePathIngestArgs {
  return {
    fileDrops: {
      resolveDroppedFilePaths,
      copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
    mentionRoots: [],
    beginPathInsertion: () => () => true,
  };
}

function oversizedFile(): File {
  const file = uniqueFile("huge.mov");
  Object.defineProperty(file, "size", { value: FILE_ATTACHMENT_MAX_BYTES + 1 });
  return file;
}

function fileTransfer(files: ReadonlyArray<File>) {
  return {
    files,
    types: ["Files"],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

/** The editor handle a surface passes, over a plain document. */
class FakeEditor implements ComposerPasteEditorHandle {
  doc: JsonContent;
  generation = 0;
  incarnation: ComposerEditorIncarnation | null =
    createComposerEditorIncarnation();
  mounted = true;

  constructor(seed: ReadonlyArray<ComposerFileAttachmentAttrs>) {
    this.doc = docOfFileNodes(seed);
  }

  nodes(): ReadonlyArray<ComposerFileAttachmentAttrs> {
    return (this.doc.content?.at(0)?.content ?? []).map((node) =>
      fileNodeAttrs({ ...node.attrs }),
    );
  }

  isReady = (): boolean => true;
  insertImageAttachments = (): void => undefined;
  beginPathInsertion = () => null;
  focus = (): void => undefined;
  getJSON = (): JsonContent => this.doc;
  getEditorIncarnation = (): ComposerEditorIncarnation | null =>
    this.incarnation;
  draftGeneration = (): number => this.generation;

  insertFileAttachment = (attrs: ComposerFileAttachmentAttrs): boolean => {
    const paragraph = this.doc.content?.at(0);
    if (paragraph === undefined) return false;
    this.doc = {
      ...this.doc,
      content: [
        {
          ...paragraph,
          content: [
            ...(paragraph.content ?? []),
            { type: "fileAttachment", attrs: { ...attrs } },
          ],
        },
      ],
    };
    return true;
  };

  settleFileAttachment = (
    id: string,
    settlement: FileNodeSettlement,
  ): boolean => {
    if (!this.mounted) return false;
    const next = settleFileNodeInContent(this.doc, id, settlement);
    if (next === null) return false;
    this.doc = next;
    return true;
  };
}

function seedNodes(count: number): ComposerFileAttachmentAttrs[] {
  return Array.from({ length: count }, (_, index) =>
    fileNodeAttrs({
      hash: (index + 1).toString(16).padStart(64, "0"),
      fileName: `seed-${String(index)}.txt`,
    }),
  );
}

interface Rig {
  readonly editor: FakeEditor;
  readonly editorRef: { current: FakeEditor };
  readonly hostId: string;
  readonly put: Mock<PutFileBlob>;
  readonly settleDraft: Mock<ComposerFileRoute["settleDraft"]>;
  readonly route: ComposerFileRoute;
}

function makeRig(input: {
  readonly seed: ReadonlyArray<ComposerFileAttachmentAttrs>;
}): Rig {
  const editor = new FakeEditor(input.seed);
  const hostId = freshHostId("host");
  const put = okPut();
  const settleDraft = vi.fn<ComposerFileRoute["settleDraft"]>();
  return {
    editor,
    editorRef: { current: editor },
    hostId,
    put,
    settleDraft,
    route: {
      target: targetFor(hostId),
      put,
      settleDraft,
    },
  };
}

function useRig(rig: Rig, route: ComposerFileRoute | null) {
  const fileAttach = useComposerFileAttachArgs(rig.editorRef, route);
  return useComposerHashPasteAdapter(() => 0, filePaths(), fileAttach);
}

function attachedNames(rig: Rig): string[] {
  return rig.editor.nodes().map((node) => node.fileName);
}

beforeEach(() => {
  installFreshIndexedDb();
  toasts.error.mockClear();
  resolveDroppedFilePaths.mockReset();
  resolveDroppedFilePaths.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("attachFiles", () => {
  it("refuses an over-cap file before upload: toast names the size, no node, no putBlob", () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([oversizedFile()]);
    });

    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("huge.mov is 16.0 MiB");
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "Files can be up to 16.0 MiB.",
    });
    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
    expect(result.current.isAttachingFiles).toBe(false);
  });

  it("admits the files in a pick that fit and refuses only the oversized one", async () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([oversizedFile(), uniqueFile("a.txt")]);
    });

    await waitFor(() => expect(attachedNames(rig)).toEqual(["a.txt"]));
    expect(toasts.error).toHaveBeenCalledTimes(1);
    const [node] = rig.editor.nodes();
    await waitFor(() =>
      expect(readFileAttachmentUploadStatus(node.id)).toBe("stored"),
    );
  });

  it("holds the composer while picked files are being hashed, then releases it", async () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([uniqueFile("a.txt")]);
    });
    expect(result.current.isAttachingFiles).toBe(true);
    expect(composerAttachmentsHoldSend(result.current, false)).toBe(true);

    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));
    expect(attachedNames(rig)).toEqual(["a.txt"]);
  });

  it("says there is no host and uploads nothing when the route has no target", () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() =>
      useRig(rig, { ...rig.route, target: null }),
    );

    act(() => {
      result.current.attachFiles([uniqueFile("a.txt")]);
    });

    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "Connect to a host, then try again.",
    });
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("is a no-op on a surface with no file route", () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, null));

    act(() => {
      result.current.attachFiles([uniqueFile("a.txt")]);
    });

    expect(toasts.error).not.toHaveBeenCalled();
    expect(result.current.isAttachingFiles).toBe(false);
  });
});

describe("the pick fence", () => {
  it("inserts and uploads nothing when the draft moved on while the file was hashing", async () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([uniqueFile("late.txt")]);
      rig.editor.generation += 1;
    });
    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));

    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("inserts and uploads nothing when the editor was recreated while the file was hashing", async () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([uniqueFile("late.txt")]);
      rig.editor.incarnation = createComposerEditorIncarnation();
    });
    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));

    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });
});

describe("settling a node whose composer is gone", () => {
  const stored: FileNodeSettlement = { kind: "stored" };

  it("falls back to the route's persisted draft when the live editor does not hold the node", () => {
    const rig = makeRig({ seed: [] });
    rig.editor.mounted = false;
    const { result } = renderHook(() =>
      useComposerFileAttachArgs(rig.editorRef, rig.route),
    );

    result.current?.settle("node-1", stored);

    expect(rig.settleDraft).toHaveBeenCalledWith("node-1", stored);
  });

  it("settles in the live editor alone while it holds the node", () => {
    const node = fileNodeAttrs({ uploadState: "pending" });
    const rig = makeRig({ seed: [node] });
    const { result } = renderHook(() =>
      useComposerFileAttachArgs(rig.editorRef, rig.route),
    );

    result.current?.settle(node.id, stored);

    expect(rig.editor.nodes()[0].uploadState).toBeNull();
    expect(rig.settleDraft).not.toHaveBeenCalled();
  });

  it("an upload that finishes after the editor unmounted is settled in the draft", async () => {
    const rig = makeRig({ seed: [] });
    let finish: () => void = () => undefined;
    const gated = vi.fn<PutFileBlob>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true });
        }),
    );
    const route: ComposerFileRoute = { ...rig.route, put: gated };
    const { result } = renderHook(() => useRig(rig, route));

    act(() => {
      result.current.attachFiles([uniqueFile("gone.txt")]);
    });
    await waitFor(() => expect(gated).toHaveBeenCalledTimes(1));
    const [node] = rig.editor.nodes();
    rig.editor.mounted = false;
    finish();

    await waitFor(() =>
      expect(rig.settleDraft).toHaveBeenCalledWith(node.id, {
        kind: "stored",
      }),
    );
  });
});

describe("the per-message file cap, by identity", () => {
  it("with 19 identities, a pick of 2 inserts the first and refuses the second by name", async () => {
    const rig = makeRig({ seed: seedNodes(19) });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([
        uniqueFile("one.txt"),
        uniqueFile("two.txt"),
      ]);
    });

    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));
    expect(attachedNames(rig).slice(19)).toEqual(["one.txt"]);
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't attach two.txt.");
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "A message can carry up to 20 files.",
    });
  });

  it("with 20 identities, a pick of 2 new files is refused whole with one toast", async () => {
    const rig = makeRig({ seed: seedNodes(20) });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([
        uniqueFile("one.txt"),
        uniqueFile("two.txt"),
      ]);
    });

    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));
    expect(rig.editor.nodes()).toHaveLength(20);
    expect(rig.put).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't attach 2 files.");
  });

  it("with 20 identities, a file already in the draft is inserted again", async () => {
    const bytes = new TextEncoder().encode("same bytes");
    const seed = seedNodes(19);
    seed.push(
      fileNodeAttrs({ hash: await sha256Hex(bytes), fileName: "same.txt" }),
    );
    const rig = makeRig({ seed });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([new File([bytes], "same.txt")]);
    });

    await waitFor(() => expect(rig.editor.nodes()).toHaveLength(21));
    expect(fileAttachmentIdentities(rig.editor.getJSON()).size).toBe(20);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("two back-to-back picks at 19 insert one file in total", async () => {
    const rig = makeRig({ seed: seedNodes(19) });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([uniqueFile("first.txt")]);
      result.current.attachFiles([uniqueFile("second.txt")]);
    });

    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));
    expect(fileAttachmentIdentities(rig.editor.getJSON()).size).toBe(20);
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it("a too-large file does not use up a slot", async () => {
    const rig = makeRig({ seed: seedNodes(19) });
    const { result } = renderHook(() => useRig(rig, rig.route));

    act(() => {
      result.current.attachFiles([oversizedFile(), uniqueFile("fits.txt")]);
    });

    await waitFor(() =>
      expect(attachedNames(rig).slice(19)).toEqual(["fits.txt"]),
    );
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("huge.mov is 16.0 MiB");
  });
});

describe("composerAttachmentsHoldSend", () => {
  const idle = {
    isIngestingImages: false,
    isResolvingFilePaths: false,
    isAttachingFiles: false,
  };

  it("holds for any ingest in flight or an unconfirmed file in the draft", () => {
    expect(composerAttachmentsHoldSend(idle, false)).toBe(false);
    expect(composerAttachmentsHoldSend(idle, true)).toBe(true);
    expect(
      composerAttachmentsHoldSend({ ...idle, isAttachingFiles: true }, false),
    ).toBe(true);
    expect(
      composerAttachmentsHoldSend({ ...idle, isIngestingImages: true }, false),
    ).toBe(true);
  });
});

describe("paste and drop of a non-image file", () => {
  function Zone(props: {
    readonly rig: Rig;
    readonly route: ComposerFileRoute | null;
  }) {
    const handlers = useRig(props.rig, props.route);
    return (
      <div
        data-testid="zone"
        onPaste={handlers.onPaste}
        onDrop={handlers.onDrop}
        onDragOver={handlers.onDragOver}
        data-busy={String(
          handlers.isResolvingFilePaths || handlers.isAttachingFiles,
        )}
      />
    );
  }

  it("a pasted file with no resolvable path goes to the file route, with no path-failure toast", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([
        new File([crypto.randomUUID()], "clip.pdf", {
          type: "application/pdf",
        }),
      ]),
    });

    await waitFor(() => expect(attachedNames(rig)).toEqual(["clip.pdf"]));
    expect(rig.editor.nodes()[0].mediaType).toBe("application/pdf");
    expect(toasts.error).not.toHaveBeenCalled();
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
  });

  it("a dropped file with no resolvable path goes to the file route", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} />);

    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: fileTransfer([
        new File([crypto.randomUUID()], "a.zip", { type: "application/zip" }),
      ]),
    });

    await waitFor(() => expect(attachedNames(rig)).toEqual(["a.zip"]));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it.each(["paste", "drop"] as const)(
    "a %s fenced at the gesture attaches nothing when the draft moved on while its path resolved",
    async (gesture) => {
      let resolvePaths: () => void = () => undefined;
      resolveDroppedFilePaths.mockImplementation(
        () =>
          new Promise<string[]>((resolve) => {
            resolvePaths = () => resolve([]);
          }),
      );
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} />);
      const zone = screen.getByTestId("zone");
      const files = [uniqueFile("slow.txt")];

      if (gesture === "paste") {
        fireEvent.paste(zone, { clipboardData: fileTransfer(files) });
      } else {
        fireEvent.drop(zone, { dataTransfer: fileTransfer(files) });
      }
      await waitFor(() => expect(resolveDroppedFilePaths).toHaveBeenCalled());
      rig.editor.generation += 1;
      resolvePaths();

      await waitFor(() => expect(zone.getAttribute("data-busy")).toBe("false"));
      expect(attachedNames(rig)).toEqual([]);
      expect(rig.put).not.toHaveBeenCalled();
      expect(toasts.error).not.toHaveBeenCalled();
    },
  );

  it("the same delayed paste with the draft unchanged attaches the file", async () => {
    let resolvePaths: () => void = () => undefined;
    resolveDroppedFilePaths.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolvePaths = () => resolve([]);
        }),
    );
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([uniqueFile("slow.txt")]),
    });
    await waitFor(() => expect(resolveDroppedFilePaths).toHaveBeenCalled());
    resolvePaths();

    await waitFor(() => expect(attachedNames(rig)).toEqual(["slow.txt"]));
  });

  it("a file that resolves to a path keeps the path route and uploads nothing", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/home/me/a.txt"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([uniqueFile("a.txt")]),
    });

    await waitFor(() => expect(resolveDroppedFilePaths).toHaveBeenCalled());
    await waitFor(() => expect(toasts.error).not.toHaveBeenCalled());
    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("without a file route the unresolvable file still reports the path failure", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={null} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([uniqueFile("a.txt")]),
    });

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't resolve file path");
  });
});
