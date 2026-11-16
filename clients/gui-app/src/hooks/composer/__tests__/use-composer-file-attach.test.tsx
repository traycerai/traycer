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
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import {
  composerAttachmentsHoldSend,
  isAttachmentIngestPending,
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
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import {
  docOfFileNodes,
  fileNodeAttrs,
  freshHostId,
  okPut,
  oversizedFile,
  targetFor,
  uniqueFile,
} from "@/lib/composer/__tests__/file-attachment-fixtures";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  REMOTE_REFUSAL_DESCRIPTION,
  REMOTE_REFUSAL_TITLE,
  emptyTransfer,
  fileTransfer,
  folderFile,
  pdfFile,
  perform,
  performWithEntries,
  uriOnlyTransfer,
} from "@/lib/composer/__tests__/file-drop-fixtures";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
}));

// The image half of a mixed gesture stores its bytes; what those bytes hash to
// is not under test here.
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    putImage: vi.fn(() => Promise.resolve("file-attach-image-hash")),
  };
});

const resolveDroppedFilePaths =
  vi.fn<(files: ReadonlyArray<File>) => Promise<string[]>>();
const readNativeClipboardFilePaths = vi.fn<() => Promise<string[]>>();

function filePaths(
  rig: Rig,
  pathsReachTarget: boolean,
): ComposerFilePathIngestArgs {
  return {
    fileDrops: {
      resolveDroppedFilePaths,
      copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      readNativeClipboardFilePaths,
    },
    mentionRoots: [],
    beginPathInsertion: () => (paths) => {
      rig.insertedPaths.push([...paths]);
      return true;
    },
    pathsReachTarget,
  };
}

/** What a browser exposes while a drag is still over the zone. */
function dragOf(itemTypes: ReadonlyArray<string>) {
  return {
    files: [],
    types: ["Files"],
    items: itemTypes.map((type) => ({ kind: "file", type })),
    getData: () => "",
    dropEffect: "none",
  };
}

/** What a URI-only drag exposes: a type name and no items. */
function uriDrag() {
  return {
    files: [],
    types: ["text/uri-list"],
    items: [],
    getData: () => "",
    dropEffect: "none",
  };
}

function pngFile(name: string): File {
  return new File(["png-bytes"], name, { type: "image/png" });
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
  /** Every list of paths the surface's path insertion was committed with. */
  readonly insertedPaths: string[][];
  /** Every batch of image attributes the surface inserted. */
  readonly insertedImages: ImageAttachmentAttrs[][];
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
    insertedPaths: [],
    insertedImages: [],
  };
}

function useRig(
  rig: Rig,
  route: ComposerFileRoute | null,
  pathsReachTarget: boolean,
) {
  const fileAttach = useComposerFileAttachArgs(rig.editorRef, route);
  return useComposerHashPasteAdapter(
    (attrs) => {
      rig.insertedImages.push([...attrs]);
      return attrs.length;
    },
    filePaths(rig, pathsReachTarget),
    fileAttach,
  );
}

function attachedNames(rig: Rig): string[] {
  return rig.editor.nodes().map((node) => node.fileName);
}

beforeEach(() => {
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
  resetNegotiatedManifests();
  toasts.error.mockClear();
  resolveDroppedFilePaths.mockReset();
  resolveDroppedFilePaths.mockResolvedValue([]);
  readNativeClipboardFilePaths.mockReset();
  readNativeClipboardFilePaths.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("attachFiles", () => {
  it("refuses an over-cap file before upload: toast names the size, no node, no putBlob", () => {
    const rig = makeRig({ seed: [] });
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
      useRig(rig, { ...rig.route, target: null }, true),
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
    const { result } = renderHook(() => useRig(rig, null, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

    act(() => {
      result.current.attachFiles([new File([bytes], "same.txt")]);
    });

    await waitFor(() => expect(rig.editor.nodes()).toHaveLength(21));
    expect(fileAttachmentIdentities(rig.editor.getJSON()).size).toBe(20);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("two back-to-back picks at 19 insert one file in total", async () => {
    const rig = makeRig({ seed: seedNodes(19) });
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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
    const { result } = renderHook(() => useRig(rig, rig.route, true));

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

function Zone(props: {
  readonly rig: Rig;
  readonly route: ComposerFileRoute | null;
  readonly pathsReachTarget: boolean;
}) {
  const handlers = useRig(props.rig, props.route, props.pathsReachTarget);
  return (
    <div
      data-testid="zone"
      onPaste={handlers.onPaste}
      onDrop={handlers.onDrop}
      onDragOver={handlers.onDragOver}
      onDragEnter={handlers.onDragEnter}
      data-variant={handlers.dragOverlayVariant ?? "none"}
      data-busy={String(isAttachmentIngestPending(handlers))}
    />
  );
}

/**
 * Resolves once nothing a gesture started is still running, so that an
 * assertion that something did NOT happen is made when no job is left that
 * could still make it happen. A gesture starts these jobs:
 *
 * - the hook's own: path resolution, file hashing and image ingest, which the
 *   zone's busy flag reports (`isAttachmentIngestPending`, the predicate that
 *   holds a send);
 * - an upload, which starts once its node is in the draft and outlives those
 *   jobs: the upload registry reports each node leaving `uploading`, and the
 *   node's outcome (its settlement and any failure toast) is written in the
 *   same step that reports it.
 */
async function settled(zone: HTMLElement, rig: Rig): Promise<void> {
  await waitFor(() => expect(zone.getAttribute("data-busy")).toBe("false"));
  await waitFor(() => {
    for (const node of rig.editor.nodes()) {
      expect(readFileAttachmentUploadStatus(node.id)).not.toBe("uploading");
    }
  });
}

describe("paste and drop of a non-image file on this machine", () => {
  it("a pasted file with no resolvable path goes to the file route, with no path-failure toast", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);

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
    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);

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
      render(<Zone rig={rig} route={rig.route} pathsReachTarget />);
      const zone = screen.getByTestId("zone");

      perform(gesture, zone, fileTransfer([uniqueFile("slow.txt")]));
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
    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([uniqueFile("slow.txt")]),
    });
    await waitFor(() => expect(resolveDroppedFilePaths).toHaveBeenCalled());
    resolvePaths();

    await waitFor(() => expect(attachedNames(rig)).toEqual(["slow.txt"]));
  });

  it("a file that resolves to a path types the path and uploads nothing", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/home/me/a.txt"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);
    const zone = screen.getByTestId("zone");

    fireEvent.paste(zone, {
      clipboardData: fileTransfer([uniqueFile("a.txt")]),
    });

    await waitFor(() =>
      expect(rig.insertedPaths).toEqual([["/home/me/a.txt"]]),
    );
    await settled(zone, rig);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });

  it.each(["paste", "drop"] as const)(
    "a %s of a folder types its path: it is not uploaded and nothing is refused",
    async (gesture) => {
      resolveDroppedFilePaths.mockResolvedValue(["/Users/me/my-folder"]);
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} pathsReachTarget />);
      const zone = screen.getByTestId("zone");

      performWithEntries(
        gesture,
        zone,
        [folderFile("my-folder")],
        new Set(["my-folder"]),
      );

      await waitFor(() =>
        expect(rig.insertedPaths).toEqual([["/Users/me/my-folder"]]),
      );
      await settled(zone, rig);
      expect(toasts.error).not.toHaveBeenCalled();
      expect(attachedNames(rig)).toEqual([]);
      expect(rig.put).not.toHaveBeenCalled();
    },
  );

  it("a file URI with no File behind it types its path", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);
    const zone = screen.getByTestId("zone");

    perform("drop", zone, uriOnlyTransfer("file:///Users/me/notes.txt"));

    await waitFor(() =>
      expect(rig.insertedPaths).toEqual([["/Users/me/notes.txt"]]),
    );
    await settled(zone, rig);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("a native-clipboard path types its path", async () => {
    readNativeClipboardFilePaths.mockResolvedValue(["/Users/me/a.txt"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);
    const zone = screen.getByTestId("zone");

    perform("paste", zone, emptyTransfer());

    await waitFor(() =>
      expect(rig.insertedPaths).toEqual([["/Users/me/a.txt"]]),
    );
    await settled(zone, rig);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("without a file route the unresolvable file still reports the path failure", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={null} pathsReachTarget />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([uniqueFile("a.txt")]),
    });

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't resolve file path");
  });
});

const INLINE_EDIT_DESCRIPTION =
  "Files can't be added while editing. Send them in a new message.";

function expectRefusalToast(message: string, description: string): void {
  expect(toasts.error).toHaveBeenCalledTimes(1);
  expect(toasts.error).toHaveBeenCalledWith(
    message,
    { description },
    expect.objectContaining({
      message: null,
      code: null,
      source: "Chat composer",
    }),
  );
}

interface RefusedEntry {
  readonly label: string;
  /** What the toast calls it. */
  readonly named: string;
  readonly gesture: (zone: HTMLElement) => void;
}

/** Everything a chat on another machine cannot be given as a typed path. */
const REFUSED_ENTRIES: ReadonlyArray<RefusedEntry> = [
  {
    label: "a pasted folder",
    named: "my-folder",
    gesture: (zone) => {
      performWithEntries(
        "paste",
        zone,
        [folderFile("my-folder")],
        new Set(["my-folder"]),
      );
    },
  },
  {
    label: "a dropped folder",
    named: "my-folder",
    gesture: (zone) => {
      performWithEntries(
        "drop",
        zone,
        [folderFile("my-folder")],
        new Set(["my-folder"]),
      );
    },
  },
  {
    label: "a pasted file URI with no File",
    named: "notes.txt",
    gesture: (zone) => {
      perform("paste", zone, uriOnlyTransfer("file:///Users/me/notes.txt"));
    },
  },
  {
    label: "a dropped file URI with no File",
    named: "notes.txt",
    gesture: (zone) => {
      perform("drop", zone, uriOnlyTransfer("file:///Users/me/notes.txt"));
    },
  },
  {
    label: "a native-clipboard path",
    named: "a.txt",
    gesture: (zone) => {
      readNativeClipboardFilePaths.mockResolvedValue(["/Users/me/a.txt"]);
      perform("paste", zone, emptyTransfer());
    },
  },
];

describe("paste and drop on another machine", () => {
  it.each(["paste", "drop"] as const)(
    "a %s of a non-image file uploads it through the file route and types no path, even when its path resolves",
    async (gesture) => {
      resolveDroppedFilePaths.mockResolvedValue(["/Users/me/report.pdf"]);
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
      const zone = screen.getByTestId("zone");

      perform(gesture, zone, fileTransfer([pdfFile("report.pdf")]));

      await waitFor(() => expect(attachedNames(rig)).toEqual(["report.pdf"]));
      expect(rig.editor.nodes()[0].mediaType).toBe("application/pdf");
      await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
      expect(rig.put.mock.calls[0][0].target.hostId).toBe(rig.hostId);
      expect(rig.put.mock.calls[0][0].request).toMatchObject({
        kind: "file",
        fileName: "report.pdf",
        mediaType: "application/pdf",
      });
      await settled(zone, rig);
      expect(rig.insertedPaths.flat()).toEqual([]);
      expect(toasts.error).not.toHaveBeenCalled();
    },
  );

  it.each(["paste", "drop"] as const)(
    "a %s of a non-image file is uploaded without waiting on a path resolution that never answers",
    async (gesture) => {
      resolveDroppedFilePaths.mockImplementation(
        () => new Promise<string[]>(() => undefined),
      );
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);

      perform(
        gesture,
        screen.getByTestId("zone"),
        fileTransfer([pdfFile("report.pdf")]),
      );

      await waitFor(() => expect(attachedNames(rig)).toEqual(["report.pdf"]));
      await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
      expect(rig.put.mock.calls[0][0].request).toMatchObject({
        kind: "file",
        fileName: "report.pdf",
        mediaType: "application/pdf",
      });
      expect(rig.insertedPaths.flat()).toEqual([]);
      expect(toasts.error).not.toHaveBeenCalled();
    },
  );

  it("a drop of an image and a non-image file ingests the image and uploads the file", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/report.pdf"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform(
      "drop",
      zone,
      fileTransfer([pngFile("shot.png"), pdfFile("report.pdf")]),
    );

    await waitFor(() => expect(rig.insertedImages).toHaveLength(1));
    expect(rig.insertedImages[0].map((attrs) => attrs.fileName)).toEqual([
      "shot.png",
    ]);
    await waitFor(() => expect(attachedNames(rig)).toEqual(["report.pdf"]));
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expect(rig.insertedPaths.flat()).toEqual([]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("an image alone is ingested as an image, as on this machine", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform("drop", zone, fileTransfer([pngFile("shot.png")]));

    await waitFor(() => expect(rig.insertedImages).toHaveLength(1));
    await settled(zone, rig);
    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("a file over 16 MiB gets the size toast, and its resolvable path is not typed", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/huge.mov"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform("drop", zone, fileTransfer([oversizedFile()]));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith(
      "huge.mov is 16.0 MiB",
      { description: "Files can be up to 16.0 MiB." },
      {
        title: "File exceeded the size limit",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    expect(rig.insertedPaths.flat()).toEqual([]);
    expect(attachedNames(rig)).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("a drop of 21 files uploads 20 and gets the count toast for the 21st, with no path typed", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/file.txt"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");
    const files = Array.from({ length: 21 }, (_, index) =>
      uniqueFile(`file-${String(index)}.txt`),
    );

    perform("drop", zone, fileTransfer(files));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(20));
    await settled(zone, rig);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith(
      "Couldn't attach file-20.txt.",
      { description: "A message can carry up to 20 files." },
      {
        title: "File attachment count exceeded the limit",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    expect(attachedNames(rig)).toHaveLength(20);
    expect(rig.insertedPaths.flat()).toEqual([]);
  });

  it("a route with no host target gets the no-host toast, and no path is typed", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/report.pdf"]);
    const rig = makeRig({ seed: [] });
    render(
      <Zone
        rig={rig}
        route={{ ...rig.route, target: null }}
        pathsReachTarget={false}
      />,
    );
    const zone = screen.getByTestId("zone");

    perform("drop", zone, fileTransfer([pdfFile("report.pdf")]));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith(
      "Couldn't attach the file.",
      { description: "Connect to a host, then try again." },
      {
        title: "No host to attach files to",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    expect(rig.insertedPaths.flat()).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("a host below drafts.putBlob 1.2 gets the outdated-host toast, and no path is typed", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/report.pdf"]);
    const rig = makeRig({ seed: [] });
    recordNegotiatedHostManifest(rig.hostId, {
      "drafts.putBlob": { major: 1, minor: 1 },
    });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform("drop", zone, fileTransfer([pdfFile("report.pdf")]));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith(
      "Couldn't attach the file.",
      { description: "Update this host to attach files." },
      {
        title: "Host does not accept file attachments",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    expect(rig.insertedPaths.flat()).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });

  it.each(["paste", "drop"] as const)(
    "a %s of a folder the browser cannot identify goes to the upload, whose unreadable bytes give the read-failure toast",
    async (gesture) => {
      resolveDroppedFilePaths.mockResolvedValue(["/Users/me/my-folder"]);
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
      const zone = screen.getByTestId("zone");

      perform(gesture, zone, fileTransfer([folderFile("my-folder")]));

      await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
      await settled(zone, rig);
      expect(toasts.error).toHaveBeenCalledTimes(1);
      expect(toasts.error).toHaveBeenCalledWith(
        "Couldn't attach the file.",
        { description: "Please try adding it again." },
        {
          title: "Could not read file attachment",
          message: null,
          code: null,
          source: "Chat composer",
        },
      );
      expect(attachedNames(rig)).toEqual([]);
      expect(rig.put).not.toHaveBeenCalled();
      expect(rig.insertedPaths.flat()).toEqual([]);
    },
  );

  it("a drop of a folder beside a file uploads the file and refuses the folder, in one toast", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/anything"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    performWithEntries(
      "drop",
      zone,
      [pdfFile("report.pdf"), folderFile("my-folder")],
      new Set(["my-folder"]),
    );

    await waitFor(() => expect(attachedNames(rig)).toEqual(["report.pdf"]));
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expectRefusalToast(
      "Couldn't attach my-folder.",
      REMOTE_REFUSAL_DESCRIPTION,
    );
    expect(rig.insertedPaths.flat()).toEqual([]);
  });

  it("a drop of two folders is refused in one toast that counts them", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/anything"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    performWithEntries(
      "drop",
      zone,
      [folderFile("first-folder"), folderFile("second-folder")],
      new Set(["first-folder", "second-folder"]),
    );

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expectRefusalToast("Couldn't attach 2 items.", REMOTE_REFUSAL_DESCRIPTION);
    expect(rig.put).not.toHaveBeenCalled();
    expect(rig.insertedPaths.flat()).toEqual([]);
  });

  it("two native-clipboard paths are refused in one toast that counts them", async () => {
    readNativeClipboardFilePaths.mockResolvedValue([
      "/Users/me/a.txt",
      "/Users/me/b.txt",
    ]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform("paste", zone, emptyTransfer());

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expectRefusalToast("Couldn't attach 2 items.", REMOTE_REFUSAL_DESCRIPTION);
    expect(rig.put).not.toHaveBeenCalled();
    expect(rig.insertedPaths.flat()).toEqual([]);
  });

  it("a native-clipboard read that finds no paths does nothing at all", async () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform("paste", zone, emptyTransfer());

    await waitFor(() =>
      expect(readNativeClipboardFilePaths).toHaveBeenCalled(),
    );
    await settled(zone, rig);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(rig.put).not.toHaveBeenCalled();
    expect(rig.insertedPaths.flat()).toEqual([]);
  });

  it.each(REFUSED_ENTRIES)(
    "$label is refused with the remote toast: nothing uploaded, no path typed",
    async ({ named, gesture }) => {
      resolveDroppedFilePaths.mockResolvedValue(["/Users/me/anything"]);
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
      const zone = screen.getByTestId("zone");

      gesture(zone);

      await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
      await settled(zone, rig);
      expectRefusalToast(
        `Couldn't attach ${named}.`,
        REMOTE_REFUSAL_DESCRIPTION,
      );
      expect(toasts.error.mock.calls[0][2]).toMatchObject({
        title: REMOTE_REFUSAL_TITLE,
      });
      expect(attachedNames(rig)).toEqual([]);
      expect(rig.put).not.toHaveBeenCalled();
      expect(rig.insertedPaths.flat()).toEqual([]);
    },
  );
});

describe("paste and drop in an inline message edit on another machine", () => {
  it.each(["paste", "drop"] as const)(
    "a %s of a non-image file gets the inline-edit toast and types no path",
    async (gesture) => {
      resolveDroppedFilePaths.mockResolvedValue(["/Users/me/report.pdf"]);
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={null} pathsReachTarget={false} />);
      const zone = screen.getByTestId("zone");

      perform(gesture, zone, fileTransfer([pdfFile("report.pdf")]));

      await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
      await settled(zone, rig);
      expectRefusalToast(
        "Couldn't attach report.pdf.",
        INLINE_EDIT_DESCRIPTION,
      );
      expect(attachedNames(rig)).toEqual([]);
      expect(rig.put).not.toHaveBeenCalled();
      expect(rig.insertedPaths.flat()).toEqual([]);
    },
  );

  it.each(REFUSED_ENTRIES)(
    "$label gets the same inline-edit toast and types no path",
    async ({ named, gesture }) => {
      resolveDroppedFilePaths.mockResolvedValue(["/Users/me/anything"]);
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={null} pathsReachTarget={false} />);
      const zone = screen.getByTestId("zone");

      gesture(zone);

      await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
      await settled(zone, rig);
      expectRefusalToast(`Couldn't attach ${named}.`, INLINE_EDIT_DESCRIPTION);
      expect(rig.put).not.toHaveBeenCalled();
      expect(rig.insertedPaths.flat()).toEqual([]);
    },
  );

  it("a drop of an image and a non-image file ingests the image and refuses the file", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/Users/me/report.pdf"]);
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={null} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    perform(
      "drop",
      zone,
      fileTransfer([pngFile("shot.png"), pdfFile("report.pdf")]),
    );

    await waitFor(() => expect(rig.insertedImages).toHaveLength(1));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    await settled(zone, rig);
    expectRefusalToast("Couldn't attach report.pdf.", INLINE_EDIT_DESCRIPTION);
    expect(rig.insertedPaths.flat()).toEqual([]);
  });
});

describe("the drop overlay variant", () => {
  const PDF = "application/pdf";
  const PNG = "image/png";

  it.each([
    { reach: false, items: [PDF], variant: "files" },
    { reach: false, items: [PNG, PDF], variant: "imagesAndFiles" },
    { reach: false, items: [PNG], variant: "images" },
    { reach: true, items: [PDF], variant: "paths" },
    { reach: true, items: [PNG, PDF], variant: "mixed" },
    { reach: true, items: [PNG], variant: "images" },
  ])(
    "shows $variant for a drag of $items when typed paths reach the target: $reach",
    ({ reach, items, variant }) => {
      const rig = makeRig({ seed: [] });
      render(<Zone rig={rig} route={rig.route} pathsReachTarget={reach} />);
      const zone = screen.getByTestId("zone");

      fireEvent.dragEnter(zone, { dataTransfer: dragOf(items) });

      expect(zone.getAttribute("data-variant")).toBe(variant);
    },
  );

  it("a URI-only drag shows the files variant on another machine and the paths variant on this one", () => {
    const rig = makeRig({ seed: [] });
    const remote = render(
      <Zone rig={rig} route={rig.route} pathsReachTarget={false} />,
    );
    fireEvent.dragEnter(screen.getByTestId("zone"), {
      dataTransfer: uriDrag(),
    });
    expect(screen.getByTestId("zone").getAttribute("data-variant")).toBe(
      "files",
    );
    remote.unmount();

    render(<Zone rig={rig} route={rig.route} pathsReachTarget />);
    fireEvent.dragEnter(screen.getByTestId("zone"), {
      dataTransfer: uriDrag(),
    });
    expect(screen.getByTestId("zone").getAttribute("data-variant")).toBe(
      "paths",
    );
  });

  it("follows the drag over the zone: an image joined by a file moves it to imagesAndFiles", () => {
    const rig = makeRig({ seed: [] });
    render(<Zone rig={rig} route={rig.route} pathsReachTarget={false} />);
    const zone = screen.getByTestId("zone");

    fireEvent.dragEnter(zone, { dataTransfer: dragOf([PNG]) });
    expect(zone.getAttribute("data-variant")).toBe("images");
    fireEvent.dragOver(zone, { dataTransfer: dragOf([PNG, PDF]) });

    expect(zone.getAttribute("data-variant")).toBe("imagesAndFiles");
  });
});
