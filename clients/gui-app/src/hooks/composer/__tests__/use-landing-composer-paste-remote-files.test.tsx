/**
 * What the landing composer's paste does with a non-image file, by whether a
 * typed path reaches the host the epic is created on.
 *
 * The landing hook shares its file ingest with the chat family, so this pins
 * only that `pathsReachTarget` reaches it: on this machine the file's path is
 * typed, on another the file goes through the landing file route.
 */
import {
  fileTransfer,
  pdfFile,
} from "@/lib/composer/__tests__/file-drop-fixtures";
import {
  cleanup,
  fireEvent,
  render,
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

import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import type {
  ComposerFileRoute,
  ComposerPasteEditorHandle,
} from "@/hooks/composer/use-composer-paste";
import type { PutFileBlob } from "@/lib/composer/file-attachment-upload";
import type { ComposerFileAttachmentAttrs } from "@/lib/composer/file-attachments";
import {
  freshHostId,
  okPut,
  targetFor,
} from "@/lib/composer/__tests__/file-attachment-fixtures";
import {
  NO_MENTION_ROOTS,
  makeHandle,
} from "@/hooks/composer/__tests__/use-landing-composer-paste-test-helpers";

const REPORT_PATH = "/Users/me/report.pdf";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: toasts.error,
}));

const resolveDroppedFilePaths =
  vi.fn<(files: ReadonlyArray<File>) => Promise<string[]>>();

interface Rig {
  readonly handle: ComposerPasteEditorHandle;
  readonly route: ComposerFileRoute;
  readonly put: Mock<PutFileBlob>;
  readonly insertedPaths: string[][];
  readonly insertedFiles: ComposerFileAttachmentAttrs[];
}

function makeRig(): Rig {
  const insertedPaths: string[][] = [];
  const insertedFiles: ComposerFileAttachmentAttrs[] = [];
  const base = makeHandle([], insertedPaths).handle;
  const put = okPut();
  return {
    handle: {
      ...base,
      insertFileAttachment: (attrs) => {
        insertedFiles.push(attrs);
        return true;
      },
      settleFileAttachment: () => true,
    },
    route: {
      target: targetFor(freshHostId("landing-host")),
      put,
      settleDraft: () => undefined,
    },
    put,
    insertedPaths,
    insertedFiles,
  };
}

function LandingZone(props: {
  readonly rig: Rig;
  readonly pathsReachTarget: boolean;
}) {
  const paste = useLandingComposerPaste({
    editorRef: { current: props.rig.handle },
    draftId: null,
    disabled: false,
    fileDrops: {
      resolveDroppedFilePaths,
      copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
    mentionRoots: NO_MENTION_ROOTS,
    fileRoute: props.rig.route,
    pathsReachTarget: props.pathsReachTarget,
  });
  return (
    <div
      data-testid="zone"
      onDrop={paste.onDrop}
      data-busy={String(paste.isResolvingFilePaths || paste.isAttachingFiles)}
    />
  );
}

function dropReport(): void {
  fireEvent.drop(screen.getByTestId("zone"), {
    dataTransfer: fileTransfer([pdfFile("report.pdf")]),
  });
}

beforeEach(() => {
  toasts.error.mockClear();
  resolveDroppedFilePaths.mockReset();
  resolveDroppedFilePaths.mockResolvedValue([REPORT_PATH]);
});

afterEach(() => {
  cleanup();
});

describe("useLandingComposerPaste, a dropped non-image file", () => {
  it("is typed as a path, and not uploaded, when typed paths reach the placement host", async () => {
    const rig = makeRig();
    render(<LandingZone rig={rig} pathsReachTarget />);

    dropReport();

    await waitFor(() => expect(rig.insertedPaths).toEqual([[REPORT_PATH]]));
    await waitFor(() =>
      expect(screen.getByTestId("zone").getAttribute("data-busy")).toBe(
        "false",
      ),
    );
    expect(rig.insertedFiles).toEqual([]);
    expect(rig.put).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("is uploaded through the landing file route, with no path typed, when they do not", async () => {
    const rig = makeRig();
    render(<LandingZone rig={rig} pathsReachTarget={false} />);

    dropReport();

    await waitFor(() =>
      expect(rig.insertedFiles.map((attrs) => attrs.fileName)).toEqual([
        "report.pdf",
      ]),
    );
    await waitFor(() => expect(rig.put).toHaveBeenCalledTimes(1));
    expect(rig.put.mock.calls[0][0].request).toMatchObject({
      kind: "file",
      fileName: "report.pdf",
      mediaType: "application/pdf",
    });
    expect(rig.insertedPaths.flat()).toEqual([]);
    expect(toasts.error).not.toHaveBeenCalled();
  });
});
