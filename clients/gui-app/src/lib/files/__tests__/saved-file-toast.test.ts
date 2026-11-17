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
  // No chooser-free download route: these cases are about what a COMPLETED
  // save can offer afterwards, which is the same question either way.
  return {
    saveFile,
    openSavedFile,
    downloadFile: null,
    downloadUrl: null,
    saveRoute: "share",
  };
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
      toastSavedFile({ name: "a.md", path: null }, vi.fn(), null, "save");

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
      toastSavedFile(saved, openSaved, host, "save");

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

      toastSavedFile({ name: "a.md", path: null }, vi.fn(), host, "save");

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });
  });

  describe("phone runtime (a save host that reports no path)", () => {
    // Nothing came back that could be re-opened, so offering the action would
    // be a dead button.
    it("shows a plain toast even though the shell has a native save route", () => {
      const host = fileSaveHost(resolvingSaveFile(null), null);

      toastSavedFile({ name: "a.md", path: null }, vi.fn(), host, "save");

      expect(toastSuccess).toHaveBeenCalledWith("Saved a.md");
    });

    it("says the file was SHARED where the sheet was the route", () => {
      // The bytes a share sheet is handed live in the app's cache container,
      // so nothing was saved anywhere the user keeps files. Claiming otherwise
      // is a plain untruth, and it is the verb the user reads.
      const host = fileSaveHost(resolvingSaveFile(null), null);

      toastSavedFile({ name: "a.md", path: null }, vi.fn(), host, "share");

      expect(toastSuccess).toHaveBeenCalledWith("Shared a.md");
    });

    it("still offers no re-open action on a share, path or not", () => {
      const host = fileSaveHost(resolvingSaveFile(null), null);

      toastSavedFile(
        { name: "a.md", path: "/tmp/a.md" },
        vi.fn(),
        host,
        "share",
      );

      const [, options] = toastSuccess.mock.calls[0];
      expect(isActionToast(options)).toBe(false);
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
      null,
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
      null,
    );

    expect(result).toBeNull();
  });

  it("passes a pathless save straight through, as a share sheet reports it", async () => {
    const result = await saveBlobToDisk(
      new Blob(["x"], { type: "image/png" }),
      "d.png",
      fileSaveHost(resolvingSaveFile({ name: "d.png", path: null }), null),
      null,
    );

    expect(result).toEqual({ name: "d.png", path: null });
  });

  it("keeps a cancellation authoritative when aborting the writable also fails: it resolves null and never falls back to a download", async () => {
    const cancelled = new DOMException("The save was cancelled.", "AbortError");
    const writable = {
      write: vi.fn(() => Promise.reject(cancelled)),
      close: vi.fn(() => Promise.resolve()),
      abort: vi.fn(() =>
        Promise.reject(new Error("The writable could not be aborted.")),
      ),
    };
    const handle = {
      name: "d.png",
      createWritable: () => Promise.resolve(writable),
    };
    const pickerDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "showSaveFilePicker",
    );
    Object.defineProperty(window, "showSaveFilePicker", {
      value: vi.fn(() => Promise.resolve(handle)),
      configurable: true,
      writable: true,
    });
    const objectUrlDescriptor = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL",
    );
    const createObjectURL = vi.fn(() => "blob:fallback");
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      const result = await saveBlobToDisk(
        new Blob(["x"], { type: "image/png" }),
        "d.png",
        null,
        null,
      );

      expect(result).toBeNull();
      expect(writable.abort).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(anchorClick).not.toHaveBeenCalled();
    } finally {
      if (pickerDescriptor === undefined)
        Reflect.deleteProperty(window, "showSaveFilePicker");
      else
        Object.defineProperty(window, "showSaveFilePicker", pickerDescriptor);
      if (objectUrlDescriptor === undefined)
        Reflect.deleteProperty(URL, "createObjectURL");
      else Object.defineProperty(URL, "createObjectURL", objectUrlDescriptor);
    }
  });
});
