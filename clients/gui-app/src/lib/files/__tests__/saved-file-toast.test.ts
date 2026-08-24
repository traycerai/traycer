import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ExternalToast } from "sonner";

const toastSuccess = vi.hoisted(() =>
  vi.fn<(message: string, options: ExternalToast | undefined) => string>(
    () => "success-toast",
  ),
);
const toastError = vi.hoisted(() =>
  vi.fn<(message: string) => string>(() => "error-toast"),
);

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

import { saveBlobToDisk } from "@/lib/files/save-blob-to-disk";
import { toastSavedFile } from "@/lib/files/saved-file-toast";

/**
 * Mirrors the shape `save-blob-to-disk.ts` expects from
 * `runnerHost.fileDrops.saveFile`'s input - not exported by the source
 * module, so redeclared here structurally rather than imported.
 */
interface DesktopSaveFileInput {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

interface DesktopFileDrops {
  readonly saveFile: (input: DesktopSaveFileInput) => Promise<unknown>;
  readonly openSavedFile: (path: string) => Promise<void>;
}

function setRunnerHost(fileDrops: DesktopFileDrops): void {
  (globalThis as { runnerHost?: unknown }).runnerHost = { fileDrops };
}

function clearRunnerHost(): void {
  delete (globalThis as { runnerHost?: unknown }).runnerHost;
}

interface ToastAction {
  readonly label: string;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/**
 * Narrows a captured `toast.success` options argument down to the
 * `{ action: { label, onClick } }` shape `toastSavedFile` builds for
 * runtimes that can re-open the saved file.
 */
function isActionToast(
  options: ExternalToast | undefined,
): options is ExternalToast & { action: ToastAction } {
  if (options === undefined) return false;
  const action = options.action;
  return (
    typeof action === "object" &&
    action !== null &&
    "label" in action &&
    "onClick" in action
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRunnerHost();
});

afterEach(() => {
  clearRunnerHost();
});

describe("toastSavedFile", () => {
  describe("browser runtime (no runnerHost bridge)", () => {
    it("shows a plain success toast with no action", () => {
      toastSavedFile({ name: "a.md", path: null }, vi.fn());

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });
  });

  describe("desktop runtime (runnerHost.fileDrops bridge present)", () => {
    it("adds an Open file action whose onClick hands the saved file to openSaved", () => {
      const openSaved =
        vi.fn<(saved: { name: string; path: string | null }) => void>();
      setRunnerHost({
        saveFile: vi.fn<(input: DesktopSaveFileInput) => Promise<unknown>>(() =>
          Promise.resolve(null),
        ),
        openSavedFile: vi.fn<(path: string) => Promise<void>>(() =>
          Promise.resolve(),
        ),
      });

      const saved = { name: "a.md", path: "/tmp/x/a.md" };
      toastSavedFile(saved, openSaved);

      expect(toastSuccess).toHaveBeenCalledTimes(1);
      const [, options] = toastSuccess.mock.calls[0];
      if (!isActionToast(options)) {
        throw new Error("Expected an action toast.");
      }
      expect(options.action.label).toBe("Open file");

      options.action.onClick({} as ReactMouseEvent<HTMLButtonElement>);

      expect(openSaved).toHaveBeenCalledWith(saved);
    });

    it("shows a plain toast when the saved file has no path", () => {
      setRunnerHost({
        saveFile: vi.fn<(input: DesktopSaveFileInput) => Promise<unknown>>(() =>
          Promise.resolve(null),
        ),
        openSavedFile: vi.fn<(path: string) => Promise<void>>(() =>
          Promise.resolve(),
        ),
      });

      toastSavedFile({ name: "a.md", path: null }, vi.fn());

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });
  });
});

describe("saveBlobToDisk", () => {
  it("resolves the saved file and forwards blob bytes to the desktop save bridge", async () => {
    const saveFileMock = vi.fn<
      (input: DesktopSaveFileInput) => Promise<unknown>
    >(() => Promise.resolve({ name: "d.png", path: "/tmp/d.png" }));
    setRunnerHost({
      saveFile: saveFileMock,
      openSavedFile: vi.fn<(path: string) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    });

    const result = await saveBlobToDisk(
      new Blob(["x"], { type: "image/png" }),
      "d.png",
    );

    expect(result).toEqual({ name: "d.png", path: "/tmp/d.png" });
    // Assert the concrete fields via `objectContaining` and the byte payload
    // separately: nesting `expect.any(ArrayBuffer)` as a property value in a
    // plain object literal here is an unsafe assignment (the matcher is
    // typed `any`, the property is typed `ArrayBuffer`) that the lint rules
    // reject.
    expect(saveFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "d.png", type: "image/png" }),
    );
    const [[input]] = saveFileMock.mock.calls;
    expect(input.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it("resolves null when the desktop bridge reports a cancel", async () => {
    setRunnerHost({
      saveFile: vi.fn<(input: DesktopSaveFileInput) => Promise<unknown>>(() =>
        Promise.resolve(null),
      ),
      openSavedFile: vi.fn<(path: string) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    });

    const result = await saveBlobToDisk(
      new Blob(["x"], { type: "image/png" }),
      "d.png",
    );

    expect(result).toBeNull();
  });

  it("rejects when the desktop bridge returns a malformed result", async () => {
    setRunnerHost({
      saveFile: vi.fn<(input: DesktopSaveFileInput) => Promise<unknown>>(() =>
        Promise.resolve("d.png"),
      ),
      openSavedFile: vi.fn<(path: string) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    });

    await expect(
      saveBlobToDisk(new Blob(["x"], { type: "image/png" }), "d.png"),
    ).rejects.toThrow(/unexpected result/);
  });
});
