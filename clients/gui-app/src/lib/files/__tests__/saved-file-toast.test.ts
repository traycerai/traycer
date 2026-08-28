import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ExternalToast } from "sonner";
import type {
  FileSaveRequest,
  IFileSaveHost,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";

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
 * The `saveFile` member of a faked `IFileSaveHost`: callable exactly as the
 * contract declares it, plus the one mock member these tests read back.
 */
interface SaveFileMock {
  (request: FileSaveRequest): Promise<SavedFileLocation | null>;
  readonly mock: {
    readonly calls: ReadonlyArray<[FileSaveRequest]>;
  };
}

/**
 * A shell with a native save route. `openSavedFile` is what separates the two
 * kinds of it: a desktop dialog reports a path and can re-open it, a share
 * sheet reports neither.
 */
function fileSaveHost(
  saveFile: SaveFileMock,
  openSavedFile: ((path: string) => Promise<void>) | null,
): IFileSaveHost {
  return { saveFile, openSavedFile };
}

function resolvingSaveFile(result: SavedFileLocation | null): SaveFileMock {
  return vi.fn<(request: FileSaveRequest) => Promise<SavedFileLocation | null>>(
    () => Promise.resolve(result),
  );
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
});

describe("toastSavedFile", () => {
  describe("browser runtime (no native save capability)", () => {
    it("shows a plain success toast with no action", () => {
      toastSavedFile({ name: "a.md", path: null }, vi.fn(), null);

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });
  });

  describe("desktop runtime (a save host that reports paths)", () => {
    it("adds an Open file action whose onClick hands the saved file to openSaved", () => {
      const openSaved = vi.fn<(saved: SavedFileLocation) => void>();
      const host = fileSaveHost(resolvingSaveFile(null), () =>
        Promise.resolve(),
      );

      const saved = { name: "a.md", path: "/tmp/x/a.md" };
      toastSavedFile(saved, openSaved, host);

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
      const host = fileSaveHost(resolvingSaveFile(null), () =>
        Promise.resolve(),
      );

      toastSavedFile({ name: "a.md", path: null }, vi.fn(), host);

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });
  });

  describe("phone runtime (a save host that reports no path)", () => {
    // The share sheet completed, so this IS a save - but nothing came back
    // that could be re-opened, so offering the action would be a dead button.
    it("shows a plain toast even though the shell has a native save route", () => {
      const host = fileSaveHost(resolvingSaveFile(null), null);

      toastSavedFile({ name: "a.md", path: null }, vi.fn(), host);

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });
  });
});

describe("saveBlobToDisk", () => {
  it("resolves the saved file and forwards blob bytes to the shell's save host", async () => {
    const saveFile = resolvingSaveFile({ name: "d.png", path: "/tmp/d.png" });

    const result = await saveBlobToDisk(
      new Blob(["x"], { type: "image/png" }),
      "d.png",
      fileSaveHost(saveFile, () => Promise.resolve()),
    );

    expect(result).toEqual({ name: "d.png", path: "/tmp/d.png" });
    // Assert the concrete fields via `objectContaining` and the byte payload
    // separately: nesting `expect.any(ArrayBuffer)` as a property value in a
    // plain object literal here is an unsafe assignment (the matcher is
    // typed `any`, the property is typed `ArrayBuffer`) that the lint rules
    // reject.
    expect(saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "d.png", type: "image/png" }),
    );
    const [[input]] = saveFile.mock.calls;
    expect(input.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it("resolves null when the save host reports a dismissal", async () => {
    const result = await saveBlobToDisk(
      new Blob(["x"], { type: "image/png" }),
      "d.png",
      fileSaveHost(resolvingSaveFile(null), () => Promise.resolve()),
    );

    expect(result).toBeNull();
  });

  it("passes a pathless save straight through, as a share sheet reports it", async () => {
    const result = await saveBlobToDisk(
      new Blob(["x"], { type: "image/png" }),
      "d.png",
      fileSaveHost(resolvingSaveFile({ name: "d.png", path: null }), null),
    );

    expect(result).toEqual({ name: "d.png", path: null });
  });
});
