import "../../../../../__tests__/test-browser-apis";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
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
  // Finding 1: ProseMirror must not also insert text/plain for file-like
  // clipboards that carry a textual sibling (e.g. VS Code uri-list + plain).
  describe("finding 1 - file-like paste/drop ownership (no ProseMirror text race)", () => {
    it("inserts a single path span for a text/uri-list + text/plain clipboard, not a plain-text duplicate", async () => {
      const copyDroppedFilePaths = vi.fn(() =>
        Promise.resolve(["/tmp/traycer-copy/notes.txt"]),
      );
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () => Promise.resolve([]),
        copyDroppedFilePaths,
      });
      const handleRef = await mountedHandle(fileDrops, undefined);

      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeUriListPlainTransfer(
          "file:///repo/external/notes.txt",
          "/repo/external/notes.txt",
        ),
      });
      await flushMicrotasks();

      expect(copyDroppedFilePaths).toHaveBeenCalledOnce();
      expect(pathSpanTexts(handleRef.current)).toEqual([
        "/tmp/traycer-copy/notes.txt",
      ]);
      expect(plainTextOutsideCode(handleRef.current)).toEqual([" "]);
      expect(handleRef.current?.getJSON()).toEqual(
        paragraphWithCodeSpan("/tmp/traycer-copy/notes.txt"),
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
  describe("finding 2 - paste-time position capture through caret moves / concurrent pastes", () => {
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

    it("maps two concurrent pastes correctly when they resolve in reverse order", async () => {
      const resolvers: Array<(paths: readonly string[]) => void> = [];
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
        initialContent: paragraphText("____"),
        initialSelection: { from: 1, to: 1 },
      });

      const first = new File(["1"], "first.txt", { type: "text/plain" });
      const second = new File(["2"], "second.txt", { type: "text/plain" });

      // First paste at start.
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([first]),
      });
      // Move caret to end, second paste.
      act(() => {
        handleRef.current?.focusAtEnd();
      });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([second]),
      });

      expect(resolvers).toHaveLength(2);

      // Resolve second paste first, then first - positions must still land
      // at their respective paste-time anchors.
      await act(async () => {
        resolvers[1]?.(["/repo/second.txt"]);
        await flushMicrotasksRaw();
      });
      await act(async () => {
        resolvers[0]?.(["/repo/first.txt"]);
        await flushMicrotasksRaw();
      });

      expect(pathSpanTexts(handleRef.current)).toEqual([
        "first.txt",
        "second.txt",
      ]);
      const runs = textRuns(handleRef.current);
      const firstIdx = runs.findIndex(
        (run) => run.code && run.text === "first.txt",
      );
      const secondIdx = runs.findIndex(
        (run) => run.code && run.text === "second.txt",
      );
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
    });
  });

  // Finding 4: mixed image+path must share one undo group even when the two
  // async jobs settle more than history.newGroupDelay (500ms) apart.
  describe("finding 4 - mixed image+path lands as a single undo group", () => {
    it("reverts both the image attachment and path span with a single Undo after a >500ms gap between settlements", async () => {
      vi.useFakeTimers();

      const pendingReaders: FileReader[] = [];
      vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(
        function (this: FileReader, _blob: Blob) {
          pendingReaders.push(this);
        },
      );

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
      });
      const before = handleRef.current?.getJSON();

      const png = new File(["png-bytes"], "shot.png", { type: "image/png" });
      const pdf = new File(["pdf-bytes"], "doc.pdf", {
        type: "application/pdf",
      });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([png, pdf]),
      });

      // Image conversion settles first...
      expect(pendingReaders.length).toBeGreaterThan(0);
      await act(async () => {
        const reader = pendingReaders.shift();
        if (reader === undefined)
          throw new Error("expected pending FileReader");
        Object.defineProperty(reader, "result", {
          configurable: true,
          value: "data:image/png;base64,cG5n",
        });
        reader.dispatchEvent(new ProgressEvent("load"));
        await flushMicrotasksRaw();
      });

      // ...then more than newGroupDelay elapses before path resolution.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(resolvePaths).not.toBeNull();
      await act(async () => {
        resolvePaths?.(["/repo/doc.pdf"]);
        await flushMicrotasksRaw();
      });

      // Both kinds of content should now be in the doc.
      const mid = handleRef.current?.getJSON();
      expect(docHasImageAttachment(mid)).toBe(true);
      expect(pathSpanTexts(handleRef.current)).toEqual(["doc.pdf"]);

      // One Undo must clear both (single history group).
      fireEvent.keyDown(screen.getByTestId("composer-editor"), {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });

      expect(handleRef.current?.getJSON()).toEqual(before);
      expect(docHasImageAttachment(handleRef.current?.getJSON())).toBe(false);
      expect(pathSpanTexts(handleRef.current)).toEqual([]);
    });
  });

  // Round-2 finding 1: a mixed image+path paste must land as ONE transaction/
  // undo group through beginAttachmentInsertion's unified commit, regardless
  // of the order files appear in the clipboard, and even when an unrelated
  // edit lands while the async image-convert/path-resolve legs are still
  // pending.
  describe("round-2 finding 1 - mixed paste stays one transaction under reorder / concurrent edits", () => {
    it("reversing the clipboard's file order still lands a single undo group", async () => {
      vi.useFakeTimers();

      const pendingReaders: FileReader[] = [];
      vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(
        function (this: FileReader, _blob: Blob) {
          pendingReaders.push(this);
        },
      );

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
      });
      const before = handleRef.current?.getJSON();

      const png = new File(["png-bytes"], "shot.png", { type: "image/png" });
      const pdf = new File(["pdf-bytes"], "doc.pdf", {
        type: "application/pdf",
      });
      // Doc-before-image file order in the clipboard (reversed from the
      // finding-4 case above) - the resulting doc order (images before
      // paths) is a fixed product decision, not derived from input order.
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([pdf, png]),
      });

      expect(pendingReaders.length).toBeGreaterThan(0);
      await act(async () => {
        const reader = pendingReaders.shift();
        if (reader === undefined)
          throw new Error("expected pending FileReader");
        Object.defineProperty(reader, "result", {
          configurable: true,
          value: "data:image/png;base64,cG5n",
        });
        reader.dispatchEvent(new ProgressEvent("load"));
        await flushMicrotasksRaw();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(resolvePaths).not.toBeNull();
      await act(async () => {
        resolvePaths?.(["/repo/doc.pdf"]);
        await flushMicrotasksRaw();
      });

      expect(docHasImageAttachment(handleRef.current?.getJSON())).toBe(true);
      expect(pathSpanTexts(handleRef.current)).toEqual(["doc.pdf"]);

      fireEvent.keyDown(screen.getByTestId("composer-editor"), {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });

      expect(handleRef.current?.getJSON()).toEqual(before);
      expect(docHasImageAttachment(handleRef.current?.getJSON())).toBe(false);
      expect(pathSpanTexts(handleRef.current)).toEqual([]);
    });

    it("an intervening edit during the pending window lands after the mixed content, and Undo reverts only the mixed commit", async () => {
      vi.useFakeTimers();

      const pendingReaders: FileReader[] = [];
      vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(
        function (this: FileReader, _blob: Blob) {
          pendingReaders.push(this);
        },
      );

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
        initialContent: paragraphText("BASE"),
        initialSelection: { from: 5, to: 5 },
      });

      const png = new File(["png-bytes"], "shot.png", { type: "image/png" });
      const pdf = new File(["pdf-bytes"], "doc.pdf", {
        type: "application/pdf",
      });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([png, pdf]),
      });

      // An unrelated edit lands (appended at the same caret, unfocused)
      // while both async legs of the mixed paste are still pending.
      act(() => {
        handleRef.current?.insertDictatedText("EDIT");
      });

      expect(pendingReaders.length).toBeGreaterThan(0);
      await act(async () => {
        const reader = pendingReaders.shift();
        if (reader === undefined)
          throw new Error("expected pending FileReader");
        Object.defineProperty(reader, "result", {
          configurable: true,
          value: "data:image/png;base64,cG5n",
        });
        reader.dispatchEvent(new ProgressEvent("load"));
        await flushMicrotasksRaw();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(resolvePaths).not.toBeNull();
      await act(async () => {
        resolvePaths?.(["/repo/doc.pdf"]);
        await flushMicrotasksRaw();
      });

      const afterCommit = handleRef.current?.getJSON();
      expect(docHasImageAttachment(afterCommit)).toBe(true);
      expect(pathSpanTexts(handleRef.current)).toEqual(["doc.pdf"]);
      const joined = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      expect(joined).toContain("BASE");
      expect(joined).toContain("EDIT");
      // Mixed content stayed pinned to the original paste caret - ahead of
      // the intervening edit, not after it.
      expect(joined.indexOf("doc.pdf")).toBeLessThan(joined.indexOf("EDIT"));

      // A single Undo reverts only the mixed commit's own transaction, not
      // the earlier, unrelated edit (more than newGroupDelay apart).
      fireEvent.keyDown(screen.getByTestId("composer-editor"), {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });

      expect(docHasImageAttachment(handleRef.current?.getJSON())).toBe(false);
      expect(pathSpanTexts(handleRef.current)).toEqual([]);
      const afterUndo = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      expect(afterUndo).toContain("BASE");
      expect(afterUndo).toContain("EDIT");
    });
  });

  // Round-2 finding 2: `beginAttachmentInsertion` captures the full selection
  // range (not a right-biased point) and maps concurrent same-caret jobs by
  // relative sequence, not a single fixed bias.
  describe("round-2 finding 2 - full selection range capture and per-job anchor bias", () => {
    it("replaces a non-collapsed selection instead of appending after it", async () => {
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () => Promise.resolve(["note.txt"]),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: [],
        initialContent: paragraphText("HELLO WORLD"),
        initialSelection: { from: 7, to: 12 },
      });

      const file = new File(["x"], "note.txt", { type: "text/plain" });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([file]),
      });
      await flushMicrotasks();

      expect(pathSpanTexts(handleRef.current)).toEqual(["note.txt"]);
      const joined = textRuns(handleRef.current)
        .map((run) => run.text)
        .join("");
      expect(joined).not.toContain("WORLD");
      expect(joined.startsWith("HELLO ")).toBe(true);
    });

    it("keeps a pending job's content before text typed at the same caret afterward", async () => {
      let resolvePaths: ((paths: readonly string[]) => void) | null = null;
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvePaths = resolve;
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: [],
        initialContent: paragraphText("AB"),
        initialSelection: { from: 3, to: 3 },
      });

      act(() => {
        handleRef.current?.focus();
      });

      const file = new File(["x"], "mid.txt", { type: "text/plain" });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([file]),
      });

      // Same-caret edit, typed while the job is still pending.
      act(() => {
        handleRef.current?.insertDictatedText("TYPED");
      });

      expect(resolvePaths).not.toBeNull();
      await act(async () => {
        resolvePaths?.(["mid.txt"]);
        await flushMicrotasksRaw();
      });

      expect(pathSpanTexts(handleRef.current)).toEqual(["mid.txt"]);
      const runs = textRuns(handleRef.current);
      const pathIdx = runs.findIndex(
        (run) => run.code && run.text === "mid.txt",
      );
      const typedIdx = runs.findIndex(
        (run) => !run.code && run.text.includes("TYPED"),
      );
      expect(pathIdx).toBeGreaterThanOrEqual(0);
      expect(typedIdx).toBeGreaterThan(pathIdx);
    });

    it("renders two concurrent jobs anchored at the same caret in paste order regardless of resolution order", async () => {
      const resolvers: Array<(paths: readonly string[]) => void> = [];
      const fileDrops = makeFileDrops({
        resolveDroppedFilePaths: () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
        copyDroppedFilePaths: (paths) => Promise.resolve([...paths]),
      });
      const handleRef = await mountedHandle(fileDrops, {
        mentionRoots: ["/repo"],
        initialContent: paragraphText("____"),
        initialSelection: { from: 1, to: 1 },
      });

      const first = new File(["1"], "first.txt", { type: "text/plain" });
      const second = new File(["2"], "second.txt", { type: "text/plain" });

      // Both pastes land at the SAME caret - unlike the finding-2 concurrent
      // test above (which moves the caret to the end before the second
      // paste), nothing moves the selection in between.
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([first]),
      });
      fireEvent.paste(screen.getByTestId("composer-editor"), {
        clipboardData: makeFileTransfer([second]),
      });

      expect(resolvers).toHaveLength(2);

      // Resolve second (B) before first (A) - paste order must still win.
      await act(async () => {
        resolvers[1]?.(["/repo/second.txt"]);
        await flushMicrotasksRaw();
      });
      await act(async () => {
        resolvers[0]?.(["/repo/first.txt"]);
        await flushMicrotasksRaw();
      });

      expect(pathSpanTexts(handleRef.current)).toEqual([
        "first.txt",
        "second.txt",
      ]);
      const runs = textRuns(handleRef.current);
      const firstIdx = runs.findIndex(
        (run) => run.code && run.text === "first.txt",
      );
      const secondIdx = runs.findIndex(
        (run) => run.code && run.text === "second.txt",
      );
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
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
  return host;
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

function docHasImageAttachment(content: JsonContent | undefined): boolean {
  if (content === undefined) return false;
  const walk = (node: JsonContent): boolean => {
    if (node.type === "imageAttachment") return true;
    return (node.content ?? []).some(walk);
  };
  return walk(content);
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await flushMicrotasksRaw();
  });
}

async function flushMicrotasksRaw(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
