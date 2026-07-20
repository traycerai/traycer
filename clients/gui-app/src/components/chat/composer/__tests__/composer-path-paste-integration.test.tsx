import "../../../../../__tests__/test-browser-apis";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { Editor } from "@tiptap/core";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../composer-prompt-editor";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";
import {
  useComposerPaste,
  type ComposerPasteEditorHandle,
} from "@/hooks/composer/use-composer-paste";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
  vi.useRealTimers();
});

/**
 * Real-editor integration coverage for the review-fix round on paste/drop
 * path insertion. Mounts the actual `ComposerPromptEditor` wired to the
 * actual `useComposerPaste` handlers - the seam the prior review called out
 * as untested (plain div / mocked handle would hide ProseMirror ownership
 * races, position mapping, undo grouping, and unmount liveness).
 */
describe("composer path paste/drop integration (real editor)", () => {
  describe("native-only clipboard fallback", () => {
    it("inserts a native VS Code file path when the DOM clipboard is empty", async () => {
      const readNativeClipboardFilePaths = vi.fn(() =>
        Promise.resolve(["/repo/from-vscode.txt"]),
      );
      const fileDrops: IFileDropHost = {
        resolveDroppedFilePaths: () => Promise.resolve([]),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
        readNativeClipboardFilePaths,
      };
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
      });

      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeEmptyTransfer([]),
      });
      await flushMicrotasks();

      expect(readNativeClipboardFilePaths).toHaveBeenCalledOnce();
      expect(pathSpanTexts(handleRef.current)).toEqual(["from-vscode.txt"]);
    });

    it("does not read native formats when the DOM exposes ordinary text", async () => {
      const readNativeClipboardFilePaths = vi.fn(() =>
        Promise.resolve(["/repo/from-vscode.txt"]),
      );
      const fileDrops: IFileDropHost = {
        resolveDroppedFilePaths: () => Promise.resolve([]),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
        readNativeClipboardFilePaths,
      };
      const handleRef = await mountedHandle(fileDrops, undefined);

      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeUriListPlainTransfer(
          "https://example.com",
          "https://example.com",
        ),
      });
      await flushMicrotasks();

      expect(readNativeClipboardFilePaths).not.toHaveBeenCalled();
      expect(pathSpanTexts(handleRef.current)).toEqual([]);
    });

    it("settles the editor job for repeated empty and failed native reads", async () => {
      const readNativeClipboardFilePaths = vi
        .fn<() => Promise<readonly string[]>>(() => Promise.resolve([]))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("native read failed"))
        .mockImplementationOnce(() => {
          throw new Error("native read threw");
        });
      const fileDrops: IFileDropHost = {
        resolveDroppedFilePaths: () => Promise.resolve([]),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
        readNativeClipboardFilePaths,
      };
      const handleRef = await mountedHandle(fileDrops, undefined);
      const on = vi.spyOn(Editor.prototype, "on");
      const off = vi.spyOn(Editor.prototype, "off");
      const editorDom = screen.getByTestId("composer-editor");

      [0, 1, 2, 3].forEach(() => {
        fireEvent.paste(editorDom, { clipboardData: makeEmptyTransfer([]) });
      });
      await waitFor(() => {
        expect(readNativeClipboardFilePaths).toHaveBeenCalledTimes(4);
      });
      await flushMicrotasks();

      expect(
        on.mock.calls.filter(([event]) => event === "transaction"),
      ).toHaveLength(4);
      expect(
        off.mock.calls.filter(([event]) => event === "transaction"),
      ).toHaveLength(4);
      expect(pathSpanTexts(handleRef.current)).toEqual([]);
    });
  });

  // Finding 1: ProseMirror must not also insert text/plain for file-like
  // clipboards that carry a textual sibling (e.g. VS Code uri-list + plain).
  describe("finding 1 - file-like paste/drop ownership (no ProseMirror text race)", () => {
    it("keeps a stable URI-only workspace path relative and avoids a plain-text duplicate", async () => {
      const copyDroppedFilePaths = vi.fn((paths: readonly string[]) =>
        Promise.resolve(paths),
      );
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () => Promise.resolve([]),
        copyDroppedFilePaths,
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
      });

      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeUriListPlainTransfer(
          "file:///repo/external/notes.txt",
          "/repo/external/notes.txt",
        ),
      });
      await flushMicrotasks();

      expect(copyDroppedFilePaths).toHaveBeenCalledOnce();
      expect(pathSpanTexts(handleRef.current)).toEqual(["external/notes.txt"]);
      expect(plainTextOutsideCode(handleRef.current)).toEqual([" "]);
      expect(handleRef.current?.getJSON()).toEqual(
        paragraphWithCodeSpan("external/notes.txt"),
      );
    });

    it("inserts a single path span for a Files + text/plain clipboard, not a plain-text duplicate", async () => {
      const file = new File(["notes"], "notes.txt", { type: "text/plain" });
      const resolveDroppedFilePaths = vi.fn(() =>
        Promise.resolve(["/repo/notes.txt"]),
      );
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths,
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
      });

      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFilesAndPlainTransfer(file, "/repo/notes.txt"),
      });
      await flushMicrotasks();

      expect(resolveDroppedFilePaths).toHaveBeenCalledOnce();
      expect(pathSpanTexts(handleRef.current)).toEqual(["notes.txt"]);
      expect(plainTextOutsideCode(handleRef.current)).toEqual([" "]);
    });

    it("inserts a single path span on drop when dataTransfer also carries text/html and text/plain", async () => {
      const file = new File(["notes"], "notes.txt", { type: "text/plain" });
      const resolveDroppedFilePaths = vi.fn(() =>
        Promise.resolve(["/repo/notes.txt"]),
      );
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths,
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
      });

      fireEvent.drop(screen.getByTestId("composer-editor"), {
        dataTransfer: makeFilesWithTextDrop(file, {
          plain: "/repo/notes.txt",
          html: "<p>/repo/notes.txt</p>",
        }),
        clientX: 0,
        clientY: 0,
      });
      await flushMicrotasks();

      expect(resolveDroppedFilePaths).toHaveBeenCalledOnce();
      expect(pathSpanTexts(handleRef.current)).toEqual(["notes.txt"]);
      expect(plainTextOutsideCode(handleRef.current)).toEqual([" "]);
    });
  });

  // Finding 2 (+ concurrent race that relies on the same position mapping).
  describe("finding 2 - paste-time position capture through caret moves", () => {
    it("inserts at the original paste position after a real post-paste edit moves the caret", async () => {
      let resolvePaths: ((paths: readonly string[]) => void) | null = null;
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvePaths = resolve;
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      // Seed "AAAABBBB" with caret between the two halves (pos 5).
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
        initialContent: paragraphText("AAAABBBB"),
        initialSelection: { from: 5, to: 5 },
      });

      const file = new File(["x"], "mid.txt", { type: "text/plain" });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([file]),
      });

      // Append at the end via a real document transaction so the mappable
      // position is tracked through an intervening edit (proves mapping, not
      // "current selection at resolve time"). insertDictatedText when unfocused
      // appends at Selection.atEnd without replacing the whole doc.
      act(() => {
        handleRef.current?.insertDictatedText("ZZZ");
      });

      expect(resolvePaths).not.toBeNull();
      await act(async () => {
        resolvePaths?.(["/repo/mid.txt"]);
        await flushMicrotasksRaw();
      });

      // Path should land between AAAA and BBBB (original paste caret), not
      // after the later "ZZZ " append at end (which would mean "current
      // selection at resolve time").
      expect(pathSpanTexts(handleRef.current)).toEqual(["mid.txt"]);
      const joined = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      expect(joined).toContain("AAAA");
      expect(joined).toContain("BBBB");
      expect(joined).toContain("ZZZ");
      expect(joined.indexOf("AAAA")).toBeLessThan(joined.indexOf("mid.txt"));
      expect(joined.indexOf("mid.txt")).toBeLessThan(joined.indexOf("BBBB"));
      expect(joined.indexOf("BBBB")).toBeLessThan(joined.indexOf("ZZZ"));
    });

    it("keeps a deferred path before same-caret typing through undo and redo", async () => {
      let resolvePaths: ((paths: readonly string[]) => void) | null = null;
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvePaths = resolve;
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
        initialContent: paragraphText("AB"),
        initialSelection: { from: 3, to: 3 },
      });
      const editor = screen.getByTestId("composer-editor");
      act(() => {
        handleRef.current?.focus();
      });

      fireEvent.paste(editor, {
        clipboardData: makeFileTransfer([
          new File(["x"], "mid.txt", { type: "text/plain" }),
        ]),
      });
      act(() => {
        handleRef.current?.insertDictatedText("NEW");
      });

      fireEvent.keyDown(editor, { key: "z", code: "KeyZ", ctrlKey: true });
      fireEvent.keyDown(editor, {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
        shiftKey: true,
      });

      expect(resolvePaths).not.toBeNull();
      await act(async () => {
        resolvePaths?.(["/repo/mid.txt"]);
        await flushMicrotasksRaw();
      });

      expect(pathSpanTexts(handleRef.current)).toEqual(["mid.txt"]);
      const joined = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      expect(joined.indexOf("AB")).toBeLessThan(joined.indexOf("mid.txt"));
      expect(joined.indexOf("mid.txt")).toBeLessThan(joined.indexOf("NEW"));
    });
  });
  // Round-2 finding 3: `hasClaimableFileTransfer` parses URI content instead
  // of trusting the `text/uri-list` type name alone, so an ordinary link
  // paste isn't silently swallowed.
  describe("round-2 finding 3 - ordinary link paste is not claimed as file-like", () => {
    it("does not swallow an ordinary https:// link paste (text/uri-list + text/plain, no file:// entries)", async () => {
      const resolveDroppedFilePaths = vi.fn(() => Promise.resolve([]));
      const copyDroppedFilePaths = vi.fn((paths: readonly string[]) =>
        Promise.resolve([...paths]),
      );
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths,
        copyDroppedFilePaths,
      });
      const handleRef = await mountedHandle(fileDrops, undefined);

      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeUriListPlainTransfer(
          "https://example.com",
          "https://example.com",
        ),
      });
      await flushMicrotasks();

      expect(resolveDroppedFilePaths).not.toHaveBeenCalled();
      expect(copyDroppedFilePaths).not.toHaveBeenCalled();
      expect(pathSpanTexts(handleRef.current)).toEqual([]);
      const joined = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      expect(joined).toContain("https://example.com");
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  // Finding 7: commit after unmount must not insert or toast.
  describe("finding 7 - unmount liveness guard on path resolution", () => {
    it("does not insert or toast when path resolution settles after unmount", async () => {
      let resolvePaths: ((paths: readonly string[]) => void) | null = null;
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvePaths = resolve;
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const { unmount } = await mountedHandleWithUnmount(fileDrops, {
        mentionRoots: ["/repo"],
      });

      const file = new File(["x"], "stale.txt", { type: "text/plain" });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([file]),
      });

      unmount();

      // Resolution after unmount must not throw and must not surface a toast
      // (commit returns false when the editor is destroyed).
      await act(async () => {
        resolvePaths?.(["/repo/stale.txt"]);
        await flushMicrotasksRaw();
      });

      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.queryByTestId("composer-editor")).toBeNull();
    });
  });
  // Round-3: https drag-enter may light the overlay (type-name only), but
  // drop clears it and does not claim the transfer. Real editor confirms
  // ordinary drop text is not doubled by a path-span pipeline.
  describe("round-3 - https uri drag-enter/drop does not claim or double-insert", () => {
    it("clears ownership on drop and inserts ordinary https text once without resolvers", async () => {
      const resolveDroppedFilePaths = vi.fn(() => Promise.resolve([]));
      const copyDroppedFilePaths = vi.fn((paths: readonly string[]) =>
        Promise.resolve([...paths]),
      );
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths,
        copyDroppedFilePaths,
      });
      const handleRef = await mountedHandle(fileDrops, undefined);
      const editor = screen.getByTestId("composer-editor");

      fireEvent.dragEnter(editor, {
        dataTransfer: makeEmptyTransfer(["text/uri-list"]),
      });
      // Overlay state lives on the paste hook; drop must still clear depth
      // even when the payload is not claimable as a file path.
      fireEvent.drop(editor, {
        dataTransfer: makeHttpsUriDrop(
          "https://example.com/doc",
          "https://example.com/doc",
        ),
        clientX: 0,
        clientY: 0,
      });
      await flushMicrotasks();

      expect(resolveDroppedFilePaths).not.toHaveBeenCalled();
      expect(copyDroppedFilePaths).not.toHaveBeenCalled();
      expect(pathSpanTexts(handleRef.current)).toEqual([]);

      const joined = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      // At most one ordinary text insertion of the URL - never a path span
      // and never a doubled plain+path pair from claiming the transfer.
      const occurrences = joined.split("https://example.com/doc").length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface MountOptions {
  readonly mentionRoots: ReadonlyArray<string>;
  readonly initialContent: JsonContent;
  readonly initialSelection: {
    readonly from: number;
    readonly to: number;
  } | null;
}

const DEFAULT_MOUNT: MountOptions = {
  mentionRoots: ["/repo"],
  initialContent: { type: "doc", content: [{ type: "paragraph" }] },
  initialSelection: null,
};

async function mountedHandle(
  fileDrops: IFileDropHost,
  options: Partial<MountOptions> | undefined,
): Promise<{ current: ComposerPromptEditorHandle | null }> {
  const { handleRef } = await mountedHandleWithUnmount(fileDrops, options);
  return handleRef;
}

async function mountedHandleWithUnmount(
  fileDrops: IFileDropHost,
  options: Partial<MountOptions> | undefined,
): Promise<{
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly unmount: () => void;
}> {
  const opts = { ...DEFAULT_MOUNT, ...(options ?? {}) };
  const handleRef: { current: ComposerPromptEditorHandle | null } = {
    current: null,
  };
  const view = render(
    <Harness
      handleRef={handleRef}
      fileDrops={fileDrops}
      mentionRoots={opts.mentionRoots}
      initialContent={opts.initialContent}
      initialSelection={opts.initialSelection}
    />,
  );
  await act(async () => {
    await flushMicrotasksRaw();
  });
  expect(handleRef.current).not.toBeNull();
  expect(handleRef.current?.isReady()).toBe(true);
  return { handleRef, unmount: view.unmount };
}

function Harness({
  handleRef,
  fileDrops,
  mentionRoots,
  initialContent,
  initialSelection,
}: {
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
  readonly fileDrops: IFileDropHost;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly initialContent: JsonContent;
  readonly initialSelection: {
    readonly from: number;
    readonly to: number;
  } | null;
}) {
  const [pickerStore] = useState<ComposerPickerStore>(() =>
    createComposerPickerStore(),
  );
  const editorRef = useRef<ComposerPasteEditorHandle | null>(null);
  const paste = useComposerPaste(editorRef, fileDrops, mentionRoots);
  const setHandle = (instance: ComposerPromptEditorHandle | null): void => {
    handleRef.current = instance;
    editorRef.current = instance;
  };
  return (
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
      hasPastedImageBytes={null}
      stabilizeImageAttachmentCaret={false}
      onSnapshot={() => undefined}
      onSubmit={() => undefined}
      onPaste={paste.onPaste}
      onDragOver={paste.onDragOver}
      onDrop={paste.onDrop}
      onKeyDown={undefined}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={null}
    />
  );
}

// ---------------------------------------------------------------------------
// Clipboard / drop fixtures
// ---------------------------------------------------------------------------

interface TransferLike {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    getAsFile: () => File | null;
  }>;
  getData: (type: string) => string;
}

function makeFileDrops(host: {
  readonly resolveDroppedFilePaths: IFileDropHost["resolveDroppedFilePaths"];
  readonly copyDroppedFilePaths: IFileDropHost["copyDroppedFilePaths"];
}): IFileDropHost {
  return {
    ...host,
    readNativeClipboardFilePaths: () => Promise.resolve([]),
  };
}

function makeFileTransfer(files: ReadonlyArray<File>): TransferLike {
  return {
    files,
    types: files.length > 0 ? ["Files"] : [],
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    getData: () => "",
  };
}

function makeUriListPlainTransfer(uri: string, plain: string): TransferLike {
  return {
    files: [],
    types: ["text/uri-list", "text/plain"],
    items: [],
    getData: (type) => {
      if (type === "text/uri-list") return uri;
      if (type === "text/plain") return plain;
      return "";
    },
  };
}

function makeFilesAndPlainTransfer(file: File, plain: string): TransferLike {
  return {
    files: [file],
    types: ["Files", "text/plain"],
    items: [{ kind: "file", getAsFile: () => file }],
    getData: (type) => (type === "text/plain" ? plain : ""),
  };
}

function makeFilesWithTextDrop(
  file: File,
  text: { readonly plain: string; readonly html: string },
): TransferLike {
  return {
    files: [file],
    types: ["Files", "text/plain", "text/html"],
    items: [{ kind: "file", getAsFile: () => file }],
    getData: (type) => {
      if (type === "text/plain") return text.plain;
      if (type === "text/html") return text.html;
      return "";
    },
  };
}

function makeEmptyTransfer(types: ReadonlyArray<string>): TransferLike {
  return { files: [], types, items: [], getData: () => "" };
}

function makeHttpsUriDrop(uri: string, plain: string): TransferLike {
  return {
    files: [],
    types: ["text/uri-list", "text/plain"],
    items: [],
    getData: (type) => {
      if (type === "text/uri-list") return uri;
      if (type === "text/plain") return plain;
      return "";
    },
  };
}

// ---------------------------------------------------------------------------
// Doc assertions
// ---------------------------------------------------------------------------

interface TextRun {
  readonly text: string;
  readonly code: boolean;
}

function textRuns(handle: ComposerPromptEditorHandle | null): TextRun[] {
  const content = handle?.getJSON();
  const paragraph = content?.content?.[0];
  return (paragraph?.content ?? []).flatMap((node) => {
    if (node.type !== "text") return [];
    const marks = node.marks ?? [];
    return [
      {
        text: node.text ?? "",
        code: marks.some((mark) => mark.type === "code"),
      },
    ];
  });
}

function pathSpanTexts(handle: ComposerPromptEditorHandle | null): string[] {
  return textRuns(handle)
    .filter((run) => run.code)
    .map((run) => run.text);
}

function plainTextOutsideCode(
  handle: ComposerPromptEditorHandle | null,
): string[] {
  return textRuns(handle)
    .filter((run) => !run.code)
    .map((run) => run.text);
}

function paragraphText(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function paragraphWithCodeSpan(path: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: path, marks: [{ type: "code" }] },
          { type: "text", text: " " },
        ],
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await flushMicrotasksRaw();
  });
}

async function flushMicrotasksRaw(): Promise<void> {
  await Promise.all(Array.from({ length: 10 }, () => Promise.resolve()));
}
