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
import { FILE_ATTACHMENT_MAX_BYTES } from "@traycer/protocol/host/drafts/schemas";

import {
  composerAttachmentsHoldSend,
  useComposerHashPasteAdapter,
  type ComposerFileAttachArgs,
  type ComposerFilePathIngestArgs,
} from "@/hooks/composer/use-composer-paste";
import {
  readFileAttachmentUploadStatus,
  type FileAttachmentUploadClient,
} from "@/lib/composer/file-attachment-upload";
import type { ComposerFileAttachmentAttrs } from "@/lib/composer/file-attachments";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
}));

type PutBlob = FileAttachmentUploadClient["requestWithOptions"];

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

function textFile(name: string, text: string, type: string): File {
  return new File([text], name, { type });
}

function oversizedFile(): File {
  const file = textFile("huge.mov", "x", "video/quicktime");
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

interface Rig {
  readonly put: Mock<PutBlob>;
  readonly inserted: ComposerFileAttachmentAttrs[];
  readonly fileAttach: ComposerFileAttachArgs;
}

function makeRig(): Rig {
  const put = vi.fn<PutBlob>().mockResolvedValue({ ok: true });
  const inserted: ComposerFileAttachmentAttrs[] = [];
  return {
    put,
    inserted,
    fileAttach: {
      target: { hostId: "host-1", client: { requestWithOptions: put } },
      insert: (attrs) => {
        inserted.push(attrs);
        return true;
      },
      attachedFileCount: () => 0,
    },
  };
}

function useRig(fileAttach: ComposerFileAttachArgs | null) {
  return useComposerHashPasteAdapter(() => 0, filePaths(), fileAttach);
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
    const rig = makeRig();
    const { result } = renderHook(() => useRig(rig.fileAttach));

    act(() => {
      result.current.attachFiles([oversizedFile()]);
    });

    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toBe("huge.mov is 16.0 MiB");
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "Files can be up to 16.0 MiB.",
    });
    expect(rig.inserted).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
    expect(result.current.isAttachingFiles).toBe(false);
  });

  it("admits the files in a pick that fit and refuses only the oversized one", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useRig(rig.fileAttach));

    act(() => {
      result.current.attachFiles([
        oversizedFile(),
        textFile("a.txt", "aaa", "text/plain"),
      ]);
    });

    await waitFor(() => expect(rig.inserted).toHaveLength(1));
    expect(rig.inserted[0].fileName).toBe("a.txt");
    expect(toasts.error).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(readFileAttachmentUploadStatus(rig.inserted[0].id)).toBe("stored"),
    );
  });

  it("holds the composer while picked files are being hashed, then releases it", async () => {
    const rig = makeRig();
    const { result } = renderHook(() => useRig(rig.fileAttach));

    act(() => {
      result.current.attachFiles([textFile("a.txt", "aaa", "text/plain")]);
    });
    expect(result.current.isAttachingFiles).toBe(true);
    expect(composerAttachmentsHoldSend(result.current, false)).toBe(true);

    await waitFor(() => expect(result.current.isAttachingFiles).toBe(false));
    expect(rig.inserted).toHaveLength(1);
  });

  it("says there is no host and uploads nothing when the route has no target", () => {
    const rig = makeRig();
    const { result } = renderHook(() =>
      useRig({
        target: null,
        insert: rig.fileAttach.insert,
        attachedFileCount: () => 0,
      }),
    );

    act(() => {
      result.current.attachFiles([textFile("a.txt", "aaa", "text/plain")]);
    });

    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][1]).toMatchObject({
      description: "Connect to a host, then try again.",
    });
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("is a no-op on a surface with no file route", () => {
    const { result } = renderHook(() => useRig(null));

    act(() => {
      result.current.attachFiles([textFile("a.txt", "aaa", "text/plain")]);
    });

    expect(toasts.error).not.toHaveBeenCalled();
    expect(result.current.isAttachingFiles).toBe(false);
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
  function Zone(props: { readonly fileAttach: ComposerFileAttachArgs | null }) {
    const handlers = useRig(props.fileAttach);
    return (
      <div
        data-testid="zone"
        onPaste={handlers.onPaste}
        onDrop={handlers.onDrop}
        onDragOver={handlers.onDragOver}
      />
    );
  }

  it("a pasted file with no resolvable path goes to the file route, with no path-failure toast", async () => {
    const rig = makeRig();
    render(<Zone fileAttach={rig.fileAttach} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([
        textFile("clip.pdf", "pdf", "application/pdf"),
      ]),
    });

    await waitFor(() => expect(rig.inserted).toHaveLength(1));
    expect(rig.inserted[0]).toMatchObject({
      fileName: "clip.pdf",
      mediaType: "application/pdf",
      uploadState: "pending",
    });
    expect(toasts.error).not.toHaveBeenCalled();
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
  });

  it("a dropped file with no resolvable path goes to the file route", async () => {
    const rig = makeRig();
    render(<Zone fileAttach={rig.fileAttach} />);

    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: fileTransfer([textFile("a.zip", "zip", "application/zip")]),
    });

    await waitFor(() => expect(rig.inserted).toHaveLength(1));
    expect(rig.inserted[0].fileName).toBe("a.zip");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("a file that resolves to a path keeps the path route and uploads nothing", async () => {
    resolveDroppedFilePaths.mockResolvedValue(["/home/me/a.txt"]);
    const rig = makeRig();
    render(<Zone fileAttach={rig.fileAttach} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([textFile("a.txt", "aaa", "text/plain")]),
    });

    await waitFor(() => expect(resolveDroppedFilePaths).toHaveBeenCalled());
    await waitFor(() => expect(toasts.error).not.toHaveBeenCalled());
    expect(rig.inserted).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
  });

  it("without a file route the unresolvable file still reports the path failure", async () => {
    render(<Zone fileAttach={null} />);

    fireEvent.paste(screen.getByTestId("zone"), {
      clipboardData: fileTransfer([textFile("a.txt", "aaa", "text/plain")]),
    });

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.error.mock.calls[0][0]).toBe("Couldn't resolve file path");
  });
});
