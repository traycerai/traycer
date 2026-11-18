import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileSaveRequest,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";
import {
  canDownloadToDevice,
  downloadBlobToDevice,
  hasSeparateDownloadRoute,
  saveBlobToDisk,
} from "@/lib/files/save-blob-to-disk";

const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

function restoreUrlMethod(
  name: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    return;
  }
  Object.defineProperty(URL, name, descriptor);
}

/** The one request a shell's save or download was handed. */
function onlyRequest(
  calls: ReadonlyArray<readonly [FileSaveRequest]>,
): FileSaveRequest {
  expect(calls).toHaveLength(1);
  const request = calls.at(0)?.[0];
  if (request === undefined) throw new Error("the shell was never called");
  return request;
}

/** Where a mock's first call falls in the order every mock was called in. */
function firstCallOrder(mock: {
  readonly mock: { readonly invocationCallOrder: readonly number[] };
}): number {
  const order = mock.mock.invocationCallOrder.at(0);
  if (order === undefined) throw new Error("the mock was never called");
  return order;
}

/** The bytes a request's own `readBytes` yields. */
async function bytesOf(request: FileSaveRequest): Promise<number[]> {
  return Array.from(new Uint8Array(await request.readBytes()));
}

afterEach(() => {
  window.showSaveFilePicker = undefined;
  restoreUrlMethod("createObjectURL", createObjectUrlDescriptor);
  restoreUrlMethod("revokeObjectURL", revokeObjectUrlDescriptor);
  vi.restoreAllMocks();
});

describe("saveBlobToDisk", () => {
  it("treats save picker cancellation as a no-op", async () => {
    const createObjectURL = vi.fn(() => "blob:mermaid");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    window.showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));

    await expect(
      saveBlobToDisk(
        new Blob(["png"], { type: "image/png" }),
        "diagram.png",
        null,
        null,
      ),
    ).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to the anchor download after a save picker write failure", async () => {
    const writable = {
      write: vi.fn().mockRejectedValue(new Error("write failed")),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const createWritable = vi.fn().mockResolvedValue(writable);
    const createObjectURL = vi.fn(() => "blob:mermaid");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectURL,
    });
    window.showSaveFilePicker = vi.fn().mockResolvedValue({
      name: "diagram.png",
      createWritable,
    });

    // A recoverable (non-cancel) write failure must not lose the file: the
    // browser falls through to the <a download> anchor and still saves it.
    await expect(
      saveBlobToDisk(
        new Blob(["png"], { type: "image/png" }),
        "diagram.png",
        null,
        null,
      ),
    ).resolves.toEqual({ name: "diagram.png", path: null });
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
    // The half-written file is abandoned before the anchor writes the real one.
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(firstCallOrder(writable.abort)).toBeLessThan(
      firstCallOrder(createObjectURL),
    );
  });

  describe("with a source lifetime and no shell", () => {
    it("goes straight to the anchor download and never opens the picker", async () => {
      const createObjectURL = vi.fn(() => "blob:lifetime");
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: createObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);
      window.showSaveFilePicker = vi.fn();
      const beforeSave = vi.fn();

      await expect(
        saveBlobToDisk(
          new Blob(["png"], { type: "image/png" }),
          "diagram.png",
          null,
          beforeSave,
        ),
      ).resolves.toEqual({ name: "diagram.png", path: null });

      expect(window.showSaveFilePicker).not.toHaveBeenCalled();
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("dispatches nothing once the lifetime has retired", async () => {
      const createObjectURL = vi.fn(() => "blob:lifetime");
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: createObjectURL,
      });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);
      window.showSaveFilePicker = vi.fn();
      const retired = new Error("The artifact is no longer shown");

      await expect(
        saveBlobToDisk(
          new Blob(["png"], { type: "image/png" }),
          "diagram.png",
          null,
          () => {
            throw retired;
          },
        ),
      ).rejects.toBe(retired);

      expect(window.showSaveFilePicker).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    });

    it("still uses the picker when there is no lifetime to honour (control)", async () => {
      const writable = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      };
      const createObjectURL = vi.fn(() => "blob:lifetime");
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: createObjectURL,
      });
      window.showSaveFilePicker = vi.fn().mockResolvedValue({
        name: "diagram.png",
        createWritable: vi.fn().mockResolvedValue(writable),
      });

      await expect(
        saveBlobToDisk(
          new Blob(["png"], { type: "image/png" }),
          "diagram.png",
          null,
          null,
        ),
      ).resolves.toEqual({ name: "diagram.png", path: null });

      expect(window.showSaveFilePicker).toHaveBeenCalledTimes(1);
      expect(writable.close).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
    });
  });

  it("uses the shell's native save host before browser save APIs", async () => {
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve({ name: "diagram.png", path: "/tmp/diagram.png" }));
    const createObjectURL = vi.fn(() => "blob:mermaid");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    window.showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("not allowed", "NotAllowedError"));

    const blob = new Blob(["png"], { type: "image/png" });
    await expect(
      saveBlobToDisk(
        blob,
        "diagram.png",
        {
          saveFile,
          openSavedFile: () => Promise.resolve(),
          downloadFile: null,
          downloadUrl: null,

          saveRoute: "download",
        },
        null,
      ),
    ).resolves.toEqual({
      name: "diagram.png",
      path: "/tmp/diagram.png",
    });
    const request = onlyRequest(saveFile.mock.calls);
    expect(request.name).toBe("diagram.png");
    expect(request.type).toBe("image/png");
    // No lifetime was given, so the shell is told nothing can retire it.
    expect(request.stillWanted).toBeNull();
    expect(await bytesOf(request)).toEqual(
      Array.from(new Uint8Array(await blob.arrayBuffer())),
    );
    expect(window.showSaveFilePicker).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("downloadBlobToDevice", () => {
  it("takes the shell's chooser-free route when it has one", async () => {
    // The whole point of the second route: a shell whose `saveFile` reaches a
    // share sheet must not send a "Download" through it.
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null));
    const downloadFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation>
    >(() =>
      Promise.resolve({
        name: "usage.png",
        path: "file:///docs/Traycer/usage.png",
      }),
    );

    const blob = new Blob(["png"], { type: "image/png" });
    await expect(
      downloadBlobToDevice(
        blob,
        "usage.png",
        {
          saveFile,
          openSavedFile: null,
          downloadFile,
          downloadUrl: null,
          saveRoute: "share",
        },
        null,
      ),
    ).resolves.toEqual({
      name: "usage.png",
      path: "file:///docs/Traycer/usage.png",
    });
    const request = onlyRequest(downloadFile.mock.calls);
    expect(request.name).toBe("usage.png");
    expect(request.type).toBe("image/png");
    expect(request.stillWanted).toBeNull();
    expect(await bytesOf(request)).toEqual(
      Array.from(new Uint8Array(await blob.arrayBuffer())),
    );
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("falls back to the shell's own save route where there is no separate one", async () => {
    // A desktop save dialog IS the download - routing around it would open a
    // second, worse one.
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve({ name: "usage.png", path: "/tmp/usage.png" }));

    await expect(
      downloadBlobToDevice(
        new Blob(["png"], { type: "image/png" }),
        "usage.png",
        {
          saveFile,
          openSavedFile: null,
          downloadFile: null,
          downloadUrl: null,
          saveRoute: "download",
        },
        null,
      ),
    ).resolves.toEqual({ name: "usage.png", path: "/tmp/usage.png" });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to the browser save APIs with no shell at all", async () => {
    const createObjectURL = vi.fn(() => "blob:usage");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    await expect(
      downloadBlobToDevice(
        new Blob(["png"], { type: "image/png" }),
        "usage.png",
        null,
        null,
      ),
    ).resolves.toEqual({ name: "usage.png", path: null });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("canDownloadToDevice", () => {
  const shareOnlyShell = () => ({
    saveFile: vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null)),
    openSavedFile: null,
    downloadFile: null,
    downloadUrl: null,
    saveRoute: "share" as const,
  });

  it("is false ONLY where the shell has a chooser and no direct write", () => {
    // Android 10: the shared-storage route does not exist and `saveFile` is the
    // share sheet. Offering Download there would route it INTO the sheet - the
    // exact mislabelling this split removes.
    expect(canDownloadToDevice(shareOnlyShell())).toBe(false);
  });

  it("is true for a browser, a direct writer, and a shell that saves itself", () => {
    expect(canDownloadToDevice(null)).toBe(true);
    expect(
      canDownloadToDevice({
        ...shareOnlyShell(),
        downloadFile: () => Promise.resolve({ name: "u.png", path: null }),
        downloadUrl: null,
      }),
    ).toBe(true);
    expect(
      canDownloadToDevice({ ...shareOnlyShell(), saveRoute: "download" }),
    ).toBe(true);
  });

  it("refuses to route a download through a chooser rather than doing it quietly", async () => {
    // Callers gate on the capability, so reaching this is a bug - and it has to
    // surface as one instead of silently opening the share sheet.
    const shell = shareOnlyShell();
    await expect(
      downloadBlobToDevice(
        new Blob(["x"], { type: "image/png" }),
        "u.png",
        shell,
        null,
      ),
    ).rejects.toThrow("no download destination");
    expect(shell.saveFile).not.toHaveBeenCalled();
  });
});

describe("hasSeparateDownloadRoute", () => {
  it("is false for no shell and for a shell whose save route is the download", () => {
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null));
    expect(hasSeparateDownloadRoute(null)).toBe(false);
    expect(
      hasSeparateDownloadRoute({
        saveFile,
        openSavedFile: null,
        downloadFile: null,
        downloadUrl: null,
        saveRoute: "download",
      }),
    ).toBe(false);
  });

  it("is true exactly where the shell owns a chooser-free download", () => {
    const saveFile = vi.fn<
      (request: FileSaveRequest) => Promise<SavedFileLocation | null>
    >(() => Promise.resolve(null));
    expect(
      hasSeparateDownloadRoute({
        saveFile,
        openSavedFile: null,
        downloadFile: () => Promise.resolve({ name: "u.png", path: null }),
        downloadUrl: null,
        saveRoute: "share",
      }),
    ).toBe(true);
  });
});
